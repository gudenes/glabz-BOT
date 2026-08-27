import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import type { FlowEdge, FlowNode } from "./types.js";

export type GeneratedFlow = {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

/** Formato bruto de nó que a LLM devolve tanto na geração (generateFlowFromPrompt)
 * quanto na edição (src/flows/edit-flow.ts) — mesmo schema simplificado nos dois
 * casos, ver materializeNode(). */
export type RawFlowNode = {
  id?: string;
  type?: string;
  text?: string;
  varName?: string;
  context?: string;
  intents?: { slug: string; description: string }[];
  /** Só pra "ask": true quando esse ask existe pra colher um NOVO pedido do
   * cliente (ex.: "posso te ajudar com mais alguma coisa?"), não um dado
   * qualquer (nome, telefone) — ver regra 10 do SYSTEM/EDIT_SYSTEM. */
  capturesIntent?: boolean;
};

export type RawFlowEdge = { from?: string; to?: string; label?: string };

/** Tetos declarados nos prompts. Usados só pra registrar estouro — ver
 * generateFlowFromPrompt. */
export const MAX_NODES_SIMPLES = 5;
export const MAX_NODES_COMPLETO = 14;

/** Qual desenho de fluxo gerar. Ver SYSTEM x SYSTEM_SIMPLES. */
export type FlowBuildMode = "simples" | "completo";

/**
 * Fluxo enxuto: resolve UMA prioridade do negócio no menor número de cards.
 * Não é o completo podado — é outro desenho. Sem boas-vindas e sem perguntar
 * nome de propósito (decisão do usuário, 27/08): essas etapas são do fluxo
 * completo, e num fluxo de 5 cards elas consumiriam quase tudo sem entregar
 * a resposta que o cliente veio buscar.
 */
const SYSTEM_SIMPLES = `Você monta fluxos de atendimento WhatsApp da GLABZ, no modo ENXUTO.
Responda APENAS um JSON válido, sem markdown:
{
  "name": "nome curto do fluxo",
  "nodes": [
    { "id": "n1", "type": "trigger|message|ask|llm_answer|handoff|end", "text": "texto visível", "varName": "opcional", "context": "opcional, só pra llm_answer" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "opcional" }
  ]
}

Regras (todas obrigatórias):
1. NO MÁXIMO 5 cards no total, contando o trigger e o fim. Menos é melhor.
2. Comece pelo trigger. NÃO use boas-vindas nem pergunte o nome — esse fluxo vai direto ao ponto.
3. TEM que existir um card llm_answer: é ele que responde de verdade, usando a base de conhecimento
   do negócio, e é o que dá valor ao fluxo. Preencha "context" com os fatos que JÁ apareceram no
   briefing (horário, preço, endereço, política) — nunca invente; se nada foi dito, deixe "" mesmo,
   o card continua funcionando pela base de conhecimento em tempo real.
4. llm_answer SEMPRE tem duas saídas: edge label "ok" e edge label "erro". A "erro" vai pra um
   handoff (atendente humano) — é a rede de segurança quando a IA não sabe responder.
5. NÃO use llm_intent, condition nem action. Este fluxo não ramifica por intenção: ele atende UMA
   necessidade principal, a que o dono indicou como mais relevante.
6. NÓ linear (trigger, message, ask, handoff, end) tem no máximo 1 saída.
Textos em português, naturais, prontos para WhatsApp (*negrito* ok).`;

const SYSTEM = `Você monta fluxos de atendimento WhatsApp da GLABZ.
Responda APENAS um JSON válido, sem markdown:
{
  "name": "nome curto do fluxo",
  "nodes": [
    { "id": "n1", "type": "trigger|message|ask|llm_intent|llm_answer|handoff|end", "text": "texto visível", "varName": "opcional", "context": "opcional, só pra llm_answer", "capturesIntent": "opcional, só pro ask de \\"mais alguma coisa?\\" da regra 10", "intents": [{"slug":"marcar","description":"quer agendar"}] }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "marcar" }
  ]
}

Arquitetura obrigatória (tronco + ramos, sem cruzar):
1. trigger → message (boas-vindas) → ask (nome, ver regra 9 — SEMPRE presente, não é opcional) →
   llm_intent
2. Do llm_intent saem 2 ou 3 ramos por pedido real do cliente (um por intenção) MAIS 1 ramo
   reservado de encerramento (ver regra 10) — todos contam pro limite de intents da regra 8. Cada
   edge do intent TEM label = slug.
3. Cada ramo (exceto o de encerramento) é uma linha reta para baixo: ask? → message? →
   (handoff|llm_answer) e, se NÃO terminar em handoff, sempre seguido do ask de "mais alguma
   coisa?" da regra 10 antes de qualquer end — nenhum ramo (fora handoff) termina direto num end.
4. TODO fluxo tem PELO MENOS UM llm_answer. Não é opcional, não é "se fizer sentido", não depende
   do segmento do negócio. Esse card responde usando a BASE DE CONHECIMENTO coletada no
   onboarding, e é o que evita resposta evasiva: quando a IA não sabe, a saída "erro" manda pro
   atendente humano. Sem ele, qualquer pergunta fora do script não tem pra onde ir.
   Dois usos, e os DOIS valem:
   a. Ramo de DÚVIDA/pergunta geral sobre o negócio (não ação estruturada tipo marcar/cancelar/
      comprar) termina em llm_answer em vez de ir direto pro handoff.
   b. Se NENHUM ramo for naturalmente de dúvida (ex.: negócio só de agendamento), crie um ramo
      dedicado a mais — "outras dúvidas", "informações sobre o negócio" — que termine em
      llm_answer. É esse ramo que segura pergunta fora do script.
   llm_answer SEMPRE tem duas saídas: edge label "ok" → (ask "mais alguma coisa?" da regra 10),
   edge label "erro" → handoff (fallback humano se a IA não souber responder). Preencha "context"
   do llm_answer com os fatos que JÁ apareceram na conversa/briefing (horário, preço, política,
   diferenciais) — nunca invente fato que não foi dito; se nada foi dito, deixe "context" como
   string vazia mesmo assim (o nó continua funcionando via base de conhecimento em tempo real,
   não depende só do "context").
5. NÃO use condition nem action.
6. NÓ linear (trigger, message, ask, handoff, end) tem no máximo 1 saída. llm_answer tem exatamente
   as duas saídas descritas acima, nunca mais que isso.
7. NÃO ligue um ramo no outro. Única exceção: o ask de "mais alguma coisa?" da regra 10 SEMPRE liga
   de volta pro llm_intent (nunca pra outro lugar).
8. Máximo 14 nós e 4 intents (já contando o ramo de encerramento da regra 10).
9. O ask de nome da regra 1 é OBRIGATÓRIO em TODO fluxo gerado — nunca opcional, nunca "se fizer
   sentido". Logo após a mensagem de boas-vindas, sempre pergunte o nome (ex.: "Antes de
   continuar, qual o seu nome?"), com "varName":"nome", antes do llm_intent. Em
   mensagens/perguntas/handoffs seguintes, salpique {{name_greet}} colado à saudação (ex.:
   "Olá{{name_greet}}! 👋") — NUNCA escreva {{nome}} cru; {{name_greet}} já vira ", Nome" ou fica
   vazio se ainda não souber.
10. NUNCA encerre um ramo de forma abrupta (regra 3/4 já exigem isso). O mecanismo: um ask com
    "text" tipo "Posso te ajudar com mais alguma coisa?", varName livre (ex. "mais_algo") e
    "capturesIntent": true — esse ask SEMPRE liga de volta pro llm_intent (regra 7), nunca pra
    outro nó. Pra essa volta poder de fato terminar a conversa, o llm_intent precisa ter uma
    intenção reservada de encerramento (ex. slug "encerrar", description "não precisa de mais
    nada, quer encerrar ou agradecer") cujo edge vai pra uma message curta de despedida (ex.
    "Foi um prazer ajudar! Até mais 👋") e SÓ DEPOIS pro "end" — nunca ligue o encerramento direto
    no "end" sem essa despedida, senão a conversa também termina em silêncio.
Textos em português, naturais, prontos para WhatsApp (*negrito* ok).`;

const COL_W = 300;
const ROW_H = 175;
const ORIGIN_X = 70;
const ORIGIN_Y = 48;

export function layoutFlow(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  if (!nodes.length) return nodes;
  const children = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    if (!children.get(e.from)!.includes(e.to)) children.get(e.from)!.push(e.to);
    incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
  }
  const root =
    nodes.find((n) => n.type === "trigger") ||
    nodes.find((n) => (incoming.get(n.id) || 0) === 0) ||
    nodes[0];

  const depth = new Map<string, number>();
  const col = new Map<string, number>();
  const seen = new Set<string>();

  function walk(id: string, d: number, c: number) {
    if (seen.has(id)) {
      if ((depth.get(id) ?? 99) > d) depth.set(id, d);
      return;
    }
    seen.add(id);
    depth.set(id, d);
    col.set(id, c);
    const kids = children.get(id) || [];
    if (kids.length === 0) return;
    if (kids.length === 1) {
      walk(kids[0], d + 1, c);
      return;
    }
    const start = c - Math.floor((kids.length - 1) / 2);
    kids.forEach((kid, i) => walk(kid, d + 1, start + i));
  }
  walk(root.id, 0, 0);

  let orphan = Math.max(0, ...col.values()) + 2;
  for (const n of nodes) {
    if (!seen.has(n.id)) {
      depth.set(n.id, 0);
      col.set(n.id, orphan++);
    }
  }
  const minC = Math.min(...col.values());
  return nodes.map((n) => ({
    ...n,
    x: ORIGIN_X + ((col.get(n.id) ?? 0) - minC) * COL_W,
    y: ORIGIN_Y + (depth.get(n.id) ?? 0) * ROW_H,
  }));
}

