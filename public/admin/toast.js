/**
 * Aviso passageiro no canto da tela.
 *
 * `opts.acao` acrescenta um botão dentro do aviso — usado pelo "desfazer" de
 * ações que somem da lista. Um aviso com ação fica mais tempo na tela: 2,8s é
 * pouco pra ler e ainda decidir clicar.
 */
export function toast(msg, kind = "ok", opts = {}) {
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

  const acao = opts.acao;
  if (acao?.texto && typeof acao.fn === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-acao";
    btn.textContent = acao.texto;
    btn.addEventListener("click", () => {
      el.remove();
      acao.fn();
    });
    el.appendChild(btn);
  }

  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  const vida = acao ? 7000 : 2800;
  setTimeout(() => el.classList.add("out"), vida);
  setTimeout(() => el.remove(), vida + 500);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
