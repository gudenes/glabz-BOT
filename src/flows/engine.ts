import type { Flow, FlowConversationState, FlowNode, EngineResult } from "./types.js";
import {
  findLiveFlow,
  getConversationState,
  getFlow,
  upsertConversationState,
} from "./store.js";
import { answerFreeform, classifyIntent, extractDate } from "./llm.js";
import { runAction } from "./connectors/index.js";

function render(template: string, vars: Record<string, string>): string {
  return (template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    if (k === "name_greet") {
      // pushName (nome do perfil do WhatsApp, capturado automaticamente em
      // runFlowStep) só entra como último recurso — nome/apelido dado
      // explicitamente pelo cliente (via ask varName:"nome") sempre vence.
      const n = vars.nome || vars.name || vars.pushName;
      return n ? `, ${n}` : "";
    }
    return vars[k] ?? "";
  });
}

function nextNode(
  flow: Flow,
  fromId: string,
  branch?: string | null
): FlowNode | null {
  const edges = flow.edges.filter((e) => e.from === fromId);
  if (!edges.length) return null;
  if (branch) {
    const hit =
      edges.find((e) => (e.label || "").toLowerCase() === branch.toLowerCase()) ||
      edges.find((e) => (e.label || "").toLowerCase() === "default");
    if (hit) return flow.nodes.find((n) => n.id === hit.to) ?? null;
    // Pedido de ramo (ex.: intenção classificada, ok/erro de llm_answer,
    // true/false de condition) que não bate com NENHUMA edge, nem "default"
    // — e o nó tem mais de uma saída de verdade (decisão de ramo, não um
    // continuação simples). Bug real já visto: cair pro "primeira edge" aqui
    // fazia o fluxo pular pro ramo errado (às vezes um ramo curto sem
    // pergunta nenhuma) sempre que a classificação de intenção não conseguia
    // decidir — a conversa "nascia quebrada" pulando direto pro fim. Não
    // adivinha: devolve null, quem chamou decide o que fazer (llm_intent
    // pede pra reformular; ver comentário em runFlowStep).
    if (edges.length > 1) return null;
  }
  // unlabeled first edge — só chega aqui sem branch, ou com 1 edge só
  // (continuação simples, sem ambiguidade de verdade).
  const plain = edges.find((e) => !e.label) || edges[0];
  return flow.nodes.find((n) => n.id === plain.to) ?? null;
}

function triggerNode(flow: Flow): FlowNode | null {
  return flow.nodes.find((n) => n.type === "trigger") ?? flow.nodes[0] ?? null;
}

/**
 * Um slug de intenção que significa "acabou, não preciso de mais nada".
 * Convenção do gerador (src/flows/from-prompt.ts, regra 10) é usar
 * exatamente "encerrar"; os outros radicais cobrem fluxos montados à mão.
 * Só é usado pra PROTEGER contra encerramento precoce — um fluxo cujo ramo
 * de saída tenha outro nome simplesmente não ganha essa proteção extra,
 * nunca quebra por causa disso.
 */
export function isClosingSlug(slug: string): boolean {
  return /^(encerr|finaliz|sair|tchau|despedi|agradec)/i.test(slug.trim());
}

/** Estado in-memory do simulador (não grava em disco). */
export type FlowSimState = {
  nodeId: string | null;
  waitingFor: string | null;
  vars: Record<string, string>;
  mode: "bot" | "human";
  /** true após end — próxima msg reentra */
  finished?: boolean;
};

export type FlowTraceStep = {
  nodeId: string;
  type: string;
  detail?: string;
  /** Texto enviado ao cliente nesse passo (message/ask/handoff), se houver. */
  reply?: string;
};

export type FlowStepResult = EngineResult & {
  nodeId: string | null;
  waitingFor: string | null;
  trace: FlowTraceStep[];
  /** slug escolhido no llm_intent, se houver */
  lastIntent?: string;
  intentSource?: string;
};

