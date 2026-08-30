/**
 * Rolar uma lista não pode levar a página junto.
 *
 * O encadeamento de rolagem é o padrão do navegador: ao chegar no fim de uma
 * área rolável, ele continua rolando o que está atrás. Em Conversas isso era
 * bem visível — rolar a lista arrastava a tela inteira.
 *
 * Vale pra toda área com rolagem própria, não só a que foi reportada; este
 * teste percorre todas.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "puppeteer-core";
import { abrirNavegador, esperarLayoutEstavel, fecharPagina, novaPagina, skipSemChrome } from "../helpers/browser.ts";
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

test("toda área rolável do portal contém a própria rolagem", { skip: skipSemChrome }, async () => {
  const page = await novaPagina(browser, 1280, 800);
  await page.goto(`${srv.url}/admin/portal.html`, { waitUntil: "networkidle0" });
  await esperarLayoutEstavel(page, ".side");

  // Procura no documento QUEM rola, em vez de conferir uma lista escrita à
  // mão: assim uma área nova criada amanhã já entra na checagem.
  const faltando = (await page.evaluate(`(() => {
    const fora = [];
    for (const el of document.querySelectorAll("*")) {
      const c = getComputedStyle(el);
      const rola = /(auto|scroll)/.test(c.overflowY) || /(auto|scroll)/.test(c.overflowX);
      if (!rola) continue;
      if (el === document.body || el === document.documentElement) continue;
      const contem = c.overscrollBehaviorY === "contain" || c.overscrollBehaviorY === "none";
      if (!contem) {
        const id = el.id ? "#" + el.id : "";
        const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "";
        fora.push((el.tagName.toLowerCase() + id + cls).slice(0, 80));
      }
    }
    return [...new Set(fora)];
  })()`)) as string[];

  await fecharPagina(page);
  assert.deepEqual(faltando, [], `estas áreas ainda arrastam a página: ${faltando.join(", ")}`);
});

test("a lista de conversas contém a rolagem", { skip: skipSemChrome }, async () => {
  // A que o usuário reportou, verificada nominalmente — se o seletor for
  // renomeado, o teste acima continua cobrindo, mas este diz o nome.
  const page = await novaPagina(browser, 1280, 800);
  await page.goto(`${srv.url}/admin/portal.html`, { waitUntil: "networkidle0" });
  const comportamento = await page.evaluate(
    `getComputedStyle(document.querySelector(".thread-list")).overscrollBehaviorY`
  );
  await fecharPagina(page);
  assert.equal(comportamento, "contain");
});
