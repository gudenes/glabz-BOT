/**
 * Validação do fluxo COM a IA respondendo.
 *
 * Este arquivo existe por causa de um falso verde que custou caro. Todos os
 * outros testes rodam sem chave de IA — e nesse mundo o card "Responder com
 * IA" SEMPRE falha, o fluxo sai pela saída "erro" e termina no atendente
 * humano. Ou seja: a saída "ok", onde vive o laço de continuação, nunca era
 * exercitada. A suíte ficava verde e um fluxo que reprovava na validação com
 * a IA ligada foi liberado assim mesmo.
 *
 * Aqui a IA responde (fetch trocado), o laço roda de verdade, e o fluxo
 * precisa conseguir CHEGAR AO FIM. Se o cliente sintético não souber se
 * despedir, isto falha — que é exatamente o que aconteceu em staging.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeLlm } from "./helpers/fake-llm.ts";
import { buildSimpleFlow, SIMPLE_IDS } from "../src/flows/simple-flow.ts";
import { catalogFlows } from "../src/flows/catalog.ts";
import { layoutFlow } from "../src/flows/from-prompt.ts";
import { validateFlow } from "../src/flows/validate.ts";
import { runFlowStep } from "../src/flows/engine.ts";
import type { Flow } from "../src/flows/types.ts";

const mk = (): Flow => {
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3.", context: "Aula experimental R$50." });
  return {
    id: "f",
    name: b.name,
    product: "p",
    accountId: null,
    status: "draft",
    mode: "simples",
    nodes: layoutFlow(b.nodes, b.edges),
    edges: b.edges,
    createdAt: "",
    updatedAt: "",
  };
};

test("com a IA respondendo, o fluxo simples passa na validação", async () => {
  const llm = fakeLlm("A aula experimental custa R$50.");
  try {
    const r = await validateFlow(mk());
    const falhas = r.cases.flatMap((c) => c.issues).filter((i) => i.severity === "fail");
    assert.deepEqual(falhas.map((f) => f.message), [], "sem reprovação");
    assert.equal(r.passed, r.total, `${r.passed}/${r.total}`);
    // Prova que o caminho de SUCESSO rodou: sem isto o teste passaria pelo
    // mesmo motivo errado de antes (tudo indo pro atendente).
    assert.ok(llm.calls > 0, "a IA foi de fato chamada");
    const tipos = r.cases[0].trace.map((t) => t.type);
    assert.ok(tipos.includes("condition"), "o laço de continuação foi exercitado");
    assert.ok(tipos.includes("end"), "e a conversa chegou ao fim");
  } finally {
    llm.restore();
  }
});

test("com a IA fora do ar, cai no atendente humano", async () => {
  const llm = fakeLlm("", { fail: true });
  try {
    const r = await validateFlow(mk());
    const falhas = r.cases.flatMap((c) => c.issues).filter((i) => i.severity === "fail");
    assert.deepEqual(falhas.map((f) => f.message), [], "a rede de segurança também é um caminho válido");
    assert.ok(
      r.cases[0].trace.some((t) => t.type === "handoff"),
      "chegou no atendente"
    );
  } finally {
    llm.restore();
  }
});

test("os 5 templates do catálogo passam com a IA ligada", async () => {
  const llm = fakeLlm("Claro! Funciona assim...");
  try {
    for (const flow of catalogFlows()) {
      const r = await validateFlow({ ...flow, mode: "simples" });
      const falhas = r.cases.flatMap((c) => c.issues).filter((i) => i.severity === "fail");
      assert.deepEqual(falhas.map((f) => f.message), [], `${flow.seedSlug}: sem reprovação`);
    }
  } finally {
    llm.restore();
  }
});

test("a conversa real: duas perguntas seguidas e depois a despedida", async () => {
  const llm = fakeLlm("Custa R$50 e dura 50 minutos.");
  try {
    const flow = mk();
    let state: Parameters<typeof runFlowStep>[0]["state"] = {};
    const falas: string[] = [];
    for (const msg of ["Oi", "quanto custa?", "e tem aula de manhã?", "não, obrigado"]) {
      const r = await runFlowStep({ flow, state, text: msg, pushName: "Carlos", simulate: true });
      falas.push(...r.replies);
      state = {
        nodeId: r.nodeId,
        waitingFor: r.waitingFor,
        vars: r.vars,
        mode: r.mode,
        finished: r.trace.some((t) => t.type === "end"),
      };
    }
    assert.match(falas[0], /Oi, Carlos!/, "cumprimenta pelo nome e espera");
    // A segunda pergunta tem que ser respondida pela IA também — é o ponto do
    // laço, e o que não acontecia quando o "ok" ia direto pro fim.
    assert.equal(llm.calls >= 2, true, `a IA respondeu as duas perguntas (chamadas: ${llm.calls})`);
    assert.equal(state.finished, true, "a despedida encerrou a conversa");
  } finally {
    llm.restore();
  }
});

test("o cliente que só faz perguntas nunca fica preso", async () => {
  // Sem despedida, o laço roda — e tem que continuar RESPONDENDO, não travar
  // nem repetir a pergunta de continuação sem responder.
  const llm = fakeLlm("Resposta.");
  try {
    const flow = mk();
    let state: Parameters<typeof runFlowStep>[0]["state"] = {};
    for (const msg of ["Oi", "p1?", "p2?", "p3?", "p4?"]) {
      const r = await runFlowStep({ flow, state, text: msg, simulate: true });
      state = { nodeId: r.nodeId, waitingFor: r.waitingFor, vars: r.vars, mode: r.mode };
      assert.ok(r.replies.length > 0, `"${msg}": o bot sempre responde algo`);
    }
    assert.equal(state.nodeId, SIMPLE_IDS.followUp, "e segue esperando no card de continuação");
    assert.equal(llm.calls, 4, "uma resposta da IA por pergunta");
  } finally {
    llm.restore();
  }
});
