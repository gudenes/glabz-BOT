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

const WELCOME =
  "Oi. Isto ainda não é o bot no ar — é só o briefing. Me conta o negócio e o que o atendimento precisa fazer. Quando já tiver o essencial, a gente testa o tom e só então monta o fluxo.";

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
  studio: {
    open: false,
    expanded: true,
    busy: false,
    phase: "ask",
    messages: [],
    previewTurns: 0,
    rec: null,
  },
  waBoot: { running: false, done: false },
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
    syncFlowPane();
    if (!hasOwnFlows()) {
      $("stage-sub").textContent = "Briefing — ensaio curto, depois a gente desenha o fluxo";
    }
  }
  else hideStudioChrome();
  if (view === "test") renderTestMeta();
  if (view === "pubs") renderPubs();
  if (view === "inbox") void loadInbox();
}

function hasOwnFlows() {
  return (state.portal?.flows || []).length > 0;
}

function openBuilder() {
  const frame = $("flow-frame");
  frame?.classList.remove("hidden");
  const cid = sessionStorage.getItem("glabs_client_id") || state.portal?.client?.id || "";
  if (frame) {
    frame.dataset.loaded = "1";
    frame.src = `/admin/flows.html?embed=1&client=${encodeURIComponent(cid)}&v=15`;
  }
}

function hideStudioChrome() {
  $("btn-wizard")?.classList.add("hidden");
  $("btn-studio-expand")?.classList.add("hidden");
}

function studioLayout() {
  const pane = $("view-flow");
  const studio = $("flow-studio");
  const frame = $("flow-frame");
  const first = !hasOwnFlows();
  const open = first || state.studio.open;
  const expanded = first || state.studio.expanded;

  studio?.classList.toggle("hidden", !open);
  pane?.classList.toggle("studio-only", first);
  pane?.classList.toggle("has-canvas", !first);
  pane?.classList.toggle("studio-full", open && expanded);
  pane?.classList.toggle("studio-split", false);

  if (first) {
    frame?.classList.add("hidden");
  } else if (open && expanded) {
    frame?.classList.add("hidden");
  } else {
    if (frame?.dataset.loaded !== "1") openBuilder();
    else frame?.classList.remove("hidden");
  }

  $("studio-close")?.classList.toggle("hidden", first || !open);
  $("studio-expand")?.classList.toggle("hidden", first);
  $("studio-alts")?.classList.toggle("hidden", hasOwnFlows());
  $("btn-wizard")?.classList.toggle("hidden", state.view !== "flow" || first || open);
  $("btn-studio-expand")?.classList.toggle("hidden", state.view !== "flow" || !open || first);
  $("btn-studio-expand").textContent = expanded ? "Recolher" : "Expandir";
  $("studio-expand").textContent = expanded && !first ? "Recolher" : "Expandir";
  const phase = state.studio.phase;
  const kick =
    phase === "ready"
      ? ["Pronto", "ready"]
      : phase === "debrief"
        ? ["Depois do ensaio", "ready"]
        : phase === "preview"
          ? ["Ensaio", "preview"]
          : phase === "offer"
            ? ["Vamos testar?", "preview"]
            : ["Briefing", ""];
  $("studio-kicker").textContent = kick[0];
  $("studio-kicker").className = "studio-kicker" + (kick[1] ? " " + kick[1] : "");
  $("studio-title").textContent =
    phase === "preview"
      ? "Ensaio do tom"
      : phase === "offer"
        ? "Já tenho o essencial"
        : phase === "debrief" || phase === "ready"
          ? "Feedback do ensaio"
          : "Montar o atendimento";
  $("studio-sub").textContent =
    phase === "preview"
      ? "Fala como o cliente. Pedido de mudança no fluxo só depois — agora é só o tom."
      : phase === "offer"
        ? "Se estiver bom, a gente testa o tom. Se faltar algo, continua o briefing."
        : phase === "debrief" || phase === "ready"
          ? "O ensaio acabou. Agora sim: muda o tom ou monta o fluxo."
          : "Ainda não é o bot no ar. Combinamos o que ele deve fazer; depois testamos o tom e montamos o fluxo.";
  $("studio-offer")?.classList.toggle("hidden", phase !== "offer" || state.studio.busy);
  $("studio-ready")?.classList.toggle(
    "hidden",
    (phase !== "debrief" && phase !== "ready") || state.studio.busy
  );
}

function syncFlowPane() {
  if (!hasOwnFlows()) {
    state.studio.open = true;
    state.studio.expanded = true;
    ensureStudioWelcome();
  }
  studioLayout();
}

