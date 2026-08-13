export function toast(msg, kind = "ok") {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.className = "toasts";
    host.setAttribute("role", "status");
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = "toast-item " + kind;
  el.innerHTML = `<span class="toast-ico" aria-hidden="true"></span><span>${escapeHtml(msg)}</span>`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => el.classList.add("out"), 2800);
  setTimeout(() => el.remove(), 3300);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
