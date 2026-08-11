/**
 * Glabs Bot · Workflow Builder (visual)
 */
const STORAGE_KEY = "glabs_bot_secret";

const state = {
  secret: localStorage.getItem(STORAGE_KEY) || "",
  flows: [],
  flow: null,
  selectedNodeId: null,
  linkFrom: null,
  drag: null,
  llmConfigured: false,
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
  if (opts.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...opts, headers, cache: "no-store" });
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
    case "condition":
      return { field: "last", op: "contains", value: "sim" };
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

function nodeTitle(node) {
  const d = node.data || {};
  if (node.type === "message") return String(d.text || "Mensagem").slice(0, 80);
  if (node.type === "ask") return String(d.prompt || "Pergunta").slice(0, 80);
  if (node.type === "llm_intent") return d.label || "LLM intenção";
  if (node.type === "condition")
    return `${d.field || "last"} ${d.op || "contains"} “${d.value || ""}”`;
  if (node.type === "handoff") return d.reason || "Handoff";
  if (node.type === "end") return d.label || "Fim";
  if (node.type === "trigger") return d.label || "Trigger";
  return node.type;
}

function typeLabel(type) {
  return (
    {
      trigger: "Início",
      message: "Mensagem",
      ask: "Perguntar",
      llm_intent: "Entender intenção",
      condition: "Se / senão",
      handoff: "Atendente",
      end: "Encerrar",
    }[type] || type
  );
}

function statusLabel(status) {
  return status === "live" ? "No ar" : "Rascunho";
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
    showLogin(e.message === "unauthorized" ? "Secret inválido" : e.message);
  }
};

if (state.secret) {
  loadAll()
    .then(showBuilder)
    .catch(() => showLogin());
}

// ── Data ─────────────────────────────────────────────────
async function loadAll() {
  const data = await api("/v1/flows");
  state.flows = data.flows || [];
  state.llmConfigured = Boolean(data.llmConfigured);
  $("llm-badge").textContent = state.llmConfigured
    ? "IA ligada"
    : "IA · palavras-chave";
  $("llm-badge").className = state.llmConfigured
    ? "fb-meta-chip on"
    : "fb-meta-chip";

  if (!state.flow && state.flows.length) {
    selectFlow(state.flows[0].id);
  } else if (!state.flow) {
    newBlankFlow();
  } else {
    const fresh = state.flows.find((f) => f.id === state.flow.id);
    if (fresh) state.flow = structuredClone(fresh);
    renderAll();
  }
}

function selectFlow(id) {
  const f = state.flows.find((x) => x.id === id);
  if (!f) return;
  state.flow = structuredClone(f);
  state.selectedNodeId = null;
  state.linkFrom = null;
  renderAll();
}

function newBlankFlow() {
  state.flow = {
    id: "",
    name: "Novo fluxo",
    product: $("flow-product")?.value || "gestor",
    accountId: null,
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
  renderAll();
}

function renderAll() {
  renderList();
  renderCanvas();
  renderProps();
  if (state.flow) {
    $("flow-name").value = state.flow.name;
    $("flow-product").value = state.flow.product || "gestor";
    $("flow-status").textContent = statusLabel(state.flow.status || "draft");
    $("flow-status").className =
      "fb-status " + (state.flow.status === "live" ? "live" : "draft");
  }
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
    const productLabel =
      f.product === "prontuario"
        ? "Prontuário"
        : f.product === "gestor"
          ? "Gestor"
          : f.product === "pilates"
            ? "Pilates"
            : f.product;
    b.querySelector(".m").textContent = `${productLabel} · ${statusLabel(f.status)}`;
    b.onclick = () => selectFlow(f.id);
    el.appendChild(b);
  }
  if (!state.flows.length) {
    el.innerHTML = `<p class="fb-palette-hint" style="margin:8px 4px">Nenhum fluxo ainda. O demo “Marcar consulta” aparece no primeiro uso.</p>`;
  }
}

