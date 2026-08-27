import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { flowHistoryPath, flowStatesPath, flowsPath } from "../config.js";
import { flowModeOf, type Flow, type FlowConversationState, type FlowEdge, type FlowMode, type FlowNode } from "./types.js";
import { catalogFlows } from "./catalog.js";

type FlowsFile = { version: 1; flows: Flow[] };
type StatesFile = { version: 1; states: FlowConversationState[] };

/** Snapshot de um fluxo salvo em algum momento — permite "voltar no tempo". */
export type FlowVersion = {
  id: string;
  flowId: string;
  snapshot: Flow;
  savedAt: string;
};

type HistoryFile = { version: 1; entries: FlowVersion[] };

/** Máximo de snapshots guardados por fluxo (os mais antigos saem primeiro). */
const MAX_VERSIONS_PER_FLOW = 30;

/**
 * Garante os templates do catálogo em disco.
 *
 * Casa por `seedSlug` (não por nome — o usuário pode renomear) e só reescreve
 * nodes/edges quando o fluxo AINDA é o template original: `seedRevision` é
 * apagado no primeiro save feito pelo builder (ver saveFlow), então um fluxo
 * customizado nunca é sobrescrito. Sem isso, qualquer edição num demo era
 * perdida no boot seguinte.
 *
 * Migração: fluxos antigos (anteriores ao seedSlug) são reconhecidos pelo nome
 * exato do seed uma única vez e ganham o slug — a partir daí seguem a regra
 * nova. Como nunca tiveram seedRevision, são tratados como customizados, ou
 * seja: no pior caso mantemos o conteúdo que está lá, nunca destruímos.
 */
function ensureSeedTemplates(file: FlowsFile): boolean {
  let changed = false;
  for (const seed of catalogFlows()) {
    let existing = file.flows.find((f) => f.seedSlug && f.seedSlug === seed.seedSlug);
    if (!existing) {
      const legacy = file.flows.find((f) => !f.seedSlug && f.name === seed.name);
      if (legacy) {
        legacy.seedSlug = seed.seedSlug;
        changed = true;
        existing = legacy;
      }
    }

    if (!existing) {
      file.flows.push(seed);
      changed = true;
      continue;
    }

    // Customizado pelo usuário — não tocar.
    if (existing.seedRevision == null) continue;
    // Já está na revisão atual do catálogo — nada a fazer.
    if (existing.seedRevision === seed.seedRevision) continue;

    existing.nodes = seed.nodes;
    existing.edges = seed.edges;
    existing.product = seed.product;
    existing.seedRevision = seed.seedRevision;
    existing.updatedAt = new Date().toISOString();
    changed = true;
  }

  // Poda de seed que saiu do catálogo. Sem isso o catálogo reescrito em
  // 27/08 deixaria os 10 templates antigos pra sempre no disco, aparecendo
  // na lista do builder glabs — ensureSeedTemplates só sabia ADICIONAR.
  //
  // Deliberadamente conservador: só remove o que é REGENERÁVEL a partir do
  // código e comprovadamente nunca foi tocado por ninguém —
  //   • tem seedSlug (nasceu do catálogo)
  //   • o slug não existe mais no catálogo atual
  //   • seedRevision != null (o primeiro save pelo builder zera isso, então
  //     null significa "alguém editou" → é trabalho humano, não se apaga)
  //   • sem clientId (fluxo de cliente nunca é seed, e nunca se apaga)
  // Fluxo sem seedSlug fica intocado por definição: pode ser algo feito à
  // mão, e apagar dado alheio por heurística não vale o risco.
  const liveSlugs = new Set(catalogFlows().map((s) => s.seedSlug));
  const before = file.flows.length;
  file.flows = file.flows.filter(
    (f) => !(f.seedSlug && !liveSlugs.has(f.seedSlug) && f.seedRevision != null && !f.clientId)
  );
  if (file.flows.length !== before) {
    console.log(`[flows] podados ${before - file.flows.length} seed(s) que saíram do catálogo`);
    changed = true;
  }
  return changed;
}

