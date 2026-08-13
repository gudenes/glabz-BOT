import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("accept", "application/json");
  const clientId = sessionStorage.getItem("glabs_client_id");
  if (clientId) headers.set("x-client-id", clientId);
  if (opts.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...opts, headers, cache: "no-store", credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.replace("/admin/login.html");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(data.reason || `HTTP ${res.status}`);
  return data;
}

const state = {
  portal: null,
  accountId: null,
  view: "status",
  simState: null,
  simBusy: false,
  lastWa: null,
  firstName: "",
  threads: [],
  selectedPhone: null,
};

const TITLES = {
  status: ["WhatsApp", "Conecte seu número e veja o status"],
  inbox: ["Conversas", "Fale com o cliente no WhatsApp real"],
  flow: ["Fluxo", "Desenhe o atendimento e publique"],
  test: ["Testar", "Simule uma conversa como o cliente"],
  pubs: ["Publicações", "O que está no ar neste projeto"],
};

function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
  });
  for (const id of ["status", "inbox", "flow", "test", "pubs"]) {
    $(`view-${id}`)?.classList.toggle("hidden", id !== view);
  }
  $("hello").textContent = state.firstName ? `Olá, ${state.firstName}!` : TITLES[view][0];
  $("stage-sub").textContent = TITLES[view][1];
  if (view === "flow") {
    const frame = $("flow-frame");
    if (frame && frame.dataset.loaded !== "1") {
      const cid = sessionStorage.getItem("glabs_client_id") || state.portal?.client?.id || "";
      frame.src = `/admin/flows.html?embed=1&client=${encodeURIComponent(cid)}&v=10`;
      frame.dataset.loaded = "1";
    }
  }
  if (view === "test") renderTestMeta();
  if (view === "pubs") renderPubs();
  if (view === "inbox") void loadInbox();
}

function pill(status) {
  const el = $("conn-pill");
  if (status === "connected") {
    el.className = "pill ok";
    el.textContent = "Conectado";
  } else if (status === "pending_qr") {
    el.className = "pill warn";
    el.textContent = "Aguardando QR";
  } else {
    el.className = "pill off";
    el.textContent = status === "error" ? "Erro" : "Desconectado";
  }
}

function fmtWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function activeFlow() {
  const flows = state.portal?.flows || [];
  return flows.find((f) => f.status === "live") || flows[0] || null;
}

function render() {
  const p = state.portal;
  if (!p) return;
  $("client-name").textContent = p.client.name;
  $("client-sub").textContent = p.impersonating ? "visão admin" : "Portal do cliente";
  $("impersonate").classList.toggle("hidden", !p.impersonating);

  const acc = p.accounts[0];
  const sess = acc?.session;
  state.accountId = acc?.account?.id || null;
  const wa = sess?.status || "disconnected";
  if (state.lastWa && state.lastWa !== wa) {
    if (wa === "connected") toast("WhatsApp conectado");
    if (wa === "pending_qr") toast("QR pronto — aponte a câmera do celular");
    if (wa === "disconnected" && state.lastWa === "connected") toast("WhatsApp desconectado");
  }
  state.lastWa = wa;
  pill(wa);

  $("st-status").textContent =
    sess?.status === "connected"
      ? "Conectado"
      : sess?.status === "pending_qr"
        ? "Aguardando QR"
        : sess?.status === "error"
          ? "Erro"
          : "Desconectado";
  $("st-live").textContent = p.liveFlow?.name || "Nenhum publicado";
  $("st-updated").textContent = fmtWhen(p.liveFlow?.publishedAt || p.liveFlow?.updatedAt);
  $("st-phone").textContent = sess?.phoneDisplay || "";

  const box = $("qr-box");
  const existingImg = box.querySelector("img");
  if (existingImg) existingImg.remove();

  if (sess?.status === "connected") {
    $("qr-kicker").textContent = "Conectado";
    $("qr-kicker").className = "hero-kicker ok";
    $("qr-title").textContent = "Seu número está conectado e pronto para receber mensagens.";
    $("qr-hint").textContent = sess.connectedAt
      ? `Conectado desde ${fmtWhen(sess.connectedAt)}`
      : "Pode testar o fluxo. Se cair, gere um QR de novo.";
    $("btn-connect").textContent = "Gerar novo QR";
  } else if (sess?.qrDataUrl) {
    $("qr-kicker").textContent = "Aguardando leitura";
    $("qr-kicker").className = "hero-kicker";
    $("qr-title").textContent = "Escaneie o QR com o celular";
    $("qr-hint").textContent = "WhatsApp → Aparelhos conectados → Conectar um aparelho.";
    $("btn-connect").textContent = "Gerar outro QR";
    const img = document.createElement("img");
    img.src = sess.qrDataUrl;
    img.alt = "QR Code WhatsApp";
    box.appendChild(img);
  } else {
    $("qr-kicker").textContent = "Ainda não conectado";
    $("qr-kicker").className = "hero-kicker";
    $("qr-title").textContent = "Conecte o WhatsApp do negócio";
    $("qr-hint").textContent =
      "Clique em Gerar QR e aponte a câmera: WhatsApp → Aparelhos conectados → Conectar um aparelho.";
    $("btn-connect").textContent = "Gerar QR";
  }
}