function ensureStudioWelcome() {
  if (state.studio.messages.length) return;
  studioSay(WELCOME, "coach");
}

function waHtml(text) {
  const esc = escapeHtml(text);
  return esc
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>");
}

function startWaBoot(sess) {
  if (state.waBoot.running || state.waBoot.done) return;
  state.waBoot.running = true;
  const items = [...document.querySelectorAll("#wa-checks li")];
  items.forEach((li) => li.classList.remove("on", "done"));
  $("wa-boot")?.classList.remove("hidden");
  $("wa-hero")?.classList.add("booting");
  $("wa-boot-kicker").textContent = "Ligando";
  $("btn-go-flow")?.classList.add("hidden");
  $("btn-connect")?.classList.add("hidden");
  $("qr-kicker").textContent = "Ligando o número";
  $("qr-kicker").className = "hero-kicker";
  $("qr-title").textContent = "O sistema está fechando os checks…";
  $("qr-hint").textContent = "Isso leva uns segundos. Não fecha a aba.";
  let i = 0;
  const step = () => {
    if (!state.waBoot.running && !state.waBoot.done) return;
    if (i > 0) {
      items[i - 1].classList.remove("on");
      items[i - 1].classList.add("done");
    }
    if (i < items.length) {
      items[i].classList.add("on");
      i += 1;
      setTimeout(step, 860);
      return;
    }
    state.waBoot.running = false;
    state.waBoot.done = true;
    $("wa-boot-kicker").textContent = "Pronto";
    $("qr-kicker").textContent = "Conectado";
    $("qr-kicker").className = "hero-kicker ok";
    $("qr-title").textContent = "Tudo certo. Ponto para começar?";
    $("qr-hint").textContent = sess?.phoneDisplay
      ? `${sess.phoneDisplay} ligado — pode montar o atendimento.`
      : "Número ligado — pode montar o atendimento.";
    $("btn-go-flow")?.classList.remove("hidden");
    $("btn-connect")?.classList.remove("hidden");
    $("btn-connect").textContent = "Gerar novo QR";
    toast("Tudo certo. Ponto para começar?");
  };
  setTimeout(step, 420);
}

function wrapFmt(kind) {
  const el = $("inbox-input");
  if (!el) return;
  const s = el.selectionStart ?? 0;
  const e = el.selectionEnd ?? 0;
  const t = el.value;
  const mark = kind === "bold" ? "*" : "_";
  el.value = t.slice(0, s) + mark + t.slice(s, e) + mark + t.slice(e);
  el.focus();
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
  const prevWa = state.lastWa;
  if (prevWa && prevWa !== wa) {
    if (wa === "pending_qr") toast("QR pronto — aponte a câmera do celular");
    if (wa === "disconnected" && prevWa === "connected") {
      state.waBoot = { running: false, done: false };
      toast("WhatsApp desconectado");
    }
  }
  const justPaired = wa === "connected" && prevWa === "pending_qr";
  state.lastWa = wa;
  pill(wa);
  if (justPaired) startWaBoot(sess);

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

  $("btn-go-flow")?.classList.toggle("hidden", wa !== "connected" || state.waBoot.running);
  $("wa-boot")?.classList.toggle("hidden", !state.waBoot.running && !(wa === "connected" && state.waBoot.done));
  $("wa-hero")?.classList.toggle("booting", state.waBoot.running || (wa === "connected" && state.waBoot.done));

  if (state.waBoot.running) {
    $("qr-kicker").textContent = "Ligando o número";
    $("qr-kicker").className = "hero-kicker";
    $("qr-title").textContent = "O sistema está fechando os checks…";
    $("qr-hint").textContent = "Isso leva uns segundos. Não fecha a aba.";
    $("btn-connect").classList.add("hidden");
    return;
  }

  $("btn-connect")?.classList.remove("hidden");

  if (sess?.status === "connected") {
    $("qr-kicker").textContent = "Conectado";
    $("qr-kicker").className = "hero-kicker ok";
    $("qr-title").textContent = state.waBoot.done
      ? "Tudo certo. Ponto para começar?"
      : "Seu número está conectado e pronto para receber mensagens.";
    $("qr-hint").textContent = sess.connectedAt
      ? `Conectado desde ${fmtWhen(sess.connectedAt)}`
      : "Pode montar o fluxo. Se cair, gere um QR de novo.";
    $("btn-connect").textContent = "Gerar novo QR";
    $("wa-boot-kicker").textContent = "Pronto";
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

$("btn-go-flow")?.addEventListener("click", () => setView("flow"));

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
    b.innerHTML = waHtml(m.body);
    log.appendChild(b);
  }
  if (!data.messages?.length) {
    log.innerHTML = `<div class="chat-empty"><p>Sem mensagens neste contato.</p></div>`;
  }
  log.scrollTop = log.scrollHeight;
}