function loadFlows(): FlowsFile {
  try {
    if (!existsSync(flowsPath())) {
      const file: FlowsFile = { version: 1, flows: catalogFlows() };
      saveFlows(file);
      return file;
    }
    const raw = readFileSync(flowsPath(), "utf8");
    const data = JSON.parse(raw) as FlowsFile;
    if (!data?.flows || !Array.isArray(data.flows)) {
      const file: FlowsFile = { version: 1, flows: catalogFlows() };
      saveFlows(file);
      return file;
    }
    if (ensureSeedTemplates(data)) saveFlows(data);
    return data;
  } catch {
    return { version: 1, flows: catalogFlows() };
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

function loadHistory(): HistoryFile {
  try {
    if (!existsSync(flowHistoryPath())) return { version: 1, entries: [] };
    const raw = readFileSync(flowHistoryPath(), "utf8");
    const data = JSON.parse(raw) as HistoryFile;
    if (!data?.entries || !Array.isArray(data.entries)) return { version: 1, entries: [] };
    return data;
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveHistory(file: HistoryFile): void {
  mkdirSync(dirname(flowHistoryPath()), { recursive: true });
  writeFileSync(flowHistoryPath(), JSON.stringify(file, null, 2), "utf8");
}

/** Guarda o estado ATUAL de um fluxo como uma versão do histórico (antes de sobrescrever). */
function snapshotFlowVersion(flow: Flow): void {
  const file = loadHistory();
  file.entries.push({
    id: randomUUID(),
    flowId: flow.id,
    snapshot: flow,
    savedAt: new Date().toISOString(),
  });
  const forFlow = file.entries.filter((e) => e.flowId === flow.id);
  if (forFlow.length > MAX_VERSIONS_PER_FLOW) {
    const excess = forFlow.length - MAX_VERSIONS_PER_FLOW;
    const oldestIds = new Set(
      forFlow
        .slice()
        .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
        .slice(0, excess)
        .map((e) => e.id)
    );
    file.entries = file.entries.filter((e) => !oldestIds.has(e.id));
  }
  saveHistory(file);
}

/** Lista as versões salvas de um fluxo, mais recente primeiro. */
export function listFlowVersions(flowId: string): FlowVersion[] {
  return loadHistory()
    .entries.filter((e) => e.flowId === flowId)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function getFlowVersion(versionId: string): FlowVersion | null {
  return loadHistory().entries.find((e) => e.id === versionId) ?? null;
}

/**
 * Restaura um snapshot antigo como versão atual do fluxo.
 * O estado atual (pré-restore) também vira uma versão no histórico — dá pra desfazer.
 */
export function restoreFlowVersion(flowId: string, versionId: string): Flow | null {
  const version = getFlowVersion(versionId);
  if (!version || version.flowId !== flowId) return null;
  // clientId e mode vêm do snapshot: enumerar campos aqui já fazia o restore
  // PERDER o clientId (o fluxo restaurado deixava de pertencer ao cliente e
  // sumia do portal dele). saveFlow recuperava via `existing?.clientId`, mas
  // por acidente, não por desenho — passar explicitamente deixa correto nos
  // dois caminhos e evita o mesmo com `mode`.
  return saveFlow({
    id: flowId,
    name: version.snapshot.name,
    product: version.snapshot.product,
    accountId: version.snapshot.accountId,
    clientId: version.snapshot.clientId,
    status: version.snapshot.status,
    nodes: version.snapshot.nodes,
    edges: version.snapshot.edges,
    mode: version.snapshot.mode,
  });
}

export function listFlows(filter?: {
  product?: string;
  accountId?: string | null;
  clientId?: string | null;
}): Flow[] {
  let flows = loadFlows().flows.slice();
  if (filter?.clientId) {
    flows = flows.filter(
      (f) =>
        f.clientId === filter.clientId ||
        (filter.product && f.product === filter.product && Boolean(f.clientId))
    );
  } else if (filter?.product) {
    flows = flows.filter((f) => f.product === filter.product);
  }
  if (filter?.accountId) {
    flows = flows.filter(
      (f) => !f.accountId || f.accountId === filter.accountId
    );
  }
  return flows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * O fluxo de um cliente num modo específico, se já existir.
 *
 * Existe pra que gerar/trocar de modo SUBSTITUA o fluxo daquele modo em vez
 * de criar mais um. Sem isso, cada alternância acumularia fluxos — que é
 * exatamente o bug do fluxo duplicado (PR #79) generalizado pra três modos.
 * Legado sem `mode` conta como "completo" (ver flowModeOf).
 */
export function findFlowByClientAndMode(clientId: string, mode: FlowMode): Flow | null {
  if (!clientId) return null;
  return (
    loadFlows()
      .flows.filter((f) => f.clientId === clientId && flowModeOf(f) === mode)
      // Mais recente primeiro: se por algum motivo houver mais de um, o
      // último editado é o que o dono considera "o daquele modo".
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
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
  clientId?: string | null;
  status?: "draft" | "live";
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Só o catálogo (templates.ts) preenche — ver ensureSeedTemplates. */
  seedSlug?: string;
  seedRevision?: number | null;
  /** Ver Flow.mode. Ausente num update preserva o modo já gravado. */
  mode?: FlowMode;
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

  const status = input.status ?? existing?.status ?? "draft";
  const flow: Flow = {
    id,
    name: input.name.trim() || "Sem nome",
    product: input.product.trim() || "gestor",
    accountId: input.accountId ?? existing?.accountId ?? null,
    clientId: input.clientId ?? existing?.clientId ?? null,
    status,
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    publishedAt:
      status === "live" ? now : status === "draft" ? existing?.publishedAt ?? null : existing?.publishedAt ?? null,
    seedSlug: input.seedSlug ?? existing?.seedSlug,
    mode: input.mode ?? existing?.mode,
    // Qualquer save que não venha do próprio catálogo marca o fluxo como
    // customizado (seedRevision = null) — é o que protege a edição do usuário
    // de ser sobrescrita por ensureSeedTemplates no próximo boot.
    seedRevision: input.seedRevision ?? null,
  };

  if (existing) {
    // Guarda como estava antes de sobrescrever — permite reverter depois.
    snapshotFlowVersion({ ...existing });
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

export function deleteFlowsForClient(clientId: string): number {
  const file = loadFlows();
  const before = file.flows.length;
  file.flows = file.flows.filter((f) => f.clientId !== clientId);
  const removed = before - file.flows.length;
  if (removed) saveFlows(file);
  return removed;
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
