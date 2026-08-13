/**
 * Glabs Bot admin SPA — controla products, accounts e sessões WhatsApp.
 */
const STORAGE_KEY = "glabs_bot_secret";

const state = {
  secret: localStorage.getItem(STORAGE_KEY) || "",
  products: [],
  accounts: [], // { account, session }
  tab: "overview",
  selectedId: null,
  pollTimer: null,
};

// ── DOM ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const viewLogin = $("view-login");
const viewApp = $("view-app");
const loginSecret = $("login-secret");
const loginError = $("login-error");
const globalError = $("global-error");
const toastEl = $("toast");
const drawer = $("account-drawer");
const drawerBackdrop = $("drawer-backdrop");
const drawerBody = $("drawer-body");
const modalAccount = $("modal-account");
const modalProduct = $("modal-product");

// ── API ──────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("accept", "application/json");
  if (state.secret) headers.set("authorization", `Bearer ${state.secret}`);
  if (opts.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...opts, headers, cache: "no-store", credentials: "include" });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(data?.reason || `HTTP ${res.status}`);
  }
  return data;
}

function toast(msg, kind = "ok") {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

function showLogin(err) {
  viewLogin.classList.remove("hidden");
  viewApp.classList.add("hidden");
  stopPoll();
  if (err) {
    loginError.textContent = err;
    loginError.classList.remove("hidden");
  } else {
    loginError.classList.add("hidden");
  }
}

function showApp() {
  viewLogin.classList.add("hidden");
  viewApp.classList.remove("hidden");
}

// ── Data ─────────────────────────────────────────────────
async function loadDashboard() {
  globalError.classList.add("hidden");
  try {
    const health = await fetch("/health").then((r) => r.json()).catch(() => null);
    $("health-label").textContent = health?.ok
      ? `v${health.version || "?"} · online`
      : "offline?";

    const data = await api("/v1/dashboard");
    state.products = data.products || [];
    state.accounts = data.accounts || [];
    render();
    if (state.selectedId) {
      const still = state.accounts.find((a) => a.account.id === state.selectedId);
      if (still) renderDrawer(still);
      else closeDrawer();
    }
  } catch (e) {
    if (e.status === 401) {
      state.secret = "";
      localStorage.removeItem(STORAGE_KEY);
      showLogin("Secret inválido.");
      return;
    }
    globalError.textContent = e.message || "Falha ao carregar";
    globalError.classList.remove("hidden");
  }
}

function counts() {
  const sessions = state.accounts.map((a) => a.session?.status || "disconnected");
  return {
    total: state.accounts.length,
    connected: sessions.filter((s) => s === "connected").length,
    pending: sessions.filter((s) => s === "pending_qr").length,
    products: state.products.length,
  };
}

// ── Render ───────────────────────────────────────────────
function statusPill(status) {
  const s = status || "disconnected";
  const labels = {
    connected: "Conectado",
    pending_qr: "QR",
    disconnected: "Desconectado",
    error: "Erro",
  };
  return `<span class="pill ${s}">${labels[s] || s}</span>`;
}

function accountRow(item) {
  const { account, session } = item;
  const title = account.label || account.externalTenantId;
  const phone = session?.phoneDisplay || session?.phoneE164 || "—";
  return `
    <div class="row" data-open="${account.id}">
      <div>
        <div class="row-title">${escapeHtml(title)}</div>
        <div class="row-meta">
          <span class="pill product">${escapeHtml(account.product)}</span>
          <span>${escapeHtml(phone)}</span>
          <span class="mono dim">${escapeHtml(shortId(account.id))}</span>
        </div>
      </div>
      <div>${statusPill(session?.status)}</div>
    </div>
  `;
}

function renderOverview() {
  const c = counts();
  $("stats-row").innerHTML = `
    <div class="stat"><div class="label">Contas</div><div class="value">${c.total}</div></div>
    <div class="stat"><div class="label">Conectadas</div><div class="value" style="color:var(--wa)">${c.connected}</div></div>
    <div class="stat"><div class="label">Aguardando QR</div><div class="value" style="color:var(--warn)">${c.pending}</div></div>
    <div class="stat"><div class="label">Products</div><div class="value">${c.products}</div></div>
  `;
  const list = state.accounts.slice(0, 12);
  $("overview-accounts").innerHTML = list.length
    ? list.map(accountRow).join("")
    : `<div class="empty">Nenhuma conta ainda. Crie a primeira em Contas.</div>`;
}

function filteredAccounts() {
  const product = ($("filter-product")?.value || "").trim().toLowerCase();
  const status = $("filter-status")?.value || "";
  return state.accounts.filter(({ account, session }) => {
    if (product && !account.product.includes(product) && !(account.label || "").toLowerCase().includes(product)) {
      return false;
    }
    if (status && session?.status !== status) return false;
    return true;
  });
}

function renderAccounts() {
  const list = filteredAccounts();
  $("accounts-list").innerHTML = list.length
    ? list.map(accountRow).join("")
    : `<div class="panel"><div class="empty">Nenhuma conta com esse filtro.</div></div>`;
}

function renderProducts() {
  const html = state.products.length
    ? state.products
        .map((p) => {
          const n = state.accounts.filter((a) => a.account.product === p.slug).length;
          return `
            <div class="row" style="cursor:default">
              <div>
                <div class="row-title">${escapeHtml(p.name)}</div>
                <div class="row-meta">
                  <span class="pill product">${escapeHtml(p.slug)}</span>
                  <span>${n} conta(s)</span>
                  ${p.defaultWebhookUrl ? `<span class="mono dim">${escapeHtml(p.defaultWebhookUrl)}</span>` : `<span class="dim">sem webhook default</span>`}
                </div>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="empty">Nenhum product.</div>`;
  $("products-list").innerHTML = html;

  // fill account modal select
  const sel = $("acc-product");
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = state.products
      .map((p) => `<option value="${escapeAttr(p.slug)}">${escapeHtml(p.name)} (${escapeHtml(p.slug)})</option>`)
      .join("");
    if (cur) sel.value = cur;
  }
}

function render() {
  renderOverview();
  renderAccounts();
  renderProducts();
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.tab);
  });
  ["overview", "accounts", "products", "clients"].forEach((t) => {
    $(`tab-${t}`)?.classList.toggle("hidden", t !== state.tab);
  });
  const titles = {
    overview: ["Overview", "Sessões e saúde do canal"],
    accounts: ["Contas", "Uma conta = um número WhatsApp"],
    products: ["Products", "Apps GLabs que consomem o bot"],
    clients: ["Clientes", "Onboarding e acesso ao portal"],
  };
  $("page-title").textContent = titles[state.tab][0];
  $("page-sub").textContent = titles[state.tab][1];
}