function renderCanvas() {
  const canvas = $("canvas");
  const svg = $("edges-svg");
  canvas.innerHTML = "";
  svg.innerHTML = "";
  if (!state.flow) return;

  // edges
  const ns = "http://www.w3.org/2000/svg";
  for (const e of state.flow.edges) {
    const a = state.flow.nodes.find((n) => n.id === e.from);
    const b = state.flow.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const x1 = a.x + 100;
    const y1 = a.y + 40;
    const x2 = b.x + 100;
    const y2 = b.y + 10;
    const midY = (y1 + y2) / 2;
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
    );
    path.setAttribute("class", "edge-path");
    path.dataset.edgeId = e.id;
    svg.appendChild(path);
    if (e.label) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", (x1 + x2) / 2);
      t.setAttribute("y", midY - 4);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "edge-label");
      t.textContent = e.label;
      svg.appendChild(t);
    }
  }

  closeAddMenu();

  // nodes
  for (const n of state.flow.nodes) {
    const el = document.createElement("div");
    el.className =
      "fb-node type-" +
      n.type +
      (state.selectedNodeId === n.id ? " selected" : "");
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.dataset.id = n.id;
    el.innerHTML = `<div class="k"></div><div class="b"></div>`;
    el.querySelector(".k").textContent = typeLabel(n.type);
    el.querySelector(".b").textContent = nodeTitle(n);

    // + para adicionar próximo nó (exceto end)
    if (n.type !== "end") {
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "node-plus";
      plus.title = "Adicionar próximo passo";
      plus.setAttribute("aria-label", "Adicionar próximo passo");
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

  // size svg
  svg.setAttribute("width", "2200");
  svg.setAttribute("height", "1400");
}

const ADDABLE_TYPES = [
  { type: "message", label: "Mensagem", icon: "💬", ic: "msg" },
  { type: "ask", label: "Perguntar", icon: "❓", ic: "ask" },
  { type: "llm_intent", label: "Entender intenção", icon: "✨", ic: "llm" },
  { type: "condition", label: "Se / senão", icon: "⑂", ic: "cond" },
  { type: "handoff", label: "Atendente", icon: "👤", ic: "hand" },
  { type: "end", label: "Encerrar", icon: "✓", ic: "end" },
];

function closeAddMenu() {
  document.querySelectorAll(".node-add-menu").forEach((m) => m.remove());
}

function openAddMenu(parentNode, anchorBtn) {
  closeAddMenu();
  const canvas = $("canvas");
  const menu = document.createElement("div");
  menu.className = "node-add-menu";
  menu.innerHTML = `<div class="m-title">Próximo passo</div>`;

  for (const item of ADDABLE_TYPES) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="pal-icon ${item.ic}">${item.icon}</span>${item.label}`;
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
        "Rótulo da intenção (slug, ex.: marcar_consulta) — vazio = default",
        siblings === 0 ? "marcar_consulta" : "default"
      )?.trim() || "default";
  } else if (parentNode.type === "condition") {
    edgeLabel = siblings === 0 ? "true" : "false";
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
  toast("Passo adicionado");
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
    const label = prompt(
      "Rótulo da ligação (ex.: marcar_consulta, true, false) — vazio = default",
      ""
    );
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
    toast("Ligação criada");
    return;
  }
  if (state.linkFrom === node.id) {
    state.linkFrom = null;
    toast("Ligação cancelada");
    return;
  }
  // start link mode on double-click? use button in props
  state.selectedNodeId = node.id;
  renderCanvas();
  renderProps();
}

function renderProps() {
  const empty = $("props-empty");
  const body = $("props-body");
  const node = state.flow?.nodes.find((n) => n.id === state.selectedNodeId);
  if (!node) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");

  const d = node.data || {};
  let html = `<div class="field"><label>Tipo</label><input value="${typeLabel(
    node.type
  )}" disabled /></div>`;

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

  html += `<div class="btn-row">
    <button type="button" class="fb-btn fb-btn-primary" id="p-apply">Aplicar</button>
    <button type="button" class="fb-btn fb-btn-secondary" id="p-link">Ligar a…</button>
    <button type="button" class="fb-btn fb-btn-danger" id="p-del">Remover</button>
  </div>`;

  body.innerHTML = html;

  if (node.type === "llm_intent") {
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
      toast("Passo atualizado");
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
      }
      renderCanvas();
      toast("Passo atualizado");
    };
  }

  $("p-link").onclick = () => {
    state.linkFrom = node.id;
    toast("Clique no próximo cartão para ligar");
  };
  $("p-del").onclick = () => {
    if (node.type === "trigger") {
      toast("O início do fluxo não pode ser removido", "err");
      return;
    }
    state.flow.nodes = state.flow.nodes.filter((n) => n.id !== node.id);
    state.flow.edges = state.flow.edges.filter(
      (e) => e.from !== node.id && e.to !== node.id
    );
    state.selectedNodeId = null;
    renderAll();
  };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Palette (fallback: nó solto; preferir o + nos nós) ───
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

$("flow-name").onchange = () => {
  if (state.flow) state.flow.name = $("flow-name").value;
};
