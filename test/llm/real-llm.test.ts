/**
 * Testes contra o modelo DE VERDADE.
 *
 * Não entram no `npm test` do dia a dia: gastam crédito e levam dezenas de
 * segundos. Rode com `npm run test:llm`, e só quando mexer em prompt ou na
 * montagem do fluxo.
 *
 * O que só eles conseguem responder: o que o modelo REALMENTE escreve. A IA
 * falsa dos outros testes prova o encanamento — que qualquer texto vira um
 * fluxo válido — mas não que o texto seja bom, nem que o modelo respeite o
 * contrato de devolver só textos.
 *
 * Sem chave, tudo aqui é PULADO em vez de falhar: quem clona o repositório
 * não pode ver a suíte vermelha por não ter credencial.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasLlmKey } from "../helpers/env.ts";
import { generateFlowFromPrompt, layoutFlow } from "../../src/flows/from-prompt.ts";
import { SIMPLE_IDS } from "../../src/flows/simple-flow.ts";
import { runFlowStep } from "../../src/flows/engine.ts";
import { validateFlow } from "../../src/flows/validate.ts";
import type { Flow } from "../../src/flows/types.ts";

const skip = hasLlmKey() ? false : "sem chave de IA — rode com .env.local para valer";

const BRIEFING = `Negócio: C3 Pilates, estúdio de pilates em Belo Horizonte.
Aula experimental custa R$50, abatida na matrícula se fechar plano.
Planos a partir de R$280 por mês. Funciona de segunda a sexta, das 6h às 21h.
Prioridade do dono: responder dúvidas sobre planos e horários.`;

const asFlow = (g: Awaited<ReturnType<typeof generateFlowFromPrompt>>): Flow => ({
  id: "f",
  name: g.name,
  product: "p",
  accountId: null,
  status: "draft",
  mode: "simples",
  nodes: layoutFlow(g.nodes, g.edges),
  edges: g.edges,
  createdAt: "",
  updatedAt: "",
});

test("o modelo real produz o esqueleto, com textos do negócio", { skip }, async () => {
  const g = await generateFlowFromPrompt(BRIEFING, "simples");

  // Compara com o esqueleto, não com um número solto.
  assert.deepEqual(
    g.nodes.map((n) => n.id).sort(),
    Object.values(SIMPLE_IDS).slice().sort(),
    "a forma vem do código, não do modelo"
  );
  const abertura = String(g.nodes.find((n) => n.id === SIMPLE_IDS.opening)?.data.prompt || "");
  const contexto = String(g.nodes.find((n) => n.id === SIMPLE_IDS.answer)?.data.context || "");
  const handoff = String(g.nodes.find((n) => n.id === SIMPLE_IDS.handoff)?.data.message || "");

  // O modelo escreveu de fato sobre ESTE negócio, não um texto genérico.
  assert.match(abertura, /pilates/i, `abertura fala do negócio: "${abertura}"`);
  assert.match(abertura, /\{\{name_greet\}\}/, "o nome do contato entra na abertura");
  assert.ok(contexto.length > 40, `contexto com fatos: "${contexto}"`);
  assert.match(contexto, /50|280/, "os números do briefing chegaram ao contexto");
  assert.ok(handoff.length > 10, `handoff escrito: "${handoff}"`);

  // A instrução mais fácil de o modelo ignorar: não cumprimentar de novo,
  // porque o código já põe "Oi{{name_greet}}!" na frente.
  const depois = abertura.replace(/^Oi\{\{name_greet\}\}!\s*/, "");
  assert.doesNotMatch(
    depois,
    /^(oi|ol[áa]|bom dia|boa tarde|boa noite)(\s|[,!.]|$)/i,
    `apresentação não cumprimenta de novo: "${depois}"`
  );

});