/**
 * Converte um nó bruto (formato que a LLM devolve) num FlowNode de verdade —
 * mesmo shape que defaultData() da UI do builder usa por tipo (flows.js).
 * Reaproveitado tanto pra geração do zero (generateFlowFromPrompt) quanto pra
 * edição de um fluxo existente (edit-flow.ts) — um só lugar decidindo o que
 * cada tipo de nó "tem" evita os dois caminhos divergirem sobre o que é um
 * llm_answer/llm_intent válido. x/y ficam 0 — quem chama decide posição
 * (layoutFlow do zero, ou preservar/posicionar pontualmente numa edição).
 */
/**
 * Jargão que nunca é nome de card, além dos nomes de tipo. Só termos que o
 * dono jamais escreveria sozinhos como nome — "llm" apareceu num fluxo real
 * depois do primeiro fix, que só barrava o nome exato do tipo.
 */
const TECH_LABELS = new Set(["llm", "ia", "ai", "node", "step", "nodo"]);

/**
 * Nome do card, descartando o nome TÉCNICO do tipo.
 *
 * A LLM às vezes preenche o `text` de um trigger/llm_answer com jargão do
 * sistema ("trigger", "llm_answer", "llm"), e esse texto vira o título do
 * card na tela (nodeTitle, flows.js) — o dono via "llm_answer" e "llm" no
 * meio de cards chamados "Mensagem recebida" e "Responder com IA". Nada disso
 * é nome de card válido, então cai no padrão em vez de aceitar. Cobre as
 * variações que a LLM produz ("LLM Answer", "llm-answer", maiúsculas).
 */
