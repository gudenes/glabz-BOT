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
