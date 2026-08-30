/**
 * Jornada guiada, no navegador de verdade.
 *
 * Cada teste aqui corresponde a um defeito que só apareceu porque o usuário
 * olhou a tela — nenhum teste de lógica pegaria, porque todos dependem de
 * geometria e de pintura reais:
 *
 *  - o balão TAPANDO o botão que ele estava explicando (passo 2);
 *  - o balão APAGADO por trás do fundo escuro do diálogo de onboarding;
 *  - o balão fora da tela em janela baixa.
 *
 * Roda com `npm run test:ui`. Sem Chrome instalado, os testes se pulam.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "puppeteer-core";
import {
  abrirNavegador,
  caixaDe,
  esperarLayoutEstavel,
  fecharPagina,
  novaPagina,
  skipSemChrome,
  sobrepoe,
  visivelDeVerdade,
} from "../helpers/browser.ts";
import { fixturesPadrao, servirPortal, type PortalServer } from "../helpers/portal-server.ts";

let srv: PortalServer;
let browser: Browser;

before(async () => {
  if (skipSemChrome) return;
  srv = await servirPortal(fixturesPadrao());
  browser = await abrirNavegador();
});

after(async () => {
  await browser?.close();
  await srv?.close();
});

/**
 * Abre o portal com a jornada rodando, no primeiro acesso.
 *
 * A jornada é dirigida pelos BOTÕES do balão, como o dono faria — nada de
 * chamar função interna por dentro. Assim o teste passa pelo mesmo caminho
 * que quebrou na mão dele, e o portal não precisa exportar nada só pra teste.
 */
