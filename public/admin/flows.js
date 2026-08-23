/**
 * Glabs Bot · Workflow Builder (visual)
 */
import { typeIcon } from "./icons.js";
import { applyStaticTranslations, mountLangToggle, t } from "./i18n.js";
import { unknownVarsIn, varsAvailableAt } from "./vars.js";

applyStaticTranslations();
document.getElementById("lang-toggle-slot-login") &&
  mountLangToggle(document.getElementById("lang-toggle-slot-login"));
document.getElementById("lang-toggle-slot-header") &&
  mountLangToggle(document.getElementById("lang-toggle-slot-header"));

const STORAGE_KEY = "glabs_bot_secret";
const qs = new URLSearchParams(location.search);
const EMBED = qs.has("embed");
const URL_CLIENT = qs.get("client") || "";
if (EMBED) document.body.classList.add("portal-embed");

const state = {
  secret: localStorage.getItem(STORAGE_KEY) || "",
  flows: [],
  flow: null,
  products: [], // [{slug, name, ...}] — carregado do servidor
  selectedNodeId: null,
  linkFrom: null,
  drag: null,
  llmConfigured: false,
  /** JSON do fluxo como veio do servidor — compara com o atual p/ saber se há edição pendente. */
  savedSnapshot: null,
  /** Simulador */
  simOpen: false,
  simState: null, // { nodeId, waitingFor, vars, mode, finished }
  simActiveNodeId: null,
  simVisitedIds: [],
  simBusy: false,
  /** Histórico de versões */
  historyOpen: false,
  historyVersions: [],
};

const $ = (id) => document.getElementById(id);
const toastEl = $("toast");

function toast(msg, kind = "ok") {
  toastEl.textContent = msg;
  toastEl.className = `fb-toast ${kind}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 2800);
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("accept", "application/json");
  if (state.secret) headers.set("authorization", `Bearer ${state.secret}`);
  const clientId = URL_CLIENT || sessionStorage.getItem("glabs_client_id");
  if (clientId) headers.set("x-client-id", clientId);
  if (opts.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...opts, headers, cache: "no-store", credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!res.ok) throw new Error(data.reason || `HTTP ${res.status}`);
  return data;
}

function uid(prefix = "n") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function defaultData(type) {
  switch (type) {
    case "trigger":
      return { label: "Mensagem recebida" };
    case "message":
      return { text: "Olá! Como posso ajudar?" };
    case "ask":
      return { prompt: "Pode me dizer?", varName: "resposta" };
    case "llm_intent":
      return {
        label: "Capturar intenção",
        prompt: "Classifique a intenção. Responda só o slug.",
        intents: [
          { slug: "marcar_consulta", description: "agendar, consulta, horário" },
          { slug: "falar_humano", description: "atendente, humano, pessoa" },
          { slug: "outro", description: "outra dúvida" },
        ],
      };
    case "llm_extract":
      return {
        label: "Extrair data",
        prompt: "Data que o cliente prefere pra marcar o horário.",
        varName: "data_confirmada",
      };
    case "llm_answer":
      return {
        label: "Responder com IA",
        context:
          "Escreva aqui o que a IA precisa saber pra responder: horários, preços, endereço, o que você faz e o que não faz.",
        varName: "resposta_ia",
        maxChars: 400,
      };
    case "condition":
      return { field: "last", op: "contains", value: "sim" };
    case "action":
      return {
        label: "Listar horários livres",
        connector: "calendar",
        operation: "list_slots",
        config: { forceMock: true },
      };
    case "handoff":
      return {
        reason: "handoff",
        message: "Vou te passar para um atendente humano.",
      };
    case "end":
      return { label: "Fim" };
    default:
      return {};
  }
}

/** Preview legível no cartão (sem {{vars}} crus). */
function prettyPreview(text) {
  return String(text || "")
    .replace(/\{\{\s*name_greet\s*\}\}/g, "")
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => `[${k}]`)
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function nodeTitle(node) {
  const d = node.data || {};
  if (node.type === "message") return prettyPreview(d.text || "Mensagem") || "Mensagem";
  if (node.type === "ask") return prettyPreview(d.prompt || "Pergunta") || "Pergunta";
  if (node.type === "llm_intent") return d.label || "Entender intenção";
  if (node.type === "llm_extract") return d.label || "Extrair data";
  if (node.type === "llm_answer") return d.label || "Responder com IA";
  if (node.type === "condition")
    return `${d.field || "texto"} ${d.op || "contém"} “${d.value || ""}”`;
  if (node.type === "action") {
    return (
      d.label ||
      (d.connector === "http"
        ? "HTTP"
        : d.operation === "create_event"
          ? "Criar evento"
          : d.operation === "list_slots"
            ? "Listar horários"
            : "Ação")
    );
  }
  if (node.type === "handoff") return "Passar para atendente";
  if (node.type === "end") return d.label || "Fim";
  if (node.type === "trigger") return d.label || "Início";
  return node.type;
}

const NODE_W = 220;
const NODE_H_FALLBACK = 100;

function nodeHeight(node, heightMap) {
  if (heightMap && heightMap.has(node.id)) return heightMap.get(node.id);
  return NODE_H_FALLBACK;
}

/**
 * Ligação ortogonal conectada de cartão → cartão.
 * Cantos levemente arredondados (não é “flecha solta”).
 */
function routeEdge(a, b, opts = {}) {
  const { exitIndex = 0, exitCount = 1, rank = 0, heightMap } = opts;
  const aH = nodeHeight(a, heightMap);
  const pad = 32;
  const spread =
    exitCount > 1 ? Math.min(NODE_W - pad * 2, (exitCount - 1) * 48) : 0;
  const x1 =
    a.x +
    NODE_W / 2 -
    spread / 2 +
    (exitCount > 1 ? exitIndex * (spread / (exitCount - 1)) : 0);
  // sai um pouco abaixo do cartão (porta de saída)
  const y1 = a.y + aH + 2;
  const x2 = b.x + NODE_W / 2;
  // entra no topo do cartão destino
  const y2 = b.y - 2;
  const dx = x2 - x1;

  // Mesma coluna → reta
  if (Math.abs(dx) < 20) {
    const yEnd = Math.max(y2, y1 + 8);
    return {
      d: `M ${x1} ${y1} L ${x2} ${yEnd}`,
      label: { x: x1 + 12, y: (y1 + yEnd) / 2 },
    };
  }

  // Faixa horizontal escalonada entre pai e filho
  const room = Math.max(0, y2 - y1);
  const base = 18 + rank * 14;
  let midY = y1 + Math.min(base, Math.max(16, room * 0.45));
  if (room > 24) {
    midY = Math.min(midY, y2 - 12);
    midY = Math.max(midY, y1 + 12);
  } else {
    // pouco espaço: sai, desce um pouco mesmo assim
    midY = y1 + 16 + rank * 10;
  }

  const r = 8; // raio do canto
  // path com cantos arredondados (continua conectado ponta a ponta)
  const dir = x2 >= x1 ? 1 : -1;
  const d = [
    `M ${x1} ${y1}`,
    `L ${x1} ${midY - r}`,
    `Q ${x1} ${midY} ${x1 + dir * r} ${midY}`,
    `L ${x2 - dir * r} ${midY}`,
    `Q ${x2} ${midY} ${x2} ${midY + r}`,
    `L ${x2} ${y2}`,
  ].join(" ");

  return {
    d,
    label: { x: (x1 + x2) / 2, y: midY - 10 },
  };
}

function friendlyEdgeLabel(label) {
  const map = {
    marcar_sessao: "agendar",
    tirar_duvida: "dúvida",
    atendimento_admin: "admin",
    marcar_consulta: "agendar",
    falar_humano: "humano",
    outro: "outro",
    default: "não entendeu",
    true: "sim",
    false: "não",
    ok: "ok",
    erro: "erro",
    ambiguous: "ambíguo",
    unclear: "não entendi",
  };
  return map[label] || label;
}

function typeLabel(type) {
  return (
    {
      trigger: t("builder.step.trigger"),
      message: t("builder.step.message"),
      ask: t("builder.step.ask"),
      llm_intent: t("builder.step.intent"),
      llm_extract: t("builder.step.extract"),
      llm_answer: t("builder.step.answer"),
      condition: t("builder.step.condition"),
      action: t("builder.step.action"),
      handoff: t("builder.step.handoff"),
      end: t("builder.step.end"),
    }[type] || type
  );
}

function statusLabel(status) {
  return status === "live" ? t("builder.status.live") : t("builder.status.draft");
}

// ── Login ────────────────────────────────────────────────
function showBuilder() {
  $("login-gate").classList.add("hidden");
  $("builder-app").classList.remove("hidden");
}

function showLogin(err) {
  $("login-gate").classList.remove("hidden");
  $("builder-app").classList.add("hidden");
  if (err) {
    $("login-error").textContent = err;
    $("login-error").classList.remove("hidden");
  }
}

$("login-btn").onclick = async () => {
  const s = $("login-secret").value.trim();
  if (!s) return;
  state.secret = s;
  localStorage.setItem(STORAGE_KEY, s);
  try {
    await loadAll();
    showBuilder();
  } catch (e) {
    showLogin(e.message === "unauthorized" ? t("builder.login.invalidSecret") : e.message);
  }
};

if (state.secret) {
  loadAll()
    .then(showBuilder)
    .catch(() => showLogin());
} else {
  fetch("/v1/auth/me", { credentials: "include", cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(() => loadAll().then(showBuilder))
    .catch((e) => {
      if (new URLSearchParams(location.search).has("embed")) {
        showBuilder();
        toast(e.message || t("builder.toast.flowOpenFailed"), "err");
      } else {
        showLogin();
      }
    });
}

// ── Data ─────────────────────────────────────────────────
async function loadAll() {
  const [flowsData, productsData] = await Promise.all([
    api("/v1/flows"),
    api("/v1/products").catch(() => ({ products: [] })),
    loadConnectorCatalog(),
  ]);
  state.flows = flowsData.flows || [];
  state.products = productsData.products || [];
  if (URL_CLIENT || sessionStorage.getItem("glabs_client_id")) {
    const cid = URL_CLIENT || sessionStorage.getItem("glabs_client_id");
    state.flows = state.flows.filter((f) => f.clientId === cid);
  }
  state.llmConfigured = Boolean(flowsData.llmConfigured);
  $("llm-badge").textContent = state.llmConfigured
    ? "IA ligada"
    : "IA · palavras-chave";
  $("llm-badge").className = state.llmConfigured
    ? "fb-meta-chip on"
    : "fb-meta-chip";

  renderProductSelect();
  loadVersionBadge();
  if (EMBED) {
    document.querySelector(".fb-icon-btn")?.classList.add("hidden");
    $("build-badge")?.classList.add("hidden");
    $("flow-product")?.closest(".fb-select-wrap")?.classList.add("hidden");
  }

  if (!state.flow && state.flows.length) {
    selectFlow(state.flows[0].id);
  } else if (!state.flow) {
    if (EMBED) {
      window.parent.postMessage({ type: "glabs-flows-changed" }, "*");
      return;
    }
    newBlankFlow();
  } else {
    const fresh = state.flows.find((f) => f.id === state.flow.id);
    if (fresh) {
      state.flow = structuredClone(fresh);
      markSaved();
    }
    renderAll();
  }
}

/** Popula o <select> de produto com o que existe hoje no servidor (sem hardcode). */
function renderProductSelect() {
  const sel = $("flow-product");
  const current = state.flow?.product || sel.value;
  sel.innerHTML = state.products
    .map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.name || p.slug)}</option>`)
    .join("");
  // se o fluxo atual usa um product que não está (mais) na lista, adiciona mesmo assim
  if (current && !state.products.some((p) => p.slug === current)) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = t("builder.products.notRegistered", { slug: current });
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