$("new-chat")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = $("new-phone").value.trim();
  if (!phone) return;
  const digits = phone.replace(/\D/g, "");
  $("new-phone").value = "";
  if (!state.threads.some((t) => t.phoneE164 === digits)) {
    state.threads.unshift({
      phoneE164: digits || phone,
      phoneDisplay: phone,
      contactName: phone,
      lastPreview: "Nova conversa",
      lastMessageAt: new Date().toISOString(),
      mode: "human",
    });
  }
  await loadInboxMessages(digits || phone);
  $("inbox-input")?.focus();
  toast("Escreva a mensagem e envie");
});
$("inbox-q")?.addEventListener("input", renderThreads);
document.querySelectorAll("[data-fmt]").forEach((b) => {
  b.addEventListener("click", () => wrapFmt(b.dataset.fmt));
});
$("inbox-file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  const phone = state.selectedPhone;
  if (!file || !phone) return;
  if (file.size > 7_500_000) {
    toast("Arquivo grande demais (máx. 7 MB)", "err");
    return;
  }
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (const x of bytes) bin += String.fromCharCode(x);
  const base64 = btoa(bin);
  const kind = file.type.startsWith("image/") ? "image" : "document";
  try {
    await api("/v1/inbox/send", {
      method: "POST",
      body: JSON.stringify({
        phone,
        body: file.name,
        media: { base64, mimetype: file.type || "application/octet-stream", fileName: file.name, kind },
      }),
    });
    toast("Arquivo enviado");
    await loadInbox();
  } catch (ex) {
    toast(ex.message, "err");
  }
});
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

function studioSay(text, who = "coach") {
  const log = $("studio-log");
  if (!log) return;
  const b = document.createElement("div");
  b.className = "bub " + who;
  b.innerHTML = waHtml(text);
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
  return b;
}

