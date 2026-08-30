/**
 * Por que a resposta não veio.
 *
 * Antes o log só guardava a resposta nula, e isso dizia duas coisas muito
 * diferentes ao mesmo tempo: a IA não ter a informação (o dono sabe, o bot
 * não — vale ensinar) e a chamada ter falhado (é infra).
 *
 * A distinção não é cosmética: a lista de pendências que vem em cima disto só
 * é útil se for confiável. Listar instabilidade como se fosse pergunta a
 * ensinar faz o dono aprender a ignorá-la, que é como um recurso desses morre.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "../src/rag/answer-log.ts";

test("só 'a IA não sabe' vira oportunidade de ensino", () => {
  assert.equal(classifyFailure("fora_do_contexto"), "sabe_nao");
});

test("falha de infra nunca é apresentada como algo a ensinar", () => {
  // Todos os motivos que answerFreeform produz quando a chamada não completa.
  for (const r of ["http_500", "http_429", "falha_na_chamada", "sem_ia_configurada", "resposta_vazia"]) {
    assert.equal(classifyFailure(r), "tecnico", `"${r}" é problema técnico`);
  }
  // Motivo desconhecido (versão futura, ou dado antigo) cai em técnico, não em
  // "ensinar": errar pro lado de não incomodar o dono com ruído.
  assert.equal(classifyFailure("motivo_que_ainda_nao_existe"), "tecnico");
});

test("resposta que deu certo não é falha nenhuma", () => {
  assert.equal(classifyFailure(null), "nenhuma");
  assert.equal(classifyFailure(undefined), "nenhuma");
  assert.equal(classifyFailure(""), "nenhuma");
  assert.equal(classifyFailure("   "), "nenhuma");
});
