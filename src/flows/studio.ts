import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import { generateFlowFromPrompt, type FlowBuildMode, type GeneratedFlow } from "./from-prompt.js";

export type StudioMsg = { role: "user" | "assistant"; content: string };
/** O ensaio (offer/preview/debrief) foi removido do onboarding em 27/08 —
 * ele passou a acontecer depois, pelo fluxo simples, dentro do tour guiado.
 * Sobraram as duas fases que importam: coletar e montar. */
export type StudioPhase = "ask" | "ready";
/** flow = briefing normal (monta fluxo no fim). knowledge = mini-briefing
 * reduzido, só pra quem não escolheu "Montar com IA" no onboarding — nunca
 * builda, só alimenta a Base de Conhecimento. */
export type StudioMode = "flow" | "knowledge";
export type StudioTurn = {
  phase: StudioPhase;
  as: "coach" | "bot";
  say: string;
};
export type ClientContext = {
  name?: string | null;
  about?: string | null;
  // Perfil de negócio ("Dados da conta" no portal) — hoje só usado ali, nunca
  // tinha chegado ao coach. Deixar disponível evita reperguntar o que já
  // existe e ajuda a direcionar quais perguntas de conhecimento fazem
  // sentido pro segmento (ver §5d da lista de observações).
  bizRole?: string | null;
  bizSize?: string | null;
  bizSegment?: string | null;
  bizAudience?: string | null;
  // URL do site do negócio (também em "Dados da conta") — quando já
  // conhecida, o coach não pergunta de novo; quando falta, é uma das
  // perguntas candidatas do roteiro de conhecimento (ver item 5b da lista
  // de observações: "vira campo persistente + pergunta no onboarding se
  // ainda não estiver preenchido").
  bizWebsite?: string | null;
};

export function clientContextBlock(ctx?: ClientContext | null): string {
  const name = ctx?.name?.trim();
  const about = ctx?.about?.trim();
  const bizRole = ctx?.bizRole?.trim();
  const bizSize = ctx?.bizSize?.trim();
  const bizSegment = ctx?.bizSegment?.trim();
  const bizAudience = ctx?.bizAudience?.trim();
  const bizWebsite = ctx?.bizWebsite?.trim();

  const lines: string[] = [];
  if (!name && !about) {
    lines.push(
      "Contexto do cliente: ainda não há nome cadastrado. Só pergunte o nome do negócio se o dono não deixar claro."
    );
  } else {
    lines.push("Contexto JÁ cadastrado neste projeto — trate como fato, não pergunte de novo:");
    if (name) lines.push(`- Nome do negócio: ${name}`);
    if (about) lines.push(`- Sobre: ${about}`);
    lines.push(
      "Se o nome já descreve o ramo (consultoria, pilates, clínica, escritório…), NÃO pergunte qual o serviço principal. Siga para o que falta: o que o cliente pede no WhatsApp, o que coletar, quando passar para humano."
    );
  }

  if (bizRole || bizSize || bizSegment || bizAudience) {
    lines.push("Perfil de negócio já cadastrado — trate como fato, não pergunte de novo:");
    if (bizRole) lines.push(`- Cargo/função do dono: ${bizRole}`);
    if (bizSize) lines.push(`- Porte: ${bizSize}`);
    if (bizSegment) lines.push(`- Segmento: ${bizSegment}`);
    if (bizAudience) lines.push(`- Público atendido: ${bizAudience}`);
  } else {
    lines.push(
      "Perfil de negócio (segmento, porte, público) AINDA não está cadastrado. Pergunte o SEGMENTO do negócio (ex.: pilates, petshop, clínica, consultoria) logo nas primeiras perguntas, antes das demais — isso ajuda a direcionar o resto da conversa. Não precisa perguntar porte/público explicitamente, só o segmento."
    );
  }

  if (bizWebsite) {
    lines.push(`Site do negócio já cadastrado: ${bizWebsite} — trate como fato, não pergunte de novo.`);
  } else {
    lines.push(
      "Ainda não sabemos se o negócio tem site. Em algum momento das perguntas de conhecimento (não precisa ser logo de cara), pergunte se tem site e, se sim, peça o link — não é obrigatório, é só mais um tópico útil, sem problema se o dono não tiver ou não souber."
    );
  }

  return lines.join("\n");
}