function productLabel(slug) {
  const p = state.products.find((x) => x.slug === slug);
  return p?.name || slug;
}

/** Busca o commit/branch do backend rodando e mostra no cabeçalho. */
async function loadVersionBadge() {
  const badge = $("build-badge");
  try {
    const v = await api("/v1/version");
    const when = v.bootAt ? timeAgo(v.bootAt) : null;
    if (v.commitShort) {
      badge.textContent = `${v.branch || "?"} · ${v.commitShort}${when ? ` · há ${when}` : ""}`;
      badge.title = v.message || "";
    } else {
      badge.textContent = `build · ${v.env || "local"}${when ? ` · há ${when}` : ""}`;
      badge.title = "Sem info de git (dev local)";
    }
  } catch {
    badge.textContent = "build · —";
  }
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return "instantes";
  if (min < 60) return `${min}min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function selectFlow(id) {
  const f = state.flows.find((x) => x.id === id);
  if (!f) return;
  state.flow = structuredClone(f);
  state.selectedNodeId = null;
  state.linkFrom = null;
  // troca de fluxo = simulação limpa
  state.simState = null;
  state.simActiveNodeId = null;
  if (state.simOpen) resetSim();
  markSaved();
  renderAll();
}

function newBlankFlow() {
  state.flow = {
    id: "",
    name: t("builder.newFlow.defaultName"),
    product: state.flows[0]?.product || $("flow-product")?.value || "gestor",
    accountId: state.flows[0]?.accountId || null,
    clientId: URL_CLIENT || sessionStorage.getItem("glabs_client_id") || state.flows[0]?.clientId || null,
    status: "draft",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger",
        x: 80,
        y: 60,
        data: defaultData("trigger"),
      },
    ],
    edges: [],
  };
  state.selectedNodeId = null;
  state.simState = null;
  state.simActiveNodeId = null;
  if (state.simOpen) resetSim();
  state.savedSnapshot = null; // novo — nada salvo ainda
  renderAll();
}

// ── Estado salvo/não salvo ──────────────────────────────
function flowFingerprint(flow) {
  if (!flow) return null;
  return JSON.stringify({
    name: flow.name,
    product: flow.product,
    status: flow.status,
    nodes: flow.nodes,
    edges: flow.edges,
  });
}

/** Chamar depois de carregar/salvar do servidor: fixa o "ponto salvo" atual. */
function markSaved() {
  state.savedSnapshot = flowFingerprint(state.flow);
  updateSaveBadge();
}

function isDirty() {
  if (!state.flow) return false;
  if (state.savedSnapshot == null) return false; // fluxo novo, ainda sem save — não assusta o usuário
  return flowFingerprint(state.flow) !== state.savedSnapshot;
}

function updateSaveBadge() {
  const el = $("save-state");
  const text = $("save-text");
  if (!el || !text) return;
  if (!state.flow) {
    el.className = "fb-save-state";
    text.textContent = "—";
    return;
  }
  if (!state.flow.id) {
    el.className = "fb-save-state";
    text.textContent = t("builder.saveState.new");
    return;
  }
  if (isDirty()) {
    el.className = "fb-save-state dirty";
    text.textContent = t("builder.saveState.dirty");
  } else {
    el.className = "fb-save-state saved";
    const when = state.flow.updatedAt ? formatDateTime(state.flow.updatedAt) : "";
    text.textContent = when ? t("builder.saveState.saved", { when }) : t("builder.toast.saved");
  }
}

function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    return "";
  }
}

function renderAll() {
  renderList();
  renderCanvas();
  renderProps();
  if (state.flow) {
    $("flow-name").value = state.flow.name;
    fitFlowName();
    renderProductSelect();
    $("flow-status").textContent = statusLabel(state.flow.status || "draft");
    $("flow-status").className =
      "fb-status " + (state.flow.status === "live" ? "live" : "draft");
  }
  updateSaveBadge();
}

function renderList() {
  const el = $("flow-list");
  el.innerHTML = "";
  for (const f of state.flows) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "flow-card" + (state.flow?.id === f.id ? " active" : "");
    b.innerHTML = `<div class="n"></div><div class="m"></div>`;
    b.querySelector(".n").textContent = f.name;
    b.querySelector(".m").textContent = `${productLabel(f.product)} · ${statusLabel(f.status)}`;
    b.onclick = () => selectFlow(f.id);
    el.appendChild(b);
  }
  if (!state.flows.length) {
    el.innerHTML = `<p class="fb-palette-hint" style="margin:8px 4px">Nenhum fluxo ainda. O demo “Marcar consulta” aparece no primeiro uso.</p>`;
  }
}

function renderCanvas() {
  const canvas = $("canvas");
  let svg = $("edges-svg");
  if (!canvas) return;

  // remove nós/menus; mantém o SVG no mesmo sistema de coordenadas do canvas
  canvas.querySelectorAll(".fb-node, .node-add-menu").forEach((el) => el.remove());
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "edges-svg";
    svg.classList.add("fb-edges");
    svg.setAttribute("aria-hidden", "true");
    canvas.prepend(svg);
  }
  svg.innerHTML = "";
  if (!state.flow) return;

  const ns = "http://www.w3.org/2000/svg";
  const nodeIds = new Set(state.flow.nodes.map((n) => n.id));
  state.flow.edges = state.flow.edges.filter(
    (e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to
  );

  closeAddMenu();

  // 1) nós
  for (const n of state.flow.nodes) {
    const el = document.createElement("div");
    el.className =
      "fb-node type-" +
      n.type +
      (state.selectedNodeId === n.id ? " selected" : "") +
      (state.linkFrom === n.id ? " link-from" : "") +
      (state.simActiveNodeId === n.id ? " sim-active" : "") +
      (state.simVisitedIds?.includes(n.id) && state.simActiveNodeId !== n.id ? " sim-visited" : "");
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.dataset.id = n.id;
    el.innerHTML = `<div class="k"></div><div class="b"></div><span class="port-in" aria-hidden="true"></span><span class="port-out" aria-hidden="true"></span>`;
    el.querySelector(".k").innerHTML = `${typeIcon(n.type, 12)}<span>${typeLabel(n.type)}</span>`;
    el.querySelector(".b").textContent = nodeTitle(n);

    if (n.type !== "end") {
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "node-plus";
      plus.title = t("builder.addNextStep");
      plus.setAttribute("aria-label", t("builder.addNextStep"));
      plus.textContent = "+";
      plus.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      plus.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openAddMenu(n, plus);
      });
      el.appendChild(plus);
    }

    el.addEventListener("mousedown", (ev) => {
      if (ev.target.closest(".node-plus")) return;
      onNodeDown(ev, n);
    });
    el.addEventListener("click", (ev) => {
      if (ev.target.closest(".node-plus")) return;
      onNodeClick(ev, n);
    });
    canvas.appendChild(el);
  }

  // 2) alturas reais
  const heightMap = new Map();
  for (const n of state.flow.nodes) {
    const el = canvas.querySelector(`.fb-node[data-id="${n.id}"]`);
    if (el) heightMap.set(n.id, el.offsetHeight || NODE_H_FALLBACK);
  }

  // 3) fan-out por origem
  const byFrom = new Map();
  for (const e of state.flow.edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }
  for (const [, list] of byFrom) {
    list.sort((e1, e2) => {
      const n1 = state.flow.nodes.find((n) => n.id === e1.to);
      const n2 = state.flow.nodes.find((n) => n.id === e2.to);
      return (n1?.x ?? 0) - (n2?.x ?? 0);
    });
  }

  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="userSpaceOnUse">
      <circle cx="5" cy="5" r="3.2" fill="rgba(165,180,252,0.95)" />
    </marker>
    <marker id="arrowhead-hot" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="userSpaceOnUse">
      <circle cx="5" cy="5" r="3.4" fill="rgba(99,102,241,1)" />
    </marker>`;
  svg.appendChild(defs);

  // 4) edges conectadas
  for (const e of state.flow.edges) {
    const a = state.flow.nodes.find((n) => n.id === e.from);
    const b = state.flow.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const siblings = byFrom.get(e.from) || [e];
    const exitIndex = siblings.indexOf(e);
    const exitCount = siblings.length;
    let rank = exitIndex;
    if (e.label === "default" || e.label === "outro") rank = exitCount;
    const routed = routeEdge(a, b, { exitIndex, exitCount, rank, heightMap });

    const isHot =
      state.simActiveNodeId &&
      (e.to === state.simActiveNodeId || e.from === state.simActiveNodeId);

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", routed.d);
    path.setAttribute(
      "class",
      "edge-path" + (e.label ? " labeled" : "") + (isHot ? " sim-hot" : "")
    );
    path.dataset.edgeId = e.id;
    path.setAttribute(
      "marker-end",
      isHot ? "url(#arrowhead-hot)" : "url(#arrowhead)"
    );
    svg.appendChild(path);

    if (e.label) {
      const pos = routed.label;
      const label = friendlyEdgeLabel(e.label);
      const tw = Math.max(52, label.length * 6.6 + 16);
      const bg = document.createElementNS(ns, "rect");
      bg.setAttribute("x", pos.x - tw / 2);
      bg.setAttribute("y", pos.y - 11);
      bg.setAttribute("width", tw);
      bg.setAttribute("height", 18);
      bg.setAttribute("rx", 9);
      bg.setAttribute("class", "edge-label-bg");
      svg.appendChild(bg);
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", pos.x);
      t.setAttribute("y", pos.y + 3);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "edge-label");
      t.textContent = label;
      svg.appendChild(t);
    }
  }

  let maxX = 1200;
  let maxY = 900;
  for (const n of state.flow.nodes) {
    maxX = Math.max(maxX, n.x + NODE_W + 120);
    maxY = Math.max(maxY, n.y + (heightMap.get(n.id) || NODE_H_FALLBACK) + 140);
  }
  // width/height em atributos = sistema de coordenadas 1:1 (sem escala CSS)
  svg.setAttribute("width", String(maxX));
  svg.setAttribute("height", String(maxY));
  svg.style.width = maxX + "px";
  svg.style.height = maxY + "px";
  canvas.style.width = maxX + "px";
  canvas.style.height = maxY + "px";
  updateSaveBadge();
}

