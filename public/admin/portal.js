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

const state = { portal: null, accountId: null, view: "status" };

function setView(view) {
  state.view = view;
  document.querySelectorAll(".rail-btn[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
  });
  document.querySelectorAll(".row-card[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
  });
  const status = $("view-status");
  const flow = $("view-flow");
  if (view === "flow") {
    status.classList.add("hidden");
    flow.classList.remove("hidden");
    if (!flow.src) flow.src = "/admin/flows.html?embed=1";
    $("stage-title").textContent = "Fluxo";
    $("stage-sub").textContent = "Edite, teste e publique o atendimento";
  } else {
    flow.classList.add("hidden");
    status.classList.remove("hidden");
    $("stage-title").textContent = "WhatsApp";
    $("stage-sub").textContent = "Conecte o número e acompanhe o que está no ar";
  }
}

function pill(status) {
  const el = $("conn-pill");
  if (status === "connected") {
    el.className = "pill ok";
    el.textContent = "conectado";
  } else if (status === "pending_qr") {
    el.className = "pill warn";
    el.textContent = "aguardando QR";
  } else {
    el.className = "pill off";
    el.textContent = status === "error" ? "erro" : "desconectado";
  }
}

function render() {
  const p = state.portal;
  if (!p) return;
  $("client-name").textContent = p.client.name;
  $("client-sub").textContent = p.impersonating ? "visão admin · " + p.client.slug : p.client.slug;
  $("impersonate").classList.toggle("hidden", !p.impersonating);

  const acc = p.accounts[0];
  const sess = acc?.session;
  state.accountId = acc?.account?.id || null;
  pill(sess?.status || "disconnected");
  $("row-wa").textContent = sess?.phoneDisplay || sess?.status || "não conectado";
  $("st-phone").textContent = sess?.phoneDisplay || "—";
  $("st-status").textContent = sess?.status || "—";
  $("st-live").textContent = p.liveFlow?.name || "Nenhum publicado";
  $("st-updated").textContent = p.liveFlow?.publishedAt
    ? new Date(p.liveFlow.publishedAt).toLocaleString("pt-BR")
    : p.liveFlow?.updatedAt
      ? new Date(p.liveFlow.updatedAt).toLocaleString("pt-BR")
      : "—";
  $("row-flow").textContent = p.liveFlow ? `no ar · ${p.liveFlow.name}` : "rascunho";

  const box = $("qr-box");
  box.innerHTML = "";
  if (sess?.status === "connected") {
    $("qr-title").textContent = "WhatsApp conectado";
    $("qr-hint").textContent = "Pode testar o fluxo. Se cair, gere um QR de novo.";
  } else if (sess?.qrDataUrl) {
    $("qr-title").textContent = "Escaneie o QR";
    $("qr-hint").textContent = "WhatsApp → Aparelhos conectados → Conectar um aparelho.";
    const img = document.createElement("img");
    img.src = sess.qrDataUrl;
    img.alt = "QR Code WhatsApp";
    box.appendChild(img);
  } else {
    $("qr-title").textContent = "Conectar WhatsApp";
    $("qr-hint").textContent = "Clique em Gerar QR e aponte a câmera do celular.";
  }
}

async function refresh() {
  state.portal = await api("/v1/portal");
  render();
}

$("btn-connect").onclick = async () => {
  if (!state.accountId) return;
  await api(`/v1/accounts/${state.accountId}/connect`, { method: "POST", body: "{}" });
  await refresh();
};
$("btn-disconnect").onclick = async () => {
  if (!state.accountId) return;
  if (!confirm("Desconectar este WhatsApp?")) return;
  await api(`/v1/accounts/${state.accountId}/disconnect`, { method: "POST", body: "{}" });
  await refresh();
};
$("btn-logout").onclick = async () => {
  sessionStorage.removeItem("glabs_client_id");
  await api("/v1/auth/logout", { method: "POST", body: "{}" });
  location.replace("/admin/login.html");
};

document.querySelectorAll("[data-view]").forEach((el) => {
  el.addEventListener("click", () => setView(el.dataset.view));
});

try {
  const me = await api("/v1/auth/me");
  if (me.user.mustChangePassword) {
    location.replace("/admin/login.html");
  } else if (me.user.role === "glabs" && !sessionStorage.getItem("glabs_client_id")) {
    location.replace("/admin/");
  } else {
    await refresh();
    setInterval(refresh, 4000);
  }
} catch {
  location.replace("/admin/login.html");
}
