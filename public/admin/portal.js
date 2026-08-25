import { toast } from "./toast.js";
import { applyStaticTranslations, mountLangToggle, t } from "./i18n.js";

applyStaticTranslations();
const langToggleSlot = document.getElementById("lang-toggle-slot");
if (langToggleSlot) mountLangToggle(langToggleSlot);

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

function welcomeText() {
  const name = state.portal?.client?.name?.trim();
  if (state.studio.mode === "knowledge") {
    return name
      ? t("portal.studio.knowledge.welcomeNamed", { name })
      : t("portal.studio.knowledge.welcome");
  }
  if (name) {
    return t("portal.studio.welcomeNamed", { name });
  }
  return t("portal.studio.welcome");
}

const state = {
  portal: null,
  accountId: null,
  view: "status",
  lastWa: null,
  firstName: "",
  me: null,
  threads: [],
  selectedPhone: null,
  dashboard: { range: "today", data: null },
  studio: {
    open: false,
    expanded: true,
    busy: false,
    phase: "ask",
    messages: [],
    previewTurns: 0,
    mode: "flow",
    // O que fazer quando o mini-briefing de conhecimento (mode:"knowledge")
    // termina ou é pulado: "template" reabre o picker, "close" só fecha.
    // null = veio do caminho "Montar com IA" (não passou pelo onboarding
    // reduzido), onde não há próximo passo a decidir.
    afterKnowledge: null,
    rec: null,
    heard: "",
    welcomed: false,
  },
  waBoot: { running: false, done: false, dismissed: false },
  sawQr: false,
  qrWatch: null,
};

const WA_PHASES = [
  ["portal.boot.phase1.title", "portal.boot.phase1.sub"],
  ["portal.boot.phase2.title", "portal.boot.phase2.sub"],
  ["portal.boot.phase3.title", "portal.boot.phase3.sub"],
  ["portal.boot.phase4.title", "portal.boot.phase4.sub"],
  ["portal.boot.phase5.title", "portal.boot.phase5.sub"],
];

const TITLES = {
  status: ["portal.nav.whatsapp", "portal.stageSub.default"],
  inbox: ["portal.nav.inbox", "portal.inboxStageSub"],
  flow: ["portal.nav.flow", "portal.flowStageSub"],
  test: ["portal.nav.test", "portal.testStageSub"],
  pubs: ["portal.nav.pubs", "portal.pubsStageSub"],
  dashboard: ["portal.nav.dashboard", "portal.dashboardStageSub"],
  account: ["portal.nav.account", "portal.accountStageSub"],
  integrations: ["portal.nav.integrations", "portal.integrationsStageSub"],
  knowledge: ["portal.nav.knowledge", "portal.knowledgeStageSub"],
};

/**
 * "test" não tem seção própria — reaproveita a aba Fluxo (mesmo builder,
 * mesmo simulador com destaque de passo no canvas). Ver [[git-branching-strategy]]
 * princípio: nunca reimplementar no portal algo que o builder já tem.
 */
function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
  });
  const shownSection = view === "test" ? "flow" : view;
  for (const id of ["status", "inbox", "flow", "pubs", "dashboard", "account", "integrations", "knowledge"]) {
    $(`view-${id}`)?.classList.toggle("hidden", id !== shownSection);
  }
  $("hello").textContent = state.firstName ? t("portal.helloName", { name: state.firstName }) : t(TITLES[view][0]);
  $("stage-sub").textContent = t(TITLES[view][1]);
  if (shownSection === "flow") {
    syncFlowPane();
    if (!hasOwnFlows()) {
      $("stage-sub").textContent = t("portal.studio.stageSub");
    } else if (view === "test") {
      openBuilderSimulator();
    }
    maybeOnboard();
  } else {
    dismissOnboard(false);
    hideStudioChrome();
  }
  if (view === "pubs") renderPubs();
  if (view === "inbox") void loadInbox();
  if (view === "dashboard") void loadDashboard();
  if (view === "account") loadAccount();
  if (view === "integrations") void loadIntegrationsStatus();
  if (view === "knowledge") { void loadKnowledge(); void loadAiAnswers(); }
}

/**
 * Abre o simulador de dentro do iframe do builder (mesmo painel usado no admin).
 * frame.dataset.loaded vira "1" assim que a navegação COMEÇA (não quando termina),
 * então não dá pra confiar nele pra saber se o app lá dentro já rodou o boot() —
 * espera o próprio botão existir no DOM do iframe antes de clicar.
 */
function openBuilderSimulator() {
  const frame = $("flow-frame");
  if (!frame) return;
  if (frame.dataset.loaded !== "1") openBuilder();
  frame.classList.remove("hidden");

  let tries = 0;
  const tryClick = () => {
    tries += 1;
    let btn = null;
    try {
      btn = frame.contentWindow?.document?.getElementById("btn-sim");
    } catch {
      /* mesma origem sempre — só acontece enquanto ainda está carregando */
    }
    if (btn) {
      btn.click();
      return;
    }
    if (tries < 40) setTimeout(tryClick, 150); // até ~6s esperando o boot() do iframe
  };
  tryClick();
}

function hasOwnFlows() {
  return (state.portal?.flows || []).length > 0;
}

/**
 * Fluxo "de verdade" = mais do que só o gatilho. provisionClient cria um
 * fluxo inicial vazio no onboarding, então contar fluxos (hasOwnFlows) não
 * distingue "acabei de entrar" de "já montei algo" — é essa diferença que
 * decide se vale oferecer o onboarding.
 */
function hasRealFlow() {
  return (state.portal?.flows || []).some((f) => (f.nodes || []).length > 1);
}

/**
 * Oferece os dois caminhos de partida (modelo pronto x montar com IA) na
 * primeira vez que o cliente abre a aba Fluxo sem ter nada montado. Some
 * assim que existir um fluxo real, e pode ser dispensado — a escolha fica
 * guardada por cliente, pra não reaparecer a cada visita.
 */
function onboardKey() {
  const cid = state.portal?.client?.id || "anon";
  return `glabs_onboard_done_${cid}`;
}

function maybeOnboard() {
  if (state.view !== "flow") return;
  if (hasRealFlow()) return;
  if (localStorage.getItem(onboardKey()) === "1") return;
  $("onboard")?.classList.remove("hidden");
}

function dismissOnboard(remember = true) {
  if (remember) localStorage.setItem(onboardKey(), "1");
  $("onboard")?.classList.add("hidden");
}

$("onboard-skip")?.addEventListener("click", () => {
  dismissOnboard();
  state.studio.afterKnowledge = "close";
  openStudio({ expand: true, mode: "knowledge" });
});
$("onboard-ia")?.addEventListener("click", () => {
  dismissOnboard();
  openStudio({ expand: true, mode: "flow" });
});
$("onboard-tpl")?.addEventListener("click", () => {
  dismissOnboard();
  state.studio.afterKnowledge = "template";
  openStudio({ expand: true, mode: "knowledge" });
});
// Clicar fora fecha, mas sem marcar como "já resolvi" — volta na próxima visita.
$("onboard")?.addEventListener("click", (ev) => {
  if (ev.target === $("onboard")) dismissOnboard(false);
});

/**
 * Tour guiado de 1º acesso — roda ANTES do onboarding acima, uma única vez
 * por cliente (mesmo padrão de onboardKey/dismissOnboard: localStorage por
 * client.id, nunca por sessionStorage['glabs_client_id']/role, pra ficar
 * idêntico em impersonation e cliente real). 2 passos com spotlight num
 * alvo real da tela: conectar WhatsApp → aba Fluxo. Ao terminar o passo 2,
 * entrega pro .onboard existente via setView("flow") — não duplica a
 * escolha template x IA que o .onboard já oferece.
 */
function tourKey() {
  const cid = state.portal?.client?.id || "anon";
  return `glabs_tour_done_${cid}`;
}

/** No breakpoint mobile a sidebar (.side) some e vira .mobile-nav — pega
 * qual dos dois data-view="flow" está de fato visível pra apontar o
 * spotlight certo. offsetParent não serve aqui: some elementos são
 * position:fixed (.mobile-nav), e offsetParent é sempre null nesse caso
 * mesmo visível. */
function visibleFlowNavLink() {
  const links = [...document.querySelectorAll('[data-view="flow"]')];
  return links.find((el) => getComputedStyle(el).display !== "none") || links[0] || null;
}

