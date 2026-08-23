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
  ragStatus: string | null;
  ragReason: string | null;
  ragHits: AiLogHit[];
  simulated: boolean;
  createdAt: string;
};

/** Grava sem bloquear a resposta — falha aqui nunca pode afetar o atendimento. */
export async function logAiAnswer(input: {
  clientId: string | null;
  flowId?: string | null;
  nodeId?: string | null;
  question: string;
  answer?: string | null;
  ragStatus?: string | null;
  ragReason?: string | null;
  ragHits?: AiLogHit[];
  simulated?: boolean;
}): Promise<void> {
  if (!hasDatabase() || !input.clientId) return;
  try {
    await db()`
      INSERT INTO ai_answer_log
        (id, client_id, flow_id, node_id, question, answer, rag_status, rag_reason, rag_hits, simulated)
      VALUES (
        ${randomUUID()}, ${input.clientId}, ${input.flowId ?? null}, ${input.nodeId ?? null},
        ${input.question.slice(0, 2000)}, ${input.answer?.slice(0, 4000) ?? null},
        ${input.ragStatus ?? null}, ${input.ragReason ?? null},
        ${JSON.stringify(input.ragHits ?? [])}::jsonb, ${Boolean(input.simulated)}
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
    SELECT id, flow_id, node_id, question, answer, rag_status, rag_reason, rag_hits, simulated, created_at
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
    answer: (r.answer as string) ?? null,
    ragStatus: (r.rag_status as string) ?? null,
    ragReason: (r.rag_reason as string) ?? null,
    ragHits: (r.rag_hits as AiLogHit[]) ?? [],
    simulated: Boolean(r.simulated),
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}
