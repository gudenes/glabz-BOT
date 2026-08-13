import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import { generateFlowFromPrompt, type GeneratedFlow } from "./from-prompt.js";

export type StudioMsg = { role: "user" | "assistant"; content: string };
export type StudioPhase = "ask" | "offer" | "preview" | "debrief" | "ready";
export type StudioTurn = {
  phase: StudioPhase;
  as: "coach" | "bot";
  say: string;
};
export type ClientContext = {
  name?: string | null;
  about?: string | null;
};

export function clientContextBlock(ctx?: ClientContext | null): string {
  const name = ctx?.name?.trim();
  const about = ctx?.about?.trim();
  if (!name && !about) {
    return "Contexto do cliente: ainda não há nome cadastrado. Só pergunte o nome do negócio se o dono não deixar claro.";
  }
  const lines = ["Contexto JÁ cadastrado neste projeto — trate como fato, não pergunte de novo:"];
  if (name) lines.push(`- Nome do negócio: ${name}`);
  if (about) lines.push(`- Sobre: ${about}`);
  lines.push(
    "Se o nome já descreve o ramo (consultoria, pilates, clínica, escritório…), NÃO pergunte qual o serviço principal. Siga para o que falta: o que o cliente pede no WhatsApp, o que coletar, quando passar para humano."
  );
  return lines.join("\n");
}

const SYSTEM = `Você é o coach da GLABZ. Ajuda o dono a DEFINIR o atendimento. Isto NÃO é o bot no ar.

Responda APENAS um JSON:
{
  "phase": "ask" | "offer" | "preview" | "debrief" | "ready",
  "as": "coach" | "bot",
  "say": "texto curto em português"
}

Fases — siga esta ordem, sem pular:
1. ask — as=coach. Briefing. UMA pergunta por vez, SÓ do que ainda falta. Nunca pergunte nome do negócio ou serviço principal se o contexto do cliente já trouxer isso. Foque no que o cliente pede no WhatsApp, o que coletar e quando passar para humano.
2. offer — as=coach. Quando já souber o essencial, NÃO comece o ensaio. Diga no espírito: "Acho que já tenho tudo. Vamos testar agora?" e pare. Espere o dono confirmar.
3. preview — as=bot. Só depois do dono aceitar o teste. Você interpreta o BOT. O dono fala como CLIENTE. Mensagens dele NÃO são pedido de mudança no fluxo — continue o ensaio. Máximo 2 respostas do bot. Não feche pedido de verdade. Não invente integração real.
4. debrief — as=coach. Depois do ensaio (ou se o dono disser "para", "chega", "muda"). Volte a ser coach: "Isso era só o ensaio. Quer ajustar o tom ou monto o fluxo?" NÃO continue o papel de bot.
5. ready — as=coach. Só se o dono pedir para montar/criar o fluxo DEPOIS do ensaio. "Ótimo — montando o fluxo agora. Vamos revisar?"

Regras:
- Se o histórico já tem abertura do coach, NÃO cumprimente de novo. Vá direto à próxima pergunta ou ao conteúdo.
- Nunca trate fala de cliente no ensaio como alteração de briefing.
- Alteração de fluxo só na fase debrief/ask, quando o dono fala como dono.
- Nunca descreva nós, JSON ou canvas.
- say: no máximo 3 frases.`;

function extractJson(raw: string): string {
  const trimmed = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export async function studioTurn(
  messages: StudioMsg[],
  ctx?: ClientContext | null
): Promise<StudioTurn> {
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
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: clientContextBlock(ctx) },
        ...history,
      ],
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
    const phase = normalizePhase(parsed.phase);
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

function normalizePhase(raw?: string): StudioPhase {
  if (raw === "offer") return "offer";
  if (raw === "preview" || raw === "simulate") return "preview";
  if (raw === "debrief") return "debrief";
  if (raw === "ready") return "ready";
  return "ask";
}

export function wantsTest(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(vamos testar|pode testar|quero testar|testa agora|bora testar|sim,? vamos)\b/.test(t);
}

export function wantsBuild(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(não|nao|ainda não|ainda nao|espera|calma|muda|troca)\b/.test(t)) return false;
  return /\b(montar o fluxo|pode montar|monta o fluxo|cria o fluxo|criar o fluxo|pode criar o fluxo)\b/.test(
    t
  );
}

export function briefFromMessages(messages: StudioMsg[], ctx?: ClientContext | null): string {
  const lines = messages
    .map((m) => (m.role === "user" ? `Dono: ${m.content}` : `Assistente: ${m.content}`))
    .join("\n");
  return `${clientContextBlock(ctx)}\n\nCom base neste BRIEFING (ignore falas de ensaio em que o dono fingiu ser cliente), monte o fluxo de WhatsApp.\nArquitetura: tronco trigger→boas-vindas→intent, depois um ramo vertical por pedido, sem cruzar linhas.\nUse o nome do negócio nas boas-vindas se já estiver no contexto.\n\n${lines}`;
}

export async function buildFlowFromStudio(
  messages: StudioMsg[],
  ctx?: ClientContext | null
): Promise<GeneratedFlow> {
  return generateFlowFromPrompt(briefFromMessages(messages, ctx).slice(0, 6000));
}