const SYSTEM = `Você é o coach da GLABZ. Ajuda o dono a DEFINIR o atendimento. Isto NÃO é o bot no ar.

Responda APENAS um JSON:
{
  "phase": "ask" | "ready",
  "as": "coach" | "bot",
  "say": "texto curto em português"
}

Fases — siga esta ordem, sem pular:
1. ask — as=coach. Briefing. UMA pergunta por vez, SÓ do que ainda falta. Nunca pergunte nome do negócio ou serviço principal se o contexto do cliente já trouxer isso. Foque no que o cliente pede no WhatsApp, o que coletar e quando passar para humano.
   Depois de cobrir o essencial do atendimento, intercale 2 a 4 perguntas de CONHECIMENTO —
   mas ADAPTATIVAS, não um roteiro fixo:
   - Comece pelo básico universal (horário de funcionamento, política de cancelamento/troca/
     reembolso) e depois pense no que é ESPECÍFICO do SEGMENTO do negócio (contexto abaixo) —
     coisas que um cliente de verdade DAQUELE tipo de negócio pergunta (ex.: pilates → aula
     experimental, modalidades, contra-indicações; petshop → banho e tosa, hospedagem, vacina;
     clínica → convênios, especialidades atendidas; restaurante → delivery, reservas,
     alergênicos). Priorize o específico do segmento sobre o genérico quando o segmento for
     conhecido.
   - Se uma resposta vier vaga ou incompleta, aprofunde com UMA pergunta de acompanhamento
     antes de mudar de assunto — não aceite resposta pela metade só pra cumprir tabela.
   - Se o dono claramente não sabe, não tem, ou não quer responder algo, NÃO insista — passe
     pra próxima. Nunca repita a mesma pergunta que já foi recusada/pulada.
   - No máximo UMA pergunta de conhecimento por vez, misturada naturalmente ao briefing — nunca
     uma bateria separada nem anuncie "agora vou perguntar sobre conhecimento". Se o dono já
     respondeu isso espontaneamente antes, não repita.
2. ready — as=coach. Quando já souber o essencial e tiver coletado o conhecimento, diga no espírito: "Acho que já tenho o que preciso. Posso montar seu atendimento?" e espere o dono confirmar.

Regras:
- Se o histórico já tem abertura do coach, NÃO cumprimente de novo. Vá direto à próxima pergunta ou ao conteúdo.
- NUNCA proponha ensaio, teste ou simulação, e NUNCA fale como se fosse o bot. Isso acontece em outro momento, fora desta conversa.
- Nunca descreva nós, JSON ou canvas.
- As respostas de conhecimento (horário, política, diferenciais, dúvidas frequentes) valem só o que o dono disser — nunca proponha valores nem preencha lacuna com achismo.
- Pergunta de conhecimento sem resposta clara (dono não soube, pulou, mudou de assunto) não vira fato — segue em frente sem tentar "fechar" aquele tópico.
- say: no máximo 3 frases.`;

/**
 * Mini-briefing pra quem NÃO escolheu "Montar com IA" (usou template ou
 * pulou) — pulável, com aviso, e SÓ sobre conhecimento (ver plano de
 * onboarding). Nunca builda: não tem fase "offer"/"preview"/"debrief", e
 * o backend recusa action:"build" quando mode==="knowledge" mesmo assim
 * (defesa em profundidade — ver POST /v1/flows/studio).
 */
