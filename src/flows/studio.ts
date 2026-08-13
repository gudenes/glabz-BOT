import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import { generateFlowFromPrompt, type GeneratedFlow } from "./from-prompt.js";

export type StudioMsg = { role: "user" | "assistant"; content: string };
export type StudioPhase = "ask" | "preview" | "ready";
export type StudioTurn = {
  phase: StudioPhase;
  as: "coach" | "bot";
  say: string;
};

const SYSTEM = `Você é o coach da GLABZ. Ajuda o dono a DEFINIR o atendimento — isto NÃO é o bot no ar.

Responda APENAS um JSON válido, sem markdown:
{
  "phase": "ask" | "preview" | "ready",
  "as": "coach" | "bot",
  "say": "texto curto em português"
}

Fases:
1. ask — as=coach. Conversa de briefing. UMA pergunta por vez. Descubra: o que o negócio faz, o que o cliente pode pedir, o que coletar, quando passar para humano. Se o usuário responder como se fosse cliente (horário, "segunda", "quero marcar"), NÃO continue o atendimento: avise que isso ainda é um ensaio e volte à pergunta de briefing.
2. preview — só DEPOIS de saber o essencial. as=bot. UM único exemplo curto de como o bot cumprimentaria. Não leve a conversa até o fim (não marque horário, não feche pedido). No máximo 1 turno de preview.
3. ready — quando já der para desenhar o fluxo (negócio + pedidos + o que coletar). as=coach. say deve ser exatamente no espírito: "Ótimo — já dá para montar o fluxo. Vamos revisar?" Sem mais perguntas.

Regras:
- Nunca finja que o WhatsApp já está funcionando.
- Nunca descreva nós, JSON, canvas ou arquitetura.
- Não invente integrações reais (calendário, RH, pagamento). Se o dono citar integração, anote e pergunte o que o bot deve DIZER enquanto isso não existe.
- say: no máximo 3 frases.
- Se o usuário pedir para montar/criar o fluxo: phase=ready.`;

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
      temperature: 0.4,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, ...history],
    }),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content || "";
  return parseTurn(raw);
}

function parseTurn(raw: string): StudioTurn {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { phase?: string; as?: string; say?: string };
    const phase: StudioPhase =
      parsed.phase === "preview" || parsed.phase === "simulate"
        ? "preview"
        : parsed.phase === "ready"
          ? "ready"
          : "ask";
    const as: "coach" | "bot" = parsed.as === "bot" || phase === "preview" ? "bot" : "coach";
    const say = String(parsed.say || "").trim();
    if (say) return { phase, as, say };
  } catch {
    /* Grok às vezes devolve prosa — não quebra o chat */
  }
  const say = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (!say) throw new Error("A IA não devolveu uma resposta.");
  return { phase: "ask", as: "coach", say };
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
