/**
 * Regras de quando e para quem o bot responde.
 *
 * O pior desfecho deste módulo é o bot ficar mudo pra clientes reais sem
 * ninguém perceber — não há erro na tela, não há log que o dono leia, o
 * atendimento só para. Por isso quase metade dos casos aqui não testa o
 * recurso funcionando, e sim que ele NÃO cala o bot por engano.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awayAlreadySent,
  AWAY_SENT_VAR,
  botShouldAnswer,
  isWithinHours,
  normalizeBotRules,
  numbersAllow,
  parseHhMm,
  phoneKey,
  zonedDateKey,
  zonedNow,
} from "../src/bot-rules.ts";

test("o mesmo celular escrito de qualquer jeito bate", () => {
  // Um lado vem do WhatsApp, o outro é digitado pelo dono — e o nono dígito
  // faz o mesmo número circular com 12 ou 13 dígitos. Comparação literal faria
  // o dono ativar a lista e o bot ignorar justamente quem ele queria atender.
  const formas = [
    "5511987654321",
    "551187654321",
    "11987654321",
    "1187654321",
    "+55 11 98765-4321",
    "(11) 98765-4321",
  ];
  const chaves = new Set(formas.map(phoneKey));
  assert.equal(chaves.size, 1, "todas as formas produzem a mesma chave");
});

test("pessoas diferentes nunca colidem", () => {
  assert.notEqual(phoneKey("11987654321"), phoneKey("11987654322"), "final diferente");
  assert.notEqual(phoneKey("11987654321"), phoneKey("21987654321"), "DDD diferente");
  assert.notEqual(phoneKey("5511987654321"), phoneKey("351912345678"), "país diferente");
  // Número estrangeiro cai no dígito puro: chutar estrutura desconhecida
  // arriscaria casar duas pessoas.
  assert.equal(phoneKey("351912345678"), "351912345678");
});

test("filtro de números: allow, block e desligado", () => {
  const allow = { numbers: { mode: "allow" as const, list: ["11987654321", "+55 21 3333-4444"] } };
  assert.equal(numbersAllow(allow, "5511987654321"), true, "da lista, em outra forma");
  assert.equal(numbersAllow(allow, "552133334444"), true, "fixo da lista");
  assert.equal(numbersAllow(allow, "5511999998888"), false, "de fora não é atendido");

  const block = { numbers: { mode: "block" as const, list: ["11987654321"] } };
  assert.equal(numbersAllow(block, "5511987654321"), false);
  assert.equal(numbersAllow(block, "5511999998888"), true);
});

test("nada pode calar o bot por engano", () => {
  const qualquer = "5511999998888";
  // "allow" com lista vazia significaria "não responda a ninguém" — o pior
  // estado possível pra se cair sem querer.
  assert.equal(numbersAllow({ numbers: { mode: "allow", list: [] } }, qualquer), true);
  assert.equal(numbersAllow({ numbers: { mode: "allow", list: ["  ", "-"] } }, qualquer), true);
  assert.equal(numbersAllow({ numbers: { mode: "block", list: [] } }, qualquer), true);
  // Conta que nunca configurou nada responde como sempre respondeu.
  assert.equal(numbersAllow(undefined, qualquer), true);
  assert.equal(numbersAllow({}, qualquer), true);
  assert.equal(numbersAllow({ numbers: { mode: "off", list: ["11987654321"] } }, qualquer), true);
});

const SEG_A_SEX = {
  timezone: "America/Sao_Paulo",
  hours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
};

test("janela de atendimento: dias e bordas exatas", () => {
  // 2026-08-28 é sexta. 11:00Z = 08:00 em São Paulo.
  assert.equal(isWithinHours(SEG_A_SEX, new Date("2026-08-28T11:00:00Z")), true, "08:00 dentro");
  assert.equal(isWithinHours(SEG_A_SEX, new Date("2026-08-28T10:59:00Z")), false, "07:59 fora");
  assert.equal(isWithinHours(SEG_A_SEX, new Date("2026-08-28T20:59:00Z")), true, "17:59 dentro");
  assert.equal(isWithinHours(SEG_A_SEX, new Date("2026-08-28T21:00:00Z")), false, "18:00 fora");
  assert.equal(isWithinHours(SEG_A_SEX, new Date("2026-08-29T15:00:00Z")), false, "sábado fora");
});

test("janela que vira a noite: pizzaria 18:00 → 02:00", () => {
  // Caso real, não exceção. O dia marcado é o dia em que a janela COMEÇA:
  // 01:00 de sexta pertence à janela que abriu quinta.
  const noite = {
    timezone: "America/Sao_Paulo",
    hours: { enabled: true, days: [4, 5, 6], start: "18:00", end: "02:00" },
  };
  assert.equal(isWithinHours(noite, new Date("2026-08-27T22:00:00Z")), true, "quinta 19:00");
  assert.equal(isWithinHours(noite, new Date("2026-08-28T04:00:00Z")), true, "sexta 01:00");
  assert.equal(isWithinHours(noite, new Date("2026-08-28T06:00:00Z")), false, "sexta 03:00");
  assert.equal(isWithinHours(noite, new Date("2026-08-31T04:00:00Z")), false, "segunda 01:00");
});

test("o fuso muda o resultado, e o horário de verão é aplicado", () => {
  const instante = new Date("2026-08-27T07:00:00Z"); // 04:00 SP / 08:00 Lisboa
  const lisboa = { ...SEG_A_SEX, timezone: "Europe/Lisbon" };
  assert.equal(isWithinHours(SEG_A_SEX, instante), false, "04:00 em SP");
  assert.equal(isWithinHours(lisboa, instante), true, "08:00 em Lisboa");
  // Julho em Lisboa é horário de verão: 18:30Z vira 19:30 local, fora da janela.
  assert.equal(isWithinHours(lisboa, new Date("2026-07-15T18:30:00Z")), false);
  assert.equal(zonedNow(instante, "America/Manaus").minutes, 3 * 60);
});

test("horário mal configurado também não pode calar o bot", () => {
  const t = new Date("2026-08-27T07:00:00Z");
  assert.equal(isWithinHours(undefined, t), true, "sem regras");
  assert.equal(isWithinHours({ hours: { enabled: false, days: [1], start: "08:00", end: "18:00" } }, t), true);
  assert.equal(isWithinHours({ hours: { enabled: true, days: [], start: "08:00", end: "18:00" } }, t), true, "sem dia");
  assert.equal(isWithinHours({ hours: { enabled: true, days: [4], start: "xx", end: "18:00" } }, t), true, "hora inválida");
  // Fuso inválido NÃO libera a janela: cai no padrão e avalia normalmente.
  // O que se garante aqui é que não estoura e que o resultado é o mesmo de
  // quem configurou o fuso padrão — confundir as duas coisas foi o que fez
  // esta asserção nascer errada.
  const invalido = { timezone: "Marte/Olympus", hours: SEG_A_SEX.hours };
  assert.doesNotThrow(() => isWithinHours(invalido, t));
  assert.equal(isWithinHours(invalido, t), isWithinHours(SEG_A_SEX, t));
  assert.equal(isWithinHours(invalido, new Date("2026-08-28T15:00:00Z")), true, "sexta 12:00 atende");
  assert.equal(parseHhMm("24:00"), null);
  assert.equal(parseHhMm("8:30"), 510);
});

test("as duas travas juntas dizem qual barrou", () => {
  const regras = { ...SEG_A_SEX, numbers: { mode: "allow" as const, list: ["11987654321"] } };
  const noHorario = new Date("2026-08-28T15:00:00Z"); // sexta 12:00
  const madrugada = new Date("2026-08-28T06:00:00Z"); // sexta 03:00

  assert.equal(botShouldAnswer(regras, "5511987654321", noHorario).ok, true);
  const porNumero = botShouldAnswer(regras, "5511999998888", noHorario);
  assert.equal(porNumero.ok === false && porNumero.reason, "numbers");
  const porHorario = botShouldAnswer(regras, "5511987654321", madrugada);
  assert.equal(porHorario.ok === false && porHorario.reason, "hours");
});

test("aviso fora do horário: uma vez por pessoa por dia, no fuso da conta", () => {
  const tz = "America/Sao_Paulo";
  // 02:00Z de sexta ainda é quinta às 23:00 em São Paulo.
  const virada = new Date("2026-08-28T02:00:00Z");
  assert.equal(zonedDateKey(virada, tz), "2026-08-27");
  assert.equal(zonedDateKey(virada, "UTC"), "2026-08-28");

  const manha = new Date("2026-08-27T09:00:00Z");
  const jaAvisado = { [AWAY_SENT_VAR]: zonedDateKey(manha, tz) };
  assert.equal(awayAlreadySent({}, manha, tz), false, "primeira mensagem do dia");
  assert.equal(awayAlreadySent(jaAvisado, manha, tz), true, "não repete");
  assert.equal(awayAlreadySent(jaAvisado, new Date("2026-08-27T23:30:00Z"), tz), true, "mesmo dia à noite");
  assert.equal(awayAlreadySent(jaAvisado, new Date("2026-08-28T09:00:00Z"), tz), false, "dia seguinte");
  assert.equal(awayAlreadySent(undefined, manha, tz), false, "conversa sem estado");
});

test("o que o formulário manda é saneado antes de gravar", () => {
  assert.equal(normalizeBotRules({}), undefined, "nada configurado não suja o registro");
  assert.equal(
    normalizeBotRules({ hours: { enabled: true, days: [], start: "08:00", end: "18:00" } }),
    undefined,
    "ligado sem dia vale como desligado"
  );
  const r = normalizeBotRules({
    numbers: { mode: "xpto", list: ["(11) 98765-4321", "5511987654321", "", "abc"] },
    hours: { enabled: true, days: [3, 1, 1, 9, "2"], start: "25:99", end: "18:00", awayMessage: "  Fechado!  " },
    timezone: "Marte/X",
  });
  assert.equal(r?.numbers.mode, "off", "modo inválido vira off");
  assert.deepEqual(r?.numbers.list, ["11987654321"], "duplicata em outra forma e lixo saem");
  assert.deepEqual(r?.hours?.days, [1, 2, 3], "dias ordenados, sem repetição, fora da faixa fora");
  assert.equal(r?.hours?.start, "08:00", "hora inválida cai no padrão");
  assert.equal(r?.hours?.awayMessage, "Fechado!", "espaço nas pontas removido");
  assert.equal(r?.timezone, undefined, "fuso inválido não é gravado");
  const grande = normalizeBotRules({
    hours: { enabled: true, days: [1], start: "08:00", end: "18:00", awayMessage: "x".repeat(900) },
  });
  assert.equal(grande?.hours?.awayMessage?.length, 700, "texto gigante é cortado");
});