function labelOr(text: string | undefined, fallback: string): string {
  const raw = (text || "").trim();
  if (!raw) return fallback;
  const canon = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return KNOWN_NODE_TYPES.has(canon) || TECH_LABELS.has(canon) ? fallback : raw;
}

export function materializeNode(n: RawFlowNode, i: number): FlowNode {
  const id = String(n.id || `n_${i + 1}`);
  const type = (n.type || "message") as FlowNode["type"];
  const data: Record<string, unknown> = {};
  if (type === "message" || type === "handoff") data[type === "handoff" ? "message" : "text"] = n.text || "";
  if (type === "ask") {
    data.prompt = n.text || "Pode me dizer?";
    data.varName = n.varName || "resposta";
    if (n.capturesIntent) data.capturesIntent = true;
  }
  if (type === "llm_intent") {
    data.label = labelOr(n.text, "Entender o pedido");
    data.intents = n.intents || [];
  }
  if (type === "llm_answer") {
    data.label = labelOr(n.text, "Responder com IA");
    data.context = n.context || "";
    data.varName = n.varName || "resposta_ia";
    data.maxChars = 400;
  }
  if (type === "trigger") data.label = labelOr(n.text, "Mensagem recebida");
  if (type === "end") data.label = labelOr(n.text, "Fim");
  if (type === "action") data.label = labelOr(n.text, "Ação");
  if (type === "condition") data.field = "last";
  return { id, type, x: 0, y: 0, data };
}

