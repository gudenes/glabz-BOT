import type { Flow, FlowConversationState, FlowNode, EngineResult } from "./types.js";
import {
  findLiveFlow,
  getConversationState,
  getFlow,
  upsertConversationState,
} from "./store.js";
import { classifyIntent, extractDate } from "./llm.js";
import { runAction } from "./connectors/index.js";

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
      const intents = (
        Array.isArray(node.data.intents) ? node.data.intents : []
      ) as { slug: string; description: string }[];
      const result = await classifyIntent({
        text,
        intents,
        systemHint: String(node.data.prompt || ""),
      });
      lastIntent = result.intent;
      intentSource = result.source;
      vars.last_intent = result.intent;
      vars.intent_source = result.source;
      // Guarda o texto que originou essa classificação — permite reaproveitar
      // (ex.: cliente já mandou a dúvida junto, não precisa perguntar de novo).
      vars.pre_answer = text;
      trace.push({
        nodeId: node.id,
        type: "llm_intent",
        detail: `${result.intent} (${result.source})`,
      });
      node = nextNode(flow, node.id, result.intent);
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
