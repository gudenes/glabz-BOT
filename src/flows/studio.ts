import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import { generateFlowFromPrompt, type GeneratedFlow } from "./from-prompt.js";

export type StudioMsg = { role: "user" | "assistant"; content: string };
export type StudioPhase = "ask" | "simulate" | "ready";
export type StudioTurn = {
  phase: StudioPhase;
  as: "coach" | "bot";
  say: string;
};

const SYSTEM = `Você ajuda o dono de um negócio a desenhar o atendimento de WhatsApp da GLABZ.

Responda APENAS um JSON válido, sem markdown:
{
  "phase": "ask" | "simulate" | "ready",
  "as": "coach" | "bot",
  "say": "texto curto em português"
}

Fases:
1. ask — você é o coach (as=coach). Faça UMA pergunta de cada vez. Descubra: o que o negócio faz, o que o cliente pode pedir, o que coletar, quando passar para um humano. Sem jargão de fluxo, nós ou canvas.
2. simulate — quando já der para atender, mude para phase=simulate e as=bot. Aí você É o bot do WhatsApp do negócio. Mensagens curtas, naturais, *negrito* permitido. O usuário fala como se fosse o cliente.
3. ready — depois de pelo menos 2 turnos de simulação, ou se o usuário pedir para montar/criar o fluxo. as=bot ou coach. No say, confirme o tom e diga que pode montar o fluxo.

Regras:
- Nunca descreva nós, JSON, canvas ou arquitetura.
- Na simulação, invente horários/exemplos se precisar — não invente integrações reais.
- say: no máximo 4 frases curtas.
- Se o usuário pedir mudança ("pergunta o nome primeiro"), continue em simulate com o ajuste.
- Se o usuário disser que está bom, pode montar, cria o fluxo, fecha: phase=ready.`;

function extractJson(raw: string): string {
  const trimmed = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export async function studioTurn(messages: StudioMsg[]): Promise<StudioTurn> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");

  const history = messages.slice(-16).map((m) => ({
    role: m.role,
    content: m.content.slice(0, 2000),
  }));

  const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.5,
      max_tokens: 500,
      messages: [{ role: "system", content: SYSTEM }, ...history],
    }),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(extractJson(raw)) as Partial<StudioTurn>;
  const phase: StudioPhase =
    parsed.phase === "simulate" || parsed.phase === "ready" ? parsed.phase : "ask";
  const as: "coach" | "bot" =
    parsed.as === "bot" || phase === "simulate" ? "bot" : "coach";
  const say = String(parsed.say || "").trim();
  if (!say) throw new Error("A IA não devolveu uma resposta.");
  return { phase, as, say };
}

export function wantsBuild(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(não|nao|ainda não|ainda nao|espera|calma|muda|troca)\b/.test(t)) return false;
  return /\b(montar o fluxo|pode montar|monta o fluxo|cria o fluxo|criar o fluxo|pode criar o fluxo)\b/.test(
    t
  );
}

export function briefFromMessages(messages: StudioMsg[]): string {
  const lines = messages
    .map((m) => (m.role === "user" ? `Dono: ${m.content}` : `Assistente: ${m.content}`))
    .join("\n");
  return `Com base nesta conversa com o dono do negócio, monte o fluxo de WhatsApp fiel ao tom e aos passos combinados (incluindo a simulação).\n\n${lines}`;
}

export async function buildFlowFromStudio(messages: StudioMsg[]): Promise<GeneratedFlow> {
  return generateFlowFromPrompt(briefFromMessages(messages).slice(0, 6000));
}
