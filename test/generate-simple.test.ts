/**
 * Geração do fluxo simples, do HTTP da LLM até o fluxo pronto.
 *
 * O teste do esqueleto (simple-flow.test.ts) cobre a montagem. Aqui a
 * pergunta é a de ponta: com o `fetch` respondendo o que o modelo responderia
 * — inclusive tentando desenhar o grafo — o fluxo entregue continua sendo o
 * esqueleto? É a checagem que eu não tinha e que deixou passar os quatro bugs
 * desta rodada.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateFlowFromPrompt } from "../src/flows/from-prompt.ts";
import { SIMPLE_IDS } from "../src/flows/simple-flow.ts";

const realFetch = globalThis.fetch;
const realKey = process.env.XAI_API_KEY;

/** Faz a LLM "responder" exatamente isto, sem sair pra rede. */
function mockLlm(content: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

before(() => {
  // generateFlowFromPrompt recusa sem chave; o valor não é usado, o fetch é falso.
  process.env.XAI_API_KEY = "test-key";
});

after(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = realKey;
});

/** O esqueleto tem forma fixa: 7 cards e o laço voltando pra IA. */
function assertEsqueleto(flow: { nodes: { id: string; type: string }[]; edges: { from: string; to: string; label?: string }[] }) {
  assert.equal(flow.nodes.length, 7);
  const volta = flow.edges.find((e) => e.from === SIMPLE_IDS.decide && e.label === "false");
  assert.equal(volta?.to, SIMPLE_IDS.answer, "o laço volta pra IA");
  const ok = flow.edges.find((e) => e.from === SIMPLE_IDS.answer && e.label === "ok");
  assert.equal(ok?.to, SIMPLE_IDS.followUp, "a saída ok continua a conversa");
  // Posicionado: sem x/y os cards empilhariam no canto do canvas.
  assert.ok(flow.nodes.some((n) => (n as { x?: number }).x !== 0 || (n as { y?: number }).y !== 0));
}

test("modo simples: usa os textos da LLM e monta o esqueleto", async () => {
  mockLlm(
    JSON.stringify({
      name: "Atendimento C3",
      apresentacao: "Aqui é da C3 Pilates. Como posso te ajudar?",
      context: "Aula experimental R$50.",
      handoff: "Vou chamar a recepção.",
    })
  );
  const flow = await generateFlowFromPrompt("briefing qualquer", "simples");
  assert.equal(flow.name, "Atendimento C3");
  assert.match(String(flow.nodes[1].data.prompt), /C3 Pilates/);
  assertEsqueleto(flow);
});

test("modo simples: LLM tentando desenhar o grafo é ignorada", async () => {
  // Exatamente o que vinha acontecendo: o modelo devolvia um desenho próprio.
  // Aqui ele manda o formato do laço FALSO do print — a pergunta de
  // continuação ligada direto no fim — e isso não pode chegar no canvas.
  mockLlm(
    JSON.stringify({
      name: "Tentativa",
      apresentacao: "Aqui é da padaria.",
      nodes: [
        { id: "x1", type: "trigger" },
        { id: "x2", type: "llm_answer" },
        { id: "x3", type: "ask", text: "Consigo te ajudar com mais alguma coisa?" },
        { id: "x4", type: "end" },
      ],
      edges: [
        { from: "x1", to: "x2" },
        { from: "x2", to: "x3", label: "ok" },
        { from: "x3", to: "x4", label: "sim" },
      ],
    })
  );
  const flow = await generateFlowFromPrompt("briefing", "simples");
  assert.ok(!flow.nodes.some((n) => n.id.startsWith("x")), "nenhum card do modelo entrou");
  assert.match(String(flow.nodes[1].data.prompt), /padaria/, "mas o texto dele foi aproveitado");
  assertEsqueleto(flow);
});

test("modo simples: resposta imprestável ainda produz fluxo válido", async () => {
  for (const ruim of ["", "desculpe, não consegui", "{", "{}", "[]", "null"]) {
    mockLlm(ruim);
    const flow = await generateFlowFromPrompt("briefing", "simples");
    assertEsqueleto(flow);
    assert.ok(flow.name.length > 0);
    assert.ok(String(flow.nodes[1].data.prompt).length > 0);
  }
});

test("modo completo segue autorando o grafo (não foi tocado)", async () => {
  mockLlm(
    JSON.stringify({
      name: "Completo",
      nodes: [
        { id: "c1", type: "trigger" },
        { id: "c2", type: "message", text: "Bem-vindo!" },
        { id: "c3", type: "ask", text: "Qual seu nome?", varName: "nome" },
        { id: "c4", type: "llm_intent", intents: [{ slug: "duvida", description: "tem dúvida" }] },
        { id: "c5", type: "llm_answer", context: "" },
        { id: "c6", type: "handoff", text: "Chamando alguém." },
        { id: "c7", type: "end" },
      ],
      edges: [
        { from: "c1", to: "c2" },
        { from: "c2", to: "c3" },
        { from: "c3", to: "c4" },
        { from: "c4", to: "c5", label: "duvida" },
        { from: "c5", to: "c7", label: "ok" },
        { from: "c5", to: "c6", label: "erro" },
      ],
    })
  );
  const flow = await generateFlowFromPrompt("briefing", "completo");
  assert.ok(flow.nodes.some((n) => n.id === "c4" && n.type === "llm_intent"), "usa o grafo do modelo");
  assert.ok(flow.nodes.some((n) => n.type === "llm_answer"));
});
