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
  if (view === "knowledge") {
    setKbTab(kbTab);
    // A contagem do selo vem sempre, mesmo fora da aba de pendências — é ela
    // que avisa que há o que fazer.
    void atualizarContadorGaps();
  }
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

/* ── Modos de fluxo (simples · completo · template) ─────────
 * Os três coexistem salvos; o dono alterna sem perder edição de nenhum.
 * Fluxo antigo, salvo antes do campo `mode`, lê como "completo" — mesma
 * regra do backend (flowModeOf em src/flows/types.ts).
 */
const FLOW_MODES = ["simples", "completo", "template"];

function flowModeOf(flow) {
  return FLOW_MODES.includes(flow?.mode) ? flow.mode : "completo";
}

/** Fluxo do cliente naquele modo, se já existir (mais recente primeiro). */
function flowForMode(mode) {
  return (
    (state.portal?.flows || [])
      .filter((f) => flowModeOf(f) === mode)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null
  );
}

/** Modo mostrado agora. Preferência: o que o dono escolheu nesta sessão →
 * o publicado → o único que existe. Guardado por cliente pra sobreviver ao
 * refresh de 4s e à volta do QR. */
function activeMode() {
  const saved = sessionStorage.getItem(`glabs_flow_mode_${state.portal?.client?.id || "anon"}`);
  if (saved && flowForMode(saved)) return saved;
  const live = (state.portal?.flows || []).find((f) => f.status === "live");
  if (live) return flowModeOf(live);
  const any = FLOW_MODES.find((m) => flowForMode(m));
  return any || "completo";
}

function setActiveMode(mode) {
  sessionStorage.setItem(`glabs_flow_mode_${state.portal?.client?.id || "anon"}`, mode);
}

