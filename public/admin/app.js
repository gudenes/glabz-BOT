/**
 * Glabs Bot admin SPA — controla products, accounts e sessões WhatsApp.
 */
import { applyStaticTranslations, mountLangToggle, t } from "./i18n.js";

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

applyStaticTranslations();
mountLangToggle($("lang-toggle-slot"));

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
      showLogin(t("admin.login.invalidSecret"));
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
    connected: t("admin.accounts.status.connected"),
    pending_qr: "QR",
    disconnected: t("admin.accounts.status.disconnected"),
    error: t("admin.accounts.status.error"),
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
    <div class="stat"><div class="label">${t("admin.overview.stat.accounts")}</div><div class="value">${c.total}</div></div>
    <div class="stat"><div class="label">${t("admin.overview.stat.connected")}</div><div class="value" style="color:var(--wa)">${c.connected}</div></div>
    <div class="stat"><div class="label">${t("admin.overview.stat.pendingQr")}</div><div class="value" style="color:var(--warn)">${c.pending}</div></div>
    <div class="stat"><div class="label">${t("admin.overview.stat.products")}</div><div class="value">${c.products}</div></div>
  `;
  const list = state.accounts.slice(0, 12);
  $("overview-accounts").innerHTML = list.length
    ? list.map(accountRow).join("")
    : `<div class="empty">${t("admin.overview.empty")}</div>`;
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
    : `<div class="panel"><div class="empty">${t("admin.accounts.emptyFiltered")}</div></div>`;
}

const DEFAULT_PRODUCT_SLUGS = ["gestor", "prontuario"];

function renderProducts() {
  const html = state.products.length
    ? state.products
        .map((p) => {
          const n = state.accounts.filter((a) => a.account.product === p.slug).length;
          const isDefault = DEFAULT_PRODUCT_SLUGS.includes(p.slug);
          return `
            <div class="row" style="cursor:default">
              <div>
                <div class="row-title">${escapeHtml(p.name)}</div>
                <div class="row-meta">
                  <span class="pill product">${escapeHtml(p.slug)}</span>
                  <span>${t("admin.products.accountsCount", { n })}</span>
                  ${p.defaultWebhookUrl ? `<span class="mono dim">${escapeHtml(p.defaultWebhookUrl)}</span>` : `<span class="dim">${t("admin.products.noDefaultWebhook")}</span>`}
                </div>
              </div>
              ${
                isDefault
                  ? ""
                  : `<button type="button" class="btn danger sm" data-del-product="${escapeAttr(p.slug)}" title="${t("admin.products.remove")}">${t("admin.products.remove")}</button>`
              }
            </div>
          `;
        })
        .join("")
    : `<div class="empty">${t("admin.products.empty")}</div>`;
  $("products-list").innerHTML = html;

  $("products-list").querySelectorAll("[data-del-product]").forEach((btn) => {
    btn.onclick = async () => {
      const slug = btn.dataset.delProduct;
      if (!confirm(t("admin.products.confirmRemove", { slug }))) return;
      try {
        await api(`/v1/products/${encodeURIComponent(slug)}`, { method: "DELETE" });
        toast(t("admin.products.toast.removed"));
        await loadDashboard();
      } catch (e) {
        toast(e.message, "err");
      }
    };
  });

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
    overview: [t("admin.title.overview"), t("admin.sub.overview")],
    accounts: [t("admin.title.accounts"), t("admin.sub.accounts")],
    products: [t("admin.title.products"), t("admin.sub.products")],
    clients: [t("admin.title.clients"), t("admin.sub.clients")],
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
           <p class="muted sm">${t("admin.drawer.qrHint")}</p>
         </div>`
      : "";

  drawerBody.innerHTML = `
    <div class="drawer-section">
      <h4>${t("admin.drawer.status")}</h4>
      <div style="margin-bottom:10px">${statusPill(st)}</div>
      <dl class="kv">
        <dt>${t("admin.drawer.phone")}</dt><dd>${escapeHtml(session?.phoneDisplay || session?.phoneE164 || "—")}</dd>
        <dt>${t("admin.drawer.waName")}</dt><dd>${escapeHtml(session?.displayName || "—")}</dd>
        <dt>${t("admin.drawer.since")}</dt><dd>${session?.connectedAt ? new Date(session.connectedAt).toLocaleString("pt-BR") : "—"}</dd>
        <dt>${t("admin.drawer.error")}</dt><dd>${escapeHtml(session?.lastError || "—")}</dd>
      </dl>
      ${qr}
      <div class="actions-row" style="margin-top:12px">
        ${
          st !== "connected"
            ? `<button type="button" class="btn wa sm" data-act="connect">${t("admin.drawer.connectQr")}</button>`
            : `<button type="button" class="btn danger sm" data-act="disconnect">${t("admin.drawer.disconnect")}</button>`
        }
        <button type="button" class="btn secondary sm" data-act="refresh-one">${t("admin.drawer.refresh")}</button>
      </div>
    </div>

    <div class="drawer-section">
      <h4>${t("admin.drawer.accountSection")}</h4>
      <dl class="kv">
        <dt>${t("admin.drawer.product")}</dt><dd><span class="pill product">${escapeHtml(account.product)}</span></dd>
        <dt>${t("admin.drawer.tenant")}</dt><dd class="mono">${escapeHtml(account.externalTenantId)}</dd>
        <dt>${t("admin.drawer.webhook")}</dt><dd class="mono">${escapeHtml(account.webhookUrl)}</dd>
        <dt>${t("admin.drawer.label")}</dt><dd>${escapeHtml(account.label || "—")}</dd>
      </dl>
      <label class="field" style="margin-top:12px">
        <span>${t("admin.drawer.webhookUrl")}</span>
        <input id="edit-webhook" class="input" value="${escapeAttr(account.webhookUrl)}" />
      </label>
      <label class="field">
        <span>${t("admin.drawer.label")}</span>
        <input id="edit-label" class="input" value="${escapeAttr(account.label || "")}" />
      </label>
      <button type="button" class="btn secondary sm" data-act="save-meta">${t("admin.drawer.saveMeta")}</button>
    </div>

    ${
      st === "connected"
        ? `
    <div class="drawer-section">
      <h4>${t("admin.drawer.sendTest")}</h4>
      <label class="field"><span>${t("admin.drawer.phoneDdi")}</span><input id="send-to" class="input" placeholder="+34 612 345 678" /></label>
      <label class="field"><span>${t("admin.drawer.message")}</span><textarea id="send-body" class="input" rows="3">Olá! Teste Glabz.</textarea></label>
      <button type="button" class="btn primary sm" data-act="send">${t("admin.drawer.send")}</button>
    </div>
    <div class="drawer-section">
      <h4>${t("admin.drawer.profile")}</h4>
      <label class="field"><span>${t("admin.drawer.name")}</span><input id="prof-name" class="input" value="${escapeAttr(session?.displayName || account.label || "")}" /></label>
      <label class="field"><span>${t("admin.drawer.statusMsg")}</span><input id="prof-status" class="input" placeholder="Atendimento" /></label>
      <label class="field"><span>${t("admin.drawer.photo")}</span><input id="prof-pic" type="file" accept="image/*" /></label>
      <div class="actions-row">
        <button type="button" class="btn secondary sm" data-act="profile">${t("admin.drawer.saveProfile")}</button>
        <button type="button" class="btn ghost sm" data-act="remove-pic">${t("admin.drawer.removePhoto")}</button>
      </div>
    </div>`
        : ""
    }

    <div class="drawer-section">
      <h4>${t("admin.drawer.danger")}</h4>
      <button type="button" class="btn danger sm" data-act="delete">${t("admin.drawer.removeAccount")}</button>
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
      toast(t("admin.drawer.toast.connecting"));
    } else if (act === "disconnect") {
      if (!confirm(t("admin.drawer.confirmDisconnect"))) return;
      await api(`/v1/accounts/${id}/disconnect`, { method: "POST" });
      toast(t("admin.drawer.toast.disconnected"));
    } else if (act === "refresh-one") {
      /* fallthrough to load */
    } else if (act === "save-meta") {
      const webhookUrl = $("edit-webhook").value.trim();
      const label = $("edit-label").value.trim() || null;
      await api(`/v1/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl, label }),
      });
      toast(t("admin.drawer.toast.metaSaved"));
    } else if (act === "send") {
      const to = $("send-to").value.trim();
      const body = $("send-body").value.trim();
      const res = await api(`/v1/accounts/${id}/send`, {
        method: "POST",
        body: JSON.stringify({ to, body }),
      });
      toast(res.externalId ? t("admin.drawer.toast.sentWithId", { id: res.externalId }) : t("admin.drawer.toast.sent"));
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
      toast(t("admin.drawer.toast.profileUpdated"));
    } else if (act === "delete") {
      if (!confirm(t("admin.drawer.confirmDelete"))) return;
      await api(`/v1/accounts/${id}`, { method: "DELETE" });
      toast(t("admin.drawer.toast.accountRemoved"));
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
    loginError.textContent = t("admin.login.informSecret");
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
    loginError.textContent = e.message === "unauthorized" ? t("admin.login.invalidSecret") : e.message;
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
    toast(t("admin.modal.newAccount.toast"));
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
    toast(t("admin.products.toast.saved"));
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
      list.innerHTML = `<p class="muted">${t("admin.clients.empty")}</p>`;
      return;
    }
    list.innerHTML = clients
      .map(
        (c) => `<div class="account-card">
          <div>
            <strong>${escapeHtml(c.name)}</strong>
            <div class="muted sm mono">${escapeHtml(c.slug)}</div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn secondary sm" data-open-portal="${escapeAttr(c.id)}">${t("admin.clients.openProject")}</button>
            <button type="button" class="btn secondary sm" data-del-client="${escapeAttr(c.id)}" data-del-name="${escapeAttr(c.name)}">${t("admin.clients.delete")}</button>
          </div>
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
$("wipe-clients-btn")?.addEventListener("click", async () => {
  if (!confirm(t("admin.clients.confirmWipe"))) return;
  try {
    const data = await api("/v1/clients/wipe", { method: "POST", body: "{}" });
    toast(
      data.deleted?.length
        ? t("admin.clients.toast.deleted", { names: data.deleted.join(", ") })
        : t("admin.clients.toast.noneDeleted")
    );
    await loadClients();
  } catch (e) {
    toast(e.message, "err");
  }
});
document.addEventListener("click", async (e) => {
  const btn = e.target.closest?.("[data-del-client]");
  if (!btn) return;
  if (!confirm(t("admin.clients.confirmDelete", { name: btn.dataset.delName }))) return;
  try {
    await api(`/v1/clients/${btn.dataset.delClient}`, { method: "DELETE" });
    toast(t("admin.clients.toast.deletedOne"));
    await loadClients();
  } catch (ex) {
    toast(ex.message, "err");
  }
});

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
    toast(t("admin.clients.toast.created", { pass }));
    alert(
      t("admin.clients.alert.created", { name: data.client.name, email: data.user.email, pass })
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