function renderTestMeta() {
  const f = activeFlow();
  $("test-flow-name").textContent = f ? f.name : "Nenhum fluxo ainda";
  $("test-flow-sub").textContent = f
    ? f.status === "live"
      ? "Testando o fluxo que está no ar."
      : "Testando o rascunho — publique quando gostar."
    : "Crie um fluxo na aba Fluxo para testar.";
}

function renderPubs() {
  const list = $("pubs-list");
  const flows = state.portal?.flows || [];
  if (!flows.length) {
    list.innerHTML = `<div class="pub"><div><h3>Nenhum fluxo</h3><p>Abra Fluxo e publique o primeiro atendimento.</p></div></div>`;
    return;
  }
  list.innerHTML = flows
    .map((f) => {
      const when = fmtWhen(f.publishedAt || f.updatedAt);
      const badge = f.status === "live" ? `<span class="pill live">No ar</span>` : `<span class="pill off">Rascunho</span>`;
      return `<article class="pub">
        <div>
          <h3>${escapeHtml(f.name)}</h3>
          <p>${f.status === "live" ? "Publicado" : "Atualizado"} ${escapeHtml(when)}</p>
        </div>
        ${badge}
      </article>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function appendChat(kind, text) {
  const log = $("chat-log");
  $("chat-empty")?.remove();
  const b = document.createElement("div");
  b.className = "bub " + kind;
  b.textContent = text;
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
}

function resetChat() {
  state.simState = null;
  $("chat-log").innerHTML =
    `<div class="chat-empty" id="chat-empty"><p>Digite como o cliente. Ex.: “Oi, quero marcar uma sessão”.</p></div>`;
  $("test-now").textContent = "Pronto para a primeira mensagem";
  toast("Simulação recomeçada");
}

async function sendChat(ev) {
  ev.preventDefault();
  const flow = activeFlow();
  const input = $("chat-input");
  const text = (input.value || "").trim();
  if (!text || state.simBusy) return;
  if (!flow?.nodes) {
    appendChat("sys", "Crie um fluxo antes de testar.");
    return;
  }
  input.value = "";
  appendChat("user", text);
  state.simBusy = true;
  $("test-now").textContent = "Pensando…";
  try {
    const data = await api("/v1/flows/simulate", {
      method: "POST",
      body: JSON.stringify({
        flowId: flow.id,
        name: flow.name,
        product: flow.product,
        nodes: flow.nodes,
        edges: flow.edges,
        text,
        state: state.simState,
      }),
    });
    state.simState = data.state || null;
    const last = (data.trace || []).at(-1);
    if (last) {
      const label = { ask: "Perguntando", message: "Enviou texto", llm_intent: "Entendeu a intenção", action: "Rodou uma ação", handoff: "Passou ao atendente", end: "Encerrou" }[last.type] || last.type;
      $("test-now").textContent = last.detail ? `${label} · ${last.detail}` : label;
      appendChat("sys", $("test-now").textContent);
    }
    for (const reply of data.replies || []) appendChat("bot", reply);
    if (data.handoff) appendChat("sys", "Passou para um atendente humano");
    if (!data.replies?.length && !data.trace?.length) appendChat("sys", "Sem resposta do fluxo");
  } catch (e) {
    appendChat("sys", "Erro: " + e.message);
    $("test-now").textContent = "Erro";
    toast(e.message, "err");
  } finally {
    state.simBusy = false;
  }
}

async function refresh() {
  state.portal = await api("/v1/portal");
  render();
  if (state.view === "test") renderTestMeta();
  if (state.view === "pubs") renderPubs();
}

$("btn-connect").onclick = async () => {
  if (!state.accountId) return;
  try {
    await api(`/v1/accounts/${state.accountId}/connect`, { method: "POST", body: "{}" });
    toast("Gerando QR…");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
};
$("btn-disconnect").onclick = async () => {
  if (!state.accountId) return;
  if (!confirm("Desconectar este WhatsApp?")) return;
  try {
    await api(`/v1/accounts/${state.accountId}/disconnect`, { method: "POST", body: "{}" });
    toast("Número desconectado");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
};
$("btn-logout").onclick = async () => {
  sessionStorage.removeItem("glabs_client_id");
  await api("/v1/auth/logout", { method: "POST", body: "{}" });
  location.replace("/admin/login.html");
};
async function loadInbox() {
  try {
    const data = await api("/v1/inbox/threads");
    state.threads = data.threads || [];
    renderThreads();
    if (state.selectedPhone) await loadInboxMessages(state.selectedPhone);
  } catch (e) {
    $("thread-list").innerHTML = `<p class="hint" style="padding:12px">${escapeHtml(e.message)}</p>`;
  }
}

function renderThreads() {
  const q = ($("inbox-q")?.value || "").toLowerCase();
  const list = state.threads.filter(
    (t) =>
      !q ||
      t.contactName.toLowerCase().includes(q) ||
      t.phoneE164.includes(q.replace(/\D/g, ""))
  );
  const el = $("thread-list");
  if (!list.length) {
    el.innerHTML = `<p class="hint" style="padding:14px">Nenhuma conversa ainda. Elas aparecem quando alguém mandar mensagem no número conectado.</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (t) => `<button type="button" class="thread ${t.phoneE164 === state.selectedPhone ? "on" : ""}" data-phone="${escapeHtml(t.phoneE164)}">
        <b>${escapeHtml(t.contactName)}</b>
        <small>${escapeHtml(t.lastPreview)}</small>
        <span class="tag">${t.mode === "human" ? "Você atende" : "Bot"}</span>
      </button>`
    )
    .join("");
  el.querySelectorAll("[data-phone]").forEach((b) => {
    b.onclick = () => loadInboxMessages(b.dataset.phone);
  });
}

async function loadInboxMessages(phone) {
  state.selectedPhone = phone;
  renderThreads();
  const t = state.threads.find((x) => x.phoneE164 === phone);
  $("inbox-title").textContent = t?.contactName || phone;
  $("inbox-sub").textContent = t?.phoneDisplay || phone;
  $("inbox-form").classList.remove("hidden");
  $("btn-bot-mode").classList.remove("hidden");
  $("btn-bot-mode").textContent = t?.mode === "human" ? "Devolver ao bot" : "Atender eu";
  const data = await api(`/v1/inbox/threads/${encodeURIComponent(phone)}/messages`);
  const log = $("inbox-log");
  log.innerHTML = "";
  for (const m of data.messages || []) {
    const kind = m.direction === "in" ? "user" : "bot";
    const b = document.createElement("div");
    b.className = "bub " + kind;
    b.textContent = m.body;
    log.appendChild(b);
  }
  if (!data.messages?.length) {
    log.innerHTML = `<div class="chat-empty"><p>Sem mensagens neste contato.</p></div>`;
  }
  log.scrollTop = log.scrollHeight;
}

$("inbox-q")?.addEventListener("input", renderThreads);
$("inbox-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = state.selectedPhone;
  const input = $("inbox-input");
  const text = (input.value || "").trim();
  if (!phone || !text) return;
  input.value = "";
  try {
    await api("/v1/inbox/send", { method: "POST", body: JSON.stringify({ phone, body: text }) });
    toast("Enviado no WhatsApp");
    await loadInbox();
  } catch (ex) {
    toast(ex.message, "err");
  }
});
$("btn-bot-mode")?.addEventListener("click", async () => {
  const phone = state.selectedPhone;
  if (!phone) return;
  const t = state.threads.find((x) => x.phoneE164 === phone);
  const next = t?.mode === "human" ? "bot" : "human";
  await api("/v1/inbox/mode", { method: "POST", body: JSON.stringify({ phone, mode: next }) });
  toast(next === "bot" ? "Bot voltou a atender" : "Você está atendendo");
  await loadInbox();
});