const ADDABLE_TYPES = [
  { type: "message", label: t("builder.step.message"), ic: "msg" },
  { type: "ask", label: t("builder.step.ask"), ic: "ask" },
  { type: "llm_intent", label: t("builder.step.intent"), ic: "llm" },
  { type: "llm_extract", label: t("builder.step.extract"), ic: "extract" },
  { type: "llm_answer", label: t("builder.step.answer"), ic: "answer" },
  { type: "action", label: t("builder.step.action"), ic: "act" },
  { type: "condition", label: t("builder.step.condition"), ic: "cond" },
  { type: "handoff", label: t("builder.step.handoff"), ic: "hand" },
  { type: "end", label: t("builder.step.end"), ic: "end" },
];

function closeAddMenu() {
  document.querySelectorAll(".node-add-menu").forEach((m) => m.remove());
}

function openAddMenu(parentNode, anchorBtn) {
  closeAddMenu();
  const canvas = $("canvas");
  const menu = document.createElement("div");
  menu.className = "node-add-menu";
  menu.innerHTML = `<div class="m-title">${t("builder.nextStep")}</div>`;

  for (const item of ADDABLE_TYPES) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="pal-icon ${item.ic}">${typeIcon(item.type, 14)}</span>${item.label}`;
    b.onclick = (ev) => {
      ev.stopPropagation();
      addChildNode(parentNode, item.type);
      closeAddMenu();
    };
    menu.appendChild(b);
  }

  // posiciona sob o botão +
  const left = parentNode.x + 100 - 90;
  const top = parentNode.y + 78;
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = top + "px";
  canvas.appendChild(menu);

  // fecha ao clicar fora
  const closer = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorBtn) {
      closeAddMenu();
      document.removeEventListener("mousedown", closer, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer, true), 0);
}

/** Cria nó filho já ligado ao pai (abaixo, levemente deslocado se já houver filhos). */
function addChildNode(parentNode, type) {
  if (!state.flow) return;
  const siblings = state.flow.edges.filter((e) => e.from === parentNode.id).length;
  const child = {
    id: uid("n"),
    type,
    x: parentNode.x + siblings * 40,
    y: parentNode.y + 130,
    data: defaultData(type),
  };
  state.flow.nodes.push(child);

  let edgeLabel;
  if (parentNode.type === "llm_intent") {
    edgeLabel =
      prompt(
        t("builder.prompt.intentLabel"),
        siblings === 0 ? "marcar_consulta" : "default"
      )?.trim() || "default";
  } else if (parentNode.type === "condition") {
    edgeLabel = siblings === 0 ? "true" : "false";
  } else if (parentNode.type === "action") {
    edgeLabel = siblings === 0 ? "ok" : "erro";
  } else if (parentNode.type === "llm_extract") {
    edgeLabel = ["ok", "ambiguous", "unclear"][siblings] || "ok";
  } else if (parentNode.type === "llm_answer") {
    edgeLabel = siblings === 0 ? "ok" : "erro";
  }

  state.flow.edges.push({
    id: uid("e"),
    from: parentNode.id,
    to: child.id,
    label: edgeLabel,
  });

  state.selectedNodeId = child.id;
  state.linkFrom = null;
  renderCanvas();
  renderProps();
  toast(t("builder.toast.stepAdded"));
}

function onNodeDown(ev, node) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const startX = ev.clientX;
  const startY = ev.clientY;
  const origX = node.x;
  const origY = node.y;
  state.drag = { id: node.id, startX, startY, origX, origY, moved: false };

  const move = (e) => {
    if (!state.drag || state.drag.id !== node.id) return;
    const dx = e.clientX - state.drag.startX;
    const dy = e.clientY - state.drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
    node.x = Math.max(0, state.drag.origX + dx);
    node.y = Math.max(0, state.drag.origY + dy);
    const el = document.querySelector(`.fb-node[data-id="${node.id}"]`);
    if (el) {
      el.style.left = node.x + "px";
      el.style.top = node.y + "px";
    }
    // cheap re-edge
    renderCanvas();
    // re-select after re-render
    state.selectedNodeId = node.id;
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    state.drag = null;
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function onNodeClick(ev, node) {
  if (state.drag?.moved) return;
  if (ev.shiftKey && state.linkFrom && state.linkFrom !== node.id) {
    // remove edge between
    state.flow.edges = state.flow.edges.filter(
      (e) =>
        !(
          (e.from === state.linkFrom && e.to === node.id) ||
          (e.from === node.id && e.to === state.linkFrom)
        )
    );
    state.linkFrom = null;
    renderCanvas();
    return;
  }
  if (state.linkFrom && state.linkFrom !== node.id) {
    const label = prompt(t("builder.prompt.edgeLabel"), "");
    state.flow.edges.push({
      id: uid("e"),
      from: state.linkFrom,
      to: node.id,
      label: label?.trim() || undefined,
    });
    state.linkFrom = null;
    state.selectedNodeId = node.id;
    renderCanvas();
    renderProps();
    toast(t("builder.toast.linkCreated"));
    return;
  }
  if (state.linkFrom === node.id) {
    state.linkFrom = null;
    toast(t("builder.toast.linkCanceled"));
    return;
  }
  // start link mode on double-click? use button in props
  state.selectedNodeId = node.id;
  renderCanvas();
  renderProps();
}

/** Remove um nó (e as ligações dele) — usado pelo botão "Remover" e pelo atalho Delete/Backspace. */
function deleteNode(node) {
  if (!node || !state.flow) return;
  if (node.type === "trigger") {
    toast(t("builder.toast.triggerCantDelete"), "err");
    return;
  }
  state.flow.nodes = state.flow.nodes.filter((n) => n.id !== node.id);
  state.flow.edges = state.flow.edges.filter(
    (e) => e.from !== node.id && e.to !== node.id
  );
  state.selectedNodeId = null;
  renderAll();
  toast("Passo removido");
}

/** Último nó cujo conteúdo já foi mostrado no painel Detalhes (evita pulsar de novo à toa). */
let lastSeenPropsNodeId = null;

/**
 * Painel "variáveis disponíveis aqui" — a lista real do que existe naquele
 * ponto do fluxo, clicável pra inserir no texto. Antes o usuário precisava
 * decorar/adivinhar os nomes; era o ponto onde um fluxo saía quebrado sem
 * nenhum aviso (mensagem indo com "{{slots_text}}" cru pro cliente final).
 */
function renderVarsPanel(node) {
  if (!node || node.type === "trigger" || node.type === "end") return "";
  const vars = varsAvailableAt(state.flow, node.id);
  const unknown = unknownVarsIn(state.flow, node);

  const warn = unknown.length
    ? `<p class="fb-vars-warn">⚠ ${unknown.map((v) => `<code>{{${escapeHtml(v)}}}</code>`).join(", ")}
       ${unknown.length > 1 ? "não existem" : "não existe"} neste ponto do fluxo — vai aparecer sem preencher pro cliente.</p>`
    : "";

  const chips = vars
    .map(
      (v) => `<button type="button" class="fb-var" data-var="${escapeHtml(v.name)}"
        title="${escapeHtml(v.hint)} · vem de: ${escapeHtml(v.from)}">{{${escapeHtml(v.name)}}}</button>`
    )
    .join("");

  return `
    <details class="fb-vars" ${unknown.length ? "open" : ""}>
      <summary>Variáveis disponíveis aqui <span class="fb-vars-n">${vars.length}</span></summary>
      ${warn}
      <div class="fb-vars-list">${chips}</div>
      <p class="fb-hint">Clique para inserir no campo de texto. Passe o mouse para ver o que cada uma guarda.</p>
    </details>`;
}

/** Insere {{var}} no último campo de texto focado (ou no primeiro do painel). */
function wireVarPanel(node) {
  const body = $("props-body");
  if (!body) return;

  const textFields = () =>
    [...body.querySelectorAll("textarea, input[type=text], input:not([type])")].filter(
      (el) => !el.disabled && el.id !== "p-var" && el.id !== "p-field"
    );

  let lastFocused = null;
  for (const el of textFields()) {
    el.addEventListener("focus", () => {
      lastFocused = el;
    });
    attachVarAutocomplete(el, node);
  }

  body.querySelectorAll(".fb-var").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = lastFocused || textFields()[0];
      if (!target) return;
      const token = `{{${btn.dataset.var}}}`;
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.value = target.value.slice(0, start) + token + target.value.slice(end);
      const pos = start + token.length;
      target.focus();
      target.setSelectionRange(pos, pos);
    });
  });
}

/**
 * Autocomplete ao digitar "{{" — atalho pra quem já conhece os nomes, sem
 * precisar tirar a mão do teclado.
 */
function attachVarAutocomplete(el, node) {
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
  };

  el.addEventListener("blur", () => setTimeout(close, 150));
  el.addEventListener("input", () => {
    const upto = el.value.slice(0, el.selectionStart ?? 0);
    const m = upto.match(/\{\{\s*([\w.]*)$/);
    close();
    if (!m) return;

    const term = (m[1] || "").toLowerCase();
    const matches = varsAvailableAt(state.flow, node.id).filter((v) =>
      v.name.toLowerCase().includes(term)
    );
    if (!matches.length) return;

    menu = document.createElement("div");
    menu.className = "fb-var-menu";
    menu.innerHTML = matches
      .map(
        (v) => `<button type="button" data-var="${escapeHtml(v.name)}">
          <b>${escapeHtml(v.name)}</b><small>${escapeHtml(v.hint)}</small></button>`
      )
      .join("");
    el.parentElement?.appendChild(menu);

    menu.querySelectorAll("button").forEach((b) => {
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const cut = (el.selectionStart ?? 0) - m[0].length;
        const token = `{{${b.dataset.var}}}`;
        el.value = el.value.slice(0, cut) + token + el.value.slice(el.selectionStart ?? 0);
        const pos = cut + token.length;
        el.focus();
        el.setSelectionRange(pos, pos);
        close();
      });
    });
  });
}

/**
 * Integrações e operações vêm de GET /v1/flows/connectors (registro em
 * flows/connectors/index.ts). Antes a lista estava duplicada aqui em HTML e
 * ficava defasada em relação ao backend. Enquanto o fetch não volta, usa o
 * fallback abaixo — o painel nunca fica sem opção.
 */
let connectorCatalogCache = [
  {
    slug: "calendar",
    label: "Calendário",
    defaultOperation: "list_slots",
    operations: [
      { value: "list_slots", label: "Listar horários livres" },
      { value: "create_event", label: "Criar evento" },
      { value: "cancel_event", label: "Cancelar evento" },
    ],
  },
  { slug: "http", label: "HTTP / webhook", defaultOperation: "request", operations: [{ value: "request", label: "Chamar a URL" }] },
];

async function loadConnectorCatalog() {
  try {
    const res = await fetch("/v1/flows/connectors", { credentials: "include", cache: "no-store" });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.connectors) && data.connectors.length) {
      connectorCatalogCache = data.connectors;
    }
  } catch {
    /* mantém o fallback */
  }
}

function connectorOptions(selected) {
  return connectorCatalogCache
    .map(
      (c) =>
        `<option value="${escapeHtml(c.slug)}"${c.slug === selected ? " selected" : ""}>${escapeHtml(c.label)}</option>`
    )
    .join("");
}

function operationOptions(connectorSlug, selected) {
  const spec = connectorCatalogCache.find((c) => c.slug === connectorSlug) || connectorCatalogCache[0];
  return (spec?.operations || [])
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`
    )
    .join("");
}

