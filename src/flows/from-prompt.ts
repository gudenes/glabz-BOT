import { randomUUID } from "node:crypto";
import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import type { FlowEdge, FlowNode } from "./types.js";

export type GeneratedFlow = {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

const SYSTEM = `Você monta fluxos de atendimento WhatsApp.
Responda APENAS um JSON válido, sem markdown, neste formato:
{
  "name": "nome curto do fluxo",
  "nodes": [
    { "id": "n1", "type": "trigger|message|ask|llm_intent|handoff|end|condition|action", "text": "texto visível", "varName": "opcional", "intents": [{"slug":"marcar","description":"quer agendar"}] }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "marcar" }
  ]
}
Regras:
- Comece com um trigger e uma message de boas-vindas.
- Se houver mais de um pedido possível, use llm_intent com intents e edges com label = slug.
- Use ask para guardar resposta (varName em snake_case).
- Use handoff quando precisar de humano.
- Termine ramos com end ou handoff.
- Textos em português, naturais, prontos para WhatsApp (*negrito* permitido).
- No máximo 14 nós.`;

function layout(nodes: FlowNode[]): FlowNode[] {
  const cols = new Map<string, number>();
  let col = 0;
  for (const n of nodes) {
    if (n.type === "llm_intent") col = 0;
    const c = n.type === "llm_intent" || n.type === "trigger" || n.type === "message" && col === 0 ? 1 : col++;
    cols.set(n.id, Math.min(c, 3));
  }
  return nodes.map((n, i) => ({
    ...n,
    x: 80 + (i % 3) * 260,
    y: 40 + Math.floor(i / 3) * 150,
  }));
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
      temperature: 0.4,
      max_tokens: 2500,
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

  const ids = new Set(nodes.map((n) => n.id));
  const edges: FlowEdge[] = (parsed.edges || [])
    .filter((e) => e.from && e.to && ids.has(e.from) && ids.has(e.to))
    .map((e, i) => ({
      id: `e_${i}`,
      from: String(e.from),
      to: String(e.to),
      label: e.label || undefined,
    }));

  return {
    name: parsed.name?.trim() || "Atendimento",
    nodes: layout(nodes),
    edges,
  };
}
