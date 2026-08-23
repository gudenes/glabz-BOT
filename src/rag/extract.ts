/**
 * Extrai pares "pergunta do cliente → resposta do atendente" do histórico.
 *
 * É a matéria-prima do RAG: o que um humano da equipe já respondeu vira
 * conhecimento reaproveitável (docs/rag-desenho.md §1). Só entra resposta com
 * `source = 'human'` — resposta do próprio bot não pode virar fonte, senão ele
 * aprende com o que ele mesmo disse e erros se realimentam.
 */
import { db, hasDatabase } from "../db.js";
import { anonymize } from "./anonymize.js";

export type QAPair = {
  question: string;
  answer: string;
  /** Mensagens de origem — permite refazer/remover quando o histórico mudar. */
  sourceIds: string[];
  /** Quantas vezes esse mesmo par apareceu (peso de confiança, §5.2). */
  occurrences: number;
};

/** Fala curta demais não ensina nada ("ok", "obrigado", "👍"). */
const MIN_QUESTION = 8;
const MIN_ANSWER = 12;
/** Texto muito longo vira contexto ruim e caro — corta. */
const MAX_LEN = 1200;

/**
 * Janela máxima entre a pergunta e a resposta. Acima disso provavelmente é
 * outro assunto, não a resposta àquela pergunta.
 */
const MAX_GAP_MINUTES = 60;

type Row = {
  id: string;
  phone_e164: string;
  direction: string;
  source: string;
  body: string;
  author_name: string | null;
  sent_at: Date;
};

/** Normaliza pra agrupar repetições (mesma pergunta escrita de leve diferente). */
function groupKey(question: string, answer: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return `${norm(question)}→${norm(answer)}`;
}

/**
 * Varre o histórico do cliente e devolve os pares já anonimizados e agrupados.
 *
 * Pareamento: para cada resposta humana, procura a última mensagem do cliente
 * na MESMA conversa (mesmo telefone) dentro da janela de tempo. É simples de
 * propósito — heurística mais elaborada aqui erra mais do que acerta, e o par
 * errado polui a base.
 */
export async function extractQAPairs(clientId: string, opts?: { limit?: number }): Promise<QAPair[]> {
  if (!hasDatabase()) return [];

  const rows = (await db()`
    SELECT id, phone_e164, direction, source, body, author_name, sent_at
    FROM wa_messages
    WHERE client_id = ${clientId}
    ORDER BY phone_e164, sent_at
    LIMIT ${opts?.limit ?? 20000}
  `) as unknown as Row[];

  const grouped = new Map<string, QAPair>();

  for (let i = 0; i < rows.length; i++) {
    const answer = rows[i];
    // Só resposta de gente de verdade vira conhecimento.
    if (answer.direction !== "out" || answer.source !== "human") continue;
    if ((answer.body || "").trim().length < MIN_ANSWER) continue;

    // Anda pra trás na MESMA conversa procurando a pergunta que originou.
    let question: Row | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = rows[j];
      if (prev.phone_e164 !== answer.phone_e164) break; // saiu da conversa
      if (prev.direction === "out") continue; // outra mensagem nossa, segue procurando
      const gapMin =
        (new Date(answer.sent_at).getTime() - new Date(prev.sent_at).getTime()) / 60000;
      if (gapMin > MAX_GAP_MINUTES) break; // longe demais pra ser resposta disso
      if ((prev.body || "").trim().length >= MIN_QUESTION) question = prev;
      break;
    }
    if (!question) continue;

    const q = anonymize(question.body, { name: question.author_name }).slice(0, MAX_LEN);
    const a = anonymize(answer.body, { name: question.author_name }).slice(0, MAX_LEN);
    if (q.length < MIN_QUESTION || a.length < MIN_ANSWER) continue;

    const key = groupKey(q, a);
    const found = grouped.get(key);
    if (found) {
      found.occurrences += 1;
      found.sourceIds.push(answer.id);
    } else {
      grouped.set(key, { question: q, answer: a, sourceIds: [question.id, answer.id], occurrences: 1 });
    }
  }

  // Mais frequente primeiro — é o sinal de confiança do desenho (§5.2).
  return [...grouped.values()].sort((x, y) => y.occurrences - x.occurrences);
}