const TOUR_STEPS = [
  { target: () => $("btn-connect"), titleKey: "portal.tour.step1Title", bodyKey: "portal.tour.step1Body" },
  { target: () => visibleFlowNavLink(), titleKey: "portal.tour.step2Title", bodyKey: "portal.tour.step2Body" },
];

let tourStep = 0;

function positionTour() {
  const target = TOUR_STEPS[tourStep]?.target();
  const hole = $("tour-hole");
  const bubble = $("tour-bubble");
  if (!target || !hole || !bubble) return;
  const r = target.getBoundingClientRect();
  const pad = 8;
  hole.style.left = `${r.left - pad}px`;
  hole.style.top = `${r.top - pad}px`;
  hole.style.width = `${r.width + pad * 2}px`;
  hole.style.height = `${r.height + pad * 2}px`;

  // Balão embaixo do alvo por padrão; sobe se não couber. Clampa nas bordas
  // horizontais da viewport pra nunca vazar pra fora da tela.
  const bubbleWidth = 320;
  const left = Math.max(12, Math.min(r.left, window.innerWidth - bubbleWidth - 12));
  const spaceBelow = window.innerHeight - r.bottom;
  const top = spaceBelow > 170 ? r.bottom + pad + 12 : Math.max(12, r.top - 150);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function showTourStep(i) {
  const step = TOUR_STEPS[i];
  const target = step?.target();
  if (!step || !target) {
    // Alvo não existe (não devia acontecer, markup é estático) — não força
    // nada nem marca como visto, só desiste silenciosamente desta vez.
    dismissTour(false);
    return;
  }
  tourStep = i;
  $("tour")?.classList.remove("hidden");
  $("tour-step-label").textContent = t("portal.tour.stepLabel", { n: i + 1 });
  $("tour-title").textContent = t(step.titleKey);
  $("tour-body").textContent = t(step.bodyKey);
  $("tour-next").textContent = i === TOUR_STEPS.length - 1 ? t("portal.tour.goToFlow") : t("portal.tour.next");
  positionTour();
}

function dismissTour(remember = true) {
  if (remember) localStorage.setItem(tourKey(), "1");
  $("tour")?.classList.add("hidden");
}

/** Chamado uma vez no boot, depois que refresh() resolve — o tour só faz
 * sentido pré-conexão (ver state.lastWa, já populado nesse ponto por
 * render()); depois disso o dono já passou dessa etapa. */
function maybeTour() {
  if (localStorage.getItem(tourKey()) === "1") return;
  if (state.lastWa === "connected") return;
  showTourStep(0);
}

$("tour-skip")?.addEventListener("click", () => dismissTour());
// Clicar fora (fora do balão) fecha, mas sem marcar como "já resolvi" —
// mesmo padrão do .onboard: volta na próxima visita. .tour-hole tem
// pointer-events:none, então cliques nele já chegam aqui como alvo #tour.
$("tour")?.addEventListener("click", (ev) => {
  if (ev.target === $("tour")) dismissTour(false);
});
$("tour-next")?.addEventListener("click", () => {
  if (tourStep < TOUR_STEPS.length - 1) {
    showTourStep(tourStep + 1);
  } else {
    dismissTour();
    setView("flow"); // aciona maybeOnboard() naturalmente — ver setView()
  }
});
window.addEventListener("resize", () => {
  if (!$("tour")?.classList.contains("hidden")) positionTour();
});
window.addEventListener(
  "scroll",
  () => {
    if (!$("tour")?.classList.contains("hidden")) positionTour();
  },
  true
);

function openBuilder() {
  const frame = $("flow-frame");
  frame?.classList.remove("hidden");
  const cid = sessionStorage.getItem("glabs_client_id") || state.portal?.client?.id || "";
  if (frame) {
    frame.dataset.loaded = "1";
    frame.src = `/admin/flows.html?embed=1&client=${encodeURIComponent(cid)}&v=16`;
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
  // `open` era `first || state.studio.open`, o que travava o Studio aberto pra
  // sempre em quem ainda não tinha fluxo — sem botão de fechar e sem como ver
  // o resto. Agora quem decide é o modal de onboarding (ver maybeOnboard).
  const open = state.studio.open;
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
  $("studio-dismiss")?.classList.toggle("hidden", !open);
  $("studio-expand")?.classList.toggle("hidden", first);
  $("btn-wizard")?.classList.toggle("hidden", state.view !== "flow" || first || open);
  // Trocar de modelo é ação válida a qualquer momento — não só no onboarding.
  $("btn-templates")?.classList.toggle("hidden", state.view !== "flow" || open);
  $("btn-studio-expand")?.classList.toggle("hidden", state.view !== "flow" || !open || first);
  $("btn-studio-expand").textContent = expanded ? t("portal.collapse") : t("portal.expand");
  $("studio-expand").textContent = expanded && !first ? t("portal.collapse") : t("portal.expand");

  if (state.studio.mode === "knowledge") {
    // Mini-briefing só de conhecimento: nunca oferece template/ensaio/build
    // (isso é papel do chat normal, mode "flow") — só pergunta e deixa pular.
    $("studio-alts")?.classList.add("hidden");
    $("studio-offer")?.classList.add("hidden");
    $("studio-ready")?.classList.add("hidden");
    $("studio-knowledge-banner")?.classList.toggle("hidden", !open);
    $("studio-knowledge-skip")?.classList.toggle("hidden", !open || state.studio.busy);
    $("studio-kicker").textContent = t("portal.studio.kicker.knowledge");
    $("studio-kicker").className = "studio-kicker";
    $("studio-title").textContent = t("portal.studio.title.knowledge");
    $("studio-sub").textContent = t("portal.studio.sub.knowledge");
    return;
  }
  $("studio-knowledge-banner")?.classList.add("hidden");
  $("studio-knowledge-skip")?.classList.add("hidden");
  // "usar um template · começar do zero" fica disponível SEMPRE que o Studio
  // estiver aberto. Antes sumia assim que o cliente tivesse qualquer fluxo — e
  // como provisionClient já cria um fluxo inicial no onboarding, isso escondia
  // o catálogo justamente de quem ainda não montou nada.
  $("studio-alts")?.classList.toggle("hidden", !open);
  const phase = state.studio.phase;
  const kick =
    phase === "ready"
      ? [t("portal.studio.kicker.ready"), "ready"]
      : phase === "debrief"
        ? [t("portal.studio.kicker.afterRehearsal"), "ready"]
        : phase === "preview"
          ? [t("portal.studio.kicker.rehearsal"), "preview"]
          : phase === "offer"
            ? [t("portal.studio.kicker.testQuestion"), "preview"]
            : [t("portal.studio.kicker.briefing"), ""];
  $("studio-kicker").textContent = kick[0];
  $("studio-kicker").className = "studio-kicker" + (kick[1] ? " " + kick[1] : "");
  $("studio-title").textContent =
    phase === "preview"
      ? t("portal.studio.title.rehearsal")
      : phase === "offer"
        ? t("portal.studio.title.essentials")
        : phase === "debrief" || phase === "ready"
          ? t("portal.studio.title.feedback")
          : t("portal.studio.title.default");
  $("studio-sub").textContent =
    phase === "preview"
      ? t("portal.studio.sub.rehearsal")
      : phase === "offer"
        ? t("portal.studio.sub.offer")
        : phase === "debrief" || phase === "ready"
          ? t("portal.studio.sub.afterRehearsal")
          : t("portal.studio.sub.ask");
  $("studio-offer")?.classList.toggle("hidden", phase !== "offer" || state.studio.busy);
  $("studio-ready")?.classList.toggle(
    "hidden",
    (phase !== "debrief" && phase !== "ready") || state.studio.busy
  );
}

function syncFlowPane() {
  // Sem fluxo nenhum, quem convida a começar é o modal de onboarding
  // (maybeOnboard) — abrir o Studio à força aqui tirava a escolha do usuário
  // e o deixava sem saída.
  if (!hasOwnFlows()) ensureStudioWelcome();
  studioLayout();
}

function ensureStudioWelcome() {
  if (state.studio.welcomed) return;
  state.studio.welcomed = true;
  const text = welcomeText();
  studioSay(text, "coach");
  state.studio.messages.push({ role: "assistant", content: text });
}

function waHtml(text) {
  const esc = escapeHtml(text);
  return esc
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>");
}

function stopQrWatch() {
  if (state.qrWatch) {
    clearInterval(state.qrWatch);
    state.qrWatch = null;
  }
}

function watchQrPairing() {
  if (state.qrWatch) return;
  state.qrWatch = setInterval(() => {
    if (state.lastWa === "connected" || state.lastWa === "disconnected") {
      stopQrWatch();
      return;
    }
    void refresh();
  }, 1200);
}

function paintWaPhase(index) {
  const items = [...document.querySelectorAll("#wa-checks li")];
  const [titleKey, subKey] = WA_PHASES[index] || WA_PHASES[0];
  items.forEach((li, n) => {
    li.classList.toggle("done", n < index);
    li.classList.toggle("on", n === index);
  });
  $("wa-boot-kicker").textContent = t("portal.boot.phaseLabel", { n: index + 1, total: WA_PHASES.length });
  $("wa-boot-title").textContent = t(titleKey);
  $("wa-boot-sub").textContent = t(subKey);
  if ($("wa-boot-fill")) $("wa-boot-fill").style.width = `${((index + 1) / WA_PHASES.length) * 100}%`;
}

function showWaCta(sess) {
  const phone = sess?.phoneDisplay
    ? t("portal.boot.done.subWithPhone", { phone: sess.phoneDisplay })
    : t("portal.boot.done.sub");
  if ($("wa-boot-done-sub")) $("wa-boot-done-sub").textContent = phone;
  $("wa-boot-stage")?.classList.add("out");
  $("wa-checks")?.classList.add("out");
  setTimeout(() => {
    $("wa-boot-stage")?.classList.add("hidden");
    $("wa-checks")?.classList.add("hidden");
    $("wa-boot-done")?.classList.remove("hidden");
    requestAnimationFrame(() => $("wa-boot-done")?.classList.add("in"));
    $("qr-kicker").textContent = t("portal.qr.connected");
    $("qr-kicker").className = "hero-kicker ok";
    $("qr-title").textContent = t("portal.qr.allSet");
    $("qr-hint").textContent = phone;
    $("btn-go-flow")?.classList.remove("hidden");
    $("btn-connect")?.classList.remove("hidden");
    if ($("btn-connect")) $("btn-connect").textContent = t("portal.qr.generateNew");
    toast(t("portal.qr.allSet"));
  }, 420);
}

function dismissWaBoot() {
  state.waBoot.dismissed = true;
  $("wa-boot")?.classList.add("hidden");
  $("view-status")?.classList.remove("wa-full");
}

function startWaBoot(sess) {
  if (state.waBoot.running) return;
  state.waBoot.running = true;
  state.waBoot.done = false;
  state.waBoot.dismissed = false;
  stopQrWatch();
  if (state.view !== "status") queueMicrotask(() => setView("status"));
  $("wa-boot")?.classList.remove("hidden");
  $("view-status")?.classList.add("wa-full");
  $("wa-boot-stage")?.classList.remove("hidden", "out");
  $("wa-checks")?.classList.remove("hidden", "out");
  $("wa-boot-done")?.classList.add("hidden");
  $("wa-boot-done")?.classList.remove("in");
  $("btn-go-flow")?.classList.add("hidden");
  $("btn-connect")?.classList.add("hidden");
  if ($("wa-boot-fill")) $("wa-boot-fill").style.width = "0%";
  document.querySelectorAll("#wa-checks li").forEach((li) => li.classList.remove("on", "done"));
  requestAnimationFrame(() => paintWaPhase(0));
  let i = 0;
  const tick = () => {
    if (!state.waBoot.running) return;
    i += 1;
    if (i < WA_PHASES.length) {
      paintWaPhase(i);
      setTimeout(tick, 1000);
      return;
    }
    document.querySelectorAll("#wa-checks li").forEach((li) => {
      li.classList.remove("on");
      li.classList.add("done");
    });
    state.waBoot.running = false;
    state.waBoot.done = true;
    showWaCta(sess);
  };
  setTimeout(tick, 1000);
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
    el.textContent = t("portal.status.connected");
  } else if (status === "pending_qr") {
    el.className = "pill warn";
    el.textContent = t("portal.status.pendingQr");
  } else {
    el.className = "pill off";
    el.textContent = status === "error" ? t("portal.status.error") : t("portal.status.disconnected");
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

function render() {
  const p = state.portal;
  if (!p) return;
  $("client-name").textContent = p.client.name;
  $("client-sub").textContent = p.impersonating ? t("portal.impersonateView") : t("portal.clientPortal");
  // Só o link da sidebar fixa agora — o banner do topo (que existia antes)
  // foi removido: ele some ao rolar a página (não é sticky como a sidebar),
  // então virou redundante depois que o link da sidebar cobre o mesmo caso
  // sempre visível (ver comentário em portal.css `.side`).
  $("back-admin")?.classList.toggle("hidden", !p.impersonating);

  const acc = p.accounts[0];
  const sess = acc?.session;
  state.accountId = acc?.account?.id || null;
  const wa = sess?.status || "disconnected";
  const prevWa = state.lastWa;
  if (prevWa && prevWa !== wa) {
    if (wa === "pending_qr") toast(t("portal.status.qrReady"));
    if (wa === "disconnected" && prevWa === "connected") {
      state.waBoot = { running: false, done: false, dismissed: false };
      state.sawQr = false;
      stopQrWatch();
      toast(t("portal.status.disconnectedFull"));
    }
  }
  if (wa === "pending_qr" || sess?.qrDataUrl) {
    state.sawQr = true;
    watchQrPairing();
  }
  const shouldBoot =
    wa === "connected" &&
    !state.waBoot.running &&
    !state.waBoot.done &&
    (prevWa === "pending_qr" || prevWa === "disconnected" || state.sawQr);
  state.lastWa = wa;
  pill(wa);
  if (shouldBoot) startWaBoot(sess);

  $("st-status").textContent =
    sess?.status === "connected"
      ? t("portal.status.connected")
      : sess?.status === "pending_qr"
        ? t("portal.status.pendingQr")
        : sess?.status === "error"
          ? t("portal.status.error")
          : t("portal.status.disconnected");
  $("st-live").textContent = p.liveFlow?.name || t("portal.stat.none");
  $("st-updated").textContent = fmtWhen(p.liveFlow?.publishedAt || p.liveFlow?.updatedAt);
  $("st-phone").textContent = sess?.phoneDisplay || "";

  const box = $("qr-box");
  const existingImg = box.querySelector("img");
  if (existingImg) existingImg.remove();

  const showBoot =
    !state.waBoot.dismissed &&
    (state.waBoot.running || (wa === "connected" && state.waBoot.done));
  $("btn-go-flow")?.classList.toggle("hidden", wa !== "connected" || state.waBoot.running);
  $("wa-boot")?.classList.toggle("hidden", !showBoot);
  $("view-status")?.classList.toggle("wa-full", showBoot);

  if (state.waBoot.running) {
    $("qr-kicker").textContent = t("portal.qr.connectingNumber");
    $("qr-kicker").className = "hero-kicker";
    $("qr-title").textContent = t("portal.qr.closingChecks");
    $("qr-hint").textContent = t("portal.qr.fewSeconds");
    $("btn-connect").classList.add("hidden");
    return;
  }

  $("btn-connect")?.classList.remove("hidden");

  if (sess?.status === "connected") {
    $("qr-kicker").textContent = t("portal.qr.connected");
    $("qr-kicker").className = "hero-kicker ok";
    $("qr-title").textContent = state.waBoot.done
      ? t("portal.qr.readyToStart")
      : t("portal.qr.readyAndConnected");
    $("qr-hint").textContent = sess.connectedAt
      ? t("portal.qr.connectedSince", { when: fmtWhen(sess.connectedAt) })
      : t("portal.qr.buildFlowOrRegenerate");
    $("btn-connect").textContent = t("portal.qr.generateNew");
    $("wa-boot-kicker").textContent = t("portal.boot.check.ready");
  } else if (sess?.qrDataUrl) {
    $("qr-kicker").textContent = t("portal.qr.awaitingScan");
    $("qr-kicker").className = "hero-kicker";
    $("qr-title").textContent = t("portal.qr.scanWithPhone");
    $("qr-hint").textContent = t("portal.qr.hint");
    $("btn-connect").textContent = t("portal.qr.generateAnother");
    const img = document.createElement("img");
    img.src = sess.qrDataUrl;
    img.alt = t("portal.qr.altText");
    box.appendChild(img);
  } else {
    $("qr-kicker").textContent = t("portal.qr.notConnected");
    $("qr-kicker").className = "hero-kicker";
    $("qr-title").textContent = t("portal.qr.title");
    $("qr-hint").textContent = t("portal.qr.hint");
    $("btn-connect").textContent = t("portal.qr.generate");
  }
}

function renderPubs() {
  const list = $("pubs-list");
  const flows = state.portal?.flows || [];
  if (!flows.length) {
    list.innerHTML = `<div class="pub"><div><h3>${t("portal.pubs.emptyTitle")}</h3><p>${t("portal.pubs.emptyBody")}</p></div></div>`;
    return;
  }
  list.innerHTML = flows
    .map((f) => {
      const when = fmtWhen(f.publishedAt || f.updatedAt);
      const badge =
        f.status === "live"
          ? `<span class="pill live">${t("portal.pubs.live")}</span>`
          : `<span class="pill off">${t("portal.pubs.draft")}</span>`;
      return `<article class="pub">
        <div>
          <h3>${escapeHtml(f.name)}</h3>
          <p>${f.status === "live" ? t("portal.pubs.published") : t("portal.pubs.updated")} ${escapeHtml(when)}</p>
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

async function refresh() {
  state.portal = await api("/v1/portal");
  render();
  if (state.view === "pubs") renderPubs();
}

/* ── Dashboards ──────────────────────────────────────────── */

async function loadDashboard(range = state.dashboard.range) {
  state.dashboard.range = range;
  try {
    state.dashboard.data = await api(`/v1/portal/dashboard?range=${encodeURIComponent(range)}`);
  } catch (e) {
    toast(e.message, "err");
    return;
  }
  renderDashboard();
}

function renderDashboard() {
  const data = state.dashboard.data;
  if (!data) return;
  $("dash-instances").textContent = String(data.accounts.total);
  $("dash-connected").textContent = String(data.accounts.connected);
  $("dash-sent").textContent = String(data.totals.out);
  $("dash-received").textContent = String(data.totals.in);
  $("dash-conversations").textContent = String(data.conversations);
  $("dash-chart").innerHTML = buildLineChartSvg(data.series || []);
}

/** Gráfico de linha em SVG puro (sem lib) — recebidas x enviadas nos últimos 30 dias. */
function buildLineChartSvg(series) {
  const width = 720;
  const height = 220;
  const pad = 28;
  if (!series.length) {
    return `<p class="dash-chart-empty">${t("portal.dashboard.chart.empty")}</p>`;
  }
  const maxY = Math.max(1, ...series.flatMap((p) => [p.in, p.out]));
  const stepX = series.length > 1 ? (width - 2 * pad) / (series.length - 1) : 0;
  const toXY = (i, v) => {
    const x = pad + i * stepX;
    const y = height - pad - (v / maxY) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const ptsIn = series.map((p, i) => toXY(i, p.in)).join(" ");
  const ptsOut = series.map((p, i) => toXY(i, p.out)).join(" ");

  const guides = [0, 0.5, 1]
    .map((f) => {
      const y = height - pad - f * (height - 2 * pad);
      const label = Math.round(maxY * f);
      return `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${width - pad}" y2="${y.toFixed(1)}" class="chart-guide" stroke-dasharray="4 4" />
        <text x="4" y="${(y + 4).toFixed(1)}" class="chart-guide-label">${label}</text>`;
    })
    .join("");

  const xLabelsIdx = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : series.map((_, i) => i);
  const xLabels = xLabelsIdx
    .map((i) => {
      const x = pad + i * stepX;
      const [, m, d] = series[i].date.split("-");
      return `<text x="${x.toFixed(1)}" y="${height - 6}" class="chart-x-label" text-anchor="middle">${d}/${m}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img">
    ${guides}
    <polyline points="${ptsIn}" class="chart-line chart-line-in" />
    <polyline points="${ptsOut}" class="chart-line chart-line-out" />
    ${xLabels}
  </svg>`;
}

document.querySelectorAll("#dash-range .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#dash-range .seg-btn").forEach((b) => b.classList.toggle("on", b === btn));
    void loadDashboard(btn.dataset.range);
  });
});

/* ── Dados da conta ──────────────────────────────────────── */

function loadAccount() {
  // Em impersonation (admin GLabs vendo o portal como um client), esse card
  // precisa mostrar o dono da conta do CLIENT sendo visualizado — não o login
  // do admin (state.me). O client vem em state.portal.users[0] (mesmo dado já
  // carregado por GET /v1/portal, sem fetch extra). Fora de impersonation
  // (o próprio client logado), state.me já É o usuário certo.
  const impersonating = Boolean(state.portal?.impersonating);
  const me = impersonating ? state.portal?.users?.[0] || null : state.me;
  if (me) {
    $("acc-profile-name").value = me.name || "";
    $("acc-profile-email").value = me.email || "";
  }
  $("form-account-profile").classList.toggle("hidden", !me);

  const c = state.portal?.client || {};
  $("bill-name").value = c.billingName || "";
  $("bill-document").value = c.billingDocument || "";
  $("bill-whatsapp").value = c.billingWhatsapp || "";
  $("bill-zip").value = c.billingZip || "";
  $("bill-street").value = c.billingStreet || "";
  $("bill-number").value = c.billingNumber || "";
  $("bill-district").value = c.billingDistrict || "";
  $("bill-complement").value = c.billingComplement || "";

  $("biz-role").value = c.bizRole || "";
  $("biz-size").value = c.bizSize || "";
  $("biz-segment").value = c.bizSegment || "";
  $("biz-website").value = c.bizWebsite || "";
  $("biz-audience").value = c.bizAudience || "";
  $("biz-source").value = c.bizSource || "";
}

/**
 * Base de conhecimento (RAG): mostra o que a IA aprendeu com as respostas da
 * equipe e permite tirar da base o que estiver errado.
 *
 * A remoção é a válvula de correção do desenho (docs/rag-desenho.md §5.2):
 * como não há aprovação prévia (não escalaria), precisa haver um jeito simples
 * de dizer "não use isso" quando alguém perceber um erro.
 */
async function loadKnowledge() {
  const box = $("kb-list");
  if (!box) return;
  box.innerHTML = `<p class="hint-muted">${t("portal.knowledge.loading")}</p>`;
  try {
    const data = await api("/v1/rag/knowledge");
    renderKnowledge(data.chunks || []);
  } catch (e) {
    box.innerHTML = `<p class="hint-muted">${escapeHtml(e.message)}</p>`;
  }
}

// De onde um item da Base de Conhecimento veio — usado só pra exibir a tag
// (não muda como a busca funciona). 'manual' é o default no banco, cobre
// tanto ensino avulso quanto qualquer origin desconhecida/futura.
const KNOWLEDGE_ORIGINS = {
  onboarding: { key: "portal.knowledge.originOnboarding", tone: "ok" },
  website: { key: "portal.knowledge.originWebsite", tone: "ok" },
  pasted: { key: "portal.knowledge.originPasted", tone: "ok" },
  imported: { key: "portal.knowledge.originImported", tone: "off" },
  manual: { key: "portal.knowledge.originManual", tone: "off" },
};

function renderKnowledge(chunks) {
  const box = $("kb-list");
  if (!box) return;
  if (!chunks.length) {
    box.innerHTML = `<p class="hint-muted">${t("portal.knowledge.empty")}</p>`;
    return;
  }
  box.innerHTML = chunks
    .map((c) => {
      const origin = KNOWLEDGE_ORIGINS[c.origin] || KNOWLEDGE_ORIGINS.manual;
      const originTag = `<span class="ai-tag ${origin.tone}">${t(origin.key)}</span>`;
      return `
      <div class="kb-item" data-id="${escapeHtml(c.id)}">
        <div class="kb-body">
          <b>${escapeHtml(c.question)}</b>
          <p>${escapeHtml(c.answer)}</p>
          <div class="ai-tags">
            ${Number(c.occurrences) > 1 ? `<span class="kb-badge">${t("portal.knowledge.times", { n: c.occurrences })}</span>` : ""}
            ${originTag}
          </div>
        </div>
        <button type="button" class="btn-text kb-remove" data-remove="${escapeHtml(c.id)}">${t("portal.knowledge.remove")}</button>
      </div>`;
    })
    .join("");

  box.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(t("portal.knowledge.confirmRemove"))) return;
      try {
        await api(`/v1/rag/knowledge/${encodeURIComponent(btn.dataset.remove)}/suppress`, { method: "POST" });
        toast(t("portal.knowledge.removed"));
        await loadKnowledge();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
}

// Abaixo disso o score é ruído de domínio (ex.: perguntas do mesmo negócio,
// mas sobre outro assunto) — a busca ainda traz como candidato pro prompt
// (proteção contra resposta ruim fica na geração, não no filtro, ver
// docs/rag-desenho.md §4.3), mas exibir como "usou a base" nesses casos
// engana quem está lendo o log. Só a TAG usa esse corte; "ver fontes"
// continua mostrando tudo, fraco incluso, porque é aí que se descobre ruído.
const RAG_TAG_MIN_SCORE = 0.4;

/**
 * Rastro das respostas da IA. Mostra em que ela se baseou — inclusive quando
 * NÃO usou a base (e por quê), que é o caso mais difícil de diagnosticar
 * olhando só a resposta.
 */
async function loadAiAnswers() {
  const box = $("ai-log");
  if (!box) return;
  try {
    const data = await api("/v1/rag/answers?limit=30");
    const items = data.answers || [];
    if (!items.length) {
      box.innerHTML = `<p class="hint-muted">${t("portal.answers.empty")}</p>`;
      return;
    }
    box.innerHTML = items
      .map((a) => {
        const quando = new Date(a.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        const ragHits = Array.isArray(a.ragHits) ? a.ragHits : [];
        const strongHits = ragHits.filter((h) => Number(h.score) >= RAG_TAG_MIN_SCORE);
        const usou = a.ragStatus === "ok" && strongHits.length > 0;
        const baseTag = usou
          ? `<span class="ai-tag ok">${t("portal.answers.usedBase", { n: strongHits.length })}</span>`
          : `<span class="ai-tag off">${t("portal.answers.noBase")}${a.ragReason ? ` · ${escapeHtml(a.ragReason)}` : ""}</span>`;
        const cardTag = a.usedManualContext
          ? `<span class="ai-tag ok">${t("portal.answers.usedCard")}</span>`
          : `<span class="ai-tag off">${t("portal.answers.noCard")}</span>`;
        const base = ragHits.length
          ? `<details class="ai-src"><summary>${t("portal.answers.seeSources")}</summary><ul>${ragHits
              .map((h) => `<li>${escapeHtml(h.question)} <em>(${Number(h.score).toFixed(2)})</em></li>`)
              .join("")}</ul></details>`
          : "";
        return `
          <div class="ai-item">
            <div class="ai-head">
              <b>${escapeHtml(a.question)}</b>
              <small>${quando}${a.simulated ? ` · ${t("portal.answers.fromTest")}` : ""}</small>
            </div>
            <p>${a.answer ? escapeHtml(a.answer) : `<i>${t("portal.answers.failed")}</i>`}</p>
            <div class="ai-tags">${cardTag}${baseTag}</div>
            ${base}
          </div>`;
      })
      .join("");
  } catch (e) {
    box.innerHTML = `<p class="hint-muted">${escapeHtml(e.message)}</p>`;
  }
}

$("btn-kb-teach-toggle")?.addEventListener("click", () => {
  $("kb-teach")?.classList.toggle("hidden");
  $("kb-q")?.focus();
});

$("kb-teach")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("kb-q")?.value.trim();
  const a = $("kb-a")?.value.trim();
  if (!q || !a) return;
  try {
    await api("/v1/rag/teach", { method: "POST", body: JSON.stringify({ question: q, answer: a }) });
    toast(t("portal.knowledge.taught"));
    $("kb-q").value = "";
    $("kb-a").value = "";
    await loadKnowledge();
  } catch (e) {
    toast(e.message, "err");
  }
});

$("btn-kb-paste-toggle")?.addEventListener("click", () => {
  $("kb-paste")?.classList.toggle("hidden");
  $("kb-paste-text")?.focus();
});

$("kb-paste")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("kb-paste-text")?.value.trim();
  if (!text) return;
  const btn = $("kb-paste-submit");
  btn?.setAttribute("disabled", "true");
  if (btn) btn.textContent = t("portal.knowledge.review.extracting");
  try {
    const data = await api("/v1/rag/extract-from-text", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    const pairs = data.pairs || [];
    if (pairs.length) {
      $("kb-paste")?.classList.add("hidden");
      $("kb-paste-text").value = "";
      renderKnowledgeReview(pairs, "pasted");
    } else {
      toast(t("portal.knowledge.pasteEmpty"));
    }
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn?.removeAttribute("disabled");
    if (btn) btn.textContent = t("portal.knowledge.pasteSubmit");
  }
});

$("btn-kb-website-toggle")?.addEventListener("click", () => {
  $("kb-website")?.classList.toggle("hidden");
  $("kb-website-url")?.focus();
});

$("kb-website")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const url = $("kb-website-url")?.value.trim();
  if (!url) return;
  const btn = $("kb-website-submit");
  btn?.setAttribute("disabled", "true");
  if (btn) btn.textContent = t("portal.knowledge.review.extracting");
  try {
    const data = await api("/v1/rag/extract-from-website", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    const pairs = data.pairs || [];
    if (pairs.length) {
      $("kb-website")?.classList.add("hidden");
      $("kb-website-url").value = "";
      renderKnowledgeReview(pairs, "website");
    } else {
      toast(t("portal.knowledge.pasteEmpty"));
    }
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn?.removeAttribute("disabled");
    if (btn) btn.textContent = t("portal.knowledge.websiteSubmit");
  }
});

$("btn-kb-reindex")?.addEventListener("click", async () => {
  const status = $("kb-status");
  const btn = $("btn-kb-reindex");
  if (btn) btn.disabled = true;
  if (status) status.textContent = t("portal.knowledge.working");
  try {
    const r = await api("/v1/rag/reindex", { method: "POST" });
    if (status) {
      status.textContent = r.ok
        ? t("portal.knowledge.done", { n: r.indexed })
        : t("portal.knowledge.unavailable");
    }
    await loadKnowledge();
  } catch (e) {
    if (status) status.textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function loadIntegrationsStatus() {
  try {
    const data = await api("/v1/integrations/google-calendar/status");
    renderIntegrationsStatus(data);
  } catch (e) {
    $("gcal-status").textContent = e.message;
  }
}

function renderIntegrationsStatus(data) {
  const statusEl = $("gcal-status");
  const connectBtn = $("btn-gcal-connect");
  const disconnectBtn = $("btn-gcal-disconnect");
  if (!statusEl || !connectBtn || !disconnectBtn) return;

  if (!data.configured) {
    statusEl.textContent = t("portal.account.integrations.notConfigured");
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.add("hidden");
    return;
  }
  if (data.connected) {
    statusEl.textContent = t("portal.account.integrations.connectedAs", { email: data.email });
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.remove("hidden");
  } else {
    statusEl.textContent = t("portal.account.integrations.notConnected");
    connectBtn.classList.remove("hidden");
    disconnectBtn.classList.add("hidden");
  }
}

$("btn-gcal-connect")?.addEventListener("click", () => {
  const clientId = state.portal?.client?.id;
  if (!clientId) return;
  location.href = `/v1/integrations/google-calendar/connect?clientId=${encodeURIComponent(clientId)}`;
});

$("btn-gcal-disconnect")?.addEventListener("click", async () => {
  if (!confirm(t("portal.account.integrations.confirmDisconnect"))) return;
  try {
    await api("/v1/integrations/google-calendar", { method: "DELETE" });
    toast(t("portal.account.integrations.disconnected"));
    void loadIntegrationsStatus();
  } catch (e) {
    toast(e.message, "err");
  }
});

$("form-account-profile").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api("/v1/portal/account/profile", {
      method: "PUT",
      body: JSON.stringify({ name: $("acc-profile-name").value }),
    });
    const name = $("acc-profile-name").value.trim();
    const impersonating = Boolean(state.portal?.impersonating);
    if (impersonating && state.portal?.users?.[0]) {
      state.portal.users[0].name = name;
    } else if (state.me) {
      state.me.name = name;
    }
    toast(t("portal.account.saved"));
  } catch (e) {
    toast(e.message, "err");
  }
});

$("form-account-billing").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    const client = await api("/v1/portal/account/billing", {
      method: "PUT",
      body: JSON.stringify({
        billingName: $("bill-name").value,
        billingDocument: $("bill-document").value,
        billingWhatsapp: $("bill-whatsapp").value,
        billingZip: $("bill-zip").value,
        billingStreet: $("bill-street").value,
        billingNumber: $("bill-number").value,
        billingDistrict: $("bill-district").value,
        billingComplement: $("bill-complement").value,
      }),
    });
    if (state.portal && client) state.portal.client = client;
    toast(t("portal.account.saved"));
  } catch (e) {
    toast(e.message, "err");
  }
});

$("form-account-business").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    const client = await api("/v1/portal/account/business", {
      method: "PUT",
      body: JSON.stringify({
        bizRole: $("biz-role").value,
        bizSize: $("biz-size").value,
        bizSegment: $("biz-segment").value,
        bizWebsite: $("biz-website").value,
        bizAudience: $("biz-audience").value,
        bizSource: $("biz-source").value,
      }),
    });
    if (state.portal && client) state.portal.client = client;
    toast(t("portal.account.saved"));
  } catch (e) {
    toast(e.message, "err");
  }
});

$("btn-go-flow")?.addEventListener("click", () => setView("flow"));
$("btn-go-flow-boot")?.addEventListener("click", () => {
  dismissWaBoot();
  setView("flow");
});
$("btn-wa-later")?.addEventListener("click", dismissWaBoot);

$("btn-connect").onclick = async () => {
  if (!state.accountId) return;
  try {
    state.waBoot = { running: false, done: false, dismissed: false };
    state.sawQr = true;
    await api(`/v1/accounts/${state.accountId}/connect`, { method: "POST", body: "{}" });
    toast(t("portal.qr.generating"));
    await refresh();
    watchQrPairing();
  } catch (e) {
    toast(e.message, "err");
  }
};
$("btn-disconnect").onclick = async () => {
  if (!state.accountId) return;
  if (!confirm(t("portal.qr.confirmDisconnect"))) return;
  try {
    await api(`/v1/accounts/${state.accountId}/disconnect`, { method: "POST", body: "{}" });
    toast(t("portal.qr.disconnected"));
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
    el.innerHTML = `<p class="hint" style="padding:14px">${t("portal.inbox.empty")}</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (th) => `<button type="button" class="thread ${th.phoneE164 === state.selectedPhone ? "on" : ""}" data-phone="${escapeHtml(th.phoneE164)}">
        <b>${escapeHtml(th.contactName)}</b>
        <small>${escapeHtml(th.lastPreview)}</small>
        <span class="tag">${th.mode === "human" ? t("portal.inbox.youAnswer") : t("portal.inbox.bot")}</span>
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
  const thread = state.threads.find((x) => x.phoneE164 === phone);
  $("inbox-title").textContent = thread?.contactName || phone;
  $("inbox-sub").textContent = thread?.phoneDisplay || phone;
  $("inbox-form").classList.remove("hidden");
  $("btn-bot-mode").classList.remove("hidden");
  $("btn-bot-mode").textContent = thread?.mode === "human" ? t("portal.inbox.returnToBot") : t("portal.inbox.answerMyself");
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
    log.innerHTML = `<div class="chat-empty"><p>${t("portal.inbox.noMessages")}</p></div>`;
  }
  log.scrollTop = log.scrollHeight;
}

$("new-chat")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = $("new-phone").value.trim();
  if (!phone) return;
  const digits = phone.replace(/\D/g, "");
  $("new-phone").value = "";
  if (!state.threads.some((th) => th.phoneE164 === digits)) {
    state.threads.unshift({
      phoneE164: digits || phone,
      phoneDisplay: phone,
      contactName: phone,
      lastPreview: t("portal.inbox.newChat"),
      lastMessageAt: new Date().toISOString(),
      mode: "human",
    });
  }
  await loadInboxMessages(digits || phone);
  $("inbox-input")?.focus();
  toast(t("portal.inbox.writeAndSend"));
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
    toast(t("portal.inbox.fileTooBig"), "err");
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
    toast(t("portal.inbox.fileSent"));
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
    toast(t("portal.inbox.sentOnWhatsapp"));
    await loadInbox();
  } catch (ex) {
    toast(ex.message, "err");
  }
});
$("btn-bot-mode")?.addEventListener("click", async () => {
  const phone = state.selectedPhone;
  if (!phone) return;
  const thread = state.threads.find((x) => x.phoneE164 === phone);
  const next = thread?.mode === "human" ? "bot" : "human";
  await api("/v1/inbox/mode", { method: "POST", body: JSON.stringify({ phone, mode: next }) });
  toast(next === "bot" ? t("portal.inbox.botReturned") : t("portal.inbox.youAreAnswering"));
  await loadInbox();
});

$("btn-refresh").onclick = async () => {
  await refresh();
  toast(t("portal.refreshed"));
};
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

function studioThink(label = t("portal.studio.thinking")) {
  const log = $("studio-log");
  if (!log) return null;
  const row = document.createElement("div");
  row.className = "think";
  row.innerHTML = `<span class="think-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${label}</span>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

function openStudio({ expand = true, mode = "flow" } = {}) {
  if (state.studio.mode !== mode) {
    // Os dois modos reaproveitam o mesmo painel/estado, mas são conversas
    // semanticamente diferentes — cada uma com seu próprio SYSTEM prompt no
    // backend. Misturar histórico de uma na outra confundiria o LLM (o modo
    // conhecimento não sabe interpretar fala de construção de fluxo, e
    // vice-versa) — por isso reseta ao trocar de modo, em qualquer direção.
    state.studio.messages = [];
    state.studio.phase = "ask";
    state.studio.welcomed = false;
    state.studio.previewTurns = 0;
    state.studio.mode = mode;
  }
  state.studio.open = true;
  state.studio.expanded = expand || !hasOwnFlows();
  ensureStudioWelcome();
  studioLayout();
  $("studio-input")?.focus();
}

function closeStudio() {
  // Antes tinha um `if (!hasOwnFlows()) return;` aqui: sem nenhum fluxo, o
  // Studio ficava sem saída nenhuma (o botão "Ver fluxo" também some nesse
  // estado). Fechar tem que funcionar sempre — quem não quer montar agora
  // pode explorar o resto do portal.
  state.studio.open = false;
  studioLayout();
}

function toggleStudioExpand() {
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
  toast(t("portal.studio.flowReadyHint"));
  await refresh();
  state.studio.open = false;
  state.studio.expanded = false;
  openBuilder();
  studioLayout();
  // Bônus pós-build, nunca bloqueia: o dono já viu o fluxo pronto (o momento
  // de recompensa da conversa) antes de qualquer coisa sobre conhecimento
  // aparecer. Roda em paralelo — se falhar ou não achar nada, não incomoda.
  void offerKnowledgeReview();
}

/**
 * Tenta extrair conhecimento da conversa que acabou de virar fluxo e, se
 * achar algo, abre a tela de revisão. Silencioso em qualquer falha ou lista
 * vazia — essa etapa é sempre um bônus pulável, nunca um requisito.
 */
async function offerKnowledgeReview() {
  try {
    const data = await api("/v1/flows/studio", {
      method: "POST",
      body: JSON.stringify({ messages: studioHistory(), action: "extract_knowledge" }),
    });
    const pairs = data.pairs || [];
    if (pairs.length) renderKnowledgeReview(pairs);
    // Sem pairs (extração não achou nada reaproveitável — o cenário mais comum
    // hoje, dado o roteiro raso do coach): não abre revisão vazia, mas ainda
    // vale checar se a base ficou vazia, pra avisar.
    else void nudgeIfKnowledgeEmpty();
  } catch {
    // extração é bônus — falha aqui não pode incomodar quem só queria o fluxo
    // pronto — mas ainda assim vale a checagem de base vazia.
    void nudgeIfKnowledgeEmpty();
  }
}

// Origem a marcar quando o dono confirmar a revisão — setada por quem abre
// a tela (onboarding vs. texto colado), lida só na hora de salvar.
let krOrigin = "onboarding";

function renderKnowledgeReview(pairs, origin = "onboarding") {
  krOrigin = origin;
  const panel = $("knowledge-review");
  const box = $("kr-list");
  if (!panel || !box) return;
  $("kr-empty")?.classList.add("hidden");
  box.innerHTML = pairs
    .map(
      (p) => `
      <div class="kr-item">
        <input class="kr-q" value="${escapeHtml(p.question)}" />
        <textarea class="kr-a" rows="2">${escapeHtml(p.answer)}</textarea>
        <button type="button" class="btn-text kr-remove">${t("portal.knowledge.review.remove")}</button>
      </div>`
    )
    .join("");
  box.querySelectorAll(".kr-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".kr-item")?.remove();
      if (!box.querySelector(".kr-item")) $("kr-empty")?.classList.remove("hidden");
    });
  });
  panel.classList.remove("hidden");
}

function closeKnowledgeReview() {
  $("knowledge-review")?.classList.add("hidden");
}

/**
 * Chamada depois que a revisão termina (salvou, pulou, ou nunca chegou a
 * abrir por falta do que revisar) — decide o próximo passo do onboarding
 * conforme `state.studio.afterKnowledge`:
 * "template" → veio de "Usar um template", reabre o Studio em modo normal
 * já no seletor de template. "close" → veio de "Pular", só fecha mesmo.
 * null → veio do caminho "Montar com IA" (offerKnowledgeReview, pós-build),
 * onde não há nenhum próximo passo — o studio já estava fechado.
 */
function finishKnowledgeReview() {
  closeKnowledgeReview();
  krOrigin = "onboarding";
  const next = state.studio.afterKnowledge;
  state.studio.afterKnowledge = null;
  if (next === "template") {
    openStudio({ expand: true, mode: "flow" });
    const box = $("tpl-pick");
    if (box) {
      box.classList.remove("hidden");
      void renderTemplatePicker();
    }
  }
  void nudgeIfKnowledgeEmpty();
}

/**
 * Fim de qualquer caminho de onboarding (com IA, template ou pular): se a
 * Base de Conhecimento continuar vazia, avisa uma vez — sem isso o dono só
 * descobre (se descobrir) ao ver uma resposta genérica de verdade num
 * cliente. Nunca bloqueia, é só um toast; silencioso em qualquer falha.
 */
async function nudgeIfKnowledgeEmpty() {
  try {
    const data = await api("/v1/rag/knowledge");
    if (!(data.chunks || []).length) toast(t("portal.knowledge.emptyNudge"));
  } catch {
    /* checagem é só um bônus — nunca deve incomodar quem está terminando o onboarding */
  }
}

$("kr-skip")?.addEventListener("click", () => finishKnowledgeReview());

// Clicar fora fecha sem salvar, mesmo padrão do modal de onboarding.
$("knowledge-review")?.addEventListener("click", (ev) => {
  if (ev.target === $("knowledge-review")) finishKnowledgeReview();
});

$("kr-confirm")?.addEventListener("click", async () => {
  const box = $("kr-list");
  const items = [...(box?.querySelectorAll(".kr-item") || [])]
    .map((el) => ({
      question: el.querySelector(".kr-q")?.value.trim() || "",
      answer: el.querySelector(".kr-a")?.value.trim() || "",
    }))
    .filter((p) => p.question && p.answer);
  if (!items.length) {
    finishKnowledgeReview();
    return;
  }
  $("kr-confirm")?.setAttribute("disabled", "true");
  try {
    const res = await api("/v1/rag/teach-batch", {
      method: "POST",
      body: JSON.stringify({ pairs: items, origin: krOrigin }),
    });
    toast(t("portal.knowledge.review.saved", { n: res.saved }));
  } catch (e) {
    toast(e.message, "err");
  } finally {
    $("kr-confirm")?.removeAttribute("disabled");
    finishKnowledgeReview();
  }
});

/**
 * Encerra o mini-briefing de conhecimento (mode:"knowledge") — chamado
 * tanto quando o backend sinaliza phase:"ready" (terminou naturalmente)
 * quanto quando o dono clica "pular por enquanto" dentro do próprio chat
 * (skipped:true, nunca chega a extrair nada).
 */
async function finishKnowledgeChat({ skipped = false } = {}) {
  if (skipped) {
    closeStudio();
    finishKnowledgeReview();
    return;
  }
  const pending = studioThink(t("portal.knowledge.review.extracting"));
  try {
    const data = await api("/v1/flows/studio", {
      method: "POST",
      body: JSON.stringify({ messages: studioHistory(), action: "extract_knowledge" }),
    });
    pending?.remove();
    closeStudio();
    const pairs = data.pairs || [];
    if (pairs.length) renderKnowledgeReview(pairs);
    else finishKnowledgeReview();
  } catch {
    // Extração é sempre pulável — falha aqui não pode travar o onboarding.
    pending?.remove();
    closeStudio();
    finishKnowledgeReview();
  }
}

$("studio-skip-knowledge")?.addEventListener("click", () => finishKnowledgeChat({ skipped: true }));

async function sendStudio(_text, action = "chat") {
  if (state.studio.busy) return;
  const pending = studioThink(
    action === "build"
      ? t("portal.studio.buildingFlow")
      : action === "test"
        ? t("portal.studio.openingRehearsal")
        : t("portal.studio.thinking")
  );
  state.studio.busy = true;
  studioLayout();
  $("studio-form")?.querySelector("button[type=submit]")?.setAttribute("disabled", "true");
  $("studio-build")?.setAttribute("disabled", "true");
  $("studio-test")?.setAttribute("disabled", "true");
  try {
    const data = await api("/v1/flows/studio", {
      method: "POST",
      body: JSON.stringify({
        messages: studioHistory(),
        action,
        phase: state.studio.phase,
        mode: state.studio.mode,
      }),
    });
    pending?.remove();
    await applyStudioReply(data);
    if (data.kind === "flow") {
      await revealBuiltFlow();
      return;
    }
    if (state.studio.mode === "knowledge" && state.studio.phase === "ready") {
      await finishKnowledgeChat();
      return;
    }
    if (data.phase === "preview") {
      state.studio.previewTurns += 1;
      if (state.studio.previewTurns >= 2) {
        state.studio.phase = "debrief";
        studioSay(t("portal.studio.rehearsalEndedNote"), "sys");
      }
    }
    studioLayout();
  } catch (ex) {
    pending?.remove();
    studioSay(t("portal.studio.failedPrefix") + ex.message, "sys");
    toast(ex.message, "err");
  } finally {
    state.studio.busy = false;
    $("studio-form")?.querySelector("button[type=submit]")?.removeAttribute("disabled");
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
  $("btn-collapse-side").title = on ? t("portal.studio.openMenu") : t("portal.studio.collapseMenu");
});
if (localStorage.getItem("glabs_side_collapsed") === "1") {
  document.querySelector(".app")?.classList.add("side-collapsed");
  if ($("btn-collapse-side")) $("btn-collapse-side").textContent = "›";
}

$("btn-wizard")?.addEventListener("click", () => openStudio({ expand: false }));
$("btn-templates")?.addEventListener("click", async () => {
  openStudio({ expand: true });
  const box = $("tpl-pick");
  if (!box) return;
  box.classList.remove("hidden");
  await renderTemplatePicker();
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("btn-studio-expand")?.addEventListener("click", toggleStudioExpand);
$("studio-expand")?.addEventListener("click", toggleStudioExpand);
$("studio-close")?.addEventListener("click", closeStudio);
$("studio-dismiss")?.addEventListener("click", () => {
  // No mini-briefing de conhecimento, fechar pelo X tem que honrar o mesmo
  // "próximo passo" que "pular por enquanto" honra — senão "Usar um
  // template" morre aqui: modal de onboarding já foi dispensado (não volta
  // sozinho) e o template picker nunca chega a abrir.
  if (state.studio.mode === "knowledge") {
    void finishKnowledgeChat({ skipped: true });
    return;
  }
  closeStudio();
});
$("start-tpl")?.addEventListener("click", async () => {
  const box = $("tpl-pick");
  if (!box) return;
  const opening = box.classList.contains("hidden");
  box.classList.toggle("hidden");
  if (opening) await renderTemplatePicker();
});
$("start-blank")?.addEventListener("click", () => useTemplate("blank"));

/**
 * Lista os templates do catálogo (GET /v1/flows/templates) agrupados por
 * complexidade. Antes eram 3 opções fixas no HTML, que ficavam defasadas
 * sempre que o catálogo mudava.
 */
let templatesCache = null;
async function renderTemplatePicker() {
  const box = $("tpl-pick");
  if (!box) return;
  if (!templatesCache) {
    box.innerHTML = `<p class="tpl-loading">${t("portal.studio.tpl.loading")}</p>`;
    try {
      const data = await api("/v1/flows/templates");
      templatesCache = data.templates || [];
    } catch (e) {
      box.innerHTML = `<p class="tpl-loading">${e.message}</p>`;
      return;
    }
  }

  const group = (complexity, titleKey) => {
    const items = templatesCache.filter((x) => x.complexity === complexity);
    if (!items.length) return "";
    return `
      <div class="tpl-group">
        <h4>${t(titleKey)}</h4>
        ${items
          .map(
            (x) => `
          <button type="button" data-tpl="${escapeHtml(x.slug)}" class="tpl-card">
            <b>${escapeHtml(x.name)}</b>
            ${x.simulated ? `<span class="tpl-sim">${t("portal.studio.tpl.simulated")}</span>` : ""}
            <small>${escapeHtml(x.summary)}</small>
            <em>${escapeHtml(x.segment)}</em>
          </button>`
          )
          .join("")}
      </div>`;
  };

  box.innerHTML =
    group("simples", "portal.studio.tpl.simple") +
    group("complexo", "portal.studio.tpl.complex") +
    `<div class="tpl-group">
       <button type="button" data-tpl="blank" class="tpl-card tpl-blank">
         <b>${t("portal.studio.tpl.blank")}</b>
         <small>${t("portal.studio.tpl.blankHint")}</small>
       </button>
     </div>`;

  box.querySelectorAll("[data-tpl]").forEach((b) => {
    b.addEventListener("click", () => useTemplate(b.dataset.tpl));
  });
}
async function useTemplate(kind) {
  try {
    await api("/v1/flows/from-template", { method: "POST", body: JSON.stringify({ template: kind }) });
    toast(t("portal.studio.templateReady"));
    await refresh();
    state.studio.open = false;
    openBuilder();
    studioLayout();
  } catch (e) {
    toast(e.message, "err");
  }
}
function growStudioInput() {
  const el = $("studio-input");
  if (!el) return;
  el.style.height = "auto";
  const max = Math.round(window.innerHeight * 0.38);
  el.style.height = Math.min(el.scrollHeight, max) + "px";
}

$("studio-input")?.addEventListener("input", growStudioInput);
$("studio-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("studio-form")?.requestSubmit();
  }
});

$("studio-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  // Cobre o caminho que faltava: apertar Enter (ou clicar em "Enviar" direto
  // com o mouse) enquanto ainda está gravando dispara o submit SEM passar
  // por stopStudioMic (que só roda no clique no próprio botão do mic) — sem
  // isso o rec ficava ativo e a fala do próximo turno se somava à anterior.
  stopMicSilently();
  const input = $("studio-input");
  const text = (input.value || "").trim();
  if (!text || state.studio.busy) return;
  input.value = "";
  growStudioInput();
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
  const msg = t("portal.studio.testNowMsg");
  studioSay(msg, "user");
  state.studio.messages.push({ role: "user", content: msg });
  state.studio.previewTurns = 0;
  await sendStudio(msg, "test");
});

function setMicUi(on) {
  $("studio-mic")?.classList.toggle("on", on);
  $("studio-listen")?.classList.toggle("hidden", !on);
  if ($("studio-mic-label")) $("studio-mic-label").textContent = on ? t("portal.studio.stopMic") : t("portal.studio.talk");
}

/**
 * Encerra a sessão de reconhecimento de voz, se houver uma ativa — sem mexer
 * no texto do campo (isso fica a cargo de quem chama). Existe separado de
 * `stopStudioMic` porque o envio do formulário pode acontecer por caminhos
 * que NUNCA passam por `stopStudioMic` (Enter no campo, clique direto em
 * "Enviar" enquanto ainda grava) — sem isso, o `rec` fica ativo e
 * `state.studio.heard` nunca zera, então a fala do PRÓXIMO turno (já depois
 * da resposta do coach) se soma ao texto do turno anterior, que nunca foi
 * de fato limpo. Chamada no topo do submit do form cobre todos os
 * caminhos de uma vez; é idempotente (não faz nada se não há `rec` ativo).
 */
function stopMicSilently() {
  const rec = state.studio.rec;
  if (!rec) return;
  state.studio.rec = null;
  try {
    rec.stop();
  } catch {
    /* ignore */
  }
  setMicUi(false);
  state.studio.heard = "";
}

function stopStudioMic({ send = false } = {}) {
  stopMicSilently();
  const text = ($("studio-input")?.value || "").trim();
  if (send && text && !state.studio.busy) {
    $("studio-form")?.requestSubmit();
  } else if ($("studio-input")) {
    // Sem envio (erro, cancelamento): limpa o campo — senão o resíduo
    // sobrevive pro próximo clique no mic, que semeia state.studio.heard a
    // partir do valor atual do textarea (abaixo) e concatena fala velha com
    // a nova.
    $("studio-input").value = "";
    growStudioInput();
  }
}

$("studio-mic")?.addEventListener("click", async () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast(t("portal.studio.audioNotSupported"), "err");
    return;
  }
  if (state.studio.rec) {
    stopStudioMic({ send: true });
    return;
  }
  if (!window.isSecureContext) {
    toast(t("portal.studio.micNeedsHttps"), "err");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    toast(t("portal.studio.micPermission"), "err");
    return;
  }
  const rec = new SR();
  rec.lang = "pt-BR";
  rec.interimResults = true;
  rec.continuous = true;
  state.studio.heard = ($("studio-input")?.value || "").trim();
  if (state.studio.heard) state.studio.heard += " ";
  rec.onresult = (ev) => {
    // Sem essa guarda, um resultado tardio de uma instância já parada/
    // substituída (comum: stop() é assíncrono, ainda dispara onresult depois
    // do form já ter sido enviado e limpo) continua escrevendo em
    // state.studio.heard/textarea — que são estado global — e isso reaparece
    // como texto repetido no próximo turno. onend já tinha essa guarda.
    if (state.studio.rec !== rec) return;
    let final = "";
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const piece = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += piece + " ";
      else interim += piece;
    }
    if (final) state.studio.heard += final;
    if ($("studio-input")) {
      $("studio-input").value = (state.studio.heard + interim).trim();
      growStudioInput();
    }
  };
  rec.onend = () => {
    if (state.studio.rec === rec) {
      try {
        rec.start();
      } catch {
        stopStudioMic({ send: false });
      }
    }
  };
  rec.onerror = (ev) => {
    if (ev.error === "no-speech" || ev.error === "aborted") return;
    stopStudioMic({ send: false });
    toast(ev.error === "not-allowed" ? t("portal.studio.micPermissionChrome") : t("portal.studio.couldntHear"), "err");
  };
  state.studio.rec = rec;
  setMicUi(true);
  rec.start();
  toast(t("portal.studio.canSpeakNow"));
});

