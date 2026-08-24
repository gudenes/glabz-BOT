/**
 * Extrai conhecimento reaproveitável pra Base de Conhecimento, a partir de
 * duas fontes possíveis:
 * - uma conversa do Studio (onboarding) já encerrada — nada do que o dono
 *   conta ali (horário, política de troca, diferencial) virava conhecimento
 *   antes disso, se perdia assim que a conversa acabava;
 * - um texto solto que o dono cola (site, cardápio, política em PDF/texto,
 *   mensagem padrão que já manda no WhatsApp) — mais barato e mais completo
 *   que depender só de uma conversa rasa, sem risco de ToS de scraping.
 *
 * As duas funções aqui só SUGEREM pares pergunta→resposta — nunca gravam
 * sozinhas: quem chama decide se salva (ver POST /v1/rag/teach-batch),
 * depois de o dono revisar/editar (nunca é automático, ver docs/rag-desenho.md
 * §5.2 — dado ruim virando "verdade" repetida com confiança é o risco que essa
 * revisão existe pra evitar).
 */
import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import { clientContextBlock, type ClientContext, type StudioMsg } from "../flows/studio.js";

export type CandidatePair = { question: string; answer: string };

const EXTRACT_SYSTEM = `Você lê uma conversa entre um coach e o dono de um negócio sobre como o
WhatsApp dele deve atender. Extraia pares pergunta→resposta REAPROVEITÁVEIS como base de
conhecimento pra uma IA responder CLIENTES FINAIS no WhatsApp.

Regras:
- A pergunta deve ser reescrita do ponto de vista de um CLIENTE FINAL perguntando no WhatsApp —
  nunca a pergunta que o coach fez pro dono.
- A resposta vale só o que o dono efetivamente disse. Nunca invente fato, horário, preço ou
  política que não foi dito.
- Ignore falas de ensaio (o dono fingindo ser cliente) e conteúdo só sobre construção do fluxo em
  si (nomes de nó, "monta o fluxo", etc.) — isso não é conhecimento de atendimento.
- Se não houver nada reaproveitável, devolva lista vazia. Não invente pares pra preencher.
- Máximo 8 pares.

Responda APENAS um JSON: {"pairs":[{"question":"...","answer":"..."}]}`;

function extractJson(raw: string): string {
  const trimmed = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export async function extractKnowledgeFromConversation(
  messages: StudioMsg[],
  ctx?: ClientContext | null
): Promise<CandidatePair[]> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");

  const history = messages.slice(-30).map((m) => ({
    role: m.role,
    content: m.content.slice(0, 2000),
  }));
  if (!history.length) return [];

  const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "system", content: clientContextBlock(ctx) },
        ...history,
      ],
    }),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content || "";
  return parsePairs(raw);
}

const EXTRACT_FROM_TEXT_SYSTEM = `Você lê um texto solto que o dono de um negócio colou — pode ser
o "sobre nós" do site, um cardápio, uma política de trocas, uma mensagem padrão que ele já manda
no WhatsApp, etc. Extraia pares pergunta→resposta REAPROVEITÁVEIS como base de conhecimento pra
uma IA responder CLIENTES FINAIS no WhatsApp.

Regras:
- A pergunta deve ser escrita do ponto de vista de um CLIENTE FINAL perguntando no WhatsApp —
  o texto original pode não ter pergunta nenhuma (ex.: um cardápio), a pergunta é sua inferência
  do que aquele trecho responde.
- A resposta vale só o que o texto efetivamente diz. Nunca invente fato, horário, preço ou
  política que não está no texto.
- Ignore o que for só formatação/navegação do site (menu, rodapé, "clique aqui") — extraia só
  conteúdo informativo de verdade.
- Se não houver nada reaproveitável, devolva lista vazia. Não invente pares pra preencher.
- Máximo 15 pares (um texto colado tende a ter mais fatos que uma conversa curta).

Responda APENAS um JSON: {"pairs":[{"question":"...","answer":"..."}]}`;

export async function extractKnowledgeFromText(
  text: string,
  ctx?: ClientContext | null
): Promise<CandidatePair[]> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");

  const trimmed = text.trim().slice(0, 8000);
  if (trimmed.length < 20) return [];

  const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_FROM_TEXT_SYSTEM },
        { role: "system", content: clientContextBlock(ctx) },
        { role: "user", content: trimmed },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content || "";
  return parsePairs(raw, 15);
}

function parsePairs(raw: string, max = 8): CandidatePair[] {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { pairs?: unknown };
    if (!Array.isArray(parsed.pairs)) return [];
    return parsed.pairs
      .map((p) => {
        const q = String((p as { question?: unknown })?.question || "").trim();
        const a = String((p as { answer?: unknown })?.answer || "").trim();
        return { question: q, answer: a };
      })
      .filter((p) => p.question.length >= 3 && p.answer.length >= 3)
      .slice(0, max);
  } catch {
    // Grok às vezes devolve prosa — trata como "nada extraído" em vez de
    // quebrar a revisão (essa etapa nunca pode travar o onboarding).
    return [];
  }
}