function activeModeFlow() {
  return flowForMode(activeMode());
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
 * Jornada guiada de 1º acesso.
 *
 * Antes eram 2 passos fixos (QR → aba Fluxo) com um booleano "já viu". A
 * jornada pedida pelo usuário (27/08) é maior: primeiro ambientar — mostrar
 * o menu, o que é cada área — e só DEPOIS perguntar o objetivo e conduzir
 * até o fim (WhatsApp conectado, ou primeiro fluxo pronto).
 *
 * Isso exigiu três coisas que o motor antigo não tinha:
 *  • `view` por passo, pra trocar de aba antes de destacar o alvo;
 *  • RAMIFICAÇÃO — a partir da escolha de objetivo os caminhos divergem;
 *  • PROGRESSO PERSISTIDO, não um booleano. A conexão do WhatsApp faz
 *    refresh() a cada 4s e o dono pode recarregar a página no meio; sem
 *    guardar onde parou, a jornada recomeçava ou sumia.
 */
function tourKey() {
  const cid = state.portal?.client?.id || "anon";
  return `glabs_tour_done_${cid}`;
}
function tourProgressKey() {
  const cid = state.portal?.client?.id || "anon";
  return `glabs_journey_${cid}`;
}

/** Elemento de nav visível pra uma view. No breakpoint mobile a sidebar some
 * e vira .mobile-nav; offsetParent não serve porque .mobile-nav é fixed
 * (offsetParent é sempre null nesse caso, mesmo visível). */
/** O diálogo de primeiro fluxo, só quando está de fato na tela. */
function visibleOnboard() {
  const el = $("onboard");
  return el && !el.classList.contains("hidden") ? el : null;
}

/** A tela "Confere antes de salvar", idem. */
function visibleKnowledgeReview() {
  const el = $("knowledge-review");
  return el && !el.classList.contains("hidden") ? el : null;
}

function visibleNavLink(view) {
  const links = [...document.querySelectorAll(`[data-view="${view}"]`)];
  return links.find((el) => getComputedStyle(el).display !== "none") || links[0] || null;
}

/**
 * Passos da jornada. `id` é o que fica salvo no progresso — por isso são
 * nomes, não índices: inserir um passo no meio não pode teleportar quem
 * está no meio da jornada.
 * `choices` transforma o passo numa bifurcação; `next` liga o passo
 * seguinte; `done` encerra a jornada ali.
 */
const JOURNEY = [
  {
    id: "menu",
    view: "status",
    target: () => visibleNavLink("status"),
    titleKey: "portal.tour.menuTitle",
    bodyKey: "portal.tour.menuBody",
    next: "conhecimento",
  },
  {
    id: "conhecimento",
    view: "status",
    target: () => visibleNavLink("knowledge") || visibleNavLink("account"),
    titleKey: "portal.tour.knowTitle",
    bodyKey: "portal.tour.knowBody",
    next: "conta",
  },
  {
    id: "conta",
    view: "status",
    target: () => visibleNavLink("account"),
    titleKey: "portal.tour.accountTitle",
    bodyKey: "portal.tour.accountBody",
    next: "objetivo",
  },
  {
    // Bifurcação: os dois caminhos que o usuário definiu. Migrar de outro
    // provedor caiu em "conectar" de propósito — ele concluiu que separar
    // seria "complexidade que não existe".
    id: "objetivo",
    view: "status",
    target: () => $("wa-hero") || visibleNavLink("status"),
    titleKey: "portal.tour.goalTitle",
    bodyKey: "portal.tour.goalBody",
    choices: [
      { labelKey: "portal.tour.goalConnect", next: "conectar" },
      { labelKey: "portal.tour.goalFlow", next: "fluxo" },
    ],
  },
  {
    id: "conectar",
    view: "status",
    target: () => $("btn-connect"),
    titleKey: "portal.tour.step1Title",
    bodyKey: "portal.tour.step1Body",
    done: true,
  },
  {
    id: "fluxo",
    view: "flow",
    // Abrir esta view faz o #onboard tomar a tela (maybeOnboard). É NELE que
    // está a decisão que o passo pede ("escolha uma das 2 opções"), então é
    // ele que precisa do destaque: mirar no item de menu deixava o balão
    // apontando pro canto enquanto o diálogo real dominava o centro, e o dono
    // não conseguia ligar o texto ao que tinha que fazer.
    target: () => visibleOnboard() || visibleNavLink("flow"),
    titleKey: "portal.tour.step2Title",
    bodyKey: "portal.tour.step2Body",
    // Entrega pro #onboard (que já oferece template x IA) e SAI DA TELA —
    // mas a jornada NÃO acaba aqui: retoma no passo "modos" assim que o
    // fluxo existir. O usuário pediu tour "até ele finalizar o primeiro
    // fluxo", e terminar antes de o fluxo existir deixava ele sozinho
    // justamente no momento em que mais precisa de orientação.
    pauseForOnboard: true,
  },
  {
    // Aparece SOBRE a tela "Confere antes de salvar", logo que o fluxo fica
    // pronto — o momento em que o dono está olhando aquelas perguntas sem
    // saber pra que servem. Explica e sai da frente: quem decide salvar ou
    // pular é ele, e a demonstração dos cards só começa depois disso.
    //
    // Fora da numeração de propósito: a revisão só abre quando a extração
    // acha algo, e um passo condicional dentro do "Passo N de M" faria o
    // total mentir justamente nas vezes em que ela não abre.
    id: "revisao",
    view: "flow",
    target: () => visibleKnowledgeReview(),
    labelKey: "portal.tour.reviewLabel",
    titleKey: "portal.tour.reviewTitle",
    bodyKey: "portal.tour.reviewBody",
    pauseForReview: true,
  },
  {
    // Alcançado por CÓDIGO, não por ligação: quem traz aqui é
    // resumeJourneyAfterFlow(), disparado quando o primeiro fluxo fica
    // pronto. Por isso não há `next` apontando pra ele.
    id: "modos",
    resumedAfterFlow: true,
    view: "flow",
    // O painel vive DENTRO do iframe do builder (ver flows.js). Precisa do
    // caminho especial abaixo pra virar coordenada da página de fora.
    inFrame: "flow-modes",
    target: () => $("flow-frame"),
    titleKey: "portal.tour.modesTitle",
    bodyKey: "portal.tour.modesBody",
    done: true,
  },
];

const journeyStep = (id) =>
  JOURNEY.find((s) => s.id === id) || demoSteps.find((s) => s.id === id) || null;

/** Para onde este passo pode levar: os ramos, o seguinte, ou a retomada. */
function nextIdsOf(step) {
  if (!step) return [];
  if (step.choices) return step.choices.map((c) => c.next).filter(Boolean);
  if (step.next) return [step.next];
  // Pausa pro onboarding não é fim de jornada: ela volta no passo de retomada.
  if (step.pauseForOnboard) {
    const r = JOURNEY.find((s) => s.resumedAfterFlow);
    return r ? [r.id] : [];
  }
  return [];
}

/**
 * Caminho do início até `id`, seguindo as ligações reais.
 *
 * A jornada BIFURCA em "objetivo": quem escolhe montar o fluxo nunca passa
 * por "conectar". Numerar pela posição no array fazia o passo 4 saltar direto
 * pro 6, e o dono lia isso como "faltou alguma coisa" — foi exatamente o que
 * aconteceu. Contar pelo caminho percorrido resolve, e sobrevive a recarregar
 * a página (é derivado do id salvo, não de estado em memória).
 */
function journeyPathTo(id, from = JOURNEY[0]?.id, seen = new Set()) {
  if (!from || seen.has(from)) return null;
  if (from === id) return [from];
  const ahead = new Set(seen).add(from);
  for (const n of nextIdsOf(journeyStep(from))) {
    const tail = journeyPathTo(id, n, ahead);
    if (tail) return [from, ...tail];
  }
  return null;
}

/** Quantos passos ainda faltam pela frente (o ramo mais longo, se bifurcar). */
function stepsAhead(step, seen = new Set()) {
  if (!step || step.done || seen.has(step.id)) return 0;
  const ahead = new Set(seen).add(step.id);
  let longest = 0;
  for (const n of nextIdsOf(step)) {
    longest = Math.max(longest, 1 + stepsAhead(journeyStep(n), ahead));
  }
  return longest;
}

let tourStepId = null;

/**
 * Retângulo do alvo em coordenadas DESTA página.
 *
 * Alvo pode estar dentro do iframe do builder (o painel de modos, por
 * exemplo). Como é mesma origem, dá pra ler o elemento lá dentro e somar a
 * posição do próprio iframe. Se ainda não carregou, cai no iframe inteiro —
 * destaque menos preciso, mas melhor que o tour sumir sem explicação.
 */
function targetRect(step) {
  const el = step?.target();
  if (!el) return null;
  if (step.inFrame || step.inFrameSelector) {
    try {
      const doc = el.contentDocument;
      const inner = step.inFrameSelector
        ? doc?.querySelector(step.inFrameSelector)
        : doc?.getElementById(step.inFrame);
      if (inner) {
        const f = el.getBoundingClientRect();
        const i = inner.getBoundingClientRect();
        return { left: f.left + i.left, top: f.top + i.top, width: i.width, height: i.height,
                 right: f.left + i.right, bottom: f.top + i.bottom };
      }
    } catch {
      /* mesma origem sempre — só falha enquanto o iframe ainda carrega */
    }
  }
  return el.getBoundingClientRect();
}

function positionTour() {
  const hole = $("tour-hole");
  const bubble = $("tour-bubble");
  const r = targetRect(journeyStep(tourStepId));
  if (!r || !hole || !bubble) return;
  const pad = 8;
  hole.style.left = `${r.left - pad}px`;
  hole.style.top = `${r.top - pad}px`;
  hole.style.width = `${r.width + pad * 2}px`;
  hole.style.height = `${r.height + pad * 2}px`;

  // O balão não pode tapar o que ele está explicando. A regra antiga chutava
  // 180px de altura pra subir o balão: quando ele era mais alto que isso —
  // sempre, nos passos de texto mais longo — a sobra descia por cima do
  // próprio alvo. Foi o que aconteceu com os itens da barra lateral, que são
  // baixos na lista e deixam pouco espaço embaixo.
  //
  // Agora mede a altura de verdade e testa posições em ordem de preferência,
  // ficando na primeira que cabe INTEIRA na tela. Abaixo/acima/ao lado nunca
  // encostam no alvo por construção.
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const box = bubble.getBoundingClientRect();
  const bw = box.width || 320;
  const bh = box.height || 200;
  const near = pad + gap;
  const clampX = (v) => Math.max(12, Math.min(v, vw - bw - 12));
  const clampY = (v) => Math.max(12, Math.min(v, vh - bh - 12));
  const spots = [
    { left: clampX(r.left), top: clampY(r.bottom + near) },      // embaixo
    { left: clampX(r.left), top: clampY(r.top - near - bh) },    // em cima
    { left: clampX(r.right + near), top: clampY(r.top) },        // à direita
    { left: clampX(r.left - near - bw), top: clampY(r.top) },    // à esquerda
  ];
  // Quanto cada posição tapa do alvo. Alvo pequeno tem várias com zero e vale
  // a ordem de preferência; alvo GRANDE (o diálogo de onboarding ocupa quase
  // a tela toda) pode não ter nenhuma limpa — aí fica a que tapa menos, que é
  // sempre melhor que uma posição fixa escolhida no escuro.
  const hidden = (s) =>
    Math.max(0, Math.min(s.left + bw, r.right) - Math.max(s.left, r.left)) *
    Math.max(0, Math.min(s.top + bh, r.bottom) - Math.max(s.top, r.top));
  const spot = spots.reduce((best, s) => (hidden(s) < hidden(best) ? s : best), spots[0]);
  const { left, top } = spot;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function showTourStep(id) {
  const step = journeyStep(id);
  if (!step) return dismissTour(false);
  if (step.view && state.view !== step.view) setView(step.view);

  if (!targetRect(step)) {
    // Alvo não existe nesta tela (ex.: item de menu ausente no mobile) —
    // pula pro próximo em vez de travar a jornada num passo invisível.
    const nxt = step.next || step.choices?.[0]?.next;
    if (nxt) return showTourStep(nxt);
    return dismissTour(false);
  }

  tourStepId = id;
  // "revisao" não vira progresso salvo: é condicional e o diálogo não existe
  // mais depois de fechado — restaurar nele deixaria a jornada num passo sem
  // alvo. O progresso segue valendo "fluxo", que é o ponto real de retomada.
  if (!step.pauseForReview) localStorage.setItem(tourProgressKey(), id);
  $("tour")?.classList.remove("hidden");

  // Numera pelo CAMINHO, não pelo array — ver journeyPathTo. Passo dinâmico
  // (demonstração) não está no grafo e usa o rótulo genérico.
  const path = journeyPathTo(id);
  $("tour-step-label").textContent = path
    ? t("portal.tour.stepLabel", { n: path.length, total: path.length + stepsAhead(step) })
    : t(step.labelKey || "portal.demo.label");
  // Passo dinâmico (demonstração) já traz o texto pronto; os fixos vêm por
  // chave i18n.
  $("tour-title").textContent = step.title ?? t(step.titleKey);
  $("tour-body").textContent = step.body ?? t(step.bodyKey);
  renderTourActions(step);
  positionTour();
}

/** Botões do balão: uma escolha por opção quando o passo bifurca, senão o
 * "Próxima"/"Concluir" de sempre. */
function renderTourActions(step) {
  const wrap = $("tour-actions-dyn");
  const next = $("tour-next");
  if (!wrap || !next) return;
  wrap.innerHTML = "";
  if (step.choices) {
    next.classList.add("hidden");
    for (const c of step.choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-lime tour-choice";
      b.textContent = t(c.labelKey);
      b.addEventListener("click", () =>
        c.action ? runDemoChoice(c.action) : showTourStep(c.next)
      );
      wrap.appendChild(b);
    }
    return;
  }
  next.classList.remove("hidden");
  next.textContent = step.done ? t("portal.tour.finish") : t("portal.tour.next");
}

function advanceTour() {
  const step = journeyStep(tourStepId);
  if (!step) return dismissTour();
  if (step.pauseForOnboard) {
    // Some da tela mas MANTÉM o progresso salvo: o dono vai conversar com o
    // coach agora, e a jornada volta quando o fluxo estiver pronto.
    $("tour")?.classList.add("hidden");
    setView("flow"); // aciona maybeOnboard()
    return;
  }
  if (step.pauseForReview) {
    // Idem: sai da frente pro dono conferir/editar os itens em paz. Quem
    // retoma é releaseJourneyAfterReview(), quando ele salva ou pula.
    $("tour")?.classList.add("hidden");
    return;
  }
  if (step.done) return dismissTour();
  if (step.next) showTourStep(step.next);
  else dismissTour();
}

/**
 * Retoma a jornada depois que o primeiro fluxo fica pronto — é o "até ele
 * finalizar o primeiro fluxo" que o usuário pediu. Mostra o painel de modos,
 * que é onde ele descobre QUAL fluxo tem e como trocar. Só roda se a jornada
 * estava mesmo pausada nesse ponto: quem já dispensou o tour não é
 * interrompido de novo.
 */
/**
 * Ligado enquanto a revisão de conhecimento pós-build está no caminho. Só o
 * caminho "Montar com IA" liga: a revisão também aparece vindo de template e
 * de texto colado, e nesses a jornada não tem nada pra retomar ali.
 */
let journeyWaitsForReview = false;

/**
 * Explica a tela "Confere antes de salvar" enquanto ela está aberta. Só
 * aparece pra quem está mesmo na jornada — quem já dispensou o tour, ou já
 * passou desse ponto, confere os itens sem interrupção.
 */
function showKnowledgeReviewStep() {
  if (!journeyWaitsForReview) return;
  if (localStorage.getItem(tourKey()) === "1") return;
  if (localStorage.getItem(tourProgressKey()) !== "fluxo") return;
  showTourStep("revisao");
}

/** Revisão terminou (ou nem abriu): a jornada pode seguir. */
function releaseJourneyAfterReview() {
  if (!journeyWaitsForReview) return;
  journeyWaitsForReview = false;
  resumeJourneyAfterFlow();
}

function resumeJourneyAfterFlow() {
  if (localStorage.getItem(tourKey()) === "1") return;
  if (localStorage.getItem(tourProgressKey()) !== "fluxo") return;
  // Espera o iframe do builder pintar os cards — eles são o alvo da
  // demonstração, e mirar num canvas ainda vazio destacaria o nada.
  waitForFlowCards().then((ok) => (ok ? startFlowDemo() : showTourStep("modos")));
}

/**
 * Resolve quando os cards do fluxo aparecem dentro do iframe. Desiste depois
 * de ~6s: sem isso, um builder que demora ou falha deixaria a jornada
 * pendurada pra sempre — melhor cair no passo simples (só o painel de modos)
 * do que sumir sem explicação.
 */
function waitForFlowCards(timeoutMs = 6000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      try {
        const doc = $("flow-frame")?.contentDocument;
        if (doc?.querySelector(".fb-node")) return resolve(true);
      } catch {
        /* mesma origem — só falha enquanto carrega */
      }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/* ── Demonstração card a card do fluxo simples ─────────────
 * Pedido do usuário: ao sair do onboarding, o tour percorre o fluxo simples
 * mostrando o que cada card faz, e no fim oferece o completo ou um modelo.
 *
 * Roda no fluxo SIMPLES de propósito: são poucos cards, então dá pra
 * explicar um a um sem cansar — no completo (14+) isso viraria tortura.
 *
 * Os cards vivem dentro do iframe do builder, então cada passo é gerado na
 * hora a partir dos nós salvos e mira `.fb-node[data-id=...]` lá dentro
 * (ver targetRect/inFrameSelector).
 */

/** Uma frase por tipo de card, na língua do dono — não do builder. */
function describeCard(node) {
  const d = node.data || {};
  const txt = (v, max = 70) => {
    const t2 = String(v || "").replace(/\s+/g, " ").trim();
    return t2.length > max ? t2.slice(0, max) + "…" : t2;
  };
  switch (node.type) {
    case "trigger":
      return t("portal.demo.trigger");
    case "message":
      return t("portal.demo.message", { texto: txt(d.text) });
    case "ask":
      return t("portal.demo.ask", { pergunta: txt(d.prompt), var: String(d.varName || "") });
    case "llm_intent":
      return t("portal.demo.intent");
    case "llm_answer":
      return t("portal.demo.answer");
    case "handoff":
      return t("portal.demo.handoff");
    case "end":
      return t("portal.demo.end");
    default:
      return t("portal.demo.generic");
  }
}

/** Passos da demonstração, montados na hora a partir do fluxo. */
function buildDemoSteps(flow) {
  const nodes = flow?.nodes || [];
  if (!nodes.length) return [];
  return nodes.map((n, i) => ({
    id: `demo:${n.id}`,
    view: "flow",
    inFrameSelector: `.fb-node[data-id="${cssEscape(n.id)}"]`,
    target: () => $("flow-frame"),
    title: t("portal.demo.cardTitle", { n: i + 1, total: nodes.length }),
    body: describeCard(n),
    next: i < nodes.length - 1 ? `demo:${nodes[i + 1].id}` : "demo:fim",
  }));
}

/** id de nó vem do nosso próprio gerador (n_xxx), mas escapar é barato e
 * evita seletor quebrado se algum dia mudar. */
function cssEscape(v) {
  return String(v).replace(/["\\]/g, "\\$&");
}

let demoSteps = [];

/** Chamado quando o fluxo simples fica pronto. */
function startFlowDemo() {
  const simples = flowForMode("simples") || activeModeFlow();
  demoSteps = buildDemoSteps(simples);
  if (!demoSteps.length) return dismissTour();
  demoSteps.push({
    id: "demo:fim",
    view: "flow",
    inFrameSelector: "#flow-modes",
    target: () => $("flow-frame"),
    title: t("portal.demo.doneTitle"),
    body: t("portal.demo.doneBody"),
    choices: [
      { labelKey: "portal.demo.keepSimple", action: "close" },
      { labelKey: "portal.demo.seeFull", action: "completo" },
      { labelKey: "portal.demo.seeTemplate", action: "template" },
    ],
  });
  showTourStep(demoSteps[0].id);
}

/** Ação do passo final da demonstração. */
function runDemoChoice(action) {
  dismissTour();
  if (action === "completo") {
    const f = flowForMode("completo");
    if (f) {
      setActiveMode("completo");
      openBuilder(f.id);
    } else {
      void makeMissingMode("completo");
    }
    return;
  }
  if (action === "template") void makeMissingMode("template");
}

function dismissTour(remember = true) {
  if (remember) {
    localStorage.setItem(tourKey(), "1");
    localStorage.removeItem(tourProgressKey());
  }
  $("tour")?.classList.add("hidden");
}

/** Chamado uma vez no boot, depois que refresh() resolve. Retoma de onde
 * parou quando há progresso salvo — o dono pode ter recarregado a página no
 * meio da conexão do WhatsApp. */
function maybeTour() {
  if (localStorage.getItem(tourKey()) === "1") return;
  if (state.lastWa === "connected") return;
  const saved = localStorage.getItem(tourProgressKey());
  showTourStep(saved && journeyStep(saved) ? saved : JOURNEY[0].id);
}

$("tour-skip")?.addEventListener("click", () => dismissTour());
// Clicar fora (fora do balão) fecha, mas sem marcar como "já resolvi" —
// mesmo padrão do .onboard: volta na próxima visita, retomando o progresso.
$("tour")?.addEventListener("click", (ev) => {
  if (ev.target === $("tour")) dismissTour(false);
});
$("tour-next")?.addEventListener("click", () => advanceTour());
window.addEventListener("resize", () => {
  if (!$("tour")?.classList.contains("hidden")) positionTour();
});
// Fonte carrega depois do primeiro desenho e muda as medidas do texto — o que
// desloca o alvo e deixa o balão apontando pro lugar errado. Reposiciona
// quando elas terminam. Foi um teste medindo a tela no meio do rearranjo que
// tornou isso visível.
document.fonts?.ready.then(() => {
  if (!$("tour")?.classList.contains("hidden")) positionTour();
});
window.addEventListener(
  "scroll",
  () => {
    if (!$("tour")?.classList.contains("hidden")) positionTour();
  },
  true
);

function openBuilder(flowId) {
  const frame = $("flow-frame");
  frame?.classList.remove("hidden");
  const cid = sessionStorage.getItem("glabs_client_id") || state.portal?.client?.id || "";
  if (frame) {
    frame.dataset.loaded = "1";
    // ?flow= diz ao builder QUAL fluxo abrir. Sem isso ele escolhia o mais
    // recente, que não tem relação com o modo selecionado no painel.
    const wanted = flowId || activeModeFlow()?.id || "";
    const q = wanted ? `&flow=${encodeURIComponent(wanted)}` : "";
    frame.src = `/admin/flows.html?embed=1&client=${encodeURIComponent(cid)}${q}&v=17`;
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
  // Sem ensaio, sobraram duas fases: coletando (ask) e pronto pra montar
  // (ready). Os ramos de offer/preview/debrief saíram junto com ele.
  const ready = state.studio.phase === "ready";
  $("studio-kicker").textContent = ready
    ? t("portal.studio.kicker.ready")
    : t("portal.studio.kicker.briefing");
  $("studio-kicker").className = "studio-kicker" + (ready ? " ready" : "");
  $("studio-title").textContent = ready
    ? t("portal.studio.title.feedback")
    : t("portal.studio.title.default");
  $("studio-sub").textContent = ready
    ? t("portal.studio.sub.afterRehearsal")
    : t("portal.studio.sub.ask");
  $("studio-ready")?.classList.toggle("hidden", !ready || state.studio.busy);
}

function syncFlowPane() {
  // Sem fluxo nenhum, quem convida a começar é o modal de onboarding
  // (maybeOnboard) — abrir o Studio à força aqui tirava a escolha do usuário
  // e o deixava sem saída.
  if (!hasOwnFlows()) ensureStudioWelcome();
  studioLayout();
}

/* A UI de troca de modo vive no CABEÇALHO DO BUILDER (flows.js) — o portal
 * só cuida de CRIAR um modo que ainda não existe, porque isso depende da
 * conversa de onboarding, que mora aqui. O builder pede via postMessage.
 */
/**
 * Cria o fluxo de um modo que o dono ainda não tem.
 * - template: abre o catálogo, que é onde ele escolhe qual.
 * - simples/completo: gera a partir da MESMA conversa de onboarding que já
 *   aconteceu (state.studio.messages). Sem histórico não dá pra gerar nada
 *   com fundamento — nesse caso reabre o Studio pra conversar primeiro.
 */
async function makeMissingMode(mode) {
  if (mode === "template") {
    openStudio({ expand: true, mode: "flow" });
    const box = $("tpl-pick");
    if (box) {
      box.classList.remove("hidden");
      void renderTemplatePicker();
    }
    return;
  }
  const history = studioHistory();
  if (history.length < 2) {
    toast(t("portal.flowMode.needBriefing"));
    openStudio({ expand: true, mode: "flow" });
    return;
  }
  toast(t("portal.flowMode.building"));
  try {
    const data = await api("/v1/flows/studio", {
      method: "POST",
      body: JSON.stringify({ messages: history, action: "build", buildMode: mode }),
    });
    if (data.flow) {
      await refresh();
      setActiveMode(mode);
      openBuilder(data.flow.id);
      studioLayout();
    }
  } catch (e) {
    toast(e.message, "err");
  }
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
  renderBotRules(acc?.account?.botRules);
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
/**
 * Abas internas de Conhecimento.
 *
 * Três listas longas empilhadas viravam uma página sem fim, e lado a lado cada
 * uma ficaria com metade da largura justo quando o volume cresce. Cada aba usa
 * a largura toda e tem busca e paginação próprias.
 */
/** Padrão do retorno automático — tem que bater com o backend (bot-rules.ts). */
const DEFAULT_RETURN_MS = 24 * 60 * 60 * 1000;

const KB_TABS = ["base", "gaps", "log"];
let kbTab = "base";

function setKbTab(aba) {
  if (!KB_TABS.includes(aba)) return;
  kbTab = aba;
  for (const btn of document.querySelectorAll("[data-kb-tab]")) {
    btn.classList.toggle("on", btn.dataset.kbTab === aba);
  }
  for (const nome of KB_TABS) {
    const painel = $(`kb-pane-${nome}`);
    if (painel) painel.hidden = nome !== aba;
  }
  // Carrega só o que está à vista: abrir Conhecimento não precisa buscar as
  // três listas de uma vez.
  if (aba === "base") void loadKnowledge();
  if (aba === "gaps") void loadGaps();
  if (aba === "log") void loadAiAnswers();
}

for (const btn of document.querySelectorAll("[data-kb-tab]")) {
  btn.addEventListener("click", () => setKbTab(btn.dataset.kbTab));
}

/** Quantos itens por página em cada lista. */
const KB_PAGE = 30;

/** Estado da paginação da base: quantos já vieram e se ainda há mais. */
let kbOffset = 0;
let kbItems = [];

async function loadKnowledge({ mais = false } = {}) {
  const box = $("kb-list");
  if (!box) return;
  const busca = $("kb-search")?.value.trim() || "";
  if (!mais) {
    kbOffset = 0;
    kbItems = [];
    box.innerHTML = `<p class="hint-muted">${t("portal.knowledge.loading")}</p>`;
  }
  try {
    const q = new URLSearchParams({ limit: String(KB_PAGE), offset: String(kbOffset) });
    if (busca) q.set("q", busca);
    const data = await api(`/v1/rag/knowledge?${q}`);
    const vieram = data.chunks || [];
    kbItems = mais ? [...kbItems, ...vieram] : vieram;
    kbOffset = kbItems.length;
    // Página cheia = provavelmente há mais. Página incompleta = acabou.
    $("btn-kb-more")?.classList.toggle("hidden", vieram.length < KB_PAGE);
    renderKnowledge(kbItems);
  } catch (e) {
    box.innerHTML = `<p class="hint-muted">${escapeHtml(e.message)}</p>`;
  }
}

$("btn-kb-more")?.addEventListener("click", () => void loadKnowledge({ mais: true }));
$("kb-search")?.addEventListener("input", debounceBusca(() => void loadKnowledge()));
$("log-search")?.addEventListener("input", debounceBusca(() => void loadAiAnswers()));

/**
 * Espera o dono parar de digitar antes de buscar.
 *
 * A busca é no servidor; disparar a cada tecla mandaria uma consulta por
 * letra e faria a lista piscar enquanto ele escreve.
 */
function debounceBusca(fn, ms = 300) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
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
  // Barra de seleção/limpeza só faz sentido com item na lista.
  $("kb-bulk")?.classList.toggle("hidden", !chunks.length);
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
        <input type="checkbox" class="kb-pick" data-pick="${escapeHtml(c.id)}" aria-label="${t("portal.knowledge.selectItem")}" />
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

  box.querySelectorAll("[data-pick]").forEach((cb) => {
    cb.addEventListener("change", syncKbSelection);
  });
  syncKbSelection();

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

/* ── Exclusão em lote da base de conhecimento ───────────────
 * Remoção aqui é SUAVE no backend (marca suppressed, preserva o histórico de
 * origem — docs/rag-desenho.md §5.2), mas pela tela não tem como desfazer:
 * por isso a confirmação exige digitar a palavra, não é só um confirm().
 */

/** Ids marcados na lista, na ordem em que aparecem. */
function kbSelectedIds() {
  return [...document.querySelectorAll("#kb-list [data-pick]:checked")].map((cb) => cb.dataset.pick);
}

function syncKbSelection() {
  const total = document.querySelectorAll("#kb-list [data-pick]").length;
  const picked = kbSelectedIds().length;
  const all = $("kb-select-all");
  if (all) {
    all.checked = total > 0 && picked === total;
    // Estado "alguns marcados" — sem isso o checkbox mestre parece desmarcado
    // mesmo com seleção parcial.
    all.indeterminate = picked > 0 && picked < total;
  }
  $("btn-kb-delete-selected")?.classList.toggle("hidden", picked === 0);
  const label = $("kb-bulk-count");
  if (label) label.textContent = picked ? t("portal.knowledge.nSelected", { n: picked }) : "";
}

$("kb-select-all")?.addEventListener("change", (ev) => {
  const on = ev.target.checked;
  document.querySelectorAll("#kb-list [data-pick]").forEach((cb) => {
    cb.checked = on;
  });
  syncKbSelection();
});

/** Palavra que o dono digita pra confirmar — maiúscula pra não sair no
 * automático, e traduzida (quem usa em inglês digita DELETE, não EXCLUIR). */
const kbConfirmWord = () => t("portal.knowledge.confirm.word");
/** O que fazer quando a confirmação for aceita — definido por quem abriu. */
let kbConfirmAction = null;

function openKbConfirm({ sub, action }) {
  kbConfirmAction = action;
  $("kb-confirm-sub").textContent = sub;
  $("kb-confirm-label").textContent = t("portal.knowledge.confirm.type", { word: kbConfirmWord() });
  const input = $("kb-confirm-input");
  if (input) input.value = "";
  $("kb-confirm-go")?.setAttribute("disabled", "true");
  $("kb-confirm")?.classList.remove("hidden");
  input?.focus();
}

function closeKbConfirm() {
  kbConfirmAction = null;
  $("kb-confirm")?.classList.add("hidden");
}

$("kb-confirm-input")?.addEventListener("input", (ev) => {
  const ok = ev.target.value.trim().toUpperCase() === kbConfirmWord().toUpperCase();
  const go = $("kb-confirm-go");
  if (!go) return;
  if (ok) go.removeAttribute("disabled");
  else go.setAttribute("disabled", "true");
});

$("kb-confirm-cancel")?.addEventListener("click", () => closeKbConfirm());
$("kb-confirm")?.addEventListener("click", (ev) => {
  if (ev.target === $("kb-confirm")) closeKbConfirm();
});

$("kb-confirm-go")?.addEventListener("click", async () => {
  const action = kbConfirmAction;
  if (!action) return;
  $("kb-confirm-go")?.setAttribute("disabled", "true");
  try {
    const removed = await action();
    toast(t("portal.knowledge.removedN", { n: removed }));
    closeKbConfirm();
    await loadKnowledge();
  } catch (e) {
    toast(e.message, "err");
    closeKbConfirm();
  }
});

$("btn-kb-delete-selected")?.addEventListener("click", () => {
  const ids = kbSelectedIds();
  if (!ids.length) return;
  openKbConfirm({
    sub: t("portal.knowledge.confirm.subSelected", { n: ids.length }),
    action: async () => {
      const r = await api("/v1/rag/knowledge/suppress-batch", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      return r.removed ?? ids.length;
    },
  });
});

$("btn-kb-clear-all")?.addEventListener("click", () => {
  openKbConfirm({
    sub: t("portal.knowledge.confirm.subAll"),
    action: async () => {
      const r = await api("/v1/rag/knowledge/suppress-all", { method: "POST" });
      return r.removed ?? 0;
    },
  });
});

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
/**
 * Caixa de entrada: o que a IA não soube responder.
 *
 * Ordenada pelas mais frequentes, porque a dúvida que volta é a que mais custa
 * deixar sem resposta. Ensinar tira da lista; o "desfazer" devolve.
 */
async function loadGaps() {
  const box = $("kb-gaps-list");
  if (!box) return;
  box.innerHTML = `<p class="hint-muted">${t("portal.knowledge.loading")}</p>`;
  try {
    const data = await api("/v1/rag/gaps?limit=50");
    const gaps = data.gaps || [];
    pintarContadorGaps(gaps.length);
    if (!gaps.length) {
      box.innerHTML = `<p class="hint-muted">${t("portal.gaps.empty")}</p>`;
      return;
    }
    box.innerHTML = agruparPorDia(gaps, (g) => g.lastAt, (g) => `
      <div class="kb-item gap-item" data-gap-key="${escapeHtml(g.key)}">
        <div class="kb-q">
          <b>${escapeHtml(g.question)}</b>
          ${g.times > 1 ? `<span class="ai-tag off">${t("portal.gaps.times", { n: g.times })}</span>` : ""}
        </div>
        <div class="kb-actions">
          <button type="button" class="btn-lime gap-teach">${t("portal.gaps.teach")}</button>
          <button type="button" class="btn-text gap-dismiss">${t("portal.gaps.dismiss")}</button>
        </div>
      </div>`);

    for (const el of box.querySelectorAll(".gap-item")) {
      const key = el.dataset.gapKey;
      const pergunta = el.querySelector("b").textContent;
      el.querySelector(".gap-teach").addEventListener("click", () => ensinarPendencia(key, pergunta));
      el.querySelector(".gap-dismiss").addEventListener("click", () => dispensarPendencia(key, pergunta));
    }
  } catch (e) {
    box.innerHTML = `<p class="hint-muted">${escapeHtml(e.message)}</p>`;
  }
}

/** Só a contagem, sem pintar a lista — pra o selo aparecer em qualquer aba. */
async function atualizarContadorGaps() {
  try {
    const data = await api("/v1/rag/gaps?limit=50");
    pintarContadorGaps((data.gaps || []).length);
  } catch {
    // Selo é informativo: falhar aqui não pode atrapalhar a tela.
  }
}

/** O contador ao lado da aba — é o que faz o dono voltar aqui. */
function pintarContadorGaps(n) {
  const badge = $("kb-gaps-count");
  if (!badge) return;
  badge.textContent = String(n);
  badge.classList.toggle("hidden", n === 0);
}

/**
 * Leva pra Base com o formulário de ensino já preenchido.
 *
 * Não ensina sozinho de propósito: o bot não sabe a resposta — quem sabe é o
 * dono. Aprender de conversa sem confirmação humana foi o que, em agosto,
 * gravou "Não foi mencionado." como resposta na base.
 */
function ensinarPendencia(key, pergunta) {
  setKbTab("base");
  $("kb-teach")?.classList.remove("hidden");
  $("kb-q").value = pergunta;
  $("kb-a").value = "";
  $("kb-a").focus();
  // Guarda a chave: ao salvar, a pendência sai da caixa de entrada.
  gapPendente = key;
}

let gapPendente = null;

async function dispensarPendencia(key, pergunta, { avisar = true } = {}) {
  try {
    await api("/v1/rag/gaps/dismiss", { method: "POST", body: JSON.stringify({ key }) });
    await loadGaps();
    if (avisar) {
      toast(t("portal.gaps.dismissed", { q: pergunta.slice(0, 40) }), "ok", {
        acao: { texto: t("portal.gaps.undo"), fn: () => void desfazerDispensa(key) },
      });
    }
  } catch (e) {
    toast(e.message, "err");
  }
}

async function desfazerDispensa(key) {
  try {
    await api("/v1/rag/gaps/dismiss", { method: "POST", body: JSON.stringify({ key, undo: true }) });
    await loadGaps();
    toast(t("portal.gaps.restored"));
  } catch (e) {
    toast(e.message, "err");
  }
}

/**
 * Agrupa uma lista por dia, com cabeçalho Hoje / Ontem / 30/08.
 *
 * "Quando isso foi perguntado" costuma importar tanto quanto o quê — uma
 * lista corrida de N dias não deixa perceber que a mesma dúvida voltou.
 *
 * O dia é o de Brasília, mesmo critério que o resto do produto usa
 * (ver AT TIME ZONE em inbox.ts).
 */
function agruparPorDia(itens, quando, render) {
  const FUSO = "America/Sao_Paulo";
  const diaDe = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: FUSO });
  const hoje = diaDe(new Date().toISOString());
  const ontem = diaDe(new Date(Date.now() - 86400000).toISOString());

  const rotulo = (dia) => {
    if (dia === hoje) return t("portal.knowledge.today");
    if (dia === ontem) return t("portal.knowledge.yesterday");
    const [a, m, d] = dia.split("-");
    return `${d}/${m}/${a}`;
  };

  let html = "";
  let atual = null;
  for (const item of itens) {
    const dia = diaDe(quando(item));
    if (dia !== atual) {
      atual = dia;
      html += `<h4 class="kb-day">${escapeHtml(rotulo(dia))}</h4>`;
    }
    html += render(item);
  }
  return html;
}

let logItems = [];
let logCursor = null;

async function loadAiAnswers({ mais = false } = {}) {
  const box = $("ai-log");
  if (!box) return;
  const busca = $("log-search")?.value.trim() || "";
  if (!mais) {
    logItems = [];
    logCursor = null;
    box.innerHTML = `<p class="hint-muted">${t("portal.knowledge.loading")}</p>`;
  }
  try {
    const q = new URLSearchParams({ limit: String(KB_PAGE) });
    if (busca) q.set("q", busca);
    if (mais && logCursor) q.set("before", logCursor);
    const data = await api(`/v1/rag/answers?${q}`);
    const vieram = data.answers || [];
    logItems = mais ? [...logItems, ...vieram] : vieram;
    logCursor = logItems.length ? logItems[logItems.length - 1].createdAt : null;
    $("btn-log-more")?.classList.toggle("hidden", vieram.length < KB_PAGE);
    const items = logItems;
    if (!items.length) {
      box.innerHTML = `<p class="hint-muted">${busca ? t("portal.knowledge.noResults") : t("portal.answers.empty")}</p>`;
      return;
    }
    box.innerHTML = agruparPorDia(items, (a) => a.createdAt, (a) => {
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
    });
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
    // Veio da caixa de entrada: ensinou, sai de lá. O "desfazer" fica no
    // aviso, caso tenha ensinado a pergunta errada.
    if (gapPendente) {
      const key = gapPendente;
      gapPendente = null;
      await dispensarPendencia(key, q, { avisar: false });
      toast(t("portal.gaps.taught"), "ok", {
        acao: { texto: t("portal.gaps.undo"), fn: () => void desfazerDispensa(key) },
      });
    }
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

/**
 * Filtro de números do bot (aba WhatsApp).
 *
 * A linha de resumo existe por um motivo específico: o pior desfecho desta
 * tela é o dono ativar o filtro, esquecer, e o bot ficar mudo pra clientes
 * reais achando que está tudo funcionando. Ela diz em voz alta o efeito atual
 * da regra, sempre que ele abre a aba.
 */
/**
 * Fusos oferecidos. Os do Brasil primeiro e por extenso — o dono não pensa em
 * "America/Cuiaba", pensa em "Mato Grosso". O resto do mundo vem depois, cru,
 * pra não travar quem está fora daqui.
 */
const BR_TIMEZONES = [
  ["America/Sao_Paulo", "Brasília (SP, RJ, MG, Sul, Nordeste)"],
  ["America/Manaus", "Manaus (AM, RR, RO, MT oeste)"],
  ["America/Cuiaba", "Cuiabá (MT)"],
  ["America/Campo_Grande", "Campo Grande (MS)"],
  ["America/Belem", "Belém (PA, AP)"],
  ["America/Fortaleza", "Fortaleza (CE, PI, MA, RN, PB, PE, AL, SE)"],
  ["America/Recife", "Recife (PE)"],
  ["America/Bahia", "Salvador (BA)"],
  ["America/Rio_Branco", "Rio Branco (AC)"],
  ["America/Noronha", "Fernando de Noronha"],
];

function fillTimezones(selected) {
  const sel = $("rules-tz");
  if (!sel || sel.options.length) {
    if (sel) sel.value = selected || DEFAULT_TZ;
    return;
  }
  const opt = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  const br = document.createElement("optgroup");
  br.label = t("portal.rules.tzBrazil");
  for (const [tz, label] of BR_TIMEZONES) br.appendChild(opt(tz, label));
  sel.appendChild(br);
  const brSet = new Set(BR_TIMEZONES.map(([tz]) => tz));
  let all = [];
  try {
    all = Intl.supportedValuesOf("timeZone").filter((tz) => !brSet.has(tz));
  } catch {
    // Navegador sem supportedValuesOf: os do Brasil já cobrem o caso real.
  }
  if (all.length) {
    const rest = document.createElement("optgroup");
    rest.label = t("portal.rules.tzOther");
    for (const tz of all) rest.appendChild(opt(tz, tz.replace(/_/g, " ")));
    sel.appendChild(rest);
  }
  sel.value = selected || DEFAULT_TZ;
}

const DEFAULT_TZ = "America/Sao_Paulo";
/** Domingo primeiro, como no calendário — o índice é o que o backend usa. */
const WEEK_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function fillDays(days) {
  const box = $("rules-days");
  if (!box) return;
  box.innerHTML = "";
  WEEK_KEYS.forEach((key, i) => {
    const label = document.createElement("label");
    label.className = "day-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(i);
    cb.checked = days.includes(i);
    const span = document.createElement("span");
    span.textContent = t(`portal.rules.day.${key}`);
    label.append(cb, span);
    box.appendChild(label);
  });
}

/**
 * O formulário está sendo mexido agora?
 *
 * render() roda a cada 4 segundos (o poller do boot), e repintar os campos
 * ali no meio apagava o que o dono estava fazendo: marcar "responder só em
 * determinado horário" e ver o painel fechar sozinho 4s depois, ou digitar
 * números e vê-los sumirem. Enquanto ele está editando, o que está na tela
 * vence o que está salvo.
 *
 * O `focus` conta junto com o `dirty`: repintar um campo focado mexe no
 * cursor mesmo quando o valor é idêntico.
 */
let botRulesDirty = false;

function botRulesBusy() {
  const alvos = [$("form-bot-rules"), $("bot-typing-card")].filter(Boolean);
  if (!alvos.length) return false;
  return botRulesDirty || alvos.some((el) => el.contains(document.activeElement));
}

for (const el of [$("form-bot-rules"), $("bot-typing-card")]) {
  el?.addEventListener("input", () => {
    botRulesDirty = true;
  });
  el?.addEventListener("change", () => {
    botRulesDirty = true;
  });
}

function renderBotRules(rules, { force = false } = {}) {
  const mode = rules?.numbers?.mode || "off";
  const list = rules?.numbers?.list || [];
  if (!$("rules-mode")) return;
  // A linha de resumo continua atualizando: ela mostra o que está SALVO, e é
  // justamente o contraste com o formulário que diz "você ainda não salvou".
  //
  // `force` é o retorno do salvamento: ali o formulário PRECISA ser repintado
  // mesmo com o botão ainda focado, senão o dono não vê o que o servidor
  // normalizou (número sem dígito descartado, texto cortado).
  if (force || !botRulesBusy()) fillBotRulesForm(rules, mode, list);
  paintBotRulesSummary(rules, mode, list);
}

function fillBotRulesForm(rules, mode, list) {
  const sel = $("rules-mode");
  sel.value = mode;
  $("rules-list").value = list.join("\n");
  toggleRulesList();

  const hours = rules?.hours;
  const hoursOn = Boolean(hours?.enabled);
  $("rules-hours-on").checked = hoursOn;
  // Dias padrão seg–sex: é o caso mais comum, e uma tela que abre com tudo
  // desmarcado obriga o dono a clicar cinco vezes só pro básico.
  fillDays(hoursOn ? hours.days || [] : [1, 2, 3, 4, 5]);
  $("rules-start").value = hours?.start || "08:00";
  $("rules-end").value = hours?.end || "18:00";
  $("rules-away").value = hours?.awayMessage || "";
  $("rules-delay").value = String(rules?.typingDelayMs || 0);
  // Ausente = nunca configurado = o padrão de 24h. Zero é escolha ("nunca"),
  // por isso o ?? em vez de ||.
  $("rules-return").value = String(rules?.handoffReturnMs ?? DEFAULT_RETURN_MS);
  fillTimezones(rules?.timezone || DEFAULT_TZ);
  toggleRulesHours();
}

function paintBotRulesSummary(rules, mode, list) {
  const hours = rules?.hours;
  const hoursOn = Boolean(hours?.enabled);
  const now = $("bot-rules-now");
  const numbersOn = mode !== "off" && list.length > 0;
  const parts = [];
  if (numbersOn) {
    parts.push(t(mode === "allow" ? "portal.rules.nowAllow" : "portal.rules.nowBlock", { n: list.length }));
  }
  if (hoursOn) {
    parts.push(t("portal.rules.nowHours", { start: hours.start, end: hours.end }));
    if (hours.awayMessage) parts.push(t("portal.rules.nowAway"));
  }
  const retorno = rules?.handoffReturnMs ?? DEFAULT_RETURN_MS;
  const linhaRetorno = retorno > 0
    ? t("portal.rules.nowReturn", { h: Math.round(retorno / 3600000) })
    : t("portal.rules.nowNoReturn");
  const atraso = Number(rules?.typingDelayMs) || 0;
  const agora = $("bot-typing-now");
  if (agora) {
    agora.textContent = atraso
      ? `${t("portal.rules.nowDelay", { s: Math.round(atraso / 1000) })} ${linhaRetorno}`
      : `${t("portal.rules.nowNoDelay")} ${linhaRetorno}`;
    agora.classList.toggle("on", atraso > 0);
  }
  now.textContent = parts.length ? parts.join(" ") : t("portal.rules.nowOff");
  now.classList.toggle("on", parts.length > 0);
}

function toggleRulesHours() {
  $("rules-hours-field")?.classList.toggle("hidden", !$("rules-hours-on")?.checked);
}

$("rules-hours-on")?.addEventListener("change", toggleRulesHours);

/** Lista de números só faz sentido com um filtro escolhido. */
function toggleRulesList() {
  const off = $("rules-mode")?.value === "off";
  $("rules-list-field")?.classList.toggle("hidden", off);
}

$("rules-mode")?.addEventListener("change", toggleRulesList);

/**
 * Salva as regras do bot.
 *
 * Os dois cartões (quem o bot atende + ritmo da conversa) mandam o corpo
 * INTEIRO: o backend regrava `botRules` de uma vez, então enviar só um pedaço
 * apagaria o resto.
 */
async function salvarRegrasDoBot() {
  const mode = $("rules-mode").value;
  const list = $("rules-list").value
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  // Avisa em vez de salvar em silêncio: escolher um filtro e deixar a lista
  // vazia é sempre engano, e o backend trataria como "sem filtro" — o dono
  // sairia daqui achando que restringiu.
  if (mode !== "off" && !list.length) {
    toast(t("portal.rules.emptyList"), "err");
    return;
  }
  const hoursOn = $("rules-hours-on").checked;
  const days = [...$("rules-days").querySelectorAll("input:checked")].map((c) => Number(c.value));
  // Mesmo cuidado da lista de números: ligar o horário sem escolher dia
  // nenhum é engano, e o backend trataria como desligado — o dono sairia
  // daqui achando que restringiu.
  if (hoursOn && !days.length) {
    toast(t("portal.rules.emptyDays"), "err");
    return;
  }
  try {
    const data = await api("/v1/portal/whatsapp/rules", {
      method: "PUT",
      body: JSON.stringify({
        numbers: { mode, list },
        timezone: $("rules-tz").value,
        typingDelayMs: Number($("rules-delay").value) || 0,
        handoffReturnMs: Number($("rules-return").value),
        hours: {
          enabled: hoursOn,
          days,
          start: $("rules-start").value,
          end: $("rules-end").value,
          awayMessage: $("rules-away").value,
        },
      }),
    });
    // Salvou: o que está no servidor volta a ser a verdade, e o formulário
    // pode ser repintado com o que ele devolveu.
    botRulesDirty = false;
    renderBotRules(data.account?.botRules, { force: true });
    if (state.portal?.accounts?.[0]?.account) {
      state.portal.accounts[0].account = data.account;
    }
    toast(t("portal.rules.saved"));
  } catch (e) {
    toast(e.message, "err");
  }
}

$("form-bot-rules")?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void salvarRegrasDoBot();
});

// O ritmo é um campo só, e num cartão sem botão: salva ao escolher. Um
// "Salvar" solo pra um único select seria cerimônia à toa — e pior, dava pra
// trocar a opção, sair da tela e achar que estava valendo.
$("rules-delay")?.addEventListener("change", () => {
  void salvarRegrasDoBot();
});
$("rules-return")?.addEventListener("change", () => {
  void salvarRegrasDoBot();
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

async function revealBuiltFlow(flow) {
  state.studio.phase = "ready";
  toast(t("portal.studio.flowReadyHint"));
  await refresh();
  state.studio.open = false;
  state.studio.expanded = false;
  // O fluxo recém-gerado passa a ser o modo ativo — é o que o dono acabou de
  // mandar montar, seria estranho abrir outro.
  if (flow?.mode) setActiveMode(flow.mode);
  openBuilder(flow?.id);
  studioLayout();
  // Bônus pós-build, nunca bloqueia: o dono já viu o fluxo pronto (o momento
  // de recompensa da conversa) antes de qualquer coisa sobre conhecimento
  // aparecer. Roda em paralelo — se falhar ou não achar nada, não incomoda.
  //
  // A jornada NÃO retoma junto: a revisão é modal e apareceria por cima da
  // demonstração, com o destaque mirando cards atrás do diálogo (os dois na
  // tela ao mesmo tempo). Espera a revisão terminar — ou retoma na hora, se
  // ela nem chegou a abrir.
  journeyWaitsForReview = true;
  void offerKnowledgeReview().then((opened) => {
    if (opened) showKnowledgeReviewStep();
    else releaseJourneyAfterReview();
  });
  // Idem pra validação automática — testa cada ramo contra o motor real
  // antes do dono descobrir sozinho testando na mão (ver PRs #69/#70:
  // fluxo "nascendo quebrado" foi exatamente o que motivou isso).
  if (flow) void validateBuiltFlow(flow);
}

/**
 * Testa automaticamente o fluxo recém-montado (mesmo mecanismo do botão
 * "Validar fluxo" dentro do builder) — bônus pós-build, nunca bloqueia,
 * silencioso em qualquer falha. Só avisa via toast; o detalhe completo por
 * ramo fica no botão "Validar fluxo" dentro do builder, que o dono já está
 * prestes a ver (openBuilder() já rodou antes desta chamada).
 */
async function validateBuiltFlow(flow) {
  try {
    const data = await api("/v1/flows/validate", {
      method: "POST",
      body: JSON.stringify({
        flowId: flow.id,
        name: flow.name,
        product: flow.product,
        nodes: flow.nodes,
        edges: flow.edges,
      }),
    });
    const report = data.report;
    if (!report || !report.total) return;
    if (report.passed === report.total) {
      toast(t("portal.studio.validatePassed", { passed: report.passed, total: report.total }));
    } else {
      toast(t("portal.studio.validateFailed", { passed: report.passed, total: report.total }), "err");
    }
  } catch {
    // Bônus pulável — nunca incomoda se falhar.
  }
}

/**
 * Tenta extrair conhecimento da conversa que acabou de virar fluxo e, se
 * achar algo, abre a tela de revisão. Silencioso em qualquer falha ou lista
 * vazia — essa etapa é sempre um bônus pulável, nunca um requisito.
 *
 * Devolve se a revisão de fato ABRIU: quem chama precisa saber se ainda tem
 * um diálogo modal na frente do dono antes de mostrar outra coisa.
 */
async function offerKnowledgeReview() {
  try {
    const data = await api("/v1/flows/studio", {
      method: "POST",
      body: JSON.stringify({ messages: studioHistory(), action: "extract_knowledge" }),
    });
    const pairs = data.pairs || [];
    if (pairs.length) {
      renderKnowledgeReview(pairs);
      return true;
    }
    // Sem pairs (extração não achou nada reaproveitável — o cenário mais comum
    // hoje, dado o roteiro raso do coach): não abre revisão vazia, mas ainda
    // vale checar se a base ficou vazia, pra avisar.
    void nudgeIfKnowledgeEmpty();
    return false;
  } catch {
    // extração é bônus — falha aqui não pode incomodar quem só queria o fluxo
    // pronto — mas ainda assim vale a checagem de base vazia.
    void nudgeIfKnowledgeEmpty();
    return false;
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
  // A tela saiu da frente — agora sim dá pra demonstrar o fluxo. Não faz nada
  // se a jornada não estava esperando por isso.
  releaseJourneyAfterReview();
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
  // Quem está OLHANDO a aba Conhecimento acabou de salvar itens novos — sem
  // isso a lista só mostrava o que havia antes, e o dono achava que não tinha
  // salvo (precisava de F5 ou "Atualizar"). Fora dessa aba não custa nada:
  // loadKnowledge só roda quando a aba está aberta.
  if (state.view === "knowledge") void loadKnowledge();
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
    action === "build" ? t("portal.studio.buildingFlow") : t("portal.studio.thinking")
  );
  state.studio.busy = true;
  studioLayout();
  $("studio-form")?.querySelector("button[type=submit]")?.setAttribute("disabled", "true");
  $("studio-build")?.setAttribute("disabled", "true");
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
      await revealBuiltFlow(data.flow);
      return;
    }
    if (state.studio.mode === "knowledge" && state.studio.phase === "ready") {
      await finishKnowledgeChat();
      return;
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
    setActiveMode("template");
    openBuilder(flowForMode("template")?.id);
    studioLayout();
    resumeJourneyAfterFlow();
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
  // Pedido do builder pra criar um modo que ainda não existe — a UI está
  // lá, mas a geração depende do briefing, que vive aqui.
  if (ev.data?.type === "glabs-make-mode") {
    void makeMissingMode(ev.data.mode);
    return;
  }
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