/** Tipos de nó que o gerador/editor por LLM sabe autorar — mesmo enum dos
 * SYSTEM prompts. Usado como rede de segurança final antes de aceitar
 * qualquer nó vindo da LLM no canvas. */
export const KNOWN_NODE_TYPES = new Set([
  "trigger",
  "message",
  "ask",
  "llm_intent",
  "llm_answer",
  "handoff",
  "end",
  "action",
  "condition",
]);

/** Cria o nó llm_answer padrão do reparo, com id que não colide. */
function makeAnswerNode(nodes: FlowNode[]): FlowNode {
  const usedIds = new Set(nodes.map((n) => n.id));
  let id = "n_faq";
  let i = 2;
  while (usedIds.has(id)) id = `n_faq${i++}`;
  return {
    id,
    type: "llm_answer",
    x: 0,
    y: 0,
    data: { label: "Responder com IA", context: "", varName: "resposta_ia", maxChars: 400 },
  };
}

/**
 * Reparo para fluxo SEM llm_intent (típico do modo simples): insere o
 * llm_answer em linha logo após o trigger, reaproveitando o destino que o
 * trigger já tinha como saída "ok". "erro" vai pro handoff se houver, senão
 * pro mesmo destino — nunca deixa a saída solta.
 */
function insertLlmAnswerInline(
  nodes: FlowNode[],
  edges: FlowEdge[]
): { nodes: FlowNode[]; edges: FlowEdge[]; repaired: boolean } {
  const trigger = nodes.find((n) => n.type === "trigger");
  if (!trigger) return { nodes, edges, repaired: false };

  const answer = makeAnswerNode(nodes);
  const fromTrigger = edges.find((e) => e.from === trigger.id);
  const anEnd = nodes.find((n) => n.type === "end");
  const aHandoff = nodes.find((n) => n.type === "handoff");
  const okTarget = fromTrigger?.to || anEnd?.id || null;
  const errTarget = aHandoff?.id || okTarget;

  // O trigger passa a apontar pro llm_answer; o que vinha depois dele vira o
  // destino da saída "ok" — o resto do fluxo continua intacto.
  const nextEdges = edges.filter((e) => e !== fromTrigger);
  nextEdges.push({ id: "e_faq_in", from: trigger.id, to: answer.id });
  if (okTarget) nextEdges.push({ id: "e_faq_ok", from: answer.id, to: okTarget, label: "ok" });
  if (errTarget) nextEdges.push({ id: "e_faq_err", from: answer.id, to: errTarget, label: "erro" });

  return { nodes: [...nodes, answer], edges: nextEdges, repaired: true };
}

/**
 * Garantia estrutural: todo fluxo gerado SAI com pelo menos um llm_answer.
 *
 * Por que existe, e por que em código e não só no prompt: esse card já ficou
 * de fora de fluxos gerados duas vezes (o mesmo erro primário reincidindo).
 * Prompt é probabilístico — quanto mais regras, mais fácil uma se perder,
 * ainda mais trocando de modelo. Aqui é determinístico: se faltou, a gente
 * põe. É o card que responde pela base de conhecimento coletada no
 * onboarding e o que evita resposta evasiva (saída "erro" → atendente).
 *
 * Só ACRESCENTA um ramo novo no llm_intent — nunca mexe nos ramos que o
 * modelo criou, pra não desmontar um fluxo que no resto está correto.
 * O `context` sai vazio (não temos como inventar fatos aqui), e tudo bem: o
 * nó funciona via RAG em tempo de execução, que não depende do context.
 */
/**
 * Garante que todo llm_answer tenha as DUAS saídas — "ok" e "erro".
 *
 * A regra 4 dos dois prompts já exige isso, mas prompt não garante nada: um
 * fluxo simples real nasceu com trigger → llm_answer --erro--> handoff e mais
 * nada. Como era a única saída, o motor a seguia mesmo quando a IA respondia
 * BEM — o cliente recebia a resposta e era passado pra um humano em seguida,
 * sem chance de continuar conversando com a IA. Era o card mais importante do
 * fluxo virando um desvio pro atendente.
 *
 * "erro" faltando vira handoff (a rede de segurança de quando a IA não sabe).
 * "ok" faltando vira end — e end aqui é o certo, não um beco: o motor
 * reinicia pelo trigger na mensagem seguinte (ver "reentrada após end" em
 * engine.ts), então o cliente pergunta de novo e é atendido de novo. Fechar
 * o atendimento e reabrir na próxima pergunta é o comportamento natural de um
 * fluxo de dúvidas, e não corre risco de laço dentro do mesmo turno.
 */