function renderProps() {
  const empty = $("props-empty");
  const body = $("props-body");
  const node = state.flow?.nodes.find((n) => n.id === state.selectedNodeId);

  // Painel recolhido + conteúdo mudou (nó diferente selecionado) → pisca o botão de expandir
  const propsPanel = $("panel-props");
  if (node && node.id !== lastSeenPropsNodeId && propsPanel?.classList.contains("collapsed")) {
    document.querySelector('[data-toggle="panel-props"]')?.classList.add("pulse");
  }
  lastSeenPropsNodeId = node?.id ?? null;

  document.querySelector(".fb-body")?.classList.toggle("has-props", Boolean(node));
  if (propsPanel) propsPanel.classList.toggle("idle", !node);

  if (!node) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  // Se o painel estiver recolhido, permanece recolhido — só o pulse acima
  // (ícone piscando) avisa que o conteúdo mudou. Forçar a expansão aqui
  // anulava esse aviso, abrindo o painel em toda seleção de passo.
  empty.classList.add("hidden");
  body.classList.remove("hidden");

  const d = node.data || {};
  let html =
    node.type === "trigger"
      ? `<div class="field"><label>${t("builder.props.type")}</label><input value="${typeLabel(node.type)}" disabled /></div>`
      : `<div class="field"><label>${t("builder.props.type")}</label>
          <select id="p-type">
            ${ADDABLE_TYPES.map(
              (it) => `<option value="${it.type}"${it.type === node.type ? " selected" : ""}>${escapeHtml(it.label)}</option>`
            ).join("")}
          </select>
        </div>`;

  if (node.type === "message" || node.type === "handoff") {
    const key = node.type === "message" ? "text" : "message";
    html += `<div class="field"><label>Texto (use {{var}})</label>
      <textarea id="p-text">${escapeHtml(String(d[key] || ""))}</textarea></div>`;
  }
  if (node.type === "handoff") {
    html += `<div class="field"><label>Reason</label>
      <input id="p-reason" value="${escapeHtml(String(d.reason || "handoff"))}" /></div>`;
  }
  if (node.type === "ask") {
    html += `<div class="field"><label>Pergunta</label>
      <textarea id="p-prompt">${escapeHtml(String(d.prompt || ""))}</textarea></div>
      <div class="field"><label>Salvar em variável</label>
      <input id="p-var" value="${escapeHtml(String(d.varName || "resposta"))}" /></div>`;
  }
  if (node.type === "condition") {
    html += `<div class="field"><label>Campo (last ou nome da var)</label>
      <input id="p-field" value="${escapeHtml(String(d.field || "last"))}" /></div>
      <div class="field"><label>Operador</label>
      <select id="p-op">
        <option value="contains"${d.op === "contains" ? " selected" : ""}>contains</option>
        <option value="equals"${d.op === "equals" ? " selected" : ""}>equals</option>
        <option value="regex"${d.op === "regex" ? " selected" : ""}>regex</option>
      </select></div>
      <div class="field"><label>Valor</label>
      <input id="p-value" value="${escapeHtml(String(d.value || ""))}" /></div>
      <p class="fb-hint">Ligações: label <code>true</code> / <code>false</code></p>`;
  }
  if (node.type === "llm_intent") {
    html += `<div class="field"><label>Como a IA deve decidir</label>
      <textarea id="p-prompt">${escapeHtml(String(d.prompt || ""))}</textarea></div>
      <div class="field"><label>Intenções (código · o que significa)</label>
      <div id="p-intents"></div>
      <button type="button" class="fb-btn fb-btn-secondary" id="p-add-intent" style="margin-top:6px">+ intenção</button>
      </div>
      <p class="fb-hint">Ao ligar o próximo passo, use o mesmo código (ex.: marcar_consulta) ou “default”.</p>`;
  }
  if (node.type === "llm_extract") {
    html += `<div class="field"><label>O que buscar (contexto pra IA)</label>
      <textarea id="p-prompt">${escapeHtml(String(d.prompt || ""))}</textarea></div>
      <div class="field"><label>Salvar em variável</label>
      <input id="p-var" value="${escapeHtml(String(d.varName || "data_confirmada"))}" /></div>
      <p class="fb-hint">Ligações: <code>ok</code> (extraiu certo) / <code>ambiguous</code> (faltou info) / <code>unclear</code> (não tinha data). Var extra: <code>date_extract_status</code>.</p>`;
  }

  if (node.type === "llm_answer") {
    html += `<div class="field"><label>Título no cartão</label>
      <input id="p-label" value="${escapeHtml(String(d.label || ""))}" placeholder="Responder dúvida" /></div>
      <div class="field"><label>O que a IA sabe sobre o seu negócio</label>
      <textarea id="p-context" rows="8" placeholder="Horário: seg a sex 9h-18h&#10;Preços: plano X R$ 000&#10;Endereço: rua ...&#10;Não atendemos: ...">${escapeHtml(String(d.context || ""))}</textarea></div>
      <div class="field"><label>Tamanho máximo da resposta (caracteres)</label>
      <input id="p-maxchars" type="number" min="80" max="1200" value="${escapeHtml(String(d.maxChars || 400))}" /></div>
      <div class="field"><label>Salvar resposta em variável</label>
      <input id="p-var" value="${escapeHtml(String(d.varName || "resposta_ia"))}" /></div>
      <p class="fb-hint">A IA responde <b>só</b> com o que estiver escrito acima — se a pergunta fugir disso, ela avisa que vai chamar a equipe em vez de inventar. Ligações: <code>ok</code> (respondeu) e <code>erro</code> (IA indisponível — ligue num Atendente).</p>`;
  }

  if (node.type === "action") {
    const cfg = d.config && typeof d.config === "object" ? d.config : {};
    const connector = d.connector || "calendar";
    const operation = d.operation || "list_slots";
    html += `<div class="field"><label>Título no cartão</label>
      <input id="p-label" value="${escapeHtml(String(d.label || ""))}" placeholder="Listar horários" /></div>
      <div class="field"><label>Integração</label>
      <select id="p-connector">
        ${connectorOptions(connector)}
      </select></div>
      <div class="field" id="p-op-wrap"><label>Operação</label>
      <select id="p-operation">
        ${operationOptions(connector, operation)}
      </select></div>
      <div class="field" id="p-provider-wrap"><label>Fonte dos horários</label>
      <select id="p-provider">
        <option value=""${cfg.provider !== "google" ? " selected" : ""}>Webhook / mock</option>
        <option value="google"${cfg.provider === "google" ? " selected" : ""}>Google Calendar do cliente</option>
      </select></div>
      <div class="field" id="p-webhook-wrap"><label>Webhook (opcional)</label>
      <input id="p-webhook" value="${escapeHtml(String(cfg.webhookUrl || cfg.url || d.webhookUrl || ""))}" placeholder="https://… (vazio = mock)" /></div>
      <div class="field" id="p-target-date-wrap"><label>Data alvo (variável, opcional)</label>
      <input id="p-target-date" value="${escapeHtml(String(cfg.targetDateVar || ""))}" placeholder="ex.: data_confirmada" />
      <p class="fb-hint" style="margin-top:4px">Se vazio, lista os próximos dias corridos. Preenchido (ex.: com a variável de um passo "Extrair data" anterior), lista só aquele dia.</p></div>
      <p class="fb-hint" id="p-google-hint">O cliente precisa conectar o Google Calendar dele em <strong>Dados da conta → Integrações</strong> no portal antes de publicar um fluxo usando essa opção.</p>
      <div class="field"><label>Mock no simulador</label>
      <select id="p-force-mock">
        <option value="1"${cfg.forceMock !== false ? " selected" : ""}>Sim — sempre mock</option>
        <option value="0"${cfg.forceMock === false ? " selected" : ""}>Não — usa a integração de verdade</option>
      </select></div>
      <p class="fb-hint">Ligações: <code>ok</code> e <code>erro</code>. Vars: <code>slots_text</code>, <code>event_link</code>, <code>event_summary</code>.</p>`;
  }

  html += `<div class="btn-row">
    <button type="button" class="fb-btn fb-btn-primary" id="p-apply">Aplicar</button>
    <button type="button" class="fb-btn fb-btn-secondary" id="p-link">Ligar a…</button>
    <button type="button" class="fb-btn fb-btn-danger" id="p-del">Remover</button>
  </div>`;

  body.innerHTML = renderVarsPanel(node) + html;
  wireVarPanel(node);

  if (node.type === "action") {
    const syncOp = () => {
      const wrap = $("p-op-wrap");
      const providerWrap = $("p-provider-wrap");
      const slug = $("p-connector").value;
      const spec = connectorCatalogCache.find((c) => c.slug === slug);
      const opSel = $("p-operation");
      // Repopula as operações da integração escolhida — antes o select ficava
      // preso nas 3 do calendário, mesmo trocando pra outra integração.
      if (opSel && spec) {
        const keep = spec.operations.some((o) => o.value === opSel.value) ? opSel.value : spec.defaultOperation;
        opSel.innerHTML = operationOptions(slug, keep);
      }
      // Esconde o select quando a integração só tem uma operação possível.
      const manyOps = (spec?.operations || []).length > 1;
      if (wrap) wrap.style.display = manyOps ? "" : "none";
      if (providerWrap) providerWrap.style.display = slug === "calendar" ? "" : "none";
      syncProvider();
    };
    const syncProvider = () => {
      const isGoogle = $("p-provider")?.value === "google";
      $("p-webhook-wrap") && ($("p-webhook-wrap").style.display = isGoogle ? "none" : "");
      $("p-google-hint") && ($("p-google-hint").style.display = isGoogle ? "" : "none");
      $("p-target-date-wrap") && ($("p-target-date-wrap").style.display = isGoogle ? "" : "none");
    };
    $("p-connector").onchange = syncOp;
    $("p-provider")?.addEventListener("change", syncProvider);
    syncOp();
    $("p-apply").onclick = () => {
      const connector = $("p-connector").value;
      const webhook = $("p-webhook").value.trim();
      const forceMock = $("p-force-mock").value === "1";
      const provider = connector === "calendar" ? $("p-provider").value : "";
      const config = {
        ...(node.data.config && typeof node.data.config === "object"
          ? node.data.config
          : {}),
        forceMock,
      };
      if (provider) config.provider = provider;
      else delete config.provider;
      const targetDateVar = provider === "google" ? $("p-target-date").value.trim() : "";
      if (targetDateVar) config.targetDateVar = targetDateVar;
      else delete config.targetDateVar;
      if (webhook && provider !== "google") {
        if (connector === "http") config.url = webhook;
        else config.webhookUrl = webhook;
      } else {
        delete config.url;
        delete config.webhookUrl;
      }
      node.data = {
        ...node.data,
        label: $("p-label").value.trim() || undefined,
        connector,
        // Antes gravava "request" fixo pra qualquer integração que não fosse
        // calendário — o que impedia qualquer connector novo de ter mais de
        // uma operação. Agora respeita o que o select mostra.
        operation: $("p-operation")?.value || node.data.operation || "request",
        config,
      };
      renderCanvas();
      toast(t("builder.toast.actionUpdated"));
    };
  } else if (node.type === "llm_intent") {
    const box = $("p-intents");
    const intents = Array.isArray(d.intents) ? d.intents : [];
    const redraw = () => {
      box.innerHTML = "";
      intents.forEach((it, i) => {
        const row = document.createElement("div");
        row.className = "intent-row";
        row.innerHTML = `<input data-i="${i}" data-k="slug" value="${escapeHtml(
          it.slug || ""
        )}" placeholder="slug" />
        <input data-i="${i}" data-k="description" value="${escapeHtml(
          it.description || ""
        )}" placeholder="descrição / keywords" />
        <button type="button" class="btn ghost sm" data-rm="${i}">×</button>`;
        box.appendChild(row);
      });
      box.querySelectorAll("input").forEach((inp) => {
        inp.onchange = () => {
          const i = Number(inp.dataset.i);
          const k = inp.dataset.k;
          intents[i][k] = inp.value;
        };
      });
      box.querySelectorAll("[data-rm]").forEach((btn) => {
        btn.onclick = () => {
          intents.splice(Number(btn.dataset.rm), 1);
          redraw();
        };
      });
    };
    redraw();
    $("p-add-intent").onclick = () => {
      intents.push({ slug: "nova", description: "" });
      redraw();
    };
    $("p-apply").onclick = () => {
      node.data = {
        ...node.data,
        prompt: $("p-prompt").value,
        intents: intents.map((x) => ({
          slug: x.slug.trim(),
          description: x.description.trim(),
        })),
      };
      renderCanvas();
      toast(t("builder.toast.stepUpdated"));
    };
  } else {
    $("p-apply").onclick = () => {
      if (node.type === "message") {
        node.data = { ...node.data, text: $("p-text").value };
      } else if (node.type === "handoff") {
        node.data = {
          ...node.data,
          message: $("p-text").value,
          reason: $("p-reason").value,
        };
      } else if (node.type === "ask") {
        node.data = {
          ...node.data,
          prompt: $("p-prompt").value,
          varName: $("p-var").value.trim() || "resposta",
        };
      } else if (node.type === "condition") {
        node.data = {
          ...node.data,
          field: $("p-field").value,
          op: $("p-op").value,
          value: $("p-value").value,
        };
      } else if (node.type === "llm_extract") {
        node.data = {
          ...node.data,
          prompt: $("p-prompt").value,
          varName: $("p-var").value.trim() || "data_confirmada",
        };
      } else if (node.type === "llm_answer") {
        node.data = {
          ...node.data,
          label: $("p-label").value.trim(),
          context: $("p-context").value,
          maxChars: Number($("p-maxchars").value) || 400,
          varName: $("p-var").value.trim() || "resposta_ia",
        };
      }
      renderCanvas();
      // Re-renderiza o painel pra revalidar as variáveis do texto recém-salvo
      // (é o que faz o aviso de "{{var}} não existe aqui" aparecer na hora).
      renderProps();
      toast(t("builder.toast.stepUpdated"));
    };
  }

  $("p-link").onclick = () => {
    state.linkFrom = node.id;
    toast(t("builder.toast.clickNextCard"));
  };
  $("p-del").onclick = () => deleteNode(node);
  $("p-type")?.addEventListener("change", (ev) => changeNodeType(node, ev.target.value));
}