const SYSTEM_KNOWLEDGE_ONLY = `Você é o coach da GLABZ. Está fazendo um mini-briefing SÓ sobre
conhecimento de atendimento — NÃO vai montar fluxo nenhum agora.

Responda APENAS um JSON:
{ "phase": "ask" | "ready", "as": "coach", "say": "texto curto em português" }

Fases:
1. ask — UMA pergunta por vez, ADAPTATIVA, não um roteiro fixo:
   - Comece pelo básico universal (horário de funcionamento, política de cancelamento/troca) e
     depois pense no que é ESPECÍFICO do SEGMENTO do negócio (contexto abaixo) — coisas que um
     cliente de verdade DAQUELE tipo de negócio pergunta (ex.: pilates → aula experimental,
     modalidades, contra-indicações; petshop → banho e tosa, hospedagem, vacina; clínica →
     convênios, especialidades atendidas). Priorize o específico do segmento sobre o genérico
     quando o segmento for conhecido.
   - Se uma resposta vier vaga, aprofunde com UMA pergunta de acompanhamento antes de seguir.
   - Se o dono não souber ou não quiser responder algo, NÃO insista — passe pra próxima. Nunca
     repita pergunta já recusada/pulada.
   - No máximo 4 a 6 perguntas no total. Pule qualquer uma que o dono já tenha respondido no
     histórico.
2. ready — depois de cobrir isso (ou se o dono disser "chega", "pular", "depois", "para"), diga
   que já tem o suficiente por agora e que ele pode revisar antes de salvar.

Regras:
- Nunca pergunte nome do negócio nem peça pra descrever/montar um fluxo — isso não é papel deste
  chat. Se o dono tentar descrever um fluxo, agradeça e redirecione pra próxima pergunta de
  conhecimento.
- Nunca ofereça ensaio nem fale como se fosse o bot.
- As respostas valem só o que o dono disser — nunca proponha valor nem preencha lacuna com achismo.
- Pergunta sem resposta clara não vira fato — segue em frente sem tentar "fechar" aquele tópico.
- say: no máximo 2 frases.`;

function extractJson(raw: string): string {
  const trimmed = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export async function studioTurn(
  messages: StudioMsg[],
  ctx?: ClientContext | null,
  mode: StudioMode = "flow"
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
        { role: "system", content: mode === "knowledge" ? SYSTEM_KNOWLEDGE_ONLY : SYSTEM },
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
    // Sem ensaio, o coach nunca fala como bot nesta conversa.
    const as: "coach" | "bot" = "coach";
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
  // offer/preview/debrief eram as fases do ensaio removido. Um modelo pode
  // ainda devolvê-las (o prompt mudou, o modelo é probabilístico) — mapear
  // pra "ask" mantém a conversa andando em vez de quebrar o layout.
  if (raw === "offer" || raw === "preview" || raw === "simulate" || raw === "debrief") return "ask";
  if (raw === "ready") return "ready";
  return "ask";
}


export function wantsBuild(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(não|nao|ainda não|ainda nao|espera|calma|muda|troca)\b/.test(t)) return false;
  return /\b(montar o fluxo|pode montar|monta o fluxo|cria o fluxo|criar o fluxo|pode criar o fluxo)\b/.test(
    t
  );
}

export function briefFromMessages(
  messages: StudioMsg[],
  ctx?: ClientContext | null,
  mode: FlowBuildMode = "completo"
): string {
  const lines = messages
    .map((m) => (m.role === "user" ? `Dono: ${m.content}` : `Assistente: ${m.content}`))
    .join("\n");
  // O preâmbulo descreve a arquitetura esperada e precisa concordar com o
  // SYSTEM usado (from-prompt.ts). No modo simples ele mandava montar
  // "tronco→boas-vindas→intent", que é justamente o que o simples NÃO deve
  // ter — os dois brigariam.
  const arch =
    mode === "simples"
      ? "Monte o fluxo MAIS CURTO possível que resolva a prioridade principal do dono: sem boas-vindas, sem perguntar nome, no máximo 5 cards."
      : "Arquitetura: tronco trigger→boas-vindas→pergunta de nome→intent, depois um ramo vertical por pedido, sem cruzar linhas.\nUse o nome do negócio nas boas-vindas se já estiver no contexto.";
  return `${clientContextBlock(ctx)}\n\nCom base neste BRIEFING (ignore falas de ensaio em que o dono fingiu ser cliente), monte o fluxo de WhatsApp.\n${arch}\n\n${lines}`;
}

export async function buildFlowFromStudio(
  messages: StudioMsg[],
  ctx?: ClientContext | null,
  mode: FlowBuildMode = "completo"
): Promise<GeneratedFlow> {
  return generateFlowFromPrompt(briefFromMessages(messages, ctx, mode).slice(0, 6000), mode);
}
