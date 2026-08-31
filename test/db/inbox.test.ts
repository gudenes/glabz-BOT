/**
 * Conversas: o que entra no inbox do portal.
 *
 * O caso que motivou: quando o atendente respondia PELO CELULAR, a conversa
 * ficava pela metade no portal — dava pra ver a pergunta do cliente e não o
 * que foi respondido. Só o que passava pela API era gravado.
 *
 * O outro lado do mesmo problema é o dedup: o WhatsApp devolve o envio do bot
 * como um evento `fromMe`, com o mesmo id. Sem dedup, capturar o atendente
 * faria toda resposta do bot aparecer duas vezes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "sem TEST_DATABASE_URL — aponte pra um Postgres descartável";
if (url) process.env.DATABASE_URL = url;

type Inbox = typeof import("../../src/inbox.ts");
let inbox: Inbox;
let sql: typeof import("../../src/db.ts").db;
const CONTA = "conta-teste-inbox";
const TEL = "5511999998888";

before(async () => {
  if (skip) return;
  ({ db: sql } = await import("../../src/db.ts"));
  const { migrate } = await import("../../src/db.ts");
  await migrate();
  inbox = await import("../../src/inbox.ts");
});

after(async () => {
  if (skip) return;
  await sql()`DELETE FROM wa_messages WHERE account_id = ${CONTA}`;
  await sql().end();
});

const limpar = () => sql()`DELETE FROM wa_messages WHERE account_id = ${CONTA}`;

const gravar = (
  source: "customer" | "bot" | "human",
  body: string,
  externalId?: string | null
) =>
  inbox.recordMessage({
    accountId: CONTA,
    phone: TEL,
    direction: source === "customer" ? "in" : "out",
    source,
    body,
    authorName: source === "human" ? "Atendente" : null,
    externalId: externalId ?? null,
  });

test("a resposta que o atendente dá pelo celular entra na conversa", { skip }, async () => {
  await limpar();
  await gravar("customer", "tem banho e tosa?", "CLI_1");
  await gravar("bot", "Vou chamar alguém da equipe.", "BOT_1");
  // O atendente digita no WhatsApp dele: chega como `fromMe`, id próprio.
  await gravar("human", "Temos sim! Banho a partir de R$60.", "CEL_1");

  const conversa = await inbox.listMessages(CONTA, TEL);
  assert.equal(conversa.length, 3, "as três pontas da conversa estão lá");
  const doAtendente = conversa.find((m) => m.source === "human");
  assert.ok(doAtendente, "a resposta do atendente aparece");
  assert.match(doAtendente.body, /R\$60/);
  assert.equal(doAtendente.authorName, "Atendente", "e vem identificada");
});

test("o eco do envio do bot não vira mensagem duplicada", { skip }, async () => {
  await limpar();
  await gravar("bot", "Olá! Como posso ajudar?", "BOT_1");
  // Mesmo id, chegando pelo outro caminho — é o eco, não uma mensagem nova.
  await gravar("human", "Olá! Como posso ajudar?", "BOT_1");

  const conversa = await inbox.listMessages(CONTA, TEL);
  assert.equal(conversa.length, 1, `o eco não duplicou: ${JSON.stringify(conversa.map((m) => m.body))}`);
  // E o registro que fica é o do envio, com a autoria certa.
  assert.equal(conversa[0].source, "bot", "continua marcada como do bot, não do atendente");
});

test("mensagem sem id não é deduplicada", { skip }, async () => {
  // Nem toda mensagem tem id do WhatsApp. Deduplicar por ausência sumiria com
  // mensagens legítimas — inclusive duas iguais seguidas, que acontecem.
  await limpar();
  await gravar("human", "oi");
  await gravar("human", "oi");
  const conversa = await inbox.listMessages(CONTA, TEL);
  assert.equal(conversa.length, 2, "as duas ficam");
});

test("o dedup é por conta: números iguais em contas diferentes não se afetam", { skip }, async () => {
  await limpar();
  const outra = `${CONTA}-2`;
  await sql()`DELETE FROM wa_messages WHERE account_id = ${outra}`;
  await gravar("bot", "mensagem da conta 1", "MESMO_ID");
  await inbox.recordMessage({
    accountId: outra,
    phone: TEL,
    direction: "out",
    source: "bot",
    body: "mensagem da conta 2",
    externalId: "MESMO_ID",
  });

  assert.equal((await inbox.listMessages(CONTA, TEL)).length, 1);
  assert.equal((await inbox.listMessages(outra, TEL)).length, 1, "a outra conta gravou a dela");
  await sql()`DELETE FROM wa_messages WHERE account_id = ${outra}`;
});

test("a conversa é identificada pelo CLIENTE, não por quem respondeu", { skip }, async () => {
  // O bug: `contactName` vinha da ÚLTIMA mensagem, qualquer que fosse. Assim
  // que alguém respondia, a lista virava uma coluna de "Atendente" — cinco
  // atendimentos, cinco linhas iguais, sem dizer com quem eram.
  await limpar();
  const cliente = async (tel: string, nome: string | null) => {
    await inbox.recordMessage({ accountId: CONTA, phone: tel, direction: "in",
      source: "customer", body: "tem banho e tosa?", authorName: nome });
    await inbox.recordMessage({ accountId: CONTA, phone: tel, direction: "out",
      source: "human", body: "Temos sim!", authorName: "Atendente", externalId: `${tel}-h` });
  };
  await cliente("5511911111111", "Maria Silva");
  await cliente("5511922222222", "João Pereira");
  await cliente("5511933333333", null); // o WhatsApp nem sempre informa o nome

  const conversas = await inbox.listThreads(CONTA);
  const nomes = conversas.map((c) => c.contactName);
  assert.ok(nomes.includes("Maria Silva"), `esperava Maria — veio: ${nomes.join(", ")}`);
  assert.ok(nomes.includes("João Pereira"));
  assert.ok(!nomes.includes("Atendente"), "nenhuma conversa se chama 'Atendente'");
  // Sem nome, o telefone identifica melhor que qualquer rótulo.
  assert.ok(nomes.some((n) => n.includes("93333")), `caiu no telefone: ${nomes.join(", ")}`);

  for (const tel of ["5511911111111", "5511922222222", "5511933333333"]) {
    await sql()`DELETE FROM wa_messages WHERE account_id = ${CONTA} AND phone_e164 = ${tel}`;
  }
});

test("o preview é a última mensagem, mesmo com timestamps iguais", { skip }, async () => {
  // sent_at vem do WhatsApp com precisão de segundo: duas mensagens seguidas
  // empatam, e aí "a última" fica indefinida — a lista mostrava o preview de
  // uma mensagem antiga.
  await limpar();
  const mesmo = new Date();
  await inbox.recordMessage({ accountId: CONTA, phone: TEL, direction: "in",
    source: "customer", body: "primeira", authorName: "Ana", sentAt: mesmo });
  await inbox.recordMessage({ accountId: CONTA, phone: TEL, direction: "out",
    source: "human", body: "última", authorName: "Atendente", externalId: "X1", sentAt: mesmo });

  const [conversa] = await inbox.listThreads(CONTA);
  assert.equal(conversa.lastPreview, "última");
  assert.equal(conversa.contactName, "Ana", "e o nome continua sendo o do cliente");
});