/**
 * Executa um passo do fluxo em memória (produção e simulador).
 * Não exige status=live — o simulador testa rascunhos.
 */
export async function runFlowStep(opts: {
  flow: Flow;
  state: FlowSimState;
  text: string;
  pushName?: string | null;
  /** true no simulador do admin */
  simulate?: boolean;
}): Promise<FlowStepResult> {
  const flow = opts.flow;
  const text = (opts.text || "").trim();
  let state = opts.state;
  const simulate = Boolean(opts.simulate);

  if (state.mode === "human") {
    return {
      replies: [],
      handoff: true,
      handoffReason: state.vars.handoff_reason || "human",
      vars: state.vars,
      mode: "human",
      nodeId: null,
      waitingFor: null,
      trace: [],
    };
  }

  const vars = { ...state.vars };
  if (opts.pushName && !vars.pushName) vars.pushName = opts.pushName;

  const replies: string[] = [];
  const trace: FlowTraceStep[] = [];
  let handoff = false;
  let handoffReason: string | undefined;
  let lastIntent: string | undefined;
  let intentSource: string | undefined;
  let node: FlowNode | null = null;
  // A mensagem desta rodada foi consumida por um "ask" que não é o llm_intent
  // (ex.: pergunta de nome no tronco, antes de saber a intenção) — sinaliza
  // pro llm_intent não reaproveitar esse texto como se fosse o pedido do
  // cliente. Bug real visto em produção: resposta de nome ("Carlos") virava
  // a "dúvida" classificada, pulando pra uma resposta desconexa e o fim do
  // fluxo sem nunca perguntar o que o cliente queria de verdade. Exceção
  // sancionada: um ask com data.capturesIntent=true (ex.: "Posso te ajudar
  // com mais alguma coisa?" antes de encerrar) existe justamente pra colher
  // um novo pedido — esse SIM deve classificar normalmente.
  let skipIntentText = false;
  // Só é legítimo ENCERRAR o atendimento quando o cliente respondeu "não
  // preciso de mais nada" a um ask de capturesIntent ("posso ajudar com mais
  // alguma coisa?"). Fora daí — em especial na saudação inicial — uma
  // classificação de encerramento é quase sempre engano do classificador e
  // mataria a conversa antes de começar (bug real: "Ola" virava "encerrar").
  let fromCapturesIntentAsk = false;

  // Continuação de ask
  if (state.waitingFor && state.nodeId) {
    const askNode = flow.nodes.find((n) => n.id === state.nodeId);
    if (askNode?.type === "ask") {
      const varName = String(askNode.data.varName || "answer");
      vars[varName] = text;
      trace.push({
        nodeId: askNode.id,
        type: "ask",
        detail: `salvou ${varName}="${text.slice(0, 60)}"`,
      });
      node = nextNode(flow, askNode.id);
      fromCapturesIntentAsk = askNode.data.capturesIntent === true;
      skipIntentText = !fromCapturesIntentAsk;
    } else {
      node = triggerNode(flow);
      if (node) node = nextNode(flow, node.id) || node;
    }
  } else if (!state.nodeId || state.finished) {
    // início ou reentrada após end
    node = triggerNode(flow);
    if (node?.type === "trigger") {
      trace.push({ nodeId: node.id, type: "trigger", detail: "início" });
      node = nextNode(flow, node.id);
    }
  } else {
    // mensagem no meio — re-entra no intent se houver
    const intentNode = flow.nodes.find((n) => n.type === "llm_intent");
    if (intentNode) {
      node = intentNode;
    } else {
      node = triggerNode(flow);
      if (node) node = nextNode(flow, node.id);
    }
  }

  let guard = 0;
  let waitingFor: string | null = null;
  let currentId: string | null = null;
  let finished = false;

  while (node && guard++ < 20) {
    currentId = node.id;

    if (node.type === "trigger") {
      trace.push({ nodeId: node.id, type: "trigger" });
      node = nextNode(flow, node.id);
      continue;
    }

    if (node.type === "message") {
      const msg = render(String(node.data.text || ""), vars);
      const hasReply = Boolean(msg.trim());
      if (hasReply) replies.push(msg);
      trace.push({
        nodeId: node.id,
        type: "message",
        detail: "enviou texto",
        reply: hasReply ? msg : undefined,
      });
      node = nextNode(flow, node.id);
      continue;
    }

    if (node.type === "ask") {
      const prompt = render(String(node.data.prompt || "Pode me dizer?"), vars);
      replies.push(prompt);
      waitingFor = String(node.data.varName || "answer");
      trace.push({
        nodeId: node.id,
        type: "ask",
        reply: prompt,
        detail: `aguarda ${waitingFor}`,
      });
      break;
    }

    if (node.type === "condition") {
      const field = String(node.data.field || "last");
      const op = String(node.data.op || "contains");
      const value = String(node.data.value || "").toLowerCase();
      const hay = (field === "last" ? text : vars[field] || "").toLowerCase();
      let ok = false;
      if (op === "contains") ok = hay.includes(value);
      else if (op === "equals") ok = hay === value;
      else if (op === "regex") {
        try {
          ok = new RegExp(value, "i").test(hay);
        } catch {
          ok = false;
        }
      }
      trace.push({
        nodeId: node.id,
        type: "condition",
        detail: ok ? "sim" : "não",
      });
      node = nextNode(flow, node.id, ok ? "true" : "false");
      continue;
    }

    if (node.type === "llm_intent") {
      const consumedByAsk = skipIntentText;
      skipIntentText = false;

      if (consumedByAsk) {
        // O texto desta rodada já virou a resposta de um ask anterior (ex.:
        // nome) — não é um pedido de verdade, não classifica em cima dele.
        // Manda uma ponte natural e PARA — a próxima mensagem reentra aqui
        // via "mensagem no meio" (topo da função), com texto fresco de
        // verdade dessa vez. {{name_greet}} aproveita o que acabou de ser
        // salvo (ex.: nome) quando fizer sentido, e some sozinho quando não.
        const bridge = render("Perfeito{{name_greet}}! Como posso te ajudar?", vars);
        replies.push(bridge);
        trace.push({
          nodeId: node.id,
          type: "llm_intent",
          detail: "aguardando pedido de verdade (resposta anterior não era um pedido)",
          reply: bridge,
        });
        break;
      }

      const intents = (
        Array.isArray(node.data.intents) ? node.data.intents : []
      ) as { slug: string; description: string }[];
      const result = await classifyIntent({
        text,
        intents,
        systemHint: String(node.data.prompt || ""),
      });
      // Guarda de encerramento precoce: só aceita cair no ramo de encerrar
      // quando o cliente respondeu isso a um "posso ajudar com mais alguma
      // coisa?" (capturesIntent). Numa saudação inicial, "encerrar" é quase
      // sempre engano do classificador — a mensagem não pede nada, mas isso
      // é o COMEÇO da conversa, não o fim dela.
      let effectiveIntent = result.intent;
      let closedTooEarly = false;
      if (!fromCapturesIntentAsk && isClosingSlug(effectiveIntent)) {
        closedTooEarly = true;
        effectiveIntent = "default";
      }

      lastIntent = effectiveIntent;
      intentSource = result.source;
      vars.last_intent = effectiveIntent;
      vars.intent_source = result.source;
      // Guarda o texto que originou essa classificação — permite reaproveitar
      // (ex.: cliente já mandou a dúvida junto, não precisa perguntar de novo).
      vars.pre_answer = text;
      trace.push({
        nodeId: node.id,
        type: "llm_intent",
        detail: closedTooEarly
          ? `${result.intent} ignorado (encerrar cedo demais) → default`
          : `${result.intent} (${result.source})`,
      });
      const routed = nextNode(flow, node.id, effectiveIntent);
      if (!routed) {
        // Não deu pra saber qual ramo seguir (classificação incerta —
        // source "default" — ou o fluxo não tem edge pro slug retornado).
        // Não adivinha um ramo: PARA aqui e espera a próxima mensagem — na
        // próxima chamada ela reentra neste mesmo llm_intent (ver "mensagem
        // no meio" no início da função) e reclassifica do zero, em vez de
        // pular direto pro fim de um ramo qualquer.
        if (replies.length) {
          // Já mandamos algo nesta mesma rodada (tipicamente a mensagem de
          // boas-vindas, que costuma terminar com "em que posso ajudar?") —
          // repetir "não entendi" logo depois soa quebrado. Só espera a
          // resposta da pergunta que acabou de sair.
          trace.push({
            nodeId: node.id,
            type: "llm_intent",
            detail: "aguardando o pedido do cliente",
          });
          break;
        }
        const clarify = "Desculpa, não entendi bem. Pode me explicar de outro jeito o que você precisa?";
        replies.push(clarify);
        trace.push({
          nodeId: node.id,
          type: "llm_intent",
          detail: "sem ramo correspondente — pediu esclarecimento",
          reply: clarify,
        });
        break;
      }
      node = routed;
      continue;
    }

    if (node.type === "llm_extract") {
      const result = await extractDate({ text });
      const varName = String(node.data.varName || "data_confirmada");
      if (result.date) vars[varName] = result.date;
      vars.date_extract_status = result.status;
      trace.push({
        nodeId: node.id,
        type: "llm_extract",
        detail: `${result.status}${result.date ? " · " + result.date : ""} (${result.source})`,
      });
      node = nextNode(flow, node.id, result.status);
      continue;
    }

    if (node.type === "llm_answer") {
      // IA responde a pergunta do cliente com o contexto que o dono do negócio
      // escreveu. Sem chave de IA (ou se a chamada falhar) NÃO inventa resposta:
      // segue pelo ramo "erro", que normalmente leva a um handoff.
      const manualContext = String(node.data.context || "");

      // Camada extra: o que a equipe já respondeu no histórico (RAG).
      // O contexto manual continua sendo a verdade oficial e vem PRIMEIRO —
      // em conflito, ele vence, porque foi escrito de propósito enquanto o
      // histórico é subproduto (docs/rag-desenho.md §5.3).
      //
      // Falha aqui nunca pode derrubar a resposta: sem RAG, o card volta a
      // funcionar exatamente como antes, só com o texto manual.
      let context = manualContext;
      // Log estruturado: sem isso, "por que a IA respondeu isso?" vira
      // adivinhação. Registra por que o RAG rodou ou não, e o que a busca
      // trouxe — foi a falta dele que fez um bug de clientId ausente passar
      // despercebido no simulador do builder.
      const ragLog: Record<string, unknown> = { node: node.id, flowId: flow.id };
      let ragHits: { question: string; score: number }[] = [];

      if (!flow.clientId) {
        ragLog.rag = "pulado";
        ragLog.motivo = "fluxo sem clientId";
      } else if (node.data.useKnowledge === false) {
        ragLog.rag = "pulado";
        ragLog.motivo = "desligado no passo";
      } else {
        try {
          const { embedTexts } = await import("./../rag/embeddings.js");
          const { searchKnowledge } = await import("./../rag/index-store.js");
          const emb = await embedTexts([text]);
          if (!emb.ok) {
            ragLog.rag = "falhou";
            ragLog.motivo = emb.reason;
          } else {
            const hits = await searchKnowledge(flow.clientId, emb.vectors[0], { topK: 4 });
            ragLog.rag = "ok";
            ragLog.trechos = hits.length;
            ragLog.scores = hits.map((h) => Number(h.score).toFixed(3));
            ragHits = hits.map((h) => ({ question: h.question, score: Number(h.score) }));
            if (hits.length) {
              const trechos = hits
                .map((h) => `- Pergunta parecida: ${h.question}\n  Resposta dada pela equipe: ${h.answer}`)
                .join("\n");
              context = [
                manualContext,
                "",
                "=== Respostas que a equipe já deu para perguntas parecidas ===",
                "(use como referência; se conflitar com o contexto acima, o de cima vale)",
                trechos,
              ].join("\n");
            }
          }
        } catch (e) {
          ragLog.rag = "erro";
          ragLog.motivo = e instanceof Error ? e.message : String(e);
        }
      }
      console.log(`[ia] ${JSON.stringify({ ...ragLog, pergunta: text.slice(0, 80) })}`);

      const result = await answerFreeform({
        question: text,
        context,
        maxChars: Number(node.data.maxChars) || 400,
      });
      // Rastro persistido: o console some, e "por que respondeu isso?" precisa
      // de resposta depois. Fire-and-forget — gravar log não pode atrasar nem
      // derrubar o atendimento.
      // Captura o id agora: `node` é reatribuído no loop, e o .then() roda
      // depois — sem isso o log apontaria pro passo errado.
      const answeringNodeId = node.id;
      void import("./../rag/answer-log.js")
        .then(({ logAiAnswer }) =>
          logAiAnswer({
            clientId: flow.clientId ?? null,
            flowId: flow.id,
            nodeId: answeringNodeId,
            question: text,
            answer: result.ok ? result.answer : null,
            ragStatus: String(ragLog.rag ?? ""),
            ragReason: ragLog.motivo ? String(ragLog.motivo) : null,
            ragHits,
            usedManualContext: manualContext.trim().length > 0,
            simulated: simulate,
          })
        )
        .catch(() => undefined);

      const varName = String(node.data.varName || "resposta_ia");
      if (result.ok) {
        vars[varName] = result.answer;
        replies.push(result.answer);
        trace.push({
          nodeId: node.id,
          type: "llm_answer",
          reply: result.answer,
          detail: "respondeu",
        });
        node = nextNode(flow, node.id, "ok");
      } else {
        vars.llm_answer_error = result.reason;
        trace.push({ nodeId: node.id, type: "llm_answer", detail: `falhou: ${result.reason}` });
        node = nextNode(flow, node.id, "erro");
      }
      continue;
    }

    if (node.type === "action") {
      const connector = String(node.data.connector || "calendar");
      const operation = String(node.data.operation || "list_slots");
      const config =
        node.data.config && typeof node.data.config === "object"
          ? (node.data.config as Record<string, unknown>)
          : {};
      // permite webhookUrl no data raiz também
      if (node.data.webhookUrl && !config.webhookUrl) {
        config.webhookUrl = node.data.webhookUrl;
      }
      if (node.data.url && !config.url) {
        config.url = node.data.url;
      }

      // última mensagem do user disponível para connectors
      vars.last = text;

      const result = await runAction({
        connector,
        operation,
        vars,
        config,
        ctx: {
          product: flow.product,
          accountId: flow.accountId,
          clientId: flow.clientId ?? null,
          simulate,
        },
      });

      if (result.vars) {
        Object.assign(vars, result.vars);
      }
      vars.last_action = `${connector}.${operation}`;
      vars.last_action_ok = result.ok ? "1" : "0";
      vars.last_action_source = result.source || "";
      if (!result.ok) {
        vars.last_action_error = result.error || "error";
        if (result.message) vars.last_action_error_message = result.message;
      }

      const actionId = node.id;
      trace.push({
        nodeId: actionId,
        type: "action",
        detail: `${connector}.${operation} · ${result.ok ? "ok" : "erro"}${
          result.source ? ` · ${result.source}` : ""
        }`,
      });

      // edges: ok / erro → fallback unlabeled / default
      const branch = result.ok ? "ok" : "erro";
      let next = nextNode(flow, actionId, branch);
      if (!next) next = nextNode(flow, actionId, null);
      node = next;
      continue;
    }

    if (node.type === "handoff") {
      const msg = render(
        String(
          node.data.message ||
            "Vou te transferir para um atendente humano. Um momento!"
        ),
        vars
      );
      const handoffHasReply = Boolean(msg.trim());
      if (handoffHasReply) replies.push(msg);
      handoff = true;
      handoffReason = String(node.data.reason || "handoff");
      vars.handoff_reason = handoffReason;
      trace.push({
        nodeId: node.id,
        type: "handoff",
        detail: handoffReason,
        reply: handoffHasReply ? msg : undefined,
      });
      break;
    }

    if (node.type === "end") {
      trace.push({ nodeId: node.id, type: "end", detail: "fim" });
      currentId = null;
      waitingFor = null;
      finished = true;
      break;
    }

    node = nextNode(flow, node.id);
  }

  const mode = handoff ? "human" : "bot";

  return {
    replies,
    handoff,
    handoffReason,
    suppressAppWebhook: false,
    vars,
    mode,
    nodeId: waitingFor ? currentId : handoff ? null : currentId,
    waitingFor,
    lastIntent,
    intentSource,
    trace,
    // attach finished for simulator via vars is awkward — return via extended use
  };
}

