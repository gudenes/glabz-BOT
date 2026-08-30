/**
 * Aba Conhecimento: abas internas, pendências, busca e paginação.
 *
 * O ciclo que isto fecha: o bot fez transbordo duas vezes pela mesma pergunta
 * e não havia como transformar aquilo em conhecimento — nem como perceber que
 * tinha se repetido, porque as não respondidas ficavam misturadas com todas
 * as outras.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "puppeteer-core";
import { abrirNavegador, esperarLayoutEstavel, fecharPagina, novaPagina, skipSemChrome } from "../helpers/browser.ts";
import { fixturesPadrao, servirPortal, type PortalServer } from "../helpers/portal-server.ts";

const agora = () => new Date().toISOString();
const diasAtras = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

const GAPS = {
  ok: true,
  gaps: [
    {
      key: "voces tem racao para cachorro de grande porte",
      question: "Vocês têm ração para cachorro de grande porte?",
      times: 3,
      lastAt: agora(),
    },
    { key: "tem banho e tosa", question: "Tem banho e tosa?", times: 1, lastAt: diasAtras(1) },
  ],
};

const RESPOSTA = (id: string, question: string, answer: string | null, createdAt: string) => ({
  id, question, answer, createdAt,
  ragHits: [], usedManualContext: false, simulated: false,
  ragStatus: "ok", ragReason: null, failReason: answer ? null : "fora_do_contexto",
});

let srv: PortalServer;
let browser: Browser;

before(async () => {
  if (skipSemChrome) return;
  srv = await servirPortal(
    fixturesPadrao({
      "/v1/rag/gaps": GAPS,
      "/v1/rag/knowledge": {
        ok: true,
        chunks: [{ id: "k1", question: "qual o horário?", answer: "6h às 21h", occurrences: 2, origin: "manual", score: 0 }],
      },
      "/v1/rag/answers": {
        ok: true,
        answers: [
          RESPOSTA("a1", "quanto custa?", "R$50", agora()),
          RESPOSTA("a2", "tem estacionamento?", null, diasAtras(2)),
        ],
      },
    })
  );
  browser = await abrirNavegador();
});

after(async () => {
  await browser?.close();
  await srv?.close();
});

async function abrirConhecimento(): Promise<Page> {
  const page = await novaPagina(browser, 1280, 900);
  await page.goto(`${srv.url}/admin/portal.html`, { waitUntil: "networkidle0" });
  await page.evaluate(`document.getElementById("tour-skip")?.click()`);
  await page.evaluate(`document.querySelector('[data-view="knowledge"]').click()`);
  await esperarLayoutEstavel(page, "#kb-tabs");
  return page;
}

const trocarAba = async (page: Page, aba: string) => {
  await page.evaluate((a) => (document.querySelector(`[data-kb-tab="${a}"]`) as HTMLElement).click(), aba);
  await new Promise((r) => setTimeout(r, 350));
};

test("uma aba por vez, e só a escolhida aparece", { skip: skipSemChrome }, async () => {
  const page = await abrirConhecimento();
  for (const aba of ["base", "gaps", "log"]) {
    await trocarAba(page, aba);
    const estado = (await page.evaluate(`(() => {
      const vis = (id) => { const e = document.getElementById(id); return Boolean(e) && !e.hidden; };
      return { base: vis("kb-pane-base"), gaps: vis("kb-pane-gaps"), log: vis("kb-pane-log"),
               ativa: document.querySelector(".kb-tab.on")?.dataset.kbTab };
    })()`)) as Record<string, unknown>;
    assert.equal(estado.ativa, aba, `a aba ${aba} fica marcada`);
    const visiveis = ["base", "gaps", "log"].filter((k) => estado[k]);
    assert.deepEqual(visiveis, [aba], `só o painel de ${aba} visível — visíveis: ${visiveis}`);
  }
  await fecharPagina(page);
});

test("o selo de pendências aparece em qualquer aba", { skip: skipSemChrome }, async () => {
  // É o selo que faz o dono voltar aqui — some se só aparecer na aba dele.
  const page = await abrirConhecimento();
  for (const aba of ["base", "log", "gaps"]) {
    await trocarAba(page, aba);
    const selo = (await page.evaluate(`(() => {
      const b = document.getElementById("kb-gaps-count");
      return { texto: b.textContent, visivel: !b.classList.contains("hidden") };
    })()`)) as { texto: string; visivel: boolean };
    assert.equal(selo.texto, "2", `contagem visível na aba ${aba}`);
    assert.ok(selo.visivel, `selo visível na aba ${aba}`);
  }
  await fecharPagina(page);
});

test("pendências: repetição à vista e agrupadas por dia", { skip: skipSemChrome }, async () => {
  const page = await abrirConhecimento();
  await trocarAba(page, "gaps");
  const lista = (await page.evaluate(`(() => ({
    itens: document.querySelectorAll("#kb-gaps-list .gap-item").length,
    dias: [...document.querySelectorAll("#kb-gaps-list .kb-day")].map((d) => d.textContent),
    primeira: document.querySelector("#kb-gaps-list b")?.textContent,
    vezes: document.querySelector("#kb-gaps-list .ai-tag")?.textContent,
    temEnsinar: Boolean(document.querySelector("#kb-gaps-list .gap-teach")),
  }))()`)) as Record<string, unknown>;

  assert.equal(lista.itens, 2);
  assert.deepEqual(lista.dias, ["Hoje", "Ontem"], "cabeçalho de dia em português");
  // A mais repetida vem primeiro: é a que mais custa deixar sem resposta.
  assert.match(String(lista.primeira), /ração/i);
  assert.match(String(lista.vezes), /3/, "mostra quantas vezes foi perguntada");
  assert.ok(lista.temEnsinar, "cada pendência tem como ensinar");
  await fecharPagina(page);
});

test("'Ensinar' leva pra Base com a pergunta já preenchida", { skip: skipSemChrome }, async () => {
  // Não ensina sozinho de propósito: quem sabe a resposta é o dono.
  const page = await abrirConhecimento();
  await trocarAba(page, "gaps");
  await page.evaluate(`document.querySelector("#kb-gaps-list .gap-teach").click()`);
  await new Promise((r) => setTimeout(r, 250));
  const estado = (await page.evaluate(`(() => ({
    aba: document.querySelector(".kb-tab.on")?.dataset.kbTab,
    formAberto: !document.getElementById("kb-teach").classList.contains("hidden"),
    pergunta: document.getElementById("kb-q").value,
    resposta: document.getElementById("kb-a").value,
  }))()`)) as Record<string, unknown>;

  assert.equal(estado.aba, "base", "vai pra aba onde se ensina");
  assert.ok(estado.formAberto, "com o formulário aberto");
  assert.match(String(estado.pergunta), /ração/i, "pergunta já preenchida");
  assert.equal(estado.resposta, "", "resposta em branco — é o dono que escreve");
  await fecharPagina(page);
});

test("busca e carregar mais existem nas duas listas", { skip: skipSemChrome }, async () => {
  const page = await abrirConhecimento();
  const campos = (await page.evaluate(`(() => ({
    buscaBase: Boolean(document.getElementById("kb-search")),
    buscaLog: Boolean(document.getElementById("log-search")),
    // Placeholder traduzido, não a chave crua.
    placeholder: document.getElementById("kb-search")?.placeholder,
    maisBase: Boolean(document.getElementById("btn-kb-more")),
    maisLog: Boolean(document.getElementById("btn-log-more")),
  }))()`)) as Record<string, unknown>;
  assert.ok(campos.buscaBase && campos.buscaLog, "as duas listas têm busca");
  assert.ok(campos.maisBase && campos.maisLog, "as duas têm carregar mais");
  assert.ok(!String(campos.placeholder).startsWith("portal."), `traduzido: "${campos.placeholder}"`);
  await fecharPagina(page);
});

test("digitar na busca consulta o servidor, com o termo", { skip: skipSemChrome }, async () => {
  // A busca é no servidor de propósito: filtrar só o que já está na tela não
  // acharia o que ficou fora das primeiras páginas — que é o caso real.
  const page = await abrirConhecimento();
  const chamadas: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/rag/knowledge")) chamadas.push(r.url());
  });
  await page.evaluate(`(() => {
    const i = document.getElementById("kb-search");
    i.value = "ração";
    i.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await fecharPagina(page);
  const comBusca = chamadas.filter((u) => u.includes("q="));
  assert.ok(comBusca.length > 0, `mandou o termo pro servidor: ${chamadas.join(" | ")}`);
  assert.match(decodeURIComponent(comBusca[comBusca.length - 1]), /q=ração/);
});