/**
 * Campos de "texto principal" equivalentes entre tipos — preserva o que a
 * pessoa já escreveu quando dá pra reaproveitar (ex.: message.text vira
 * ask.prompt), em vez de resetar tudo pro padrão genérico.
 */
const MAIN_TEXT_FIELD = { message: "text", ask: "prompt", handoff: "message" };

/** Troca o tipo de um nó já existente, sem apagar — mantém id/posição/ligações. */
function changeNodeType(node, newType) {
  if (!newType || newType === node.type || node.type === "trigger" || newType === "trigger") return;

  const oldField = MAIN_TEXT_FIELD[node.type];
  const newField = MAIN_TEXT_FIELD[newType];
  const carryText = oldField && newField ? node.data?.[oldField] : null;

  const wasBranching = ["llm_intent", "llm_extract", "llm_answer", "condition", "action"].includes(node.type);
  const isBranching = ["llm_intent", "llm_extract", "llm_answer", "condition", "action"].includes(newType);
  const outEdges = state.flow.edges.filter((e) => e.from === node.id);
  const labeledOutEdges = outEdges.filter((e) => e.label);

  node.type = newType;
  node.data = defaultData(newType);
  if (carryText && newField) node.data[newField] = carryText;

  state.selectedNodeId = node.id;
  renderCanvas();
  renderProps();
  toast(t("builder.toast.typeChanged"));

  // Nó tinha várias ligações rotuladas (ex.: intenções) e virou um tipo linear —
  // só a primeira ligação será seguida, o resto fica sem uso até serem revisadas.
  if (wasBranching && !isBranching && labeledOutEdges.length > 1) {
    toast(t("builder.toast.typeChangedEdgesWarning"), "err");
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Palette (fallback: nó solto; preferir o + nos nós) ───
document.querySelector(".fb-canvas-wrap")?.addEventListener("click", (ev) => {
  if (ev.target.closest(".fb-node, .node-plus, .node-add-menu")) return;
  if (!state.selectedNodeId) return;
  state.selectedNodeId = null;
  renderCanvas();
  renderProps();
});

document.querySelectorAll(".pal-item").forEach((btn) => {
  btn.onclick = () => {
    if (!state.flow) return;
    const type = btn.dataset.type;
    const selected = state.flow.nodes.find((n) => n.id === state.selectedNodeId);
    if (selected && selected.type !== "end") {
      addChildNode(selected, type);
      return;
    }
    const n = {
      id: uid("n"),
      type,
      x: 120 + Math.random() * 200,
      y: 120 + Math.random() * 200,
      data: defaultData(type),
    };
    state.flow.nodes.push(n);
    state.selectedNodeId = n.id;
    renderCanvas();
    renderProps();
  };
});

// ── Painéis colapsáveis (Seus fluxos / Passos / Detalhes) ─
const PANEL_STATE_KEY = "glabs_bot_panels";

function loadPanelState() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function chevronSvg(dir) {
  const d = dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6";
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** Seta do botão aponta pra direção em que o painel vai (recolher) ou volta (expandir). */
function syncToggleIcon(btn, panel) {
  const collapsed = panel.classList.contains("collapsed");
  const side = btn.dataset.side;
  const dir = side === "left" ? (collapsed ? "right" : "left") : collapsed ? "left" : "right";
  btn.innerHTML = chevronSvg(dir);
  btn.title = collapsed ? "Expandir painel" : "Recolher painel";
}

function initPanels() {
  const saved = loadPanelState();
  document.querySelectorAll(".fb-aside-toggle").forEach((btn) => {
    const panel = document.getElementById(btn.dataset.toggle);
    if (!panel) return;
    if (saved[btn.dataset.toggle]) panel.classList.add("collapsed");
    syncToggleIcon(btn, panel);
    btn.onclick = () => {
      panel.classList.toggle("collapsed");
      btn.classList.remove("pulse"); // usuário interagiu — não precisa mais chamar atenção
      const s = loadPanelState();
      s[btn.dataset.toggle] = panel.classList.contains("collapsed");
      localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(s));
      syncToggleIcon(btn, panel);
      if (state.flow) setTimeout(renderCanvas, 190); // depois da transição de largura
    };
  });
}
initPanels();

// No portal, a coluna de canvas fica espremida (ou some) em iframes estreitos —
// a grade de Passos(190px)+Detalhes(300px) fixos não sobra espaço nenhum pro
// canvas quando o iframe fica abaixo de ~860px. Recolhe os dois automaticamente
// nesse caso, pelo mesmo mecanismo de sempre (o botão continua liberando pra
// expandir manualmente se o usuário preferir apertar mesmo assim).
if (EMBED) {
  const narrowMq = window.matchMedia("(max-width: 860px)");
  const applyNarrowCollapse = () => {
    for (const id of ["panel-palette", "panel-props"]) {
      const panel = document.getElementById(id);
      if (!panel) continue;
      panel.classList.toggle("collapsed", narrowMq.matches);
      const btn = document.querySelector(`[data-toggle="${id}"]`);
      if (btn) syncToggleIcon(btn, panel);
    }
    if (state.flow) renderCanvas();
  };
  narrowMq.addEventListener("change", applyNarrowCollapse);
  applyNarrowCollapse();
}

// ── Atalhos de teclado ───────────────────────────────────
document.addEventListener("keydown", (e) => {
  // Delete (Windows/Linux) e Backspace (tecla "Delete" do Mac mandam "Backspace")
  if (e.key !== "Delete" && e.key !== "Backspace") return;

  // não intercepta enquanto o usuário está digitando em algum campo
  const el = document.activeElement;
  const isEditing =
    el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  if (isEditing) return;

  if (!state.flow || !state.selectedNodeId) return;
  const node = state.flow.nodes.find((n) => n.id === state.selectedNodeId);
  if (!node) return;

  e.preventDefault();
  deleteNode(node);
});

// ── Actions ──────────────────────────────────────────────
$("btn-new").onclick = () => newBlankFlow();

$("btn-save").onclick = async () => {
  if (!state.flow) return;
  state.flow.name = $("flow-name").value.trim() || "Sem nome";
  state.flow.product = $("flow-product").value;
  try {
    const data = await api("/v1/flows", {
      method: "POST",
      body: JSON.stringify({
        id: state.flow.id || undefined,
        name: state.flow.name,
        product: state.flow.product,
        accountId: state.flow.accountId,
        status: state.flow.status || "draft",
        nodes: state.flow.nodes,
        edges: state.flow.edges,
      }),
    });
    state.flow = data.flow;
    toast("Salvo");
    await loadAll();
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-publish").onclick = async () => {
  if (!state.flow?.id) {
    toast("Salve o fluxo antes de publicar", "err");
    return;
  }
  try {
    // save first
    await $("btn-save").onclick();
    const data = await api(`/v1/flows/${state.flow.id}/publish`, {
      method: "POST",
    });
    state.flow = data.flow;
    toast("Publicado — no ar");
    await loadAll();
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-unpublish").onclick = async () => {
  if (!state.flow?.id) return;
  try {
    const data = await api(`/v1/flows/${state.flow.id}/unpublish`, {
      method: "POST",
    });
    state.flow = data.flow;
    toast("Pausado — rascunho");
    await loadAll();
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-delete").onclick = async () => {
  if (!state.flow?.id) {
    toast(t("builder.toast.flowNotSaved"), "err");
    return;
  }
  const live = state.flow.status === "live";
  const ok = confirm(
    live
      ? t("builder.confirmDeleteLive", { name: state.flow.name })
      : t("builder.confirmDelete", { name: state.flow.name })
  );
  if (!ok) return;
  try {
    await api(`/v1/flows/${state.flow.id}`, { method: "DELETE" });
    toast(t("builder.toast.flowDeleted"));
    state.flow = null;
    state.selectedNodeId = null;
    if (EMBED) window.parent.postMessage({ type: "glabs-flows-changed" }, "*");
    await loadAll();
  } catch (e) {
    toast(e.message, "err");
  }
};

function fitFlowName() {
  const el = $("flow-name");
  if (!el) return;
  const probe = el.value || el.placeholder || "Fluxo";
  el.style.width = Math.min(Math.max(probe.length * 11 + 28, 96), 440) + "px";
}

$("flow-name").oninput = () => {
  if (!state.flow) return;
  state.flow.name = $("flow-name").value;
  fitFlowName();
  updateSaveBadge();
};

$("flow-product").onchange = () => {
  if (!state.flow) return;
  state.flow.product = $("flow-product").value;
  updateSaveBadge();
};

$("btn-revert").onclick = () => {
  if (!state.flow?.id) {
    toast(t("builder.toast.newFlowNoVersion"), "err");
    return;
  }
  if (isDirty() && !confirm(t("builder.confirmRevert"))) {
    return;
  }
  selectFlow(state.flow.id);
  toast(t("builder.toast.reverted"));
};

// ── Simulador ────────────────────────────────────────────
function openSim() {
  if (!state.flow) {
    toast("Abra um fluxo primeiro", "err");
    return;
  }
  state.simOpen = true;
  $("sim-panel").classList.remove("hidden");
  $("sim-input")?.focus();
  updateSimStatus();
}

function closeSim() {
  state.simOpen = false;
  $("sim-panel").classList.add("hidden");
}

function resetSim() {
  state.simState = null;
  state.simActiveNodeId = null;
  state.simVisitedIds = [];
  const chat = $("sim-chat");
  chat.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "sim-empty";
  empty.id = "sim-empty";
  empty.innerHTML = `<p>${t("builder.sim.emptyHint")}</p>
    <div class="sim-chips">
      <button type="button" class="sim-chip" data-text="Oi, quero marcar uma sessão">${t("builder.sim.chip.book")}</button>
      <button type="button" class="sim-chip" data-text="Quanto custa?">${t("builder.sim.chip.doubt")}</button>
      <button type="button" class="sim-chip" data-text="Preciso da nota fiscal">${t("builder.sim.chip.admin")}</button>
    </div>`;
  chat.appendChild(empty);
  bindSimChips();
  $("sim-meta").textContent = "";
  updateSimStatus(t("builder.sim.status.restarted"));
  renderCanvas();
}

function bindSimChips() {
  document.querySelectorAll(".sim-chip").forEach((btn) => {
    btn.onclick = () => {
      const t = btn.dataset.text || btn.textContent;
      $("sim-input").value = t;
      sendSimMessage();
    };
  });
}

function updateSimStatus(extra) {
  const el = $("sim-status");
  if (!el) return;
  if (state.simState?.mode === "human") {
    el.textContent = extra || t("builder.sim.status.human");
    return;
  }
  if (state.simState?.waitingFor) {
    el.textContent = extra || t("builder.sim.status.waiting", { field: state.simState.waitingFor });
    return;
  }
  if (state.simState?.finished) {
    el.textContent = extra || t("builder.sim.status.finished");
    return;
  }
  el.textContent = extra || t("builder.sim.status");
}

function appendSimBubble(kind, text, nodeId) {
  const chat = $("sim-chat");
  const empty = $("sim-empty");
  if (empty) empty.remove();
  const b = document.createElement("div");
  b.className = "sim-bubble " + kind;
  b.textContent = text;
  if (nodeId) {
    b.dataset.nodeId = nodeId;
    b.addEventListener("mouseenter", () => {
      state.simActiveNodeId = nodeId;
      renderCanvas();
    });
  }
  chat.appendChild(b);
  chat.scrollTop = chat.scrollHeight;
  return b;
}

function typeLabelPt(type) {
  return (
    {
      trigger: t("builder.step.trigger"),
      message: t("builder.step.message"),
      ask: t("builder.sim.trace.ask"),
      llm_intent: t("builder.sim.trace.intent"),
      llm_extract: t("builder.step.extract"),
      llm_answer: t("builder.step.answer"),
      action: t("builder.step.action"),
      condition: t("builder.step.condition"),
      handoff: t("builder.step.handoff"),
      end: t("builder.sim.trace.end"),
    }[type] || type
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function playTrace(trace) {
  for (const step of trace) {
    if (!state.simVisitedIds.includes(step.nodeId)) state.simVisitedIds.push(step.nodeId);
    state.simActiveNodeId = step.nodeId;
    renderCanvas();
    const nodeEl = document.querySelector(`.fb-node[data-id="${step.nodeId}"]`);
    nodeEl?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const label = typeLabelPt(step.type);
    const detail = step.detail ? ` · ${step.detail}` : "";
    appendSimBubble("sys", `${label}${detail}`, step.nodeId);
    // Mostra a mensagem enviada nesse passo (message/ask/handoff) já aqui, na hora —
    // antes ela só aparecia depois de TODO o trace tocar, então um fluxo que termina
    // logo depois (nó Fim) parecia "encerrar antes de mostrar a última mensagem".
    if (step.reply) appendSimBubble("bot", step.reply, step.nodeId);
    updateSimStatus(t("builder.sim.nowAt", { label }));
    await sleep(420);
  }
}

function renderSimMeta(data) {
  const parts = [];
  if (data.lastIntent) {
    parts.push(
      `${t("builder.sim.meta.intent")}: <b>${escapeHtml(data.lastIntent)}</b>` +
        (data.intentSource ? ` · ${escapeHtml(data.intentSource)}` : "")
    );
  }
  if (data.state?.waitingFor) {
    parts.push(`${t("builder.sim.meta.savedIn")} <b>${escapeHtml(data.state.waitingFor)}</b>`);
  }
  if (data.handoff) {
    parts.push(`handoff · ${escapeHtml(data.handoffReason || "")}`);
  }
  const vars = data.state?.vars || {};
  const keys = Object.keys(vars).filter(
    (k) => !["last_intent", "intent_source", "handoff_reason", "pushName"].includes(k)
  );
  if (keys.length) {
    parts.push(
      `${t("builder.sim.meta.vars")}: ` +
        keys
          .map((k) => `<b>${escapeHtml(k)}</b>=${escapeHtml(String(vars[k]).slice(0, 24))}`)
          .join(", ")
    );
  }
  $("sim-meta").innerHTML = parts.join(" · ");
}

async function sendSimMessage() {
  if (!state.flow || state.simBusy) return;
  const input = $("sim-input");
  const text = (input.value || "").trim();
  if (!text) return;

  if (state.simState?.mode === "human") {
    appendSimBubble("sys", "Conversa em handoff — reinicie para testar de novo");
    return;
  }

  input.value = "";
  appendSimBubble("user", text);
  state.simBusy = true;
  $("sim-send").disabled = true;
  updateSimStatus("Pensando…");

  try {
    const data = await api("/v1/flows/simulate", {
      method: "POST",
      body: JSON.stringify({
        flowId: state.flow.id || undefined,
        name: state.flow.name,
        product: state.flow.product,
        nodes: state.flow.nodes,
        edges: state.flow.edges,
        text,
        state: state.simState,
      }),
    });

    state.simState = data.state || null;

    const trace = data.trace || [];
    if (trace.length) {
      await playTrace(trace);
    } else if (data.state?.nodeId) {
      state.simActiveNodeId = data.state.nodeId;
      if (!state.simVisitedIds.includes(data.state.nodeId)) {
        state.simVisitedIds.push(data.state.nodeId);
      }
    }

    // playTrace já mostrou cada reply junto do passo que a gerou, na ordem certa.
    // Só cai aqui de fallback se por algum motivo o trace não trouxe reply nenhum
    // atrelado (ex.: resposta de um backend antigo, sem o campo).
    if (!trace.some((step) => step.reply)) {
      for (const reply of data.replies || []) {
        appendSimBubble("bot", reply, state.simActiveNodeId);
      }
    }

    if (data.handoff) {
      appendSimBubble(
        "handoff",
        t("builder.sim.handoffMsg") +
          (data.handoffReason ? ` (${data.handoffReason})` : ""),
        state.simActiveNodeId
      );
    } else if (!data.replies?.length && !trace.length) {
      appendSimBubble("sys", t("builder.sim.noReply"));
    }

    renderSimMeta(data);
    updateSimStatus();
    renderCanvas();
  } catch (e) {
    appendSimBubble("sys", t("builder.sim.errorPrefix") + e.message);
    toast(e.message, "err");
    updateSimStatus("Erro");
  } finally {
    state.simBusy = false;
    $("sim-send").disabled = false;
    input.focus();
  }
}

$("btn-sim").onclick = () => {
  if (state.simOpen) closeSim();
  else openSim();
};
$("sim-close").onclick = () => closeSim();
$("sim-reset").onclick = () => resetSim();
$("sim-form").onsubmit = (e) => {
  e.preventDefault();
  sendSimMessage();
};
bindSimChips();

// ── Histórico de versões ────────────────────────────────
function openHistory() {
  if (!state.flow?.id) {
    toast(t("builder.history.toast.loadFirst"), "err");
    return;
  }
  state.historyOpen = true;
  $("history-panel").classList.remove("hidden");
  loadHistory();
}

function closeHistory() {
  state.historyOpen = false;
  $("history-panel").classList.add("hidden");
}

async function loadHistory() {
  const list = $("history-list");
  $("history-sub").textContent = state.flow?.name || "";
  list.innerHTML = `<div class="history-empty">${t("common.loading")}</div>`;
  try {
    const data = await api(`/v1/flows/${state.flow.id}/versions`);
    state.historyVersions = data.versions || [];
    renderHistoryList();
  } catch (e) {
    list.innerHTML = `<div class="history-empty">${t("builder.history.loadError", { message: e.message })}</div>`;
  }
}

function renderHistoryList() {
  const list = $("history-list");
  list.innerHTML = "";

  // linha "atual" no topo, pra deixar claro o que está no ar agora
  const current = document.createElement("div");
  current.className = "history-item current";
  current.innerHTML = `
    <div class="history-item-top">
      <span class="history-item-when">${t("builder.history.current")}</span>
      <span class="history-badge">${t("builder.history.now")}</span>
    </div>
    <div class="history-item-meta">${escapeHtml(state.flow.name)} · ${t("builder.history.stepsCount", { n: state.flow.nodes.length })}${
      isDirty() ? ` · ${t("builder.history.unsavedSuffix")}` : ""
    }</div>`;
  list.appendChild(current);

  if (!state.historyVersions.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = t("builder.history.empty");
    list.appendChild(empty);
    return;
  }

  for (const v of state.historyVersions) {
    const el = document.createElement("div");
    el.className = "history-item";
    el.innerHTML = `
      <div class="history-item-top">
        <span class="history-item-when">${escapeHtml(formatDateTime(v.savedAt))}</span>
      </div>
      <div class="history-item-meta">${escapeHtml(v.name)} · ${escapeHtml(productLabel(v.product))} · ${t("builder.history.stepsCount", { n: v.nodeCount })}</div>
      <button type="button" class="fb-btn fb-btn-secondary" data-restore="${v.id}">${t("builder.history.restore")}</button>`;
    list.appendChild(el);
  }

  list.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(t("builder.history.confirmRestore"))) return;
      try {
        const data = await api(`/v1/flows/${state.flow.id}/versions/${btn.dataset.restore}/restore`, {
          method: "POST",
        });
        toast(t("builder.history.toast.restored"));
        await loadAll();
        closeHistory();
      } catch (e) {
        toast(e.message, "err");
      }
    };
  });
}

$("btn-history").onclick = () => {
  if (state.historyOpen) closeHistory();
  else openHistory();
};
$("history-close").onclick = () => closeHistory();
