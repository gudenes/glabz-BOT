import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import type { FlowEdge, FlowNode } from "./types.js";
import {
  KNOWN_NODE_TYPES,
  materializeNode,
  sanitizeEdges,
  type RawFlowEdge,
  type RawFlowNode,
} from "./from-prompt.js";

export type EditResult = {
  /** Só os cards TOCADOS pela edição (novos ou com conteúdo alterado) — o
   * frontend faz merge por id em cima do que já tem, nunca substitui tudo. */
  nodes: FlowNode[];
  /** Lista COMPLETA de edges depois da edição — substituição total, não diff
   * (mais barato que reconciliar edge a edge e evita edge órfã). */
  edges: FlowEdge[];
  changedNodeIds: string[];
  /** Confirmação curta em português pra mostrar no chat do assistente. */
  say: string;
};

const COL_W = 300;
const ROW_H = 175;

// Mesma arquitetura obrigatória de generateFlowFromPrompt (from-prompt.ts) —
// duplicada de propósito em vez de interpolada: os dois prompts têm frames
// diferentes (montar do zero x editar o que já existe) e divergir um pouco
// no texto facilita manter cada um claro sozinho. Qualquer mudança na
// arquitetura de fluxo (novo tipo de nó, nova regra de ramo) precisa ser
// replicada aqui também.
const EDIT_SYSTEM = `Você edita um fluxo de atendimento WhatsApp da GLABZ que JÁ EXISTE. Você recebe
a lista NUMERADA dos cards atuais — o número é como o dono se refere a cada um (ex.: "card 2") — e
uma instrução em português pedindo uma mudança.

Responda APENAS um JSON válido, sem markdown:
{
  "say": "confirmação curta do que você fez (ou por que não deu), em português, pro dono ler no chat",
  "nodes": [
    { "id": "id exato de um card existente OU um id novo tipo n_novo1", "type": "trigger|message|ask|llm_intent|llm_answer|handoff|end", "text": "texto visível", "varName": "opcional", "context": "opcional, só pra llm_answer", "intents": [{"slug":"marcar","description":"quer agendar"}] }
  ],
  "edges": [
    { "from": "id", "to": "id", "label": "opcional" }
  ]
}

Regras:
1. Em "nodes", inclua APENAS os cards que você está de fato criando ou mudando o conteúdo — NUNCA
   liste um card que a instrução só mencionou de passagem sem pedir mudança nele.
2. Pra EDITAR um card existente, reuse o "id" EXATO dele (veio na lista numerada abaixo) — nunca
   invente um id novo pra um card que já existe.
3. Pra CRIAR um card novo, invente um id que não exista na lista (ex.: "n_novo1", "n_novo2").
4. Em "edges", devolva a lista COMPLETA de edges do fluxo DEPOIS da mudança, incluindo as que não
   mudaram — não é um diff.
5. Arquitetura obrigatória, mesma de sempre (tronco + ramos, sem cruzar):
   a. trigger → message (boas-vindas) → llm_intent → 2-3 ramos (edge do intent TEM label=slug).
   b. Cada ramo é uma linha reta pra baixo: ask? → message? → (handoff|end|llm_answer).
   c. Ramo de dúvida/pergunta geral (não ação estruturada) prefere terminar em llm_answer: edge
      "ok"→end, edge "erro"→handoff. Preencha "context" só com fatos já ditos, nunca invente.
   d. NÃO use condition nem action. NÃO ligue um ramo no outro nem faça atalho de volta ao intent.
   e. Nó linear tem no máximo 1 saída; llm_answer tem exatamente 2 (ok/erro).
   f. Máximo 10 cards e 3 intents no total, mesmo depois da edição.
6. Se a instrução referenciar um card que não existe na lista, pedir algo contraditório, ou for
   ambígua demais pra agir com segurança, NÃO invente uma interpretação — devolva "nodes":[],
   "edges": a MESMA lista de edges atual (repita de volta), e explique o problema em "say".
Textos em português, naturais, prontos para WhatsApp (*negrito* ok).`;

function nodeSummaryLine(n: FlowNode, i: number): string {
  const d = n.data || {};
  const label = String(d.label ?? d.text ?? d.prompt ?? d.message ?? d.context ?? "").slice(0, 90);
  return `${i + 1}. [${n.type}] id=${n.id} — ${label}`;
}

function edgeSummaryLine(e: FlowEdge, indexOf: Map<string, number>): string {
  const from = indexOf.has(e.from) ? `card${indexOf.get(e.from)! + 1}` : e.from;
  const to = indexOf.has(e.to) ? `card${indexOf.get(e.to)! + 1}` : e.to;
  return `${from}→${to}${e.label ? ` (${e.label})` : ""}`;
}

