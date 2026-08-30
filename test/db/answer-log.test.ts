/**
 * O SQL do log de respostas, contra um Postgres DE VERDADE.
 *
 * As partes puras (busca, agrupamento) têm testes próprios em test/search.ts.
 * Aqui ficam as coisas que só o banco responde: se o escape de curinga
 * funciona mesmo, se o cursor não pula nem repete linha na virada de página,
 * e se um cliente não enxerga o log do outro.
 *
 * Rode com `npm run test:db`. Sem `TEST_DATABASE_URL`, tudo se pula em vez de
 * falhar — quem clona o repositório não pode ver vermelho por não ter banco.
 *
 * Cria as tabelas na base apontada e LIMPA antes de cada teste, então aponte
 * pra uma base descartável, nunca pra staging.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "sem TEST_DATABASE_URL — aponte pra um Postgres descartável";
if (url) process.env.DATABASE_URL = url;

type Mod = typeof import("../../src/rag/answer-log.ts");
let mod: Mod;
let sql: typeof import("../../src/db.ts").db;

before(async () => {
  if (skip) return;
  ({ db: sql } = await import("../../src/db.ts"));
  mod = await import("../../src/rag/answer-log.ts");
  const { migrate } = await import("../../src/db.ts");
  await migrate();
  await sql()`INSERT INTO clients (id, name, slug) VALUES ('t1', 'Teste 1', 'teste-1')
              ON CONFLICT (id) DO NOTHING`;
  await sql()`INSERT INTO clients (id, name, slug) VALUES ('t2', 'Teste 2', 'teste-2')
              ON CONFLICT (id) DO NOTHING`;
});

after(async () => {
  if (skip) return;
  await sql()`DELETE FROM ai_answer_log WHERE client_id IN ('t1','t2')`;
  await sql().end();
});

/** Grava as perguntas em instantes distintos, pra o cursor ter o que ordenar. */
async function semear(clientId: string, perguntas: [string, string | null][]): Promise<void> {
  await sql()`DELETE FROM ai_answer_log WHERE client_id = ${clientId}`;
  for (const [q, a] of perguntas) {
    await mod.logAiAnswer({
      clientId,
      question: q,
      answer: a,
      failReason: a === null ? "fora_do_contexto" : null,
      ragStatus: "ok",
    });
    await new Promise((r) => setTimeout(r, 12));
  }
}

test("busca acha sem acento e sem caixa, no banco", { skip }, async () => {
  await semear("t1", [
    ["vocês têm RAÇÃO para cachorro?", "não"],
    ["qual o horário?", "6h às 21h"],
    ["pergunta comum", "temos ÁGUA e café"],
  ]);
  for (const termo of ["ração", "RACAO", "racao"]) {
    const r = await mod.listAiAnswers("t1", { search: termo, limit: 50 });
    assert.equal(r.length, 1, `"${termo}" acha a da ração`);
  }
  // Também procura DENTRO da resposta, não só na pergunta.
  const naResposta = await mod.listAiAnswers("t1", { search: "agua", limit: 50 });
  assert.equal(naResposta.length, 1, "acha pelo texto da resposta");
});

test("curinga digitado não vira curinga de verdade", { skip }, async () => {
  await semear("t1", [
    ["desconto de 50% à vista?", "sim"],
    ["tem estacionamento?", "sim"],
    ["aceitam cartão?", "sim"],
  ]);
  const comPorcento = await mod.listAiAnswers("t1", { search: "%", limit: 50 });
  // Se o escape falhasse, "%" traria as três. Tem que trazer só a que contém
  // o caractere de verdade.
  assert.equal(comPorcento.length, 1, "só a linha que tem % no texto");
  assert.match(comPorcento[0].question, /50%/);
});

test("carregar mais não pula nem repete linha", { skip }, async () => {
  const perguntas = Array.from({ length: 7 }, (_, i) => [`pergunta ${i}`, `resposta ${i}`] as [string, string]);
  await semear("t1", perguntas);

  const vistos: string[] = [];
  let antes: string | null = null;
  for (let pagina = 0; pagina < 4; pagina += 1) {
    const r: Awaited<ReturnType<Mod["listAiAnswers"]>> = await mod.listAiAnswers("t1", {
      limit: 3,
      before: antes,
    });
    if (!r.length) break;
    vistos.push(...r.map((x) => x.id));
    antes = r[r.length - 1].createdAt;
  }
  assert.equal(vistos.length, perguntas.length, "trouxe todas");
  assert.equal(new Set(vistos).size, vistos.length, "nenhuma repetida entre páginas");
});

test("o log de um cliente não vaza pro outro", { skip }, async () => {
  await semear("t1", [["só do cliente 1", "x"]]);
  await semear("t2", [["só do cliente 2", "y"]]);
  const doUm = await mod.listAiAnswers("t1", { limit: 50 });
  assert.equal(doUm.length, 1);
  assert.equal(doUm[0].question, "só do cliente 1");
  // E a busca também respeita o isolamento.
  const buscando = await mod.listAiAnswers("t1", { search: "cliente 2", limit: 50 });
  assert.equal(buscando.length, 0, "não acha o do outro cliente nem buscando");
});

test("o motivo da falha sobrevive à ida e volta do banco", { skip }, async () => {
  await semear("t1", [
    ["essa a IA não soube", null],
    ["essa ela respondeu", "resposta"],
  ]);
  const linhas = await mod.listAiAnswers("t1", { limit: 50 });
  const semResposta = linhas.find((l) => l.answer === null);
  const comResposta = linhas.find((l) => l.answer !== null);
  assert.equal(mod.classifyFailure(semResposta?.failReason), "sabe_nao");
  assert.equal(mod.classifyFailure(comResposta?.failReason), "nenhuma");
});
