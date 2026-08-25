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
};

export type RawFlowEdge = { from?: string; to?: string; label?: string };

const SYSTEM = `Você monta fluxos de atendimento WhatsApp da GLABZ.
Responda APENAS um JSON válido, sem markdown:
{
  "name": "nome curto do fluxo",
  "nodes": [
    { "id": "n1", "type": "trigger|message|ask|llm_intent|llm_answer|handoff|end", "text": "texto visível", "varName": "opcional", "context": "opcional, só pra llm_answer", "intents": [{"slug":"marcar","description":"quer agendar"}] }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "marcar" }
  ]
}

Arquitetura obrigatória (tronco + ramos, sem cruzar):
1. trigger → message (boas-vindas) → llm_intent
2. Do llm_intent saem 2 ou 3 ramos, um por intenção. Cada edge do intent TEM label = slug.
3. Cada ramo é uma linha reta para baixo: ask? → message? → (handoff|end|llm_answer).
4. Se o ramo for uma DÚVIDA/pergunta geral sobre o negócio (não uma ação estruturada tipo
   marcar/cancelar/comprar), prefira terminar o ramo em llm_answer em vez de ir direto pro
   handoff — é exatamente pra isso que esse nó existe. llm_answer SEMPRE tem duas saídas: edge
   label "ok" → end, edge label "erro" → handoff (fallback humano se a IA não souber responder).
   Preencha "context" do llm_answer com os fatos que JÁ apareceram na conversa/briefing (horário,
   preço, política, diferenciais) — nunca invente fato que não foi dito; se nada foi dito, deixe
   "context" como string vazia mesmo assim (o nó continua funcionando via base de conhecimento em
   tempo real, não depende só do "context").
5. NÃO use condition nem action.
6. NÓ linear (trigger, message, ask, handoff, end) tem no máximo 1 saída. llm_answer tem exatamente
   as duas saídas descritas acima, nunca mais que isso.
7. NÃO ligue um ramo no outro. NÃO faça atalho de volta ao intent.
8. Máximo 10 nós e 3 intents.
9. Se fizer sentido capturar o nome de quem está conversando, use um ask cedo no tronco (antes do
   llm_intent, comum a todos os ramos) com "varName":"nome". Em mensagens/perguntas/handoffs
   seguintes, salpique {{name_greet}} colado à saudação (ex.: "Olá{{name_greet}}! 👋") — NUNCA
   escreva {{nome}} cru; {{name_greet}} já vira ", Nome" ou fica vazio se ainda não souber.
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
export function materializeNode(n: RawFlowNode, i: number): FlowNode {
  const id = String(n.id || `n_${i + 1}`);
  const type = (n.type || "message") as FlowNode["type"];
  const data: Record<string, unknown> = {};
  if (type === "message" || type === "handoff") data[type === "handoff" ? "message" : "text"] = n.text || "";
  if (type === "ask") {
    data.prompt = n.text || "Pode me dizer?";
    data.varName = n.varName || "resposta";
  }
  if (type === "llm_intent") {
    data.label = n.text || "Entender o pedido";
    data.intents = n.intents || [];
  }
  if (type === "llm_answer") {
    data.label = n.text || "Responder com IA";
    data.context = n.context || "";
    data.varName = n.varName || "resposta_ia";
    data.maxChars = 400;
  }
  if (type === "trigger") data.label = n.text || "Mensagem recebida";
  if (type === "end") data.label = n.text || "Fim";
  if (type === "action") data.label = n.text || "Ação";
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

export async function generateFlowFromPrompt(prompt: string): Promise<GeneratedFlow> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");
  const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.3,
      max_tokens: 2600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
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

  return {
    name: parsed.name?.trim() || "Atendimento",
    nodes: layoutFlow(nodes, edges),
    edges,
  };
}
