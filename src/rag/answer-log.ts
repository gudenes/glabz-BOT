/**
 * Rastro das respostas do card de IA.
 *
 * Responde "por que a IA respondeu isso?" — mostrando o que ela viu antes de
 * responder. Sem esse rastro, um bug em que o RAG era silenciosamente pulado
 * (fluxo sem clientId, no simulador do builder) passou despercebido: a resposta
 * saía plausível, só não usava a base.
 *
 * Guarda a pergunta do cliente final, então segue a mesma regra do resto:
 * some junto com o cliente (ON DELETE CASCADE) e tem retenção limitada.
 */
import { randomUUID } from "node:crypto";
import { db, hasDatabase } from "../db.js";

/** Quantas respostas guardar por cliente — o suficiente pra investigar sem virar arquivo morto. */
const MAX_PER_CLIENT = 500;

export type AiLogHit = { question: string; score: number };

export type AiLogEntry = {
  id: string;
  flowId: string | null;
  nodeId: string | null;
  question: string;
  answer: string | null;
  failReason: string | null;
  ragStatus: string | null;
  ragReason: string | null;
  ragHits: AiLogHit[];
  usedManualContext: boolean;
  simulated: boolean;
  createdAt: string;
};

/**
 * O que significa uma resposta que não veio.
 *
 * `sabe_nao` = a informação não está na base nem no contexto do card. É a
 * ÚNICA que vale virar pendência de ensino — o dono sabe a resposta, o bot não.
 *
 * `tecnico` = a chamada falhou (fora do ar, sem chave, tempo esgotado). Não se
 * ensina nada com isso; misturar as duas na mesma lista faria o dono aprender
 * a ignorá-la, que é como um recurso desses morre.
 */
export type FailureKind = "sabe_nao" | "tecnico" | "nenhuma";

export function classifyFailure(failReason: string | null | undefined): FailureKind {
  const r = String(failReason || "").trim();
  if (!r) return "nenhuma";
  return r === "fora_do_contexto" ? "sabe_nao" : "tecnico";
}

/**
 * Busca que ignora acento, sem depender de extensão do Postgres.
 *
 * `ILIKE` ignora maiúscula mas NÃO ignora acento: procurar "racao" não achava
 * "ração", e digitar sem acento é o comportamento normal de quem busca com
 * pressa. `unaccent` resolveria, mas é extensão e pode não existir no Railway
 * — `translate` é SQL puro e funciona em qualquer instalação.
 *
 * Os dois lados passam pela mesma redução: a coluna, no SQL, e o termo
 * digitado, aqui.
 */
export const ACENTOS = {
  com: "áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ",
  sem: "aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC",
};

/** Termo pronto pro LIKE: sem acento, minúsculo e com curingas escapados. */
export function searchPattern(term: string | null | undefined): string | null {
  const bruto = String(term || "").trim();
  if (!bruto) return null;
  const semAcento = bruto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  // % e _ são curingas do LIKE — sem escapar, digitar "50%" traria tudo.
  return `%${semAcento.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Uma pergunta que a IA não soube responder, agrupada por texto. */
export type KnowledgeGap = {
  /** Chave normalizada — é por ela que as repetições se juntam. */
  key: string;
  /** A forma mais recente em que a pergunta foi feita, pra mostrar na tela. */
  question: string;
  times: number;
  lastAt: string;
};

/**
 * Normaliza a pergunta pra agrupar repetições.
 *
 * Minúsculas, sem acento, sem pontuação, espaços colapsados — assim
 * "Vocês têm ração?" e "voces tem racao" contam como a mesma.
 *
 * NÃO agrupa por semelhança: "ração p/ cão grande" fica separado de "vocês têm
 * ração para cachorro de grande porte?". Semelhança exigiria embeddings e
 * pgvector, e erraria junto quando errasse — melhor duas linhas honestas que
 * uma linha errada.
 */
export function questionKey(question: string): string {
  return String(question || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Grava sem bloquear a resposta — falha aqui nunca pode afetar o atendimento. */
export async function logAiAnswer(input: {
  clientId: string | null;
  flowId?: string | null;
  nodeId?: string | null;
  question: string;
  answer?: string | null;
  /** Motivo quando não houve resposta — ver classifyFailure. */
  failReason?: string | null;
  ragStatus?: string | null;
  ragReason?: string | null;
  ragHits?: AiLogHit[];
  usedManualContext?: boolean;
  simulated?: boolean;
}): Promise<void> {
  if (!hasDatabase() || !input.clientId) return;
  try {
    await db()`
      INSERT INTO ai_answer_log
        (id, client_id, flow_id, node_id, question, answer, fail_reason, rag_status, rag_reason, rag_hits, used_manual_context, simulated)
      VALUES (
        ${randomUUID()}, ${input.clientId}, ${input.flowId ?? null}, ${input.nodeId ?? null},
        ${input.question.slice(0, 2000)}, ${input.answer?.slice(0, 4000) ?? null},
        ${input.failReason?.slice(0, 120) ?? null},
        ${input.ragStatus ?? null}, ${input.ragReason ?? null},
        ${db().json(input.ragHits ?? [])}, ${Boolean(input.usedManualContext)}, ${Boolean(input.simulated)}
      )
    `;
    // Poda os antigos — mantém a tabela útil sem crescer sem limite.
    await db()`
      DELETE FROM ai_answer_log
      WHERE client_id = ${input.clientId}
        AND id NOT IN (
          SELECT id FROM ai_answer_log
          WHERE client_id = ${input.clientId}
          ORDER BY created_at DESC
          LIMIT ${MAX_PER_CLIENT}
        )
    `;
  } catch (e) {
    console.warn("[ia] falhou ao gravar log:", e instanceof Error ? e.message : e);
  }
}

export type ListAnswersOpts = {
  limit?: number;
  /** Palavra buscada na pergunta E na resposta. Vazio = sem filtro. */
  search?: string | null;
  /**
   * Cursor: devolve o que é MAIS ANTIGO que este instante. Paginar por
   * created_at em vez de OFFSET evita pular ou repetir linha quando chega
   * pergunta nova entre uma página e a seguinte — e usa o índice que já
   * existe (idx_ai_log_client).
   */
  before?: string | null;
};

export async function listAiAnswers(
  clientId: string,
  optsOrLimit: ListAnswersOpts | number = 50
): Promise<AiLogEntry[]> {
  if (!hasDatabase()) return [];
  const opts: ListAnswersOpts =
    typeof optsOrLimit === "number" ? { limit: optsOrLimit } : optsOrLimit;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const padrao = searchPattern(opts.search);
  const antes = opts.before ? new Date(opts.before) : null;
  const cursor = antes && !Number.isNaN(antes.getTime()) ? antes : null;

  const rows = (await db()`
    SELECT id, flow_id, node_id, question, answer, fail_reason, rag_status, rag_reason, rag_hits, used_manual_context, simulated, created_at
    FROM ai_answer_log
    WHERE client_id = ${clientId}
      ${cursor ? db()`AND created_at < ${cursor}` : db()``}
      ${
        padrao
          ? db()`AND (
              translate(lower(question), ${ACENTOS.com}, ${ACENTOS.sem}) LIKE ${padrao}
              OR translate(lower(coalesce(answer, '')), ${ACENTOS.com}, ${ACENTOS.sem}) LIKE ${padrao}
            )`
          : db()``
      }
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    flowId: (r.flow_id as string) ?? null,
    nodeId: (r.node_id as string) ?? null,
    question: String(r.question),
    failReason: (r.fail_reason as string) ?? null,
    answer: (r.answer as string) ?? null,
    ragStatus: (r.rag_status as string) ?? null,
    ragReason: (r.rag_reason as string) ?? null,
    ragHits: (r.rag_hits as AiLogHit[]) ?? [],
    usedManualContext: Boolean(r.used_manual_context),
    simulated: Boolean(r.simulated),
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}