function renderDrawer(item) {
  const { account, session } = item;
  state.selectedId = account.id;
  $("drawer-title").textContent = account.label || account.product;
  $("drawer-id").textContent = account.id;
  drawer.classList.remove("hidden");
  drawerBackdrop.classList.remove("hidden");
  drawer.setAttribute("aria-hidden", "false");

  const st = session?.status || "disconnected";
  const qr =
    st === "pending_qr" && session?.qrDataUrl
      ? `<div class="qr-box">
           <img src="${session.qrDataUrl}" alt="QR Code WhatsApp" />
           <p class="muted sm">WhatsApp → Dispositivos conectados → Conectar dispositivo</p>
         </div>`
      : "";

  drawerBody.innerHTML = `
    <div class="drawer-section">
      <h4>Status</h4>
      <div style="margin-bottom:10px">${statusPill(st)}</div>
      <dl class="kv">
        <dt>Telefone</dt><dd>${escapeHtml(session?.phoneDisplay || session?.phoneE164 || "—")}</dd>
        <dt>Nome WA</dt><dd>${escapeHtml(session?.displayName || "—")}</dd>
        <dt>Desde</dt><dd>${session?.connectedAt ? new Date(session.connectedAt).toLocaleString("pt-BR") : "—"}</dd>
        <dt>Erro</dt><dd>${escapeHtml(session?.lastError || "—")}</dd>
      </dl>
      ${qr}
      <div class="actions-row" style="margin-top:12px">
        ${
          st !== "connected"
            ? `<button type="button" class="btn wa sm" data-act="connect">Conectar / QR</button>`
            : `<button type="button" class="btn danger sm" data-act="disconnect">Desconectar</button>`
        }
        <button type="button" class="btn secondary sm" data-act="refresh-one">Atualizar</button>
      </div>
    </div>

    <div class="drawer-section">
      <h4>Account</h4>
      <dl class="kv">
        <dt>Product</dt><dd><span class="pill product">${escapeHtml(account.product)}</span></dd>
        <dt>Tenant</dt><dd class="mono">${escapeHtml(account.externalTenantId)}</dd>
        <dt>Webhook</dt><dd class="mono">${escapeHtml(account.webhookUrl)}</dd>
        <dt>Label</dt><dd>${escapeHtml(account.label || "—")}</dd>
      </dl>
      <label class="field" style="margin-top:12px">
        <span>Webhook URL</span>
        <input id="edit-webhook" class="input" value="${escapeAttr(account.webhookUrl)}" />
      </label>
      <label class="field">
        <span>Label</span>
        <input id="edit-label" class="input" value="${escapeAttr(account.label || "")}" />
      </label>
      <button type="button" class="btn secondary sm" data-act="save-meta">Salvar metadados</button>
    </div>

    ${
      st === "connected"
        ? `
    <div class="drawer-section">
      <h4>Enviar teste</h4>
      <label class="field"><span>Telefone (DDI)</span><input id="send-to" class="input" placeholder="+34 612 345 678" /></label>
      <label class="field"><span>Mensagem</span><textarea id="send-body" class="input" rows="3">Olá! Teste Glabs Bot.</textarea></label>
      <button type="button" class="btn primary sm" data-act="send">Enviar</button>
    </div>
    <div class="drawer-section">
      <h4>Perfil do número</h4>
      <label class="field"><span>Nome</span><input id="prof-name" class="input" value="${escapeAttr(session?.displayName || account.label || "")}" /></label>
      <label class="field"><span>Recado</span><input id="prof-status" class="input" placeholder="Atendimento" /></label>
      <label class="field"><span>Foto (JPEG/PNG)</span><input id="prof-pic" type="file" accept="image/*" /></label>
      <div class="actions-row">
        <button type="button" class="btn secondary sm" data-act="profile">Salvar perfil</button>
        <button type="button" class="btn ghost sm" data-act="remove-pic">Remover foto</button>
      </div>
    </div>`
        : ""
    }

    <div class="drawer-section">
      <h4>Perigo</h4>
      <button type="button" class="btn danger sm" data-act="delete">Remover conta do bot</button>
    </div>
  `;
}