function studioThink(label = "Pensando") {
  const log = $("studio-log");
  if (!log) return null;
  const row = document.createElement("div");
  row.className = "think";
  row.innerHTML = `<span class="think-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${label}</span>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

function openStudio({ expand = true } = {}) {
  state.studio.open = true;
  state.studio.expanded = expand || !hasOwnFlows();
  ensureStudioWelcome();
  studioLayout();
  $("studio-input")?.focus();
}

function closeStudio() {
  if (!hasOwnFlows()) return;
  state.studio.open = false;
  studioLayout();
}

function toggleStudioExpand() {
  if (!hasOwnFlows()) return;
  state.studio.expanded = !state.studio.expanded;
  studioLayout();
}

function studioHistory() {
  return state.studio.messages.map((m) => ({ role: m.role, content: m.content }));
}

async function applyStudioReply(data) {
  if (data.say) {
    const who = data.as === "bot" ? "bot" : "coach";
    studioSay(data.say, who);
    state.studio.messages.push({ role: "assistant", content: data.say, as: who });
  }
  if (data.phase) state.studio.phase = data.phase;
}

async function revealBuiltFlow() {
  state.studio.phase = "ready";
  toast("Fluxo pronto — o canvas está inteiro para revisar");
  await refresh();
  state.studio.open = false;
  state.studio.expanded = false;
  openBuilder();
  studioLayout();
}

async function sendStudio(_text, action = "chat") {
  if (state.studio.busy) return;
  const pending = studioThink(
    action === "build" ? "Montando o fluxo" : action === "test" ? "Abrindo o ensaio" : "Pensando"
  );
  state.studio.busy = true;
  studioLayout();
  $("studio-form")?.querySelector("button")?.setAttribute("disabled", "true");
  $("studio-build")?.setAttribute("disabled", "true");
  $("studio-test")?.setAttribute("disabled", "true");
  try {
    const data = await api("/v1/flows/studio", {
      method: "POST",
      body: JSON.stringify({
        messages: studioHistory(),
        action,
        phase: state.studio.phase,
      }),
    });
    pending?.remove();
    await applyStudioReply(data);
    if (data.kind === "flow") {
      await revealBuiltFlow();
      return;
    }
    if (data.phase === "preview") {
      state.studio.previewTurns += 1;
      if (state.studio.previewTurns >= 2) {
        state.studio.phase = "debrief";
        studioSay("Ensaio encerrado. Agora o que você falar vale como ajuste — ou a gente monta o fluxo.", "sys");
      }
    }
    studioLayout();
  } catch (ex) {
    pending?.remove();
    studioSay("Não deu: " + ex.message, "sys");
    toast(ex.message, "err");
  } finally {
    state.studio.busy = false;
    $("studio-form")?.querySelector("button")?.removeAttribute("disabled");
    $("studio-build")?.removeAttribute("disabled");
    $("studio-test")?.removeAttribute("disabled");
    studioLayout();
  }
}

$("btn-collapse-side")?.addEventListener("click", () => {
  const app = document.querySelector(".app");
  const on = app.classList.toggle("side-collapsed");
  localStorage.setItem("glabs_side_collapsed", on ? "1" : "0");
  $("btn-collapse-side").textContent = on ? "›" : "‹";
  $("btn-collapse-side").title = on ? "Abrir menu" : "Recolher menu";
});
if (localStorage.getItem("glabs_side_collapsed") === "1") {
  document.querySelector(".app")?.classList.add("side-collapsed");
  if ($("btn-collapse-side")) $("btn-collapse-side").textContent = "›";
}

$("btn-wizard")?.addEventListener("click", () => openStudio({ expand: false }));
$("btn-studio-expand")?.addEventListener("click", toggleStudioExpand);
$("studio-expand")?.addEventListener("click", toggleStudioExpand);
$("studio-close")?.addEventListener("click", closeStudio);
$("start-tpl")?.addEventListener("click", () => $("tpl-pick")?.classList.toggle("hidden"));
$("start-blank")?.addEventListener("click", () => useTemplate("blank"));
$("tpl-pick")?.querySelectorAll("[data-tpl]").forEach((b) => {
  b.addEventListener("click", () => useTemplate(b.dataset.tpl));
});
async function useTemplate(kind) {
  try {
    await api("/v1/flows/from-template", { method: "POST", body: JSON.stringify({ template: kind }) });
    toast("Template pronto");
    await refresh();
    state.studio.open = false;
    openBuilder();
    studioLayout();
  } catch (e) {
    toast(e.message, "err");
  }
}
$("studio-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("studio-input");
  const text = (input.value || "").trim();
  if (!text || state.studio.busy) return;
  input.value = "";
  studioSay(text, "user");
  state.studio.messages.push({ role: "user", content: text });
  await sendStudio(text, "chat");
});
$("studio-build")?.addEventListener("click", async () => {
  if (state.studio.busy) return;
  await sendStudio("", "build");
});
$("studio-test")?.addEventListener("click", async () => {
  if (state.studio.busy) return;
  studioSay("Vamos testar agora", "user");
  state.studio.messages.push({ role: "user", content: "Vamos testar agora" });
  state.studio.previewTurns = 0;
  await sendStudio("Vamos testar agora", "test");
});

function stopStudioMic() {
  try {
    state.studio.rec?.stop();
  } catch {
    /* ignore */
  }
  state.studio.rec = null;
  $("studio-mic")?.classList.remove("on");
}

$("studio-mic")?.addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("Áudio não roda neste navegador — tenta o Chrome", "err");
    return;
  }
  if (state.studio.rec) {
    stopStudioMic();
    return;
  }
  const rec = new SR();
  rec.lang = "pt-BR";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (ev) => {
    let t = "";
    for (const r of ev.results) t += r[0].transcript;
    if ($("studio-input")) $("studio-input").value = t;
  };
  rec.onend = () => {
    const wasOn = Boolean(state.studio.rec);
    stopStudioMic();
    const text = ($("studio-input")?.value || "").trim();
    if (wasOn && text && !state.studio.busy) $("studio-form")?.requestSubmit();
  };
  rec.onerror = () => {
    stopStudioMic();
    toast("Não deu para ouvir — tenta de novo", "err");
  };
  state.studio.rec = rec;
  $("studio-mic")?.classList.add("on");
  rec.start();
});

window.addEventListener("message", async (ev) => {
  if (ev.data?.type !== "glabs-flows-changed") return;
  await refresh();
  if (!hasOwnFlows()) {
    state.studio.open = true;
    state.studio.expanded = true;
    const frame = $("flow-frame");
    if (frame) {
      frame.dataset.loaded = "";
      frame.src = "about:blank";
      frame.classList.add("hidden");
    }
    ensureStudioWelcome();
  }
  studioLayout();
});

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
