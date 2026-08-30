/**
 * Busca e agrupamento — as partes puras.
 *
 * O SQL em si é exercitado em test/db/ contra um Postgres de verdade; aqui
 * ficam as duas funções que decidem O QUE procurar e O QUE juntar, que é onde
 * moram os erros silenciosos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { questionKey, searchPattern } from "../src/rag/answer-log.ts";

test("busca ignora acento e caixa — digitar sem acento é o normal", () => {
  // "racao" tem que achar "ração". ILIKE sozinho não faz isso: ignora
  // maiúscula, não ignora acento.
  const esperado = "%racao%";
  for (const termo of ["ração", "RAÇÃO", "racao", "RaÇaO", " Ração "]) {
    assert.equal(searchPattern(termo), esperado, `"${termo}"`);
  }
  assert.equal(searchPattern("horário"), "%horario%");
  assert.equal(searchPattern("CARTÃO"), "%cartao%");
});

test("curinga digitado é procurado como texto, não como curinga", () => {
  // Sem escapar, buscar "50%" traria a tabela inteira — e "%" sozinho também.
  assert.equal(searchPattern("50%"), "%50\\%%");
  assert.equal(searchPattern("_"), "%\\_%");
  assert.equal(searchPattern("a_b%c"), "%a\\_b\\%c%");
});

test("busca vazia não vira filtro", () => {
  // Devolver "%%" filtraria por nada e ainda assim pagaria o custo; null diz
  // a quem chama pra não pôr a cláusula.
  assert.equal(searchPattern(""), null);
  assert.equal(searchPattern("   "), null);
  assert.equal(searchPattern(null), null);
  assert.equal(searchPattern(undefined), null);
});

test("perguntas iguais escritas diferente contam como uma só", () => {
  const alvo = "voces tem racao";
  for (const q of [
    "Vocês têm ração?",
    "voces tem racao",
    "VOCÊS  TÊM   RAÇÃO!!!",
    "  Vocês têm ração...  ",
    "vocês, têm ração?",
  ]) {
    assert.equal(questionKey(q), alvo, `"${q}"`);
  }
});

test("perguntas diferentes NÃO são juntadas", () => {
  // Limitação assumida: o agrupamento é por texto normalizado, não por
  // semelhança. "ração p/ cão grande" e a pergunta completa contam separado —
  // semelhança exigiria embeddings e erraria junto quando errasse.
  assert.notEqual(
    questionKey("ração p/ cão grande"),
    questionKey("vocês têm ração para cachorro de grande porte?")
  );
  assert.notEqual(questionKey("tem estacionamento?"), questionKey("tem estacionamento gratuito?"));
  assert.equal(questionKey(""), "");
  assert.equal(questionKey("!!!???"), "");
});