async function abrirTour(largura = 1280, altura = 800): Promise<Page> {
  const page = await novaPagina(browser, largura, altura);
  await page.goto(`${srv.url}/admin/portal.html`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#tour-bubble", { visible: true, timeout: 5000 });
  await esperarQuadro(page);
  return page;
}

/** Espera o balão parar de se mexer — ver esperarLayoutEstavel. */
const esperarQuadro = (page: Page) => esperarLayoutEstavel(page, "#tour-bubble");

/** Clica "Próxima" (ou a escolha pedida numa bifurcação) e espera repintar. */
async function avancar(page: Page, escolha?: number): Promise<void> {
  const temEscolhas = await page.evaluate(
    `document.querySelectorAll("#tour-actions-dyn button").length`
  );
  if (Number(temEscolhas) > 0) {
    await page.evaluate(
      (i) => (document.querySelectorAll("#tour-actions-dyn button")[i] as HTMLElement).click(),
      escolha ?? 0
    );
  } else {
    await page.evaluate(`document.getElementById("tour-next").click()`);
  }
  await esperarQuadro(page);
}

/** Quantos passos a jornada tem até a bifurcação (inclusive). */
const ATE_BIFURCACAO = 4;

test("o balão nunca tapa o alvo que está explicando", { skip: skipSemChrome }, async () => {
  // O bug: o passo 2 apontava o item Conhecimento e o balão caía POR CIMA
  // dele. A causa era um chute de 180px de altura; aqui o Chrome mede.
  const page = await abrirTour();
  for (let passo = 1; passo <= ATE_BIFURCACAO; passo += 1) {
    const balao = await caixaDe(page, "#tour-bubble");
    const buraco = await caixaDe(page, "#tour-hole");
    assert.ok(balao && buraco, `passo ${passo}: balão e destaque existem`);
    assert.ok(
      !sobrepoe(balao, buraco),
      `passo ${passo}: o balão tapa o alvo — balão ${JSON.stringify(balao)} / alvo ${JSON.stringify(buraco)}`
    );
    if (passo < ATE_BIFURCACAO) await avancar(page);
  }
  await fecharPagina(page);
});

test("o balão fica dentro da tela, inclusive em janela baixa", { skip: skipSemChrome }, async () => {
  for (const [largura, altura] of [[1280, 800], [1440, 620], [390, 780]] as const) {
    const page = await abrirTour(largura, altura);
    for (let passo = 1; passo <= ATE_BIFURCACAO; passo += 1) {
      const b = await caixaDe(page, "#tour-bubble");
      assert.ok(b, `passo ${passo}: balão existe`);
      const onde = `passo ${passo} em ${largura}x${altura}`;
      assert.ok(b.left >= 0 && b.top >= 0, `${onde}: balão saiu pela borda`);
      assert.ok(
        b.right <= largura + 1 && b.bottom <= altura + 1,
        `${onde}: balão vaza da tela (${JSON.stringify(b)})`
      );
      if (passo < ATE_BIFURCACAO) await avancar(page);
    }
    await fecharPagina(page);
  }
});

test("o balão é visível de verdade, não pintado por baixo do diálogo", { skip: skipSemChrome }, async () => {
  // O bug: no passo do fluxo o balão aparecia APAGADO. `.tour` e `.onboard`
  // dividiam o mesmo z-index, e o fundo escuro do diálogo pintava por cima.
  // Existir no documento não bastava — daí perguntar quem está no topo.
  const page = await irAtePassoDoFluxo();
  const onboardVisivel = await page.evaluate(
    `!document.getElementById("onboard").classList.contains("hidden")`
  );
  const balaoVisivel = await visivelDeVerdade(page, "#tour-bubble");
  const tituloVisivel = await visivelDeVerdade(page, "#tour-title");
  await fecharPagina(page);
  assert.equal(onboardVisivel, true, "o diálogo de onboarding está na tela neste passo");
  assert.ok(balaoVisivel, "o balão está por cima do diálogo, não por baixo");
  assert.ok(tituloVisivel, "e o texto dele é legível");
});

test("no passo do fluxo, o destaque cai sobre o diálogo — não no menu", { skip: skipSemChrome }, async () => {
  // O bug: o destaque ficava no item de menu enquanto a decisão que o texto
  // pedia estava no diálogo, no centro da tela.
  const page = await irAtePassoDoFluxo();
  const buraco = await caixaDe(page, "#tour-hole");
  // "#onboard .onboard-card" e não ".onboard-card": a classe também existe
  // dentro do diálogo de revisão de conhecimento, que vem ANTES no HTML e
  // está escondido — o seletor solto media uma caixa 0x0.
  const dialogo = await caixaDe(page, "#onboard .onboard-card");
  await fecharPagina(page);
  assert.ok(buraco && dialogo);
  assert.ok(
    sobrepoe(buraco, dialogo),
    `o destaque devia cobrir o diálogo — destaque ${JSON.stringify(buraco)} / diálogo ${JSON.stringify(dialogo)}`
  );
});

test("a numeração dos passos não pula", { skip: skipSemChrome }, async () => {
  // O bug: o passo 4 saltava pro 6, porque a numeração usava a posição no
  // array e a jornada bifurca. Percorre INCLUSIVE a bifurcação (escolhendo
  // "montar o fluxo"), que é onde o salto acontecia.
  const page = await abrirTour();
  const vistos: number[] = [];
  const numero = async () => {
    const txt = (await page.evaluate(`document.getElementById("tour-step-label").textContent`)) as string;
    return Number(/(\d+)/.exec(txt)?.[1] || 0);
  };
  for (let i = 0; i < ATE_BIFURCACAO; i += 1) {
    vistos.push(await numero());
    await avancar(page, 1); // na bifurcação, a 2ª escolha é "criar fluxo"
  }
  vistos.push(await numero());
  await fecharPagina(page);
  for (let i = 1; i < vistos.length; i += 1) {
    assert.equal(vistos[i], vistos[i - 1] + 1, `numeração pulou: ${vistos.join(" → ")}`);
  }
});

/** Percorre a jornada até o passo do fluxo, escolhendo "montar o fluxo". */
async function irAtePassoDoFluxo(): Promise<Page> {
  const page = await abrirTour();
  for (let i = 0; i < ATE_BIFURCACAO; i += 1) await avancar(page, 1);
  return page;
}

test("o balão se desvia mesmo com o alvo em posição hostil", { skip: skipSemChrome }, async () => {
  // Os tamanhos de janela acima não reproduzem a condição do bug original: no
  // portal real o item do menu fica alto, e a regra antiga (chute de 180px)
  // acertava por sorte. Aqui o alvo é EMPURRADO pra posições difíceis — perto
  // do rodapé, colado no topo, no meio — e o posicionamento real é
  // reexecutado (ele roda no `resize`). É o algoritmo sendo testado, não a
  // sorte do layout.
  const page = await abrirTour(1280, 700);
  for (const [top, altura] of [[560, 36], [660, 30], [8, 36], [340, 300]] as const) {
    await page.evaluate(
      (t, h) => {
        const alvo = document.querySelector('.side [data-view="knowledge"]') as HTMLElement;
        alvo.style.position = "fixed";
        alvo.style.left = "16px";
        alvo.style.width = "180px";
        alvo.style.top = `${t}px`;
        alvo.style.height = `${h}px`;
        window.dispatchEvent(new Event("resize"));
      },
      top,
      altura
    );
    await esperarQuadro(page);
    const balao = await caixaDe(page, "#tour-bubble");
    const buraco = await caixaDe(page, "#tour-hole");
    assert.ok(balao && buraco);
    const onde = `alvo em top=${top} altura=${altura}`;
    assert.ok(!sobrepoe(balao, buraco), `${onde}: o balão tapa o alvo (${JSON.stringify(balao)})`);
    assert.ok(balao.top >= 0 && balao.bottom <= 701, `${onde}: balão vaza da tela`);
  }
  await fecharPagina(page);
});