test("o fluxo gerado pelo modelo real passa na validação", { skip }, async () => {
  const g = await generateFlowFromPrompt(BRIEFING, "simples");
  const r = await validateFlow(asFlow(g));
  const falhas = r.cases.flatMap((c) => c.issues).filter((i) => i.severity === "fail");
  assert.deepEqual(falhas.map((f) => f.message), [], "sem reprovação");
  assert.equal(r.passed, r.total, `${r.passed}/${r.total}`);
});

test("conversa real: duas perguntas, respostas pelo contexto, e despedida", { skip }, async () => {
  const flow = asFlow(await generateFlowFromPrompt(BRIEFING, "simples"));
  let state: Parameters<typeof runFlowStep>[0]["state"] = {};
  const ditos: string[][] = [];

  for (const msg of ["Oi", "quanto custa a aula experimental?", "e qual o horário?", "não, obrigado"]) {
    const r = await runFlowStep({ flow, state, text: msg, pushName: "Carlos", simulate: true });
    ditos.push(r.replies);
    state = {
      nodeId: r.nodeId,
      waitingFor: r.waitingFor,
      vars: r.vars,
      mode: r.mode,
      finished: r.trace.some((t) => t.type === "end"),
    };
  }

  assert.match(ditos[0][0], /Carlos/, "cumprimenta pelo nome e espera");
  // As respostas têm que vir do CONTEXTO do briefing, não de invenção.
  assert.match(ditos[1].join(" "), /50/, `preço veio do contexto: "${ditos[1].join(" ")}"`);
  assert.match(ditos[2].join(" "), /6|21|segunda|sexta/i, `horário veio do contexto: "${ditos[2].join(" ")}"`);
  // A segunda pergunta ser respondida é o ponto do laço.
  assert.ok(ditos[2].length > 0, "o laço respondeu a segunda pergunta");
  assert.equal(state.finished, true, "a despedida encerrou");
});

test("briefing vazio não quebra a geração", { skip }, async () => {
  // O dono que pula o onboarding: o modelo tem pouco a dizer, e mesmo assim
  // o fluxo tem que sair utilizável.
  const g = await generateFlowFromPrompt("Não sei descrever meu negócio.", "simples");
  assert.equal(g.nodes.length, Object.keys(SIMPLE_IDS).length);
  const abertura = String(g.nodes.find((n) => n.id === SIMPLE_IDS.opening)?.data.prompt || "");
  assert.ok(abertura.length > 12, `abertura utilizável: "${abertura}"`);
  const r = await validateFlow(asFlow(g));
  assert.equal(r.passed, r.total, "e continua válido");
});

test("modelo real: pergunta fora do contexto transborda pra uma pessoa", { skip }, async () => {
  // O bug que isto tranca: a IA escrevia "não tenho essa informação, vou
  // chamar alguém da equipe" e o fluxo seguia em frente — o bot PROMETIA o
  // atendente e não entregava. Só o modelo real prova que ele obedece à
  // sentinela; com IA falsa eu estaria testando a minha própria suposição.
  const flow = asFlow(await generateFlowFromPrompt(BRIEFING, "simples"));
  const parado = {
    nodeId: SIMPLE_IDS.followUp,
    waitingFor: SIMPLE_IDS.followUp,
    vars: {},
    mode: "bot" as const,
  };

  const fora = await runFlowStep({
    flow, state: parado, text: "vocês têm day use pra visitante e estacionamento coberto?", simulate: true,
  });
  assert.equal(fora.mode, "human", `deveria transbordar — falas: ${JSON.stringify(fora.replies)}`);
  assert.ok(!fora.replies.join(" ").includes("NAO_SEI"), "a sentinela não vaza pro cliente");

  // E o contrário: pergunta coberta pelo briefing continua sendo respondida
  // pela IA. Transbordar à toa esvazia o produto.
  const dentro = await runFlowStep({ flow, state: parado, text: "quanto custa a aula?", simulate: true });
  assert.notEqual(dentro.mode, "human", `não deveria transbordar — falas: ${JSON.stringify(dentro.replies)}`);
  assert.match(dentro.replies.join(" "), /50/, "respondeu pelo contexto");
});