window.addEventListener("message", async (ev) => {
  if (ev.data?.type !== "glabs-flows-changed") return;
  await refresh();
  if (!hasOwnFlows()) {
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
  state.me = me.user;
  const asAdmin = me.user.role === "glabs";
  if (me.user.mustChangePassword) {
    location.replace("/admin/login.html");
  } else if (asAdmin && !sessionStorage.getItem("glabs_client_id")) {
    location.replace("/admin/");
  } else {
    await refresh();

    // Volta do redirect OAuth do Google Calendar (/v1/integrations/google-calendar/callback)
    const qs = new URLSearchParams(location.search);
    if (qs.get("view") && TITLES[qs.get("view")]) setView(qs.get("view"));
    if (qs.get("google_connected")) toast(t("portal.account.integrations.connected"));
    if (qs.get("google_error")) toast(t("portal.account.integrations.connectError"), "err");
    const cameFromRedirect = qs.has("view") || qs.has("google_connected") || qs.has("google_error");
    if (cameFromRedirect) {
      history.replaceState(null, "", location.pathname);
    }
    // Tour de 1º acesso: nunca ao voltar de um redirect/callback (OAuth do
    // Calendar, deep-link ?view=) — competiria com o destino real dele.
    if (!cameFromRedirect) maybeTour();

    const clientName = state.portal?.client?.name || "";
    // Mesmo caso do card de perfil (ver loadAccount): em impersonation, a
    // saudação precisa ser sobre o NEGÓCIO sendo visualizado, não sobre o
    // login do admin — senão vira "Olá, zabateste44!" pro cliente errado.
    // O badge who-name/who-role no canto (+ o banner amarelo) já deixam
    // claro que quem está logado é o admin; aqui é só o "oi" da tela.
    const clientUser = state.portal?.users?.[0] || null;
    const person = asAdmin
      ? (clientUser?.name || clientName || "").split(" ")[0]
      : me.user.name && me.user.name !== clientName
        ? me.user.name.split(" ")[0]
        : "";
    state.firstName = person;
    $("who-name").textContent = asAdmin ? (me.user.name || "GLabs") : clientName || me.user.email;
    $("who-av").textContent = (asAdmin ? (me.user.name || "G") : clientName || "C").slice(0, 1).toUpperCase();
    $("who-role").textContent = asAdmin ? t("portal.role.adminViewing") : t("portal.role.client");
    $("hello").textContent = person ? t("portal.helloName", { name: person }) : t("portal.hello");
    setInterval(() => {
      void refresh();
      if (state.view === "inbox") void loadInbox();
    }, 4000);
  }
} catch {
  location.replace("/admin/login.html");
}