/**
 * Wrapper do simulador: devolve também o próximo estado.
 */
export async function simulateFlowMessage(opts: {
  flow: Flow;
  state?: Partial<FlowSimState> | null;
  text: string;
}): Promise<{ result: FlowStepResult; state: FlowSimState }> {
  const prev: FlowSimState = {
    nodeId: opts.state?.nodeId ?? null,
    waitingFor: opts.state?.waitingFor ?? null,
    vars: { ...(opts.state?.vars || {}) },
    mode: opts.state?.mode || "bot",
    finished: opts.state?.finished ?? false,
  };

  // se human, não avança
  if (prev.mode === "human") {
    const result = await runFlowStep({
      flow: opts.flow,
      state: prev,
      text: opts.text,
      simulate: true,
    });
    return { result, state: prev };
  }

  const result = await runFlowStep({
    flow: opts.flow,
    state: prev,
    text: opts.text,
    simulate: true,
  });

  const next: FlowSimState = {
    nodeId: result.nodeId,
    waitingFor: result.waitingFor,
    vars: result.vars,
    mode: result.mode,
    finished:
      result.trace.some((t) => t.type === "end") && !result.waitingFor && !result.handoff,
  };

  return { result, state: next };
}

/**
 * Processa mensagem do usuário no fluxo live (produção WhatsApp).
 */
