/**
 * Contrato de geração do fluxo simples.
 *
 * Este é o teste que faltava e que teria pego os quatro bugs desta rodada.
 * Os anteriores exercitavam as funções de REPARO contra formatos que eu
 * imaginei — e o modelo produzia formatos que eu não tinha imaginado. Aqui a
 * pergunta é outra: seja qual for a resposta da LLM, inclusive lixo, o fluxo
 * produzido tem que ser o esqueleto válido.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSimpleFlow, parseSimpleFlowTexts, SIMPLE_IDS } from "../src/flows/simple-flow.ts";
import { runFlowStep } from "../src/flows/engine.ts";
import { layoutFlow } from "../src/flows/from-prompt.ts";
import type { Flow } from "../src/flows/types.ts";

/** Tudo que o esqueleto promete, num lugar só. */
function assertEsqueletoValido(flow: ReturnType<typeof buildSimpleFlow>, contexto: string) {
  const { nodes, edges } = flow;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const out = (id: string) => edges.filter((x) => x.from === id);
  const alvo = (id: string, label?: string) =>
    byId.get(out(id).find((x) => (x.label || undefined) === label)?.to || "");

  // Compara o CONJUNTO de cards, não a quantidade: se a forma mudar, o teste
  // diz exatamente o que entrou ou saiu em vez de só "8 !== 7".
  assert.deepEqual(
    nodes.map((x) => x.id).sort(),
    Object.values(SIMPLE_IDS).slice().sort(),
    `${contexto}: exatamente os cards do esqueleto`
  );
  assert.equal(edges.length, nodes.length, `${contexto}: uma ligação por card`);

  // Espera o cliente falar antes de acionar a IA — só `ask` faz o motor parar.
  assert.equal(byId.get(SIMPLE_IDS.opening)?.type, "ask", `${contexto}: abertura é pergunta`);
  assert.equal(
    alvo(SIMPLE_IDS.trigger)?.id,
    SIMPLE_IDS.opening,
    `${contexto}: gatilho vai pra abertura`
  );
  assert.equal(alvo(SIMPLE_IDS.opening)?.id, SIMPLE_IDS.answer, `${contexto}: abertura vai pra IA`);

  // As duas saídas da IA, cada uma pro lugar certo.
  assert.equal(alvo(SIMPLE_IDS.answer, "ok")?.id, SIMPLE_IDS.followUp, `${contexto}: ok → continua`);
  assert.equal(alvo(SIMPLE_IDS.answer, "erro")?.id, SIMPLE_IDS.handoff, `${contexto}: erro → pessoa`);

  // O laço fecha E tem saída.
  assert.equal(alvo(SIMPLE_IDS.followUp)?.id, SIMPLE_IDS.decide, `${contexto}: continua → decisão`);
  // Despedida ANTES do fim: sem ela o bot emudecia quando o cliente encerrava.
  assert.equal(alvo(SIMPLE_IDS.decide, "true")?.id, SIMPLE_IDS.bye, `${contexto}: despediu → despedida`);
  assert.equal(alvo(SIMPLE_IDS.bye)?.id, SIMPLE_IDS.end, `${contexto}: despedida → fim`);
  assert.equal(
    alvo(SIMPLE_IDS.decide, "false")?.id,
    SIMPLE_IDS.answer,
    `${contexto}: quer mais → VOLTA pra IA (o laço falso do print ia pro fim)`
  );

  // Nada de saída duplicada: duas com o mesmo rótulo deixam o motor sem saber
  // qual seguir (foi o bug do builder no PR #102).
  for (const node of nodes) {
    const labels = out(node.id).map((x) => x.label || "");
    assert.equal(new Set(labels).size, labels.length, `${contexto}: ${node.id} sem saída duplicada`);
  }
  // Toda ligação aponta pra card existente.
  for (const edge of edges) {
    assert.ok(byId.has(edge.to), `${contexto}: ligação ${edge.id} aponta pra card existente`);
  }
}

test("resposta boa da LLM produz o esqueleto", () => {
  const flow = buildSimpleFlow(
    parseSimpleFlowTexts(
      JSON.stringify({
        name: "Atendimento C3",
        apresentacao: "Aqui é da C3 Pilates. Como posso te ajudar?",
        context: "Aula experimental R$50, abatida na matrícula.",
        handoff: "Vou chamar a recepção.",
      })
    )
  );
  assertEsqueletoValido(flow, "resposta boa");
  assert.equal(flow.name, "Atendimento C3");
  assert.match(String(flow.nodes[1].data.prompt), /C3 Pilates/);
  assert.equal(flow.nodes[2].data.context, "Aula experimental R$50, abatida na matrícula.");
});

