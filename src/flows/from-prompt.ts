import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import type { FlowEdge, FlowNode } from "./types.js";

export type GeneratedFlow = {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

const SYSTEM = `Você monta fluxos de atendimento WhatsApp da GLABZ.
Responda APENAS um JSON válido, sem markdown:
{
  "name": "nome curto do fluxo",
  "nodes": [
    { "id": "n1", "type": "trigger|message|ask|llm_intent|handoff|end", "text": "texto visível", "varName": "opcional", "intents": [{"slug":"marcar","description":"quer agendar"}] }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "marcar" }
  ]
}

Arquitetura obrigatória (tronco + ramos, sem cruzar):
1. trigger → message (boas-vindas) → llm_intent
2. Do llm_intent saem 2 ou 3 ramos, um por intenção. Cada edge do intent TEM label = slug.
3. Cada ramo é uma linha reta para baixo: ask? → message? → (handoff|end)
4. NÃO use condition nem action.
5. NÓ linear (trigger, message, ask, handoff, end) tem no máximo 1 saída.
6. NÃO ligue um ramo no outro. NÃO faça atalho de volta ao intent.
7. Máximo 10 nós e 3 intents.
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
    if (t !== "llm_intent" && t !== "condition" && n > 1) continue;
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
      max_tokens: 2200,
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
    nodes?: Array<{
      id?: string;
      type?: string;
      text?: string;
      varName?: string;
      intents?: { slug: string; description: string }[];
    }>;
    edges?: Array<{ from?: string; to?: string; label?: string }>;
  };
  if (!parsed.nodes?.length) throw new Error("A IA não devolveu um fluxo válido.");

  const nodes: FlowNode[] = parsed.nodes.map((n, i) => {
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
    if (type === "trigger") data.label = n.text || "Mensagem recebida";
    if (type === "end") data.label = n.text || "Fim";
    if (type === "action") data.label = n.text || "Ação";
    if (type === "condition") data.field = "last";
    return { id, type, x: 0, y: 0, data };
  });

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