export function ensureAnswerBranches(
  nodes: FlowNode[],
  edges: FlowEdge[]
): { nodes: FlowNode[]; edges: FlowEdge[]; repaired: string[] } {
  const answers = nodes.filter((n) => n.type === "llm_answer");
  if (!answers.length) return { nodes, edges, repaired: [] };

  const outNodes = [...nodes];
  const outEdges = [...edges];
  const repaired: string[] = [];
  const usedIds = new Set(nodes.map((n) => n.id));
  const freshId = (base: string) => {
    let id = base;
    let i = 2;
    while (usedIds.has(id)) id = `${base}${i++}`;
    usedIds.add(id);
    return id;
  };
  // Reaproveita um destino que já exista antes de criar card novo: o teto de
  // cards do fluxo simples é apertado, e um handoff/end a mais por reparo
  // estouraria à toa.
  const reuse = (type: "handoff" | "end") => {
    const found = outNodes.find((n) => n.type === type);
    if (found) return found.id;
    const id = freshId(type === "handoff" ? "n_handoff" : "n_end");
    outNodes.push({
      id,
      type,
      x: 0,
      y: 0,
      data:
        type === "handoff"
          ? { message: "Vou chamar alguém da equipe pra te ajudar." }
          : { label: "Fim" },
    });
    return id;
  };

  for (const answer of answers) {
    const out = outEdges.filter((e) => e.from === answer.id);
    for (const branch of ["ok", "erro"] as const) {
      if (out.some((e) => (e.label || "") === branch)) continue;
      const to = reuse(branch === "erro" ? "handoff" : "end");
      outEdges.push({ id: `e_${answer.id}_${branch}`, from: answer.id, to, label: branch });
      repaired.push(`${answer.id}:${branch}`);
    }
  }
  return { nodes: outNodes, edges: outEdges, repaired };
}

export function ensureLlmAnswer(nodes: FlowNode[], edges: FlowEdge[]): {
  nodes: FlowNode[];
  edges: FlowEdge[];
  repaired: boolean;
} {
  if (nodes.some((n) => n.type === "llm_answer")) {
    return { nodes, edges, repaired: false };
  }
  const intent = nodes.find((n) => n.type === "llm_intent");
  // Sem llm_intent (caso normal no fluxo simples, que não ramifica por
  // intenção) o reparo entra em LINHA, logo depois do trigger, em vez de
  // pendurar um ramo. Antes essa situação fazia a garantia desistir — e um
  // fluxo simples sem llm_answer é exatamente o que ela existe pra impedir.
  if (!intent) return insertLlmAnswerInline(nodes, edges);

  const usedIds = new Set(nodes.map((n) => n.id));
  let answerId = "n_faq";
  let i = 2;
  while (usedIds.has(answerId)) answerId = `n_faq${i++}`;

  const slugs = new Set(
    ((intent.data.intents as { slug?: string }[] | undefined) || []).map((x) => String(x.slug || ""))
  );
  let slug = "duvida";
  let k = 2;
  while (slugs.has(slug)) slug = `duvida${k++}`;

  const answer: FlowNode = {
    id: answerId,
    type: "llm_answer",
    x: 0,
    y: 0,
    data: {
      label: "Responder com IA",
      context: "",
      varName: "resposta_ia",
      maxChars: 400,
    },
  };

  // "ok" cai no ask de "mais alguma coisa?" quando ele existe (mantém o
  // padrão de não encerrar seco); senão, no primeiro end. "erro" vai pro
  // handoff — é o fallback humano que dá sentido ao card.
  const backAsk = nodes.find((n) => n.type === "ask" && n.data.capturesIntent === true);
  const anEnd = nodes.find((n) => n.type === "end");
  const aHandoff = nodes.find((n) => n.type === "handoff");
  const okTarget = backAsk?.id || anEnd?.id || null;
  const errTarget = aHandoff?.id || okTarget;

  const nextNodes = [...nodes, answer];
  const nextEdges: FlowEdge[] = [
    ...edges,
    { id: `e_faq_in`, from: intent.id, to: answerId, label: slug },
  ];
  if (okTarget) nextEdges.push({ id: `e_faq_ok`, from: answerId, to: okTarget, label: "ok" });
  if (errTarget) nextEdges.push({ id: `e_faq_err`, from: answerId, to: errTarget, label: "erro" });

  intent.data.intents = [
    ...((intent.data.intents as unknown[] | undefined) || []),
    { slug, description: "tem uma dúvida ou quer informação sobre o negócio" },
  ];

  return { nodes: nextNodes, edges: nextEdges, repaired: true };
}

