/**
 * As quatro saídas do laço do fluxo simples.
 *
 * A cada volta o bot tem que perguntar "consigo te ajudar com mais alguma
 * coisa?", e a resposta decide entre três destinos: continuar, encerrar com
 * despedida, ou passar pra uma pessoa. Cada um desses já esteve errado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeLlm } from "./helpers/fake-llm.ts";
import { buildSimpleFlow, SIMPLE_IDS } from "../src/flows/simple-flow.ts";
import { layoutFlow } from "../src/flows/from-prompt.ts";
import { isUnknownAnswer, UNKNOWN_TOKEN } from "../src/flows/llm.ts";
import { runFlowStep } from "../src/flows/engine.ts";
import type { Flow } from "../src/flows/types.ts";

const mk = (): Flow => {
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3.", context: "Aula R$50." });
  return { id: "f", name: b.name, product: "p", accountId: null, status: "draft",
    nodes: layoutFlow(b.nodes, b.edges), edges: b.edges, createdAt: "", updatedAt: "" };
};
const parado = () => ({
  nodeId: SIMPLE_IDS.followUp, waitingFor: SIMPLE_IDS.followUp, vars: {}, mode: "bot" as const,
});

test("a cada volta o bot pergunta 'mais alguma coisa?'", async () => {
  const llm = fakeLlm("Custa R$50.");
  try {
    const flow = mk();
    let state: Parameters<typeof runFlowStep>[0]["state"] = {};
    await runFlowStep({ flow, state, text: "Oi", simulate: true }).then((r) => {
      state = { nodeId: r.nodeId, waitingFor: r.waitingFor, vars: r.vars, mode: r.mode };
    });
    // Quatro perguntas seguidas: em TODAS o bot responde e volta a oferecer ajuda.
    for (const p of ["p1?", "p2?", "p3?", "p4?"]) {
      const r = await runFlowStep({ flow, state, text: p, simulate: true });
      assert.ok(
        r.replies.some((x) => /mais alguma coisa/i.test(x)),
        `"${p}": tem que voltar a perguntar — falas: ${JSON.stringify(r.replies)}`
      );
      state = { nodeId: r.nodeId, waitingFor: r.waitingFor, vars: r.vars, mode: r.mode };
    }
  } finally {
    llm.restore();
  }
});

test("despedida: o bot se despede antes de encerrar, não emudece", async () => {
  const llm = fakeLlm("Resposta.");
  try {
    const r = await runFlowStep({ flow: mk(), state: parado(), text: "não, obrigado", pushName: "Carlos", simulate: true });
    assert.ok(r.trace.some((t) => t.type === "end"), "encerrou");
    // O bug: o cliente se despedia e não recebia nada. Sumir no meio da
    // conversa é pior do que não ter tido bot.
    assert.ok(r.replies.length > 0, "o bot fala antes de encerrar");
    assert.match(r.replies.join(" "), /Carlos/, "e se despede pelo nome");
  } finally {
    llm.restore();
  }
});

test("pergunta fora da base: transborda pra uma pessoa de verdade", async () => {
  // O bug mais grave: a IA escrevia "não tenho essa informação, vou chamar
  // alguém" e o fluxo seguia em frente. O bot PROMETIA o atendente e não
  // entregava.
  const llm = fakeLlm(UNKNOWN_TOKEN);
  try {
    const r = await runFlowStep({ flow: mk(), state: parado(), text: "vocês têm day use?", simulate: true });
    assert.equal(r.mode, "human", "a conversa passou pra uma pessoa");
    assert.ok(r.trace.some((t) => t.type === "handoff"));
    assert.ok(
      !r.replies.some((x) => x.includes(UNKNOWN_TOKEN)),
      "e a sentinela nunca vaza pro cliente"
    );
  } finally {
    llm.restore();
  }
});

test("'não sei' é transbordo; 'não temos' é resposta", () => {
  // A distinção que evita transbordar à toa: as frases de baixo falam do
  // CONHECIMENTO da IA; "não temos piscina" fala do NEGÓCIO e é resposta
  // legítima vinda do contexto.
  for (const f of [
    UNKNOWN_TOKEN,
    "NAO_SEI",
    "Não tenho essa informação aqui. Vou chamar alguém da equipe.",
    "Não tenho essa informação no contexto.",
    "não sei",
    "Isso não consta no contexto.",
    "Não encontrei esse dado.",
  ]) {
    assert.ok(isUnknownAnswer(f), `deveria transbordar: "${f}"`);
  }
  for (const f of [
    "Não temos piscina.",
    "Não.",
    "Não trabalhamos aos domingos.",
    "A aula custa R$50.",
    "Não há taxa de matrícula.",
    "Sim, temos estacionamento.",
  ]) {
    assert.ok(!isUnknownAnswer(f), `NÃO deveria transbordar: "${f}"`);
  }
});