function closeDrawer() {
  state.selectedId = null;
  drawer.classList.add("hidden");
  drawerBackdrop.classList.add("hidden");
  drawer.setAttribute("aria-hidden", "true");
}

// ── Polling (QR) ─────────────────────────────────────────
function startPoll() {
  stopPoll();
  state.pollTimer = setInterval(() => {
    const needs =
      state.selectedId &&
      state.accounts.some(
        (a) =>
          a.account.id === state.selectedId &&
          (a.session?.status === "pending_qr" ||
            (a.session?.status === "disconnected" &&
              a.session?.lastError?.includes("Reconectando")))
      );
    if (needs || document.visibilityState === "visible") {
      void loadDashboard();
    }
  }, 2500);
}

function stopPoll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

// ── Actions ──────────────────────────────────────────────
async function openAccount(id) {
  const item = state.accounts.find((a) => a.account.id === id);
  if (!item) return;
  renderDrawer(item);
  // refresh single
  try {
    const data = await api(`/v1/accounts/${id}`);
    const idx = state.accounts.findIndex((a) => a.account.id === id);
    if (idx >= 0) {
      state.accounts[idx] = { account: data.account, session: data.session };
      renderDrawer(state.accounts[idx]);
      render();
    }
  } catch (e) {
    toast(e.message, "bad");
  }
}