test("respostas ruins da LLM continuam produzindo o esqueleto", () => {
  const ruins: [string, string][] = [
    ["vazia", ""],
    ["prosa em vez de JSON", "Claro! Aqui está o fluxo que montei pra você."],
    ["JSON quebrado", '{"name": "x", '],
    ["JSON vazio", "{}"],
    ["array em vez de objeto", "[1,2,3]"],
    ["campos nulos", '{"name":null,"apresentacao":null,"context":null,"handoff":null}'],
    ["campos do tipo errado", '{"name":42,"apresentacao":{"a":1},"context":[],"handoff":true}'],
    ["com cerca de markdown", '```json\n{"name":"Ok","apresentacao":"Oi!"}\n```'],
    // O caso que importa: o modelo insistindo em desenhar o grafo.
    [
      "modelo tentou mandar nodes/edges",
      JSON.stringify({
        name: "Tentativa",
        nodes: [{ id: "x", type: "llm_answer" }],
        edges: [{ from: "x", to: "x" }],
      }),
    ],
  ];
  for (const [nome, raw] of ruins) {
    const flow = buildSimpleFlow(parseSimpleFlowTexts(raw));
    assertEsqueletoValido(flow, nome);
    assert.ok(flow.name.length > 0, `${nome}: nome nunca vazio`);
    assert.ok(String(flow.nodes[1].data.prompt).length > 0, `${nome}: abertura nunca vazia`);
    assert.ok(String(flow.nodes.find((x) => x.id === SIMPLE_IDS.handoff)?.data.message).length > 0, `${nome}: handoff nunca vazio`);
  }
});

test("nunca lê nodes/edges da resposta, mesmo quando vêm", () => {
  const texts = parseSimpleFlowTexts(
    JSON.stringify({ apresentacao: "Oi", nodes: [{ id: "hack" }], edges: [{ from: "hack" }] })
  );
  assert.deepEqual(Object.keys(texts).sort(), ["apresentacao", "context", "handoff", "name"]);
  const flow = buildSimpleFlow(texts);
  assert.ok(!flow.nodes.some((x) => x.id === "hack"));
});

test("o nome do WhatsApp entra na abertura sem a IA precisar acertar o token", () => {
  const flow = buildSimpleFlow({ apresentacao: "Aqui é da padaria. O que você precisa?" });
  assert.match(String(flow.nodes[1].data.prompt), /\{\{name_greet\}\}/);
});

test("a conversa completa: espera, responde, continua e encerra", async () => {
  const built = buildSimpleFlow({ apresentacao: "Aqui é da C3. Como posso ajudar?" });
  const flow: Flow = {
    id: "f",
    name: built.name,
    product: "p",
    accountId: null,
    status: "draft",
    nodes: layoutFlow(built.nodes, built.edges),
    edges: built.edges,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 1ª mensagem: cumprimenta e ESPERA, em vez de gastar a resposta da IA
  // respondendo o "oi" (era o bug do PR #101).
  const abre = await runFlowStep({ flow, state: {}, text: "Olá", pushName: "Carlos", simulate: true });
  assert.ok(abre.waitingFor, "para e espera o cliente dizer o que quer");
  assert.match(abre.replies[0], /Carlos/, "usa o nome do WhatsApp");

  // Sem chave de IA neste ambiente o card de resposta sempre falha, então o
  // laço é exercitado entrando direto pelo card de continuação — que é o
  // estado em que a conversa fica logo depois de a IA responder.
  const parado = { nodeId: SIMPLE_IDS.followUp, waitingFor: SIMPLE_IDS.followUp, vars: {}, mode: "bot" as const };

  const despediu = await runFlowStep({ flow, state: parado, text: "não, obrigado", simulate: true });
  assert.ok(
    despediu.trace.some((s) => s.type === "end"),
    "despedida encerra"
  );

  const querMais = await runFlowStep({ flow, state: parado, text: "e tem aula de manhã?", simulate: true });
  assert.ok(
    querMais.trace.some((s) => s.type === "llm_answer"),
    "outra pergunta volta pra IA"
  );

  const pareceDespedida = await runFlowStep({ flow, state: parado, text: "não sei o horário", simulate: true });
  assert.ok(
    pareceDespedida.trace.some((s) => s.type === "llm_answer"),
    "'não sei...' é pergunta, não despedida — encerrar aqui seria pior que perguntar de novo"
  );
});