/**
 * Posiciona só os nós REALMENTE novos (id não existia no fluxo antes da
 * edição) — nunca mexe em x/y de nó existente, mesmo que o conteúdo dele
 * tenha mudado (preservar onde o dono arrastou o card é o ponto central de
 * não usar layoutFlow aqui, que reposicionaria TUDO). Heurística simples:
 * gruda embaixo do pai (via edge que aponta pra ele), com leve jitter
 * horizontal se mais de um card novo cair sob o mesmo pai; sem pai
 * identificável, cola à direita do que já existe.
 */
function positionNewNodes(
  patch: FlowNode[],
  originalById: Map<string, FlowNode>,
  rawEdges: RawFlowEdge[]
): void {
  const siblingCount = new Map<string, number>();
  const patchById = new Map(patch.map((n) => [n.id, n]));
  const rightmostX = Math.max(0, ...[...originalById.values()].map((n) => n.x));
  for (const n of patch) {
    if (originalById.has(n.id)) continue; // existente — x/y já herdado antes de chamar isto
    const parentEdge = rawEdges.find((e) => String(e.to || "") === n.id);
    const parentId = parentEdge ? String(parentEdge.from || "") : "";
    const parent = originalById.get(parentId) || patchById.get(parentId) || null;
    const siblingKey = parentId || "_root";
    const k = siblingCount.get(siblingKey) || 0;
    siblingCount.set(siblingKey, k + 1);
    if (parent) {
      n.x = parent.x + k * 40;
      n.y = parent.y + ROW_H;
    } else {
      n.x = rightmostX + COL_W;
      n.y = 48 + k * ROW_H;
    }
  }
}

function extractJson(raw: string): string {
  const trimmed = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export async function editFlowFromInstruction(input: {
  instruction: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}): Promise<EditResult> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");
  const instruction = (input.instruction || "").trim().slice(0, 1000);
  if (!instruction) throw new Error("Escreve o que você quer mudar.");
  if (!input.nodes?.length) throw new Error("Fluxo vazio — nada pra editar.");

  const indexOf = new Map(input.nodes.map((n, i) => [n.id, i]));
  const nodesSummary = input.nodes.map((n, i) => nodeSummaryLine(n, i)).join("\n");
  const edgesSummary = input.edges.map((e) => edgeSummaryLine(e, indexOf)).join("; ") || "(nenhuma)";
  const userMsg = `Cards atuais (numerados):\n${nodesSummary}\n\nLigações atuais:\n${edgesSummary}\n\nInstrução do dono: ${instruction}`;

  const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.2,
      max_tokens: 2600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EDIT_SYSTEM },
        { role: "user", content: userMsg.slice(0, 6000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content || "";
  let parsed: { say?: string; nodes?: RawFlowNode[]; edges?: RawFlowEdge[] };
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { nodes: [], edges: input.edges, changedNodeIds: [], say: "Não entendi — pode tentar de outro jeito?" };
  }

  const say = String(parsed.say || "Pronto.").slice(0, 500);
  if (!parsed.nodes?.length) {
    // A própria IA decidiu não mexer em nada (instrução ambígua/contraditória,
    // regra 6 do prompt) — devolve o "say" explicando, sem tocar no fluxo.
    return { nodes: [], edges: input.edges, changedNodeIds: [], say };
  }

  const originalById = new Map(input.nodes.map((n) => [n.id, n]));
  const patchNodes: FlowNode[] = parsed.nodes
    .map((n, i) => {
      const materialized = materializeNode(n, i);
      const original = n.id ? originalById.get(String(n.id)) : undefined;
      if (!original) return materialized; // card novo — posição decidida abaixo
      // Card existente: preserva x/y (nunca reposiciona por causa de uma
      // edição de conteúdo) e faz MERGE do data em vez de substituir por
      // inteiro — protege campos que materializeNode não conhece (ex.: um
      // action/condition editado manualmente no builder com config mais
      // rica do que o schema simplificado do gerador cobre).
      return { ...materialized, id: original.id, x: original.x, y: original.y, data: { ...original.data, ...materialized.data } };
    })
    .filter((n) => KNOWN_NODE_TYPES.has(n.type));

  positionNewNodes(patchNodes, originalById, parsed.edges || []);

  const mergedById = new Map(originalById);
  for (const n of patchNodes) mergedById.set(n.id, n);
  const mergedNodes = [...mergedById.values()];

  const rawEdgesForSanitize = (parsed.edges || []).map((e, i) => ({
    id: `e_${i}`,
    from: String(e.from || ""),
    to: String(e.to || ""),
    label: e.label || undefined,
  }));
  const edges = sanitizeEdges(mergedNodes, rawEdgesForSanitize);

  return { nodes: patchNodes, edges, changedNodeIds: patchNodes.map((n) => n.id), say };
}