export function sanitizeEdges(nodes: FlowNode[], edges: FlowEdge[]): FlowEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const seen = new Set<string>();
  const outCount = new Map<string, number>();
  const out: FlowEdge[] = [];
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const key = `${e.from}->${e.to}:${e.label || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = typeOf.get(e.from);
    const n = (outCount.get(e.from) || 0) + 1;
    if (t !== "llm_intent" && t !== "condition" && t !== "llm_answer" && n > 1) continue;
    outCount.set(e.from, n);
    out.push({
      id: e.id || `e_${out.length}`,
      from: e.from,
      to: e.to,
      label: e.label || undefined,
    });
  }
  return out;
}

export async function generateFlowFromPrompt(
  prompt: string,
  mode: FlowBuildMode = "completo"
): Promise<GeneratedFlow> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");
  const simples = mode === "simples";
  const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.3,
      // O simples cabe em muito menos: no máximo 5 cards contra 14.
      max_tokens: simples ? 1200 : 3200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: simples ? SYSTEM_SIMPLES : SYSTEM },
        { role: "user", content: prompt.slice(0, 4000) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Grok HTTP ${res.status}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content || "";
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(jsonText) as {
    name?: string;
    nodes?: RawFlowNode[];
    edges?: RawFlowEdge[];
  };
  if (!parsed.nodes?.length) throw new Error("A IA não devolveu um fluxo válido.");

  const nodes: FlowNode[] = parsed.nodes
    .map((n, i) => materializeNode(n, i))
    .filter((n) => KNOWN_NODE_TYPES.has(n.type));

  const edges = sanitizeEdges(
    nodes,
    (parsed.edges || []).map((e, i) => ({
      id: `e_${i}`,
      from: String(e.from || ""),
      to: String(e.to || ""),
      label: e.label || undefined,
    }))
  );

  // Rede de segurança determinística: o prompt (regra 4) exige llm_answer,
  // mas prompt não garante nada — esse card já ficou de fora duas vezes.
  const guaranteed = ensureLlmAnswer(nodes, edges);
  if (guaranteed.repaired) {
    console.warn(
      "[from-prompt] fluxo veio sem llm_answer — ramo de dúvida adicionado automaticamente"
    );
  }
  // sanitizeEdges de novo: as edges novas precisam passar pelas mesmas
  // regras (llm_answer com 2 saídas, sem duplicata) que as do modelo.
  // Segunda garantia: llm_answer com as duas saídas. Roda DEPOIS da primeira,
  // que pode acabar de criar o card.
  const branched = ensureAnswerBranches(guaranteed.nodes, guaranteed.edges);
  if (branched.repaired.length) {
    console.warn(
      `[from-prompt] llm_answer sem saída completa — reparado: ${branched.repaired.join(", ")}`
    );
  }
  const finalEdges =
    guaranteed.repaired || branched.repaired.length
      ? sanitizeEdges(branched.nodes, branched.edges)
      : edges;

  // Teto de tamanho: o prompt pede no máximo 5 (simples) ou 14 (completo)
  // nós, mas isso é instrução — o modelo estourou na prática (fluxo com 15+
  // cards reportado pelo usuário em 27/08). Não dá pra podar sem quebrar o
  // grafo, então aqui só REGISTRA: o dono continua com o fluxo que a IA fez,
  // e a gente fica sabendo que o teto não está sendo respeitado.
  const cap = simples ? MAX_NODES_SIMPLES : MAX_NODES_COMPLETO;
  if (branched.nodes.length > cap) {
    console.warn(
      `[from-prompt] fluxo ${mode} veio com ${branched.nodes.length} nós (teto do prompt: ${cap})`
    );
  }

  return {
    name: parsed.name?.trim() || "Atendimento",
    nodes: layoutFlow(branched.nodes, finalEdges),
    edges: finalEdges,
  };
}
