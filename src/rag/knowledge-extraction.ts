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

/** Só os campos que a conversa de fato mencionou — nunca inventado, nunca
 * completo por obrigação (ver parseExtractionResult). */
export type BizProfileGuess = {
  role?: string;
  size?: string;
  segment?: string;
  audience?: string;
  /** URL do site do negócio, se mencionada na conversa (item 5b). Normalizada
   * em parseExtractionResult — aqui é só o que o modelo devolveu bruto. */
  website?: string;
};

export type ExtractedKnowledge = {
  pairs: CandidatePair[];
  bizProfile: BizProfileGuess;
};

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
- NUNCA crie uma pergunta pra que você não tem resposta real. Se você pensar numa pergunta
  plausível (ex.: "tem personal trainer?") mas o dono não respondeu isso na conversa, NÃO inclua
  o par — nem com resposta tipo "não foi mencionado"/"não sei"/"não informado". Um par sem
  resposta de verdade é pior que não ter o par: a IA responderia isso pro cliente final.
- Máximo 8 pares.

Além dos pares, se a conversa disser claramente o SEGMENTO do negócio (ex.: pilates, petshop,
clínica), o PORTE (quantas pessoas trabalham), o PÚBLICO atendido ou a URL DO SITE do negócio
(ex.: "temos site sim, é loja.com.br", "pode ver em www.exemplo.com"), devolva em "bizProfile" —
só os campos que foram DE FATO ditos, omita os que não foram. Porte só entra se puder ser um
destes valores exatos: "solo" (só o dono) | "2-5" | "6-20" | "21-50" | "50+"; se não souber
converter com confiança pra um desses, omita o campo porte. Site só entra se um endereço de
verdade foi dito (domínio ou URL) — nunca invente um site nem preencha com "não tem"/"não sei".

Responda APENAS um JSON:
{"pairs":[{"question":"...","answer":"..."}], "bizProfile": {"segment":"...", "role":"...", "audience":"...", "size":"...", "website":"..."}}`;

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
): Promise<ExtractedKnowledge> {
  const key = llmApiKey();
  if (!key) throw new Error("LLM não configurada (XAI_API_KEY).");

  const history = messages.slice(-30).map((m) => ({
    role: m.role,
    content: m.content.slice(0, 2000),
  }));
  if (!history.length) return { pairs: [], bizProfile: {} };

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
  return parseExtractionResult(raw);
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
- NUNCA crie uma pergunta pra que o texto não responde. Se você pensar numa pergunta plausível
  mas o texto não trouxer a resposta, NÃO inclua o par — nem com resposta tipo "não
  mencionado"/"não consta"/"não informado". Um par sem resposta de verdade é pior que não ter o
  par: a IA responderia isso pro cliente final.
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

// Rede de segurança: mesmo com a regra no prompt, o modelo às vezes ainda
// inclui um par pra uma pergunta plausível sem resposta real, escrevendo um
// "não sei" qualquer no lugar da resposta (visto em teste real — ver item 9
// da lista de observações). Compara a resposta INTEIRA (normalizada) contra
// frases conhecidas de "sem informação" — não usa substring, pra não cortar
// uma resposta legítima que só contenha a palavra "não" (ex.: "Não, não
// atendemos aos domingos." é um fato de verdade, não pode ser filtrado).
const NON_ANSWER_PHRASES = new Set([
  "não foi mencionado",
  "não mencionado",
  "não foi dito",
  "não foi especificado",
  "não especificado",
  "não informado",
  "não consta",
  "não consta informação",
  "sem informação",
  "sem essa informação",
  "não há informação",
  "não tenho essa informação",
  "não sei",
  "não sabemos",
  "informação não disponível",
  "não disponível",
  "não aplicável",
  "desconhecido",
  "n/a",
  "n.a.",
]);

function looksLikeNonAnswer(answer: string): boolean {
  const normalized = answer
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  return NON_ANSWER_PHRASES.has(normalized);
}

function pairsFrom(parsed: { pairs?: unknown }, max: number): CandidatePair[] {
  if (!Array.isArray(parsed.pairs)) return [];
  return parsed.pairs
    .map((p) => {
      const q = String((p as { question?: unknown })?.question || "").trim();
      const a = String((p as { answer?: unknown })?.answer || "").trim();
      return { question: q, answer: a };
    })
    .filter((p) => p.question.length >= 3 && p.answer.length >= 3 && !looksLikeNonAnswer(p.answer))
    .slice(0, max);
}

function parsePairs(raw: string, max = 8): CandidatePair[] {
  try {
    return pairsFrom(JSON.parse(extractJson(raw)) as { pairs?: unknown }, max);
  } catch {
    // Grok às vezes devolve prosa — trata como "nada extraído" em vez de
    // quebrar a revisão (essa etapa nunca pode travar o onboarding).
    return [];
  }
}

const VALID_BIZ_SIZES = new Set(["solo", "2-5", "6-20", "21-50", "50+"]);

// Aceita o que o modelo devolver como "domínio ou URL solta" (ex.: "loja.com.br",
// "www.exemplo.com", "https://exemplo.com/sobre") e normaliza pra uma URL http(s)
// completa. Descarta qualquer coisa que não vire uma URL com host plausível
// (precisa de um "." no host) — evita salvar lixo tipo "sim"/"não tem" que o
// modelo eventualmente devolva apesar da instrução do prompt.
function normalizeWebsite(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    if (!u.hostname.includes(".")) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function parseExtractionResult(raw: string): ExtractedKnowledge {
  try {
    const parsed = JSON.parse(extractJson(raw)) as {
      pairs?: unknown;
      bizProfile?: {
        segment?: unknown;
        role?: unknown;
        audience?: unknown;
        size?: unknown;
        website?: unknown;
      };
    };
    const pairs = pairsFrom(parsed, 8);
    const bp = parsed.bizProfile;
    const bizProfile: BizProfileGuess = {};
    const segment = String(bp?.segment || "").trim();
    const role = String(bp?.role || "").trim();
    const audience = String(bp?.audience || "").trim();
    const size = String(bp?.size || "").trim();
    const website = String(bp?.website || "").trim();
    if (segment) bizProfile.segment = segment;
    if (role) bizProfile.role = role;
    if (audience) bizProfile.audience = audience;
    if (VALID_BIZ_SIZES.has(size)) bizProfile.size = size;
    if (website) {
      const normalized = normalizeWebsite(website);
      if (normalized) bizProfile.website = normalized;
    }
    return { pairs, bizProfile };
  } catch {
    // Mesmo raciocínio de parsePairs — nunca deixa a extração travar o
    // onboarding só porque o modelo devolveu algo fora do formato.
    return { pairs: [], bizProfile: {} };
  }
}
