/**
 * Layout dos cartões da aba WhatsApp, no navegador de verdade.
 *
 * O cartão de ritmo da conversa nasceu DENTRO do "Quem o bot atende", que
 * ficou pesado enquanto sobrava tela vazia ao lado. Agora dividem a linha —
 * e é o tipo de arranjo que só se verifica medindo, porque depende de largura
 * real: já quebrou uma tela antes por um painel virar coluna e espremer o
 * builder.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "puppeteer-core";
import {
  abrirNavegador,
  caixaDe,
  esperarLayoutEstavel,
  fecharPagina,
  novaPagina,
  skipSemChrome,
  sobrepoe,
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

async function abrirWhatsApp(largura: number, altura: number) {
  const page = await novaPagina(browser, largura, altura);
  await page.goto(`${srv.url}/admin/portal.html`, { waitUntil: "networkidle0" });
  // Sai da jornada: ela cobre a tela e não é o assunto deste arquivo.
  await page.evaluate(`document.getElementById("tour-skip")?.click()`);
  await esperarLayoutEstavel(page, "#bot-typing-card");
  return page;
}

test("em tela larga os dois cartões dividem a linha, sem se sobrepor", { skip: skipSemChrome }, async () => {
  for (const [largura, altura] of [[1440, 900], [1280, 800]] as const) {
    const page = await abrirWhatsApp(largura, altura);
    const esq = await caixaDe(page, "#bot-rules-card");
    const dir = await caixaDe(page, "#bot-typing-card");
    await fecharPagina(page);
    assert.ok(esq && dir, `${largura}x${altura}: os dois cartões existem`);
    const onde = `${largura}x${altura}`;
    assert.ok(Math.abs(esq.top - dir.top) < 20, `${onde}: começam na mesma altura`);
    assert.ok(dir.left >= esq.right - 5, `${onde}: o de ritmo fica À DIREITA`);
    assert.ok(!sobrepoe(esq, dir), `${onde}: não se sobrepõem`);
    assert.ok(dir.right <= largura, `${onde}: não vaza da tela`);
    // Nenhum dos dois pode ficar espremido a ponto de não dar pra usar.
    assert.ok(esq.width > 300 && dir.width > 300, `${onde}: larguras utilizáveis (${esq.width}/${dir.width})`);
  }
});

test("em tela estreita eles empilham, em vez de espremer", { skip: skipSemChrome }, async () => {
  for (const [largura, altura] of [[860, 900], [390, 780]] as const) {
    const page = await abrirWhatsApp(largura, altura);
    const esq = await caixaDe(page, "#bot-rules-card");
    const dir = await caixaDe(page, "#bot-typing-card");
    await fecharPagina(page);
    assert.ok(esq && dir);
    const onde = `${largura}x${altura}`;
    assert.ok(dir.top >= esq.bottom - 5, `${onde}: o de ritmo vai PRA BAIXO`);
    assert.ok(!sobrepoe(esq, dir), `${onde}: não se sobrepõem`);
    assert.ok(esq.right <= largura && dir.right <= largura, `${onde}: nenhum vaza da tela`);
  }
});

test("o campo de ritmo é alcançável e tem as quatro opções", { skip: skipSemChrome }, async () => {
  const page = await abrirWhatsApp(1280, 800);
  // Rola até ele: nas telas estreitas fica abaixo da dobra, e "abaixo da
  // dobra" é diferente de "escondido".
  await page.evaluate(`document.getElementById("rules-delay").scrollIntoView({block:"center"})`);
  await esperarLayoutEstavel(page, "#rules-delay");
  const info = (await page.evaluate(`(() => {
    const s = document.getElementById("rules-delay");
    const r = s.getBoundingClientRect();
    return {
      valores: [...s.options].map((o) => o.value),
      rotulos: [...s.options].map((o) => o.textContent.trim()),
      dentroDaTela: r.top >= 0 && r.bottom <= window.innerHeight,
      // O rótulo tem que estar traduzido, não a chave crua.
      rotuloTraduzido: !document.querySelector('[for="rules-delay"]').textContent.startsWith("portal."),
    retorno: [...document.getElementById("rules-return").options].map((o) => o.value),
    retornoAtual: document.getElementById("rules-return").value,
    };
  })()`)) as {
    valores: string[]; rotulos: string[]; dentroDaTela: boolean; rotuloTraduzido: boolean;
    retorno: string[]; retornoAtual: string;
  };
  await fecharPagina(page);

  assert.deepEqual(info.valores, ["0", "1000", "3000", "5000"], "responder na hora, 1s, 3s e 5s");
  assert.deepEqual(info.retorno, ["3600000", "21600000", "86400000", "259200000", "0"], "1h, 6h, 24h, 3d e nunca");
  // Ligado por padrão: a tela tem que abrir em 24h, não em "nunca".
  assert.equal(info.retornoAtual, "86400000", "padrão de 24h selecionado");
  assert.ok(info.dentroDaTela, "dá pra chegar nele rolando");
  assert.ok(info.rotuloTraduzido, "o rótulo está traduzido");
  for (const r of info.rotulos) assert.ok(r.length > 3 && !r.startsWith("portal."), `opção traduzida: "${r}"`);
});
