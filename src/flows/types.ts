/**
 * Modelo de fluxo visual + runtime.
 *
 * Nós: trigger | message | ask | condition | llm_intent | handoff | end
 */

export type FlowStatus = "draft" | "live";

export type FlowNodeType =
  | "trigger"
  | "message"
  | "ask"
  | "condition"
  | "llm_intent"
  | "handoff"
  | "end";

export type FlowNode = {
  id: string;
  type: FlowNodeType;
  x: number;
  y: number;
  data: Record<string, unknown>;
};

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  /** branch: true/false · intent slug · default */
  label?: string;
};

export type Flow = {
  id: string;
  name: string;
  product: string;
  /** null = todas as accounts do product */
  accountId: string | null;
  status: FlowStatus;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: string;
  updatedAt: string;
};

/** Estado por conversa (account + telefone). */
export type FlowConversationState = {
  accountId: string;
  phoneE164: string;
  mode: "bot" | "human";
  flowId: string | null;
  nodeId: string | null;
  /** aguardando resposta de um nó `ask` */
  waitingFor?: string | null;
  vars: Record<string, string>;
  updatedAt: string;
};

export type EngineResult = {
  /** respostas a enviar no WhatsApp (ordem) */
  replies: string[];
  /** true se passou para humano — app deve receber webhook */
  handoff: boolean;
  handoffReason?: string;
  /** se false, não reenvia a msg do user ao app como “bot handled” opcional */
  suppressAppWebhook?: boolean;
  vars: Record<string, string>;
  mode: "bot" | "human";
};