export async function processInboundFlow(opts: {
  accountId: string;
  product: string;
  phoneE164: string;
  text: string;
  pushName?: string | null;
}): Promise<EngineResult | null> {
  const phone = opts.phoneE164.replace(/\D/g, "");
  let state =
    getConversationState(opts.accountId, phone) ||
    ({
      accountId: opts.accountId,
      phoneE164: phone,
      mode: "bot" as const,
      flowId: null,
      nodeId: null,
      waitingFor: null,
      vars: {},
      updatedAt: new Date().toISOString(),
    } satisfies FlowConversationState);

  // Já em handoff humano — não intercepta
  if (state.mode === "human") return null;

  const flow =
    (state.flowId && getFlow(state.flowId)) ||
    findLiveFlow({ product: opts.product, accountId: opts.accountId });

  if (!flow || flow.status !== "live") return null;

  const step = await runFlowStep({
    flow,
    state: {
      nodeId: state.nodeId,
      waitingFor: state.waitingFor ?? null,
      vars: state.vars || {},
      mode: state.mode,
    },
    text: opts.text,
    pushName: opts.pushName,
  });

  upsertConversationState({
    accountId: opts.accountId,
    phoneE164: phone,
    mode: step.mode,
    flowId: flow.id,
    nodeId: step.waitingFor ? step.nodeId : step.handoff ? null : step.nodeId,
    waitingFor: step.waitingFor,
    vars: step.vars,
    updatedAt: new Date().toISOString(),
  });

  return {
    replies: step.replies,
    handoff: step.handoff,
    handoffReason: step.handoffReason,
    suppressAppWebhook: false,
    vars: step.vars,
    mode: step.mode,
  };
}
