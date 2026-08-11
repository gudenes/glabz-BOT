import type { Flow, FlowConversationState, FlowNode, EngineResult } from "./types.js";
import {
  findLiveFlow,
  getConversationState,
  getFlow,
  upsertConversationState,
} from "./store.js";
import { classifyIntent } from "./llm.js";

function render(template: string, vars: Record<string, string>): string {
  return (template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    if (k === "name_greet") {
      const n = vars.nome || vars.name;
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
  }
  // unlabeled first edge
  const plain = edges.find((e) => !e.label) || edges[0];
  return flow.nodes.find((n) => n.id === plain.to) ?? null;
}

function triggerNode(flow: Flow): FlowNode | null {
  return flow.nodes.find((n) => n.type === "trigger") ?? flow.nodes[0] ?? null;
}

/**
 * Processa mensagem do usuário no fluxo live.
 * - Se mode=human → não intercepta (apps cuidam).
 * - Se waitingFor ask → grava var e avança.
 * - Caso contrário, inicia/continua o fluxo.
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

  // Já em handoff humano — não processa fluxo
  if (state.mode === "human") return null;

  const flow =
    (state.flowId && getFlow(state.flowId)) ||
    findLiveFlow({ product: opts.product, accountId: opts.accountId });

  if (!flow || flow.status !== "live") return null;

  const vars = { ...state.vars };
  if (opts.pushName && !vars.pushName) vars.pushName = opts.pushName;

  const replies: string[] = [];
  let handoff = false;
  let handoffReason: string | undefined;
  let node: FlowNode | null = null;

  // Continuação de ask
  if (state.waitingFor && state.nodeId) {
    const askNode = flow.nodes.find((n) => n.id === state.nodeId);
    if (askNode?.type === "ask") {
      const varName = String(askNode.data.varName || "answer");
      vars[varName] = opts.text.trim();
      node = nextNode(flow, askNode.id);
    } else {
      node = triggerNode(flow);
      if (node) node = nextNode(flow, node.id) || node;
    }
  } else if (!state.nodeId || !state.flowId) {
    // início
    node = triggerNode(flow);
    if (node?.type === "trigger") node = nextNode(flow, node.id);
  } else {
    // mensagem no meio (ex.: depois de end) — re-entra no intent se houver
    const intentNode = flow.nodes.find((n) => n.type === "llm_intent");
    if (intentNode) {
      node = intentNode;
    } else {
      node = triggerNode(flow);
      if (node) node = nextNode(flow, node.id);
    }
  }

  // Executa cadeia até ask/handoff/end ou limite
  let guard = 0;
  let waitingFor: string | null = null;
  let currentId: string | null = null;

  while (node && guard++ < 20) {
    currentId = node.id;

    if (node.type === "trigger") {
      node = nextNode(flow, node.id);
      continue;
    }

    if (node.type === "message") {
      const text = render(String(node.data.text || ""), vars);
      if (text.trim()) replies.push(text);
      node = nextNode(flow, node.id);
      continue;
    }

    if (node.type === "ask") {
      const prompt = render(String(node.data.prompt || "Pode me dizer?"), vars);
      replies.push(prompt);
      waitingFor = String(node.data.varName || "answer");
      break; // espera próxima msg
    }

    if (node.type === "condition") {
      const field = String(node.data.field || "last");
      const op = String(node.data.op || "contains");
      const value = String(node.data.value || "").toLowerCase();
      const hay = (
        field === "last" ? opts.text : vars[field] || ""
      ).toLowerCase();
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
      node = nextNode(flow, node.id, ok ? "true" : "false");
      continue;
    }

    if (node.type === "llm_intent") {
      const intents = (Array.isArray(node.data.intents) ? node.data.intents : []) as {
        slug: string;
        description: string;
      }[];
      const result = await classifyIntent({
        text: opts.text,
        intents,
        systemHint: String(node.data.prompt || ""),
      });
      vars.last_intent = result.intent;
      vars.intent_source = result.source;
      node = nextNode(flow, node.id, result.intent);
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
      if (msg.trim()) replies.push(msg);
      handoff = true;
      handoffReason = String(node.data.reason || "handoff");
      break;
    }

    if (node.type === "end") {
      // volta a aceitar nova intenção na próxima msg
      currentId = null;
      waitingFor = null;
      break;
    }

    // tipo desconhecido
    node = nextNode(flow, node.id);
  }

  const mode = handoff ? "human" : "bot";
  upsertConversationState({
    accountId: opts.accountId,
    phoneE164: phone,
    mode,
    flowId: flow.id,
    nodeId: waitingFor ? currentId : handoff ? null : currentId,
    waitingFor,
    vars,
    updatedAt: new Date().toISOString(),
  });

  return {
    replies,
    handoff,
    handoffReason,
    // Enquanto o bot conduz o fluxo, ainda podemos espelhar no app;
    // no handoff sempre mandamos webhook com a última msg do user.
    suppressAppWebhook: false,
    vars,
    mode,
  };
}
