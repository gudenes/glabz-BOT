import { toast } from "./toast.js";
import { applyStaticTranslations, mountLangToggle, t } from "./i18n.js";

applyStaticTranslations();
mountLangToggle(document.getElementById("lang-toggle-slot"));

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("accept", "application/json");
  if (opts.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...opts, headers, cache: "no-store", credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.reason || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function go(user) {
  if (window !== window.top) return;
  if (user.role === "client") location.replace("/admin/portal.html");
  else location.replace("/admin/");
}

const formLogin = document.getElementById("form-login");
const formChange = document.getElementById("form-change");
const err = document.getElementById("login-error");
const err2 = document.getElementById("change-error");

try {
  const me = await api("/v1/auth/me");
  if (me.user?.mustChangePassword) {
    formLogin.classList.add("hidden");
    formChange.classList.remove("hidden");
  } else if (me.user) {
    go(me.user);
  }
} catch {
  /* fica no login */
}

formLogin.onsubmit = async (e) => {
  e.preventDefault();
  err.classList.add("hidden");
  const btn = document.getElementById("login-btn");
  btn.disabled = true;
  try {
    const data = await api("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value,
      }),
    });
    if (data.user.mustChangePassword) {
      formLogin.classList.add("hidden");
      formChange.classList.remove("hidden");
      toast(t("login.toast.firstAccess"));
    } else {
      toast(t("login.toast.in"));
      go(data.user);
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
};

formChange.onsubmit = async (e) => {
  e.preventDefault();
  err2.classList.add("hidden");
  try {
    await api("/v1/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ password: document.getElementById("new-pass").value }),
    });
    toast(t("login.toast.passwordUpdated"));
    const me = await api("/v1/auth/me");
    go(me.user);
  } catch (ex) {
    err2.textContent = ex.message;
    err2.classList.remove("hidden");
  }
};
