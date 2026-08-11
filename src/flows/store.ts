import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { flowStatesPath, flowsPath } from "../config.js";
import type { Flow, FlowConversationState, FlowEdge, FlowNode } from "./types.js";
import { demoConsultationFlow } from "./templates.js";

type FlowsFile = { version: 1; flows: Flow[] };
type StatesFile = { version: 1; states: FlowConversationState[] };

function loadFlows(): FlowsFile {
  try {
    if (!existsSync(flowsPath())) {
      const seed = demoConsultationFlow();
      const file: FlowsFile = { version: 1, flows: [seed] };
      saveFlows(file);
      return file;
    }
    const raw = readFileSync(flowsPath(), "utf8");
    const data = JSON.parse(raw) as FlowsFile;
    if (!data?.flows || !Array.isArray(data.flows)) return { version: 1, flows: [] };
    return data;
  } catch {
    return { version: 1, flows: [] };
  }
}

function saveFlows(file: FlowsFile): void {
  mkdirSync(dirname(flowsPath()), { recursive: true });
  writeFileSync(flowsPath(), JSON.stringify(file, null, 2), "utf8");
}

function loadStates(): StatesFile {
  try {
    if (!existsSync(flowStatesPath())) return { version: 1, states: [] };
    const raw = readFileSync(flowStatesPath(), "utf8");
    const data = JSON.parse(raw) as StatesFile;
    if (!data?.states || !Array.isArray(data.states)) return { version: 1, states: [] };
    return data;
  } catch {
    return { version: 1, states: [] };
  }
}

function saveStates(file: StatesFile): void {
  mkdirSync(dirname(flowStatesPath()), { recursive: true });
  writeFileSync(flowStatesPath(), JSON.stringify(file, null, 2), "utf8");
}

export function listFlows(filter?: {
  product?: string;
  accountId?: string | null;
}): Flow[] {
  let flows = loadFlows().flows.slice();
  if (filter?.product) {
    flows = flows.filter((f) => f.product === filter.product);
  }
  if (filter?.accountId) {
    flows = flows.filter(
      (f) => !f.accountId || f.accountId === filter.accountId
    );
  }
  return flows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getFlow(id: string): Flow | null {
  return loadFlows().flows.find((f) => f.id === id) ?? null;
}

/** Fluxo live para account (prioriza account-specific, depois product-wide). */
export function findLiveFlow(opts: {
  product: string;
  accountId: string;
}): Flow | null {
  const all = listFlows({ product: opts.product }).filter((f) => f.status === "live");
  const specific = all.find((f) => f.accountId === opts.accountId);
  if (specific) return specific;
  return all.find((f) => !f.accountId) ?? null;
}

export function saveFlow(input: {
  id?: string;
  name: string;
  product: string;
  accountId?: string | null;
  status?: "draft" | "live";
  nodes: FlowNode[];
  edges: FlowEdge[];
}): Flow {
  const file = loadFlows();
  const now = new Date().toISOString();
  const id = input.id?.trim() || randomUUID();
  const existing = file.flows.find((f) => f.id === id);

  // Só um live por product+account scope
  if (input.status === "live") {
    const acc = input.accountId ?? null;
    for (const f of file.flows) {
      if (
        f.id !== id &&
        f.product === input.product &&
        (f.accountId ?? null) === acc &&
        f.status === "live"
      ) {
        f.status = "draft";
        f.updatedAt = now;
      }
    }
  }

  const flow: Flow = {
    id,
    name: input.name.trim() || "Sem nome",
    product: input.product.trim() || "gestor",
    accountId: input.accountId ?? null,
    status: input.status ?? existing?.status ?? "draft",
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    Object.assign(existing, flow);
  } else {
    file.flows.push(flow);
  }
  saveFlows(file);
  return flow;
}

export function deleteFlow(id: string): boolean {
  const file = loadFlows();
  const before = file.flows.length;
  file.flows = file.flows.filter((f) => f.id !== id);
  if (file.flows.length === before) return false;
  saveFlows(file);
  return true;
}

export function getConversationState(
  accountId: string,
  phoneE164: string
): FlowConversationState | null {
  const key = phoneE164.replace(/\D/g, "");
  return (
    loadStates().states.find(
      (s) => s.accountId === accountId && s.phoneE164.replace(/\D/g, "") === key
    ) ?? null
  );
}

export function upsertConversationState(
  state: FlowConversationState
): FlowConversationState {
  const file = loadStates();
  const key = state.phoneE164.replace(/\D/g, "");
  const idx = file.states.findIndex(
    (s) => s.accountId === state.accountId && s.phoneE164.replace(/\D/g, "") === key
  );
  const next = { ...state, phoneE164: key, updatedAt: new Date().toISOString() };
  if (idx >= 0) file.states[idx] = next;
  else file.states.push(next);
  // cap memory
  if (file.states.length > 5000) {
    file.states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    file.states = file.states.slice(0, 4000);
  }
  saveStates(file);
  return next;
}

export function setConversationHuman(
  accountId: string,
  phoneE164: string,
  reason?: string
): void {
  const prev = getConversationState(accountId, phoneE164);
  upsertConversationState({
    accountId,
    phoneE164,
    mode: "human",
    flowId: prev?.flowId ?? null,
    nodeId: null,
    waitingFor: null,
    vars: { ...(prev?.vars ?? {}), handoff_reason: reason || "handoff" },
    updatedAt: new Date().toISOString(),
  });
}

export function resetConversationToBot(
  accountId: string,
  phoneE164: string
): void {
  upsertConversationState({
    accountId,
    phoneE164,
    mode: "bot",
    flowId: null,
    nodeId: null,
    waitingFor: null,
    vars: {},
    updatedAt: new Date().toISOString(),
  });
}