async function handleDrawerAction(act) {
  const id = state.selectedId;
  if (!id) return;
  try {
    if (act === "connect") {
      await api(`/v1/accounts/${id}/connect`, { method: "POST" });
      toast("Conectando…");
    } else if (act === "disconnect") {
      if (!confirm("Desconectar e apagar credenciais desta sessão?")) return;
      await api(`/v1/accounts/${id}/disconnect`, { method: "POST" });
      toast("Desconectado");
    } else if (act === "refresh-one") {
      /* fallthrough to load */
    } else if (act === "save-meta") {
      const webhookUrl = $("edit-webhook").value.trim();
      const label = $("edit-label").value.trim() || null;
      await api(`/v1/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl, label }),
      });
      toast("Metadados salvos");
    } else if (act === "send") {
      const to = $("send-to").value.trim();
      const body = $("send-body").value.trim();
      const res = await api(`/v1/accounts/${id}/send`, {
        method: "POST",
        body: JSON.stringify({ to, body }),
      });
      toast(res.externalId ? `Enviado · ${res.externalId}` : "Enviado");
    } else if (act === "profile" || act === "remove-pic") {
      const payload = {
        displayName: $("prof-name")?.value?.trim() || undefined,
        status: $("prof-status")?.value?.trim() || undefined,
      };
      if (act === "remove-pic") {
        payload.removePicture = true;
      } else {
        const file = $("prof-pic")?.files?.[0];
        if (file) {
          payload.pictureBase64 = await fileToBase64(file);
        }
      }
      await api(`/v1/accounts/${id}/profile`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("Perfil atualizado");
    } else if (act === "delete") {
      if (!confirm("Remover account do registry e desconectar sessão?")) return;
      await api(`/v1/accounts/${id}`, { method: "DELETE" });
      toast("Conta removida");
      closeDrawer();
    }
    await loadDashboard();
  } catch (e) {
    toast(e.message, "bad");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Utils ────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function shortId(id) {
  return id?.slice(0, 8) + "…" || "";
}

// ── Events ───────────────────────────────────────────────
$("login-btn").addEventListener("click", async () => {
  const secret = loginSecret.value.trim();
  if (!secret) {
    loginError.textContent = "Informe o secret.";
    loginError.classList.remove("hidden");
    return;
  }
  state.secret = secret;
  try {
    await api("/v1/dashboard");
    localStorage.setItem(STORAGE_KEY, secret);
    showApp();
    await loadDashboard();
    startPoll();
  } catch (e) {
    state.secret = "";
    loginError.textContent = e.message === "unauthorized" ? "Secret inválido." : e.message;
    loginError.classList.remove("hidden");
  }
});

loginSecret.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("login-btn").click();
});

$("logout-btn").addEventListener("click", async () => {
  state.secret = "";
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem("glabs_client_id");
  try {
    await fetch("/v1/auth/logout", { method: "POST", credentials: "include", body: "{}" });
  } catch {
    /* ignore */
  }
  location.replace("/admin/login.html");
});

$("refresh-btn").addEventListener("click", () => void loadDashboard());

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    render();
  });
});

document.addEventListener("click", (e) => {
  const open = e.target.closest?.("[data-open]");
  if (open) {
    void openAccount(open.dataset.open);
    return;
  }
  const act = e.target.closest?.("[data-act]");
  if (act && drawer.contains(act)) {
    void handleDrawerAction(act.dataset.act);
  }
});

$("drawer-close").addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

$("filter-product").addEventListener("input", renderAccounts);
$("filter-status").addEventListener("change", renderAccounts);

$("new-account-btn").addEventListener("click", () => {
  state.tab = "accounts";
  render();
  modalAccount.showModal();
});

$("new-product-btn").addEventListener("click", () => modalProduct.showModal());

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog")?.close());
});

$("form-account").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("acc-form-err");
  err.classList.add("hidden");
  try {
    await api("/v1/accounts", {
      method: "POST",
      body: JSON.stringify({
        product: $("acc-product").value,
        externalTenantId: $("acc-tenant").value.trim(),
        webhookUrl: $("acc-webhook").value.trim(),
        label: $("acc-label").value.trim() || null,
      }),
    });
    modalAccount.close();
    toast("Conta criada / atualizada");
    $("acc-tenant").value = "";
    $("acc-webhook").value = "";
    $("acc-label").value = "";
    await loadDashboard();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
});

$("form-product").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("prod-form-err");
  err.classList.add("hidden");
  try {
    await api("/v1/products", {
      method: "POST",
      body: JSON.stringify({
        slug: $("prod-slug").value.trim(),
        name: $("prod-name").value.trim() || undefined,
        defaultWebhookUrl: $("prod-webhook").value.trim() || null,
      }),
    });
    modalProduct.close();
    toast("Product salvo");
    $("prod-slug").value = "";
    $("prod-name").value = "";
    $("prod-webhook").value = "";
    await loadDashboard();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
});

async function loadClients() {
  const list = $("clients-list");
  if (!list) return;
  try {
    const data = await api("/v1/clients");
    const clients = data.clients || [];
    if (!clients.length) {
      list.innerHTML = `<p class="muted">Nenhum cliente ainda. Crie o primeiro para mandar o acesso.</p>`;
      return;
    }
    list.innerHTML = clients
      .map(
        (c) => `<div class="account-card">
          <div>
            <strong>${escapeHtml(c.name)}</strong>
            <div class="muted sm mono">${escapeHtml(c.slug)}</div>
          </div>
          <button type="button" class="btn secondary sm" data-open-portal="${escapeAttr(c.id)}">Abrir projeto</button>
        </div>`
      )
      .join("");
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-open-portal]");
  if (!btn) return;
  sessionStorage.setItem("glabs_client_id", btn.dataset.openPortal);
  location.href = "/admin/portal.html";
});

$("new-client-btn")?.addEventListener("click", () => $("modal-client")?.showModal());

$("form-client")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("client-form-err");
  err?.classList.add("hidden");
  try {
    const data = await api("/v1/clients", {
      method: "POST",
      body: JSON.stringify({
        name: $("cli-name").value.trim(),
        email: $("cli-email").value.trim(),
        template: $("cli-template").value,
      }),
    });
    $("modal-client").close();
    const pass = data.tempPassword;
    toast(`Cliente criado. Senha temporária: ${pass}`);
    alert(
      `Cliente: ${data.client.name}\nE-mail: ${data.user.email}\nSenha temporária: ${pass}\n\nMande isso para o cliente. Ele troca no primeiro acesso.`
    );
    $("cli-name").value = "";
    $("cli-email").value = "";
    await loadClients();
  } catch (ex) {
    if (err) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } else toast(ex.message, "err");
  }
});

// ── Boot ─────────────────────────────────────────────────
async function boot() {
  try {
    const me = await fetch("/v1/auth/me", { credentials: "include", cache: "no-store" }).then((r) =>
      r.ok ? r.json() : null
    );
    if (me?.user?.role === "client") {
      location.replace("/admin/portal.html");
      return;
    }
    if (me?.user?.role === "glabs") {
      showApp();
      await loadDashboard();
      await loadClients();
      startPoll();
      return;
    }
  } catch {
    /* cai no secret/login */
  }

  if (!state.secret) {
    location.replace("/admin/login.html");
    return;
  }
  try {
    await api("/v1/dashboard");
    showApp();
    await loadDashboard();
    startPoll();
  } catch {
    state.secret = "";
    localStorage.removeItem(STORAGE_KEY);
    location.replace("/admin/login.html");
  }
}

void boot();