/**
 * Perguntas que a IA não soube responder e que ainda não foram tratadas.
 *
 * Agrupa as repetições e ordena pelas mais frequentes: a que chega várias
 * vezes é a que mais custa deixar sem resposta. A da ração apareceu 2× e só
 * dava pra perceber isso lendo o log inteiro.
 *
 * Só entra `fora_do_contexto` — falha técnica não se ensina, e misturar as
 * duas faria o dono aprender a ignorar a lista.
 *
 * `simulated` fica de fora: pergunta do simulador é teste do próprio dono,
 * não dúvida de cliente.
 */
export async function listKnowledgeGaps(
  clientId: string,
  limit = 50
): Promise<KnowledgeGap[]> {
  if (!hasDatabase()) return [];
  const teto = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = (await db()`
    WITH nao_respondidas AS (
      SELECT question, created_at,
             -- Mesma normalização do questionKey, feita no banco pra agrupar
             -- sem trazer tudo pra memória.
             btrim(regexp_replace(
               lower(translate(question, ${ACENTOS.com}, ${ACENTOS.sem})),
               '[^a-z0-9]+', ' ', 'g'
             )) AS chave
      FROM ai_answer_log
      WHERE client_id = ${clientId}
        AND fail_reason = 'fora_do_contexto'
        AND NOT simulated
    )
    SELECT n.chave AS key,
           (array_agg(n.question ORDER BY n.created_at DESC))[1] AS question,
           COUNT(*)::int AS times,
           MAX(n.created_at) AS last_at
    FROM nao_respondidas n
    WHERE n.chave <> ''
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_gap_dismissed d
        WHERE d.client_id = ${clientId} AND d.question_key = n.chave
      )
    GROUP BY n.chave
    ORDER BY COUNT(*) DESC, MAX(n.created_at) DESC
    LIMIT ${teto}
  `) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    key: String(r.key),
    question: String(r.question),
    times: Number(r.times),
    lastAt: new Date(r.last_at as string).toISOString(),
  }));
}

/** Tira a pergunta da caixa de entrada. Idempotente. */
export async function dismissGap(clientId: string, key: string): Promise<void> {
  if (!hasDatabase() || !key.trim()) return;
  await db()`
    INSERT INTO knowledge_gap_dismissed (client_id, question_key)
    VALUES (${clientId}, ${key.trim()})
    ON CONFLICT (client_id, question_key) DO NOTHING
  `;
}

/** Desfaz a dispensa — a pergunta volta pra lista. */
export async function undismissGap(clientId: string, key: string): Promise<void> {
  if (!hasDatabase() || !key.trim()) return;
  await db()`
    DELETE FROM knowledge_gap_dismissed
    WHERE client_id = ${clientId} AND question_key = ${key.trim()}
  `;
}
