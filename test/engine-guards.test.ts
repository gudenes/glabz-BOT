/**
 * Guardas do motor que custaram caro pra descobrir.
 *
 * Cada teste aqui corresponde a um bug que chegou no usuário e a uma correção
 * que, se alguém desfizer sem querer, volta a quebrar o atendimento em
 * produção — em silêncio, porque nada na tela acusa.
 *
 * Não dependem de chave de IA: os cenários são montados com fluxos sintéticos
 * e exercitados pelo motor real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClosingSlug, runFlowStep } from "../src/flows/engine.ts";
import { layoutFlow } from "../src/flows/from-prompt.ts";
import { buildSimpleFlow, SIMPLE_IDS } from "../src/flows/simple-flow.ts";
import type { Flow, FlowEdge, FlowNode } from "../src/flows/types.ts";

const n = (id: string, type: FlowNode["type"], data: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  x: 0,
  y: 0,
  data,
});

const mkFlow = (nodes: FlowNode[], edges: FlowEdge[]): Flow => ({
  id: "f",
  name: "t",
  product: "p",
  accountId: null,
  status: "draft",
  nodes: layoutFlow(nodes, edges),
  edges,
  createdAt: "",
  updatedAt: "",
});

test("PR #69: ramo indefinido não é adivinhado", async () => {
  // O bug: quando a classificação não decidia, o motor caía na "primeira
  // edge" e o cliente ia parar num ramo que não tinha pedido. Com mais de uma
  // saída e nenhuma batendo, o certo é parar e pedir pra reformular.
  const flow = mkFlow(
    [
      n("t1", "trigger"),
      n("i1", "llm_intent", {
        intents: [
          { slug: "marcar", description: "quer agendar" },
          { slug: "duvida", description: "tem uma pergunta" },
        ],
      }),
      n("m1", "message", { text: "ramo de agendamento" }),
      n("m2", "message", { text: "ramo de dúvida" }),
    ],
    [
      { id: "a", from: "t1", to: "i1" },
      { id: "b", from: "i1", to: "m1", label: "marcar" },
      { id: "c", from: "i1", to: "m2", label: "duvida" },
    ]
  );
  // Sem chave de IA a classificação não decide — exatamente o cenário do bug.
  const r = await runFlowStep({ flow, state: {}, text: "asdfgh qwerty", simulate: true });
  assert.ok(
    !r.replies.includes("ramo de agendamento"),
    "não pode entrar no primeiro ramo por falta de opção"
  );
});

test("PR #74: saudação não é tratada como encerramento", () => {
  // "Ola" chegou a ser classificado como "encerrar" e o bot se despedia antes
  // de ouvir o cliente. A guarda só aceita encerramento vindo do ask de
  // "mais alguma coisa?" (capturesIntent), nunca de uma saudação.
  assert.equal(isClosingSlug("encerrar"), true);
  assert.equal(isClosingSlug("duvida"), false);
  assert.equal(isClosingSlug(""), false);
});

test("PR #101: a abertura espera, em vez de gastar a resposta no 'oi'", async () => {
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3. Como posso ajudar?" });
  const flow = mkFlow(b.nodes, b.edges);
  const r = await runFlowStep({ flow, state: {}, text: "Olá", simulate: true });
  assert.ok(r.waitingFor, "para e aguarda o cliente dizer o que quer");
  assert.ok(
    !r.trace.some((s) => s.type === "llm_answer"),
    "a IA não é acionada com um simples 'oi'"
  );
});

test("motor reinicia pelo gatilho depois de encerrar", async () => {
  // É o que torna o card de Fim aceitável no fluxo simples: encerrar não
  // deixa o cliente sem atendimento, só fecha o ciclo. Se isso mudar, o Fim
  // vira um beco e o bot fica mudo na mensagem seguinte.
  //
  // O estado abaixo é o que o motor realmente grava ao chegar no fim
  // (nodeId null, finished true) — verificado, não suposto.
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3." });
  const flow = mkFlow(b.nodes, b.edges);
  const r = await runFlowStep({
    flow,
    state: { nodeId: null, waitingFor: null, vars: {}, mode: "bot", finished: true },
    text: "oi de novo",
    simulate: true,
  });
  assert.ok(r.trace.some((s) => s.type === "trigger"), "recomeça pelo gatilho");
  assert.ok(r.waitingFor, "e volta a esperar o cliente");
});

test("conversa já entregue a uma pessoa não é interceptada", async () => {
  // Cobre a guarda do runFlowStep. Existe uma segunda, equivalente, em
  // processInboundFlow (o caminho do WhatsApp ao vivo), que não é exercitada
  // aqui porque depende do estado em disco.
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3." });
  const flow = mkFlow(b.nodes, b.edges);
  const r = await runFlowStep({
    flow,
    state: { nodeId: SIMPLE_IDS.opening, waitingFor: SIMPLE_IDS.opening, vars: {}, mode: "human" },
    text: "oi",
    simulate: true,
  });
  assert.equal(r.mode, "human", "segue em atendimento humano");
  assert.deepEqual(r.replies, [], "o bot não fala por cima da pessoa");
});

test("{{name_greet}} some quando não há nome, sem deixar frase quebrada", async () => {
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3." });
  const flow = mkFlow(b.nodes, b.edges);

  const comNome = await runFlowStep({ flow, state: {}, text: "oi", pushName: "Carlos", simulate: true });
  assert.match(comNome.replies[0], /Oi, Carlos!/);

  const semNome = await runFlowStep({ flow, state: {}, text: "oi", simulate: true });
  assert.match(semNome.replies[0], /^Oi!/, "sem nome não sobra vírgula solta");
});
