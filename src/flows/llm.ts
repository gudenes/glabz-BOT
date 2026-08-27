import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";
import { BR_WEEKDAY_NAMES, brDateIso, brLocalParts, brWeekday } from "../br-time.js";

/**
 * Classifica intenção com LLM (xAI/OpenAI-compatible).
 * Fallback: keywords se não houver API key ou se a chamada falhar.
 */
export async function classifyIntent(opts: {
  text: string;
  intents: { slug: string; description: string }[];
  systemHint?: string;
}): Promise<{ intent: string; source: "llm" | "keyword" | "default" }> {
  const intents = opts.intents.filter((i) => i.slug?.trim());
  if (!intents.length) return { intent: "default", source: "default" };

  const key = llmApiKey();
  if (key) {
    try {
      const slugs = intents.map((i) => i.slug).join(", ");
      const catalog = intents
        .map((i) => `- ${i.slug}: ${i.description}`)
        .join("\n");
      const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: llmModel(),
          temperature: 0,
          max_tokens: 40,
          messages: [
            {
              role: "system",
              content:
                (opts.systemHint ||
                  "Você classifica intenções de mensagens de WhatsApp em português.") +
                `\nResponda APENAS com um dos slugs: ${slugs}, ou "default" se nenhum servir.` +
                // Sem isso, uma saudação pura ("oi", "olá") era classificada como
                // a intenção de ENCERRAR ("não precisa de mais nada") — porque de
                // fato não pede nada — e o atendimento terminava na primeira
                // mensagem, antes de o cliente dizer o que queria. Bug real visto
                // em produção; a saudação não é um pedido, é o começo da conversa.
                `\nRegra importante: se a mensagem for só uma saudação/cumprimento sem pedido nenhum` +
                ` ("oi", "olá", "bom dia", "tudo bem?"), responda "default" — NUNCA escolha uma` +
                ` intenção de encerrar/agradecer nesse caso. Só escolha encerrar quando a mensagem` +
                ` de fato disser que não precisa de mais nada (ex.: "não, obrigado", "era só isso").` +
                `\n\nCatálogo:\n${catalog}`,
            },
            { role: "user", content: opts.text.slice(0, 800) },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
        const hit = intents.find(
          (i) =>
            raw === i.slug.toLowerCase() ||
            raw.includes(i.slug.toLowerCase())
        );
        if (hit) return { intent: hit.slug, source: "llm" };
      } else {
        console.warn("[flow/llm] HTTP", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.warn("[flow/llm] failed", (e as Error).message);
    }
  }

  // Keyword fallback
  const t = opts.text.toLowerCase();
  for (const i of intents) {
    const words = i.description
      .toLowerCase()
      .split(/[,;|/]/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2);
    if (words.some((w) => t.includes(w))) {
      return { intent: i.slug, source: "keyword" };
    }
    if (t.includes(i.slug.replace(/_/g, " "))) {
      return { intent: i.slug, source: "keyword" };
    }
  }

  // Heuristics for demo intents
  if (
    /sess[aã]o|pilates|aula|vaga|experimental|remarcar/.test(t) ||
    /consulta|agend|marcar|hor[aá]rio|visita|reuni[aã]o/.test(t)
  ) {
    const m = intents.find(
      (i) =>
        i.slug.includes("sessao") ||
        i.slug.includes("consulta") ||
        i.slug.includes("agend") ||
        i.slug.includes("marcar")
    );
    if (m) return { intent: m.slug, source: "keyword" };
  }
  if (/d[uú]vida|como funciona|valor|pre[cç]o|plano|iniciante/.test(t)) {
    const m = intents.find(
      (i) => i.slug.includes("duvida") || i.slug.includes("faq") || i.slug.includes("outro")
    );
    if (m) return { intent: m.slug, source: "keyword" };
  }
  if (
    /admin|boleto|nota fiscal|cancel|mensalidade|financeiro|contrato|rematr/.test(t)
  ) {
    const m = intents.find((i) => i.slug.includes("admin"));
    if (m) return { intent: m.slug, source: "keyword" };
  }
  if (/humano|atendente|pessoa|operador|algu[eé]m/.test(t)) {
    const m = intents.find((i) => i.slug.includes("humano") || i.slug.includes("atend"));
    if (m) return { intent: m.slug, source: "keyword" };
  }

  return { intent: "default", source: "default" };
}

export type DateExtraction = {
  status: "ok" | "ambiguous" | "unclear";
  date: string | null; // AAAA-MM-DD
  source: "llm" | "keyword";
};

/**
 * Extrai uma data mencionada em texto livre (ex.: "segunda-feira",
 * "amanhã", "dia 17"), relativa a `now`. Diferente de classifyIntent
 * (lista fechada de slugs), aqui a saída é um valor livre — data ISO — com
 * um status indicando se deu pra ter certeza (ok), se faltou informação
 * (ambiguous, ex.: "semana que vem" sem dizer o dia) ou se não tinha nada
 * de data no texto (unclear).
 */
export async function extractDate(opts: { text: string; now?: Date }): Promise<DateExtraction> {
  const now = opts.now || new Date();
  const todayIso = brDateIso(now);
  const weekdayName = BR_WEEKDAY_NAMES[brWeekday(now)];

  const key = llmApiKey();
  if (key) {
    try {
      const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: llmModel(),
          temperature: 0,
          max_tokens: 60,
          messages: [
            {
              role: "system",
              content: `Hoje é ${weekdayName}, ${todayIso} (formato AAAA-MM-DD). O usuário respondeu a uma pergunta sobre que dia ele prefere marcar um horário. Extraia a data mencionada.
Responda APENAS um JSON válido, sem nenhum texto além dele, no formato:
{"status":"ok"|"ambiguous"|"unclear","date":"AAAA-MM-DD"|null}
- "ok": você tem certeza de UMA data específica (calcule a partir de hoje se for relativa, tipo "amanhã" ou "segunda-feira").
- "ambiguous": faltam informações pra decidir entre datas possíveis (ex.: "semana que vem" sem dizer o dia).
- "unclear": o texto não menciona nenhuma data.`,
            },
            { role: "user", content: opts.text.slice(0, 400) },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const raw = (data.choices?.[0]?.message?.content || "").trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { status?: string; date?: string | null };
          const date =
            parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
          if (parsed.status === "ok" && date) return { status: "ok", date, source: "llm" };
          if (parsed.status === "ambiguous" || parsed.status === "unclear") {
            return { status: parsed.status, date: null, source: "llm" };
          }
        }
      } else {
        console.warn("[flow/llm] extractDate HTTP", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.warn("[flow/llm] extractDate failed", (e as Error).message);
    }
  }

  return keywordExtractDate(opts.text, now);
}

const WEEKDAY_ALIASES: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDateFromParts(y: number, m: number, day: number): string {
  const d = new Date(Date.UTC(y, m, day));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Fallback sem LLM (sem API key configurada, ou se a chamada falhar). */
function keywordExtractDate(text: string, now: Date): DateExtraction {
  const t = stripAccents(text.toLowerCase());

  if (/\bhoje\b/.test(t)) return { status: "ok", date: brDateIso(now), source: "keyword" };
  if (/\bamanha\b/.test(t)) return { status: "ok", date: brDateIso(addDays(now, 1)), source: "keyword" };

  const dateSlash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (dateSlash) {
    const day = Number(dateSlash[1]);
    const month = Number(dateSlash[2]) - 1;
    const { y } = brLocalParts(now);
    return { status: "ok", date: isoDateFromParts(y, month, day), source: "keyword" };
  }

  const dayOnly = t.match(/\bdia\s+(\d{1,2})\b/);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    const { y, m, day: today } = brLocalParts(now);
    const targetMonth = day < today ? m + 1 : m;
    return { status: "ok", date: isoDateFromParts(y, targetMonth, day), source: "keyword" };
  }

  for (const [name, weekday] of Object.entries(WEEKDAY_ALIASES)) {
    if (t.includes(name)) {
      const isNextWeek = /proxim|semana que vem/.test(t);
      let delta = (weekday - brWeekday(now) + 7) % 7;
      if (delta === 0) delta = 7; // hoje já é esse dia -> assume a próxima ocorrência (a menos que diga "hoje")
      if (isNextWeek) delta += 7;
      return { status: "ok", date: brDateIso(addDays(now, delta)), source: "keyword" };
    }
  }

  if (/semana que vem|proxima semana|mes que vem/.test(t)) {
    return { status: "ambiguous", date: null, source: "keyword" };
  }

  return { status: "unclear", date: null, source: "keyword" };
}

/**
 * Resposta livre da IA (nó `llm_answer`).
 *
 * Diferente de classifyIntent (escolhe entre opções fixas) e extractDate
 * (extrai um dado): aqui a IA responde a pergunta do cliente com as palavras
 * dela, dentro do contexto que o dono do negócio escreveu. Era a lacuna mais
 * universal do estudo — sem isso, todo fluxo vira menu de URA e qualquer
 * pergunta fora do script cai em handoff.
 *
 * `ok: false` quando não há chave configurada ou a chamada falha — o fluxo
 * então segue pelo ramo "erro" (tipicamente handoff), em vez de responder
 * qualquer coisa inventada.
 */
/**
 * Registro da resposta. Separa O QUE dizer (a base de conhecimento, que não
 * se inventa) de COMO dizer (o tom, que o dono escolhe) — antes as duas
 * coisas estavam coladas numa frase só do prompt.
 * "literal" não passa por aqui: é resolvido antes, sem chamar o modelo
 * (ver engine.ts).
 */
export type AnswerTone = "direta" | "mediana" | "cordial";

const TONE_RULES: Record<AnswerTone, string> = {
  direta: "Seja objetivo: uma ou duas frases, direto ao ponto, sem rodeio nem saudação.",
  mediana: "Seja cordial e claro, sem formalidade excessiva.",
  cordial:
    "Seja formal e acolhedor: trate por senhor/senhora, use 'por gentileza'/'gostaria' quando couber, e explique com um pouco mais de contexto.",
};

/** Tamanho padrão por tom — cordial precisa de espaço, direta não. */
const TONE_MAX_CHARS: Record<AnswerTone, number> = {
  direta: 220,
  mediana: 400,
  cordial: 600,
};

export function normalizeTone(raw: unknown): AnswerTone {
  const t = String(raw || "").trim().toLowerCase();
  return t === "direta" || t === "cordial" ? t : "mediana";
}

export async function answerFreeform(opts: {
  question: string;
  /** O que a IA sabe sobre este negócio — escrito pelo dono no builder. */
  context: string;
  /** Limite de tamanho da resposta, em caracteres (WhatsApp fica ruim com textão). */
  maxChars?: number;
  /** Registro da resposta — ver AnswerTone. */
  tone?: AnswerTone;
  history?: { role: "user" | "assistant"; content: string }[];
}): Promise<{ ok: true; answer: string } | { ok: false; reason: string }> {
  const key = llmApiKey();
  if (!key) return { ok: false, reason: "sem_ia_configurada" };

  const tone = normalizeTone(opts.tone);
  // maxChars explícito do card vence; sem ele, o padrão do tom.
  const maxChars = Math.min(Math.max(opts.maxChars ?? TONE_MAX_CHARS[tone], 80), 1200);
  const system = [
    "Você atende clientes deste negócio pelo WhatsApp, em português do Brasil.",
    TONE_RULES[tone] + " No máximo " + maxChars + " caracteres.",
    // "Use SOMENTE as informações" cuida do CONTEÚDO; o tom acima cuida da
    // forma. Sem essa separação o modelo tendia a devolver quase literal o
    // que estava gravado na base, em vez de responder com o registro pedido.
    "Use SOMENTE as informações do contexto abaixo — mas escreva com as SUAS palavras, no tom pedido, em vez de copiar o texto do contexto.",
    "Se a resposta não estiver no contexto, diga que vai chamar alguém da equipe;",
    "NUNCA invente preço, horário, prazo, endereço ou disponibilidade.",
    "Não use markdown além de *negrito* eventual.",
    "",
    "=== Contexto do negócio ===",
    opts.context?.trim() || "(o dono do negócio ainda não preencheu o contexto)",
  ].join("\n");

  try {
    const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0.3,
        max_tokens: Math.ceil(maxChars / 2),
        messages: [
          { role: "system", content: system },
          ...(opts.history || []).slice(-6),
          { role: "user", content: opts.question.slice(0, 1500) },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn("[flow/llm] answer HTTP", res.status, await res.text().catch(() => ""));
      return { ok: false, reason: `http_${res.status}` };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = (data.choices?.[0]?.message?.content || "").trim();
    if (!answer) return { ok: false, reason: "resposta_vazia" };
    return { ok: true, answer: answer.slice(0, maxChars) };
  } catch (e) {
    console.warn("[flow/llm] answer failed", (e as Error).message);
    return { ok: false, reason: "falha_na_chamada" };
  }
}

/**
 * Julgamento barato (poucos tokens, mesmo perfil de custo de classifyIntent
 * — não é uma segunda chamada cara) de se uma resposta de llm_answer parece
 * útil/específica ou vazia/genérica — usado pela validação automática de
 * fluxo (src/flows/validate.ts) pra sinalizar card "Responder com IA" sem
 * contexto suficiente. Sem chave configurada, ou se a chamada falhar, não
 * reprova por conta própria: devolve `ok:true` (sem sinal, não é "ruim",
 * é "não avaliado") — a validação nunca deve travar nem reportar falso
 * negativo só porque o julgamento em si não rodou.
 */
export async function judgeAnswerQuality(opts: {
  question: string;
  answer: string;
}): Promise<{ ok: boolean; note?: string }> {
  const key = llmApiKey();
  if (!key) return { ok: true };
  if (!opts.answer.trim()) return { ok: false, note: "resposta vazia" };

  try {
    const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0,
        max_tokens: 20,
        messages: [
          {
            role: "system",
            content:
              "Você avalia se a RESPOSTA de um atendente de WhatsApp responde de fato a PERGUNTA " +
              "do cliente com informação específica (não vale só 'vou verificar'/'vou chamar a " +
              "equipe' quando a pergunta parecia simples). Responda APENAS uma palavra: " +
              '"ok" se a resposta é específica e útil, ou "generica" se é vaga/evasiva/deflete.',
          },
          { role: "user", content: `Pergunta: ${opts.question.slice(0, 400)}\nResposta: ${opts.answer.slice(0, 600)}` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: true };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
    // "gener" (não "generic") de propósito — cobre "generica" e "genérica"
    // (o modelo às vezes "corrige" a acentuação apesar do prompt pedir sem).
    if (raw.includes("gener")) return { ok: false, note: "resposta parece genérica/evasiva" };
    return { ok: true };
  } catch (e) {
    console.warn("[flow/llm] judge failed", (e as Error).message);
    return { ok: true };
  }
}
