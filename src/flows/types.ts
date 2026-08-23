/**
 * Modelo de fluxo visual + runtime.
 *
 * Nós: trigger | message | ask | condition | llm_intent | llm_extract | action | handoff | end
 */

export type FlowStatus = "draft" | "live";

export type FlowNodeType =
  | "trigger"
  | "message"
  | "ask"
  | "condition"
  | "llm_intent"
  | "llm_extract"
  | "action"
  | "handoff"
  | "end";

/** Connectors suportados no nó `action`. */
export type ActionConnector = "calendar" | "http";

/** Ops do connector calendar. */
export type CalendarOperation = "list_slots" | "create_event" | "cancel_event";

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
  /** cliente do portal (postgres); opcional nos seeds */
  clientId?: string | null;
  status: FlowStatus;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
  /**
   * Identifica um fluxo que nasceu de um template de demo do catálogo
   * (ver templates.ts). Usado pra localizar o seed no disco sem depender do
   * nome, que o usuário pode renomear.
   */
  seedSlug?: string;
  /**
   * Revisão do template de origem. Só é mantida enquanto o fluxo continua
   * idêntico ao catálogo: assim que o usuário salva uma edição pelo builder,
   * some (ver saveFlow), e o fluxo passa a ser tratado como customizado —
   * é isso que impede o boot seguinte de sobrescrever o trabalho dele.
   */
  seedRevision?: number | null;
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