$("btn-refresh").onclick = async () => {
  await refresh();
  toast("Atualizado");
};
$("test-reset").onclick = () => resetChat();
$("chat-form").onsubmit = sendChat;

document.querySelectorAll("[data-view]").forEach((el) => {
  el.addEventListener("click", () => setView(el.dataset.view));
});
$("back-admin")?.addEventListener("click", () => {
  sessionStorage.removeItem("glabs_client_id");
});

try {
  const me = await api("/v1/auth/me");
  const asAdmin = me.user.role === "glabs";
  if (me.user.mustChangePassword) {
    location.replace("/admin/login.html");
  } else if (asAdmin && !sessionStorage.getItem("glabs_client_id")) {
    location.replace("/admin/");
  } else {
    await refresh();
    const clientName = state.portal?.client?.name || "";
    const person = asAdmin
      ? (me.user.name || me.user.email.split("@")[0] || "GLabs").split(" ")[0]
      : me.user.name && me.user.name !== clientName
        ? me.user.name.split(" ")[0]
        : "";
    state.firstName = person;
    $("who-name").textContent = asAdmin ? (me.user.name || "GLabs") : clientName || me.user.email;
    $("who-av").textContent = (asAdmin ? (me.user.name || "G") : clientName || "C").slice(0, 1).toUpperCase();
    $("who-role").textContent = asAdmin ? "Admin · vendo o cliente" : "Cliente";
    $("hello").textContent = person ? `Olá, ${person}!` : "Olá!";
    setInterval(() => {
      void refresh();
      if (state.view === "inbox") void loadInbox();
    }, 4000);
  }
} catch {
  location.replace("/admin/login.html");
}
