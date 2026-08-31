/**
 * Conversas: quem é o contato, quando cada mensagem foi e quem respondeu.
 *
 * Três coisas que só apareciam olhando a tela:
 *  - a lista virava uma coluna de "Atendente", sem dizer com quem era a conversa;
 *  - as mensagens não tinham data nem hora — não dava pra saber se foi agora
 *    ou na semana passada;
 *  - atendente e bot apareciam idênticos, agora que a resposta dada pelo
 *    celular também é capturada.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "puppeteer-core";
import { abrirNavegador, fecharPagina, novaPagina, skipSemChrome } from "../helpers/browser.ts";
import { fixturesPadrao, servirPortal, type PortalServer } from "../helpers/portal-server.ts";

const agora = new Date();
const ontem = new Date(Date.now() - 86400000);
const TEL = "5511911111111";

const msg = (
  id: string,
  direction: "in" | "out",
  source: string,
  body: string,
  quando: Date,
  authorName?: string
) => ({ id, phoneE164: TEL, direction, source, body, authorName: authorName ?? null, sentAt: quando.toISOString(), externalId: null });

let srv: PortalServer;
let browser: Browser;

before(async () => {
  if (skipSemChrome) return;
  srv = await servirPortal(
    fixturesPadrao({
      "/v1/inbox/threads": {
        ok: true,
        threads: [
          {
            phoneE164: TEL,
            phoneDisplay: "+55 (11) 91111-1111",
            contactName: "Maria Silva",
            lastPreview: "Temos sim!",
            lastMessageAt: agora.toISOString(),
            mode: "human",
          },
        ],
      },
      [`/v1/inbox/threads/${TEL}/messages`]: {
        ok: true,
        messages: [
          msg("m1", "in", "customer", "tem banho e tosa?", ontem, "Maria Silva"),
          msg("m2", "out", "bot", "Vou chamar alguém da equipe.", ontem),
          msg("m3", "out", "human", "Temos sim! A partir de R$60.", agora, "Carlos"),
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

async function abrirConversa(): Promise<Page> {
  const page = await novaPagina(browser, 1280, 900);
  await page.goto(`${srv.url}/admin/portal.html`, { waitUntil: "networkidle0" });
  await page.evaluate(`document.getElementById("tour-skip")?.click()`);
  await page.evaluate(`document.querySelector('[data-view="inbox"]').click()`);
  await page.waitForSelector("#thread-list [data-phone]", { timeout: 5000 });
  await page.evaluate(`document.querySelector("#thread-list [data-phone]").click()`);
  await page.waitForSelector("#inbox-log .bub", { timeout: 5000 });
  return page;
}

test("a lista mostra o nome do cliente, com o selo de quem atende", { skip: skipSemChrome }, async () => {
  const page = await abrirConversa();
  const lista = (await page.evaluate(`(() => ({
    nome: document.querySelector("#thread-list b")?.textContent,
    selo: document.querySelector("#thread-list .tag")?.textContent?.trim(),
    seloDestacado: document.querySelector("#thread-list .tag")?.classList.contains("atende"),
  }))()`)) as Record<string, unknown>;
  await fecharPagina(page);
  assert.equal(lista.nome, "Maria Silva", "o nome é do cliente, não de quem respondeu");
  assert.ok(!String(lista.selo).match(/atendente/i), `o selo diz quem atende, não é o nome: "${lista.selo}"`);
  assert.ok(lista.seloDestacado, "e ganha destaque quando é uma pessoa atendendo");
});

test("cada mensagem tem hora, e os dias são separados", { skip: skipSemChrome }, async () => {
  const page = await abrirConversa();
  const chat = (await page.evaluate(`(() => ({
    dias: [...document.querySelectorAll("#inbox-log .kb-day")].map((d) => d.textContent),
    horas: [...document.querySelectorAll("#inbox-log .bub-hora")].map((h) => h.textContent),
    bolhas: document.querySelectorAll("#inbox-log .bub").length,
  }))()`)) as { dias: string[]; horas: string[]; bolhas: number };
  await fecharPagina(page);

  assert.deepEqual(chat.dias, ["Ontem", "Hoje"], "as mensagens de ontem ficam sob 'Ontem'");
  assert.equal(chat.horas.length, chat.bolhas, "toda mensagem mostra a hora");
  for (const h of chat.horas) assert.match(h, /^\d{2}:\d{2}$/, `hora legível: "${h}"`);
});

test("atendente e bot não se confundem na conversa", { skip: skipSemChrome }, async () => {
  // Antes da captura do celular, tudo que saía era "bot" — agora que a
  // resposta da pessoa também entra, pintar as duas iguais escondia quem
  // falou.
  const page = await abrirConversa();
  const quem = (await page.evaluate(`(() => [...document.querySelectorAll("#inbox-log .bub")].map((b) => ({
    classe: b.className, autor: b.querySelector(".bub-autor")?.textContent || null,
  })))()`)) as { classe: string; autor: string | null }[];
  await fecharPagina(page);

  assert.ok(quem.some((b) => b.classe.includes("user")), "a do cliente");
  assert.ok(quem.some((b) => b.classe.includes("bot") && !b.classe.includes("human")), "a do bot");
  const doAtendente = quem.find((b) => b.classe.includes("human"));
  assert.ok(doAtendente, "a do atendente tem aparência própria");
  assert.equal(doAtendente.autor, "Carlos", "e mostra quem respondeu");
});
