/**
 * Fila de reenvio (Fase 2 do roadmap de infra) — rede de segurança sobre o
 * envio síncrono já existente (sendText, em session.ts). O caminho feliz
 * continua indo direto, sem latência nova; só quando sendText() falha de um
 * jeito "transitório" (retryable: true — desconexão momentânea, erro de rede
 * no envio) é que a mensagem cai aqui pra retry automático com backoff
 * exponencial (mesmo padrão já usado na reconexão de socket em session.ts).
 *
 * Callers continuam chamando sendTextWithRetry() (não sendText() direto) —
 * é ela quem decide se enfileira. O worker chama sendText() puro pros retries,
 * pra não reenfileirar em cima de si mesmo.
 */
import { randomUUID } from "node:crypto";
import { db, hasDatabase } from "./db.js";
import {
  sendText,
  type QuotedMessageInput,
  type SendMediaInput,
} from "./session.js";

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;
/** ~8 tentativas com backoff até 30s cada = alguns minutos de retry total
 * antes de desistir e marcar failed. */
const MAX_ATTEMPTS = 8;

type SendResult =
  | { ok: true; externalId: string | null }
  | { ok: false; reason: string; retryable?: boolean };

type OutboxMeta = { source?: "bot" | "human"; authorName?: string | null } | null;

export type EnqueueInput = {
  accountId: string;
  phoneE164: string;
  body: string;
  media?: SendMediaInput | null;
  quoted?: QuotedMessageInput | null;
  meta?: OutboxMeta;
  lastError?: string;
};

async function enqueueForRetry(input: EnqueueInput): Promise<void> {
  if (!hasDatabase()) return;
  try {
    await db()`
      INSERT INTO outbox
        (id, account_id, phone_e164, body, media, quoted, meta, status, attempts, last_error, next_attempt_at)
      VALUES (
        ${randomUUID()}, ${input.accountId}, ${input.phoneE164}, ${input.body},
        ${input.media ? JSON.stringify(input.media) : null}::jsonb,
        ${input.quoted ? JSON.stringify(input.quoted) : null}::jsonb,
        ${input.meta ? JSON.stringify(input.meta) : null}::jsonb,
        'pending', 0, ${input.lastError ?? null}, now()
      )
    `;
    console.log(`[outbox] enfileirado account=${input.accountId} to=${input.phoneE164}`);
  } catch (e) {
    console.error("[outbox] enqueue failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Ponto de entrada pra quem manda mensagem "de fora" (portal, fluxo automático)
 * — igual sendText(), mas enfileira pra retry quando a falha é transitória.
 */
export async function sendTextWithRetry(
  accountId: string,
  to: string,
  body: string,
  media?: SendMediaInput | null,
  quoted?: QuotedMessageInput | null,
  meta?: OutboxMeta
): Promise<SendResult> {
  const result = await sendText(accountId, to, body, media, quoted, meta ?? undefined);
  if (!result.ok && result.retryable) {
    void enqueueForRetry({
      accountId,
      phoneE164: to,
      body,
      media,
      quoted,
      meta,
      lastError: result.reason,
    });
  }
  return result;
}

function backoffDelayMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** attempts);
}

async function processBatch(): Promise<void> {
  if (!hasDatabase()) return;
  let claimed: Array<{
    id: string;
    account_id: string;
    phone_e164: string;
    body: string;
    media: SendMediaInput | null;
    quoted: QuotedMessageInput | null;
    meta: OutboxMeta;
    attempts: number;
  }>;
  try {
    // Um único UPDATE...FROM(CTE com FOR UPDATE SKIP LOCKED) é atômico por si
    // só (statement único) — "reivindica" as linhas (pending -> sending) sem
    // precisar de BEGIN/COMMIT explícito. Evita processamento duplicado se
    // algum dia rodar mais de uma réplica (hoje é só 1, mas já fica correto).
    claimed = (await db()`
      WITH picked AS (
        SELECT id FROM outbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox SET status = 'sending', updated_at = now()
      WHERE id IN (SELECT id FROM picked)
      RETURNING id, account_id, phone_e164, body, media, quoted, meta, attempts
    `) as never;
  } catch (e) {
    console.error("[outbox] poll failed:", e instanceof Error ? e.message : e);
    return;
  }

  for (const row of claimed) {
    const result = await sendText(
      row.account_id,
      row.phone_e164,
      row.body,
      row.media ?? undefined,
      row.quoted ?? undefined,
      row.meta ?? undefined
    );

    if (result.ok) {
      await db()`UPDATE outbox SET status = 'sent', updated_at = now() WHERE id = ${row.id}`.catch(
        (e) => console.error("[outbox] mark sent failed:", (e as Error).message)
      );
      console.log(`[outbox] ${row.id} enviado no retry`);
      continue;
    }

    const attempts = row.attempts + 1;
    if (!result.retryable || attempts >= MAX_ATTEMPTS) {
      await db()`
        UPDATE outbox SET status = 'failed', attempts = ${attempts},
          last_error = ${result.reason}, updated_at = now()
        WHERE id = ${row.id}
      `.catch((e) => console.error("[outbox] mark failed failed:", (e as Error).message));
      console.warn(
        `[outbox] ${row.id} desistiu após ${attempts} tentativa(s): ${result.reason}`
      );
      continue;
    }

    const delayMs = backoffDelayMs(attempts);
    await db()`
      UPDATE outbox SET status = 'pending', attempts = ${attempts},
        last_error = ${result.reason},
        next_attempt_at = now() + (${delayMs} || ' milliseconds')::interval,
        updated_at = now()
      WHERE id = ${row.id}
    `.catch((e) => console.error("[outbox] reschedule failed:", (e as Error).message));
  }
}

let workerHandle: NodeJS.Timeout | null = null;

export function startOutboxWorker(): void {
  if (!hasDatabase() || workerHandle) return;
  workerHandle = setInterval(() => {
    void processBatch();
  }, POLL_INTERVAL_MS);
  console.log("[outbox] worker iniciado");
}
