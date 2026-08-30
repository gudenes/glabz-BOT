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
  remainingDelayMs,
  MAX_TYPING_DELAY_MS,
  shouldReturnToBot,
  MAX_HANDOFF_RETURN_MS,
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

test("tempo de 'digitando': espera o que FALTA, não soma", () => {
  // A escolha que importa: é tempo TOTAL mínimo. Se a IA já levou 3s e o dono
  // pediu 2s, não espera mais nada — somar deixaria a conversa lenta
  // justamente nas perguntas difíceis, que já são as mais demoradas.
  const r2s = { typingDelayMs: 2000 };
  assert.equal(remainingDelayMs(r2s, 0), 2000, "resposta instantânea espera os 2s");
  assert.equal(remainingDelayMs(r2s, 500), 1500, "meio segundo de IA → falta 1,5s");
  assert.equal(remainingDelayMs(r2s, 2000), 0, "já levou o tempo todo → não espera");
  assert.equal(remainingDelayMs(r2s, 5000), 0, "demorou mais que o pedido → não espera");

  // Nada configurado = comportamento de sempre, sem atraso nenhum.
  assert.equal(remainingDelayMs(undefined, 0), 0);
  assert.equal(remainingDelayMs({}, 0), 0);
  assert.equal(remainingDelayMs({ typingDelayMs: 0 }, 0), 0);

  // Lixo não pode virar espera absurda nem negativa.
  assert.equal(remainingDelayMs({ typingDelayMs: -500 } as never, 0), 0);
  assert.equal(remainingDelayMs({ typingDelayMs: 999999 }, 0), MAX_TYPING_DELAY_MS, "teto respeitado");
  assert.equal(remainingDelayMs({ typingDelayMs: Number.NaN }, 0), 0);
  assert.equal(remainingDelayMs(r2s, -100), 2000, "tempo decorrido negativo não estica a espera");
});

test("o atraso é saneado antes de gravar", () => {
  assert.equal(normalizeBotRules({ typingDelayMs: 2000 })?.typingDelayMs, 2000);
  assert.equal(normalizeBotRules({ typingDelayMs: 0 }), undefined, "zero não suja o registro");
  assert.equal(normalizeBotRules({ typingDelayMs: 99999 })?.typingDelayMs, MAX_TYPING_DELAY_MS);
  assert.equal(normalizeBotRules({ typingDelayMs: "abc" })?.typingDelayMs, undefined);
  assert.equal(normalizeBotRules({ typingDelayMs: 1500.7 })?.typingDelayMs, 1501, "arredonda");
});

test("conversa com atendente volta pro bot sozinha, por padrão", () => {
  // Antes o modo humano era permanente: ninguém "devolve" formalmente, então
  // uma conversa resolvida ficava presa e o cliente que voltasse semanas
  // depois não era atendido.
  const agora = new Date("2026-08-31T12:00:00Z");
  const hAtras = (h: number) => new Date(agora.getTime() - h * 3600000).toISOString();

  // Sem nada configurado: o padrão de 24h vale.
  assert.equal(shouldReturnToBot(undefined, hAtras(1), agora), false, "1h ainda é atendimento");
  assert.equal(shouldReturnToBot(undefined, hAtras(23), agora), false, "23h ainda não");
  assert.equal(shouldReturnToBot(undefined, hAtras(25), agora), true, "25h volta");
  assert.equal(shouldReturnToBot({}, hAtras(24 * 30), agora), true, "um mês volta");
});

test("zero é escolha do dono ('nunca'), não 'não configurado'", () => {
  const agora = new Date("2026-08-31T12:00:00Z");
  const anoAtras = new Date(agora.getTime() - 365 * 86400000).toISOString();
  assert.equal(shouldReturnToBot({ handoffReturnMs: 0 }, anoAtras, agora), false, "nunca volta");
  // E o zero precisa SOBREVIVER ao salvamento: omitir cairia no padrão de 24h,
  // o oposto do que ele pediu.
  assert.equal(normalizeBotRules({ handoffReturnMs: 0 })?.handoffReturnMs, 0);
  // Já não mandar a chave é "não configurado" — aí o padrão vale.
  assert.equal(normalizeBotRules({ typingDelayMs: 1000 })?.handoffReturnMs, undefined);
});

test("prazo escolhido pelo dono, e os limites", () => {
  const agora = new Date("2026-08-31T12:00:00Z");
  const hAtras = (h: number) => new Date(agora.getTime() - h * 3600000).toISOString();
  assert.equal(shouldReturnToBot({ handoffReturnMs: 3600000 }, hAtras(0.5), agora), false);
  assert.equal(shouldReturnToBot({ handoffReturnMs: 3600000 }, hAtras(2), agora), true);
  // Teto: pedir mais de 30 dias vale 30 dias.
  assert.equal(normalizeBotRules({ handoffReturnMs: 999 * 86400000 })?.handoffReturnMs, MAX_HANDOFF_RETURN_MS);
  assert.equal(normalizeBotRules({ handoffReturnMs: -5 })?.handoffReturnMs, 0);
});

test("sem data válida, não devolve — falar por cima de um atendente é pior", () => {
  const agora = new Date("2026-08-31T12:00:00Z");
  assert.equal(shouldReturnToBot(undefined, null, agora), false);
  assert.equal(shouldReturnToBot(undefined, "", agora), false);
  assert.equal(shouldReturnToBot(undefined, "data ruim", agora), false);
});
