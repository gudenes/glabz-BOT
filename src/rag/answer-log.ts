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

export async function listAiAnswers(clientId: string, limit = 50): Promise<AiLogEntry[]> {
  if (!hasDatabase()) return [];
  const rows = (await db()`
    SELECT id, flow_id, node_id, question, answer, fail_reason, rag_status, rag_reason, rag_hits, used_manual_context, simulated, created_at
    FROM ai_answer_log
    WHERE client_id = ${clientId}
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
