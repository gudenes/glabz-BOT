import { randomBytes } from "node:crypto";
import { db, hasDatabase } from "./db.js";
import { digitsOnly, formatPhoneDisplay } from "./phone.js";
import { getConversationState } from "./flows/store.js";
import { getAccount } from "./registry.js";

export type InboxMessage = {
  id: string;
  phoneE164: string;
  direction: "in" | "out";
  source: "customer" | "bot" | "human";
  body: string;
  authorName: string | null;
  sentAt: string;
  externalId: string | null;
};

export type InboxThread = {
  phoneE164: string;
  phoneDisplay: string;
  contactName: string;
  lastPreview: string;
  lastMessageAt: string;
  mode: "bot" | "human";
};

export async function recordMessage(input: {
  accountId: string;
  phone: string;
  direction: "in" | "out";
  source: "customer" | "bot" | "human";
  body: string;
  authorName?: string | null;
  externalId?: string | null;
  sentAt?: Date | string;
}): Promise<void> {
  if (!hasDatabase()) return;
  const phone = digitsOnly(input.phone);
  if (!phone || !input.body?.trim()) return;
  const acc = getAccount(input.accountId);
  const id = `msg_${randomBytes(12).toString("hex")}`;
  const sentAt = input.sentAt ? new Date(input.sentAt) : new Date();
  const externalId = input.externalId || null;

  // Dedup por id do WhatsApp: a mesma mensagem pode chegar por dois caminhos.
  // O bot envia pela API (grava aqui) e o WhatsApp DEVOLVE esse envio como
  // um evento `fromMe` — que agora também é gravado, pra capturar o atendente
  // respondendo pelo celular. Sem isto, toda resposta do bot apareceria duas
  // vezes na conversa.
  //
  // WHERE NOT EXISTS em vez de constraint única: a tabela já está em produção
  // e pode ter repetições antigas, e criar um índice único que falha no boot
  // derrubaria o serviço inteiro por causa de um detalhe cosmético.
  await db()`
    INSERT INTO wa_messages (
      id, account_id, client_id, phone_e164, direction, source, body, author_name, external_id, sent_at
    )
    SELECT
      ${id},
      ${input.accountId},
      ${acc?.clientId || acc?.externalTenantId || null},
      ${phone},
      ${input.direction},
      ${input.source},
      ${input.body.trim().slice(0, 8000)},
      ${input.authorName || null},
      ${externalId},
      ${sentAt}
    ${
      externalId
        ? db()`WHERE NOT EXISTS (
            SELECT 1 FROM wa_messages
            WHERE account_id = ${input.accountId} AND external_id = ${externalId}
          )`
        : db()``
    }
  `;
}

export async function listThreads(accountId: string): Promise<InboxThread[]> {
  if (!hasDatabase()) return [];
  const rows = await db()`
    SELECT DISTINCT ON (phone_e164)
      phone_e164, body, author_name, sent_at, direction, source
    FROM wa_messages
    WHERE account_id = ${accountId}
    ORDER BY phone_e164, sent_at DESC
  `;
  return rows
    .map((r) => {
      const phone = String(r.phone_e164);
      const name = (r.author_name as string) || formatPhoneDisplay(phone) || phone;
      const mode = getConversationState(accountId, phone)?.mode || "bot";
      return {
        phoneE164: phone,
        phoneDisplay: formatPhoneDisplay(phone) || phone,
        contactName: name,
        lastPreview: String(r.body || "").slice(0, 80),
        lastMessageAt: new Date(r.sent_at as Date).toISOString(),
        mode: mode === "human" ? "human" : "bot",
      } satisfies InboxThread;
    })
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
}

export type MessageStatsPoint = { date: string; in: number; out: number };

/**
 * Agregação diária de wa_messages por direção, num intervalo [from, to).
 * Os dias são contados em horário de Brasília (AT TIME ZONE), não UTC —
 * senão uma mensagem enviada às 22h local cairia no dia seguinte.
 */
export async function getMessageStats(
  clientId: string,
  from: Date,
  to: Date
): Promise<MessageStatsPoint[]> {
  if (!hasDatabase()) return [];
  const rows = await db()`
    SELECT
      date_trunc('day', sent_at AT TIME ZONE 'America/Sao_Paulo') AS day,
      direction,
      count(*)::int AS n
    FROM wa_messages
    WHERE client_id = ${clientId} AND sent_at >= ${from} AND sent_at < ${to}
    GROUP BY 1, 2
    ORDER BY 1
  `;
  const byDay = new Map<string, MessageStatsPoint>();
  for (const r of rows) {
    const date = new Date(r.day as Date).toISOString().slice(0, 10);
    const point = byDay.get(date) || { date, in: 0, out: 0 };
    if (r.direction === "in") point.in = Number(r.n);
    else if (r.direction === "out") point.out = Number(r.n);
    byDay.set(date, point);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Conversas com pelo menos 1 mensagem no intervalo [from, to). */
export async function countActiveConversations(
  clientId: string,
  from: Date,
  to: Date
): Promise<number> {
  if (!hasDatabase()) return 0;
  const rows = await db()`
    SELECT count(DISTINCT phone_e164)::int AS n
    FROM wa_messages
    WHERE client_id = ${clientId} AND sent_at >= ${from} AND sent_at < ${to}
  `;
  return Number(rows[0]?.n || 0);
}

export async function listMessages(
  accountId: string,
  phone: string
): Promise<InboxMessage[]> {
  if (!hasDatabase()) return [];
  const p = digitsOnly(phone);
  const rows = await db()`
    SELECT id, phone_e164, direction, source, body, author_name, sent_at, external_id
    FROM wa_messages
    WHERE account_id = ${accountId} AND phone_e164 = ${p}
    ORDER BY sent_at ASC
    LIMIT 200
  `;
  return rows.map((r) => ({
    id: r.id as string,
    phoneE164: r.phone_e164 as string,
    direction: r.direction as "in" | "out",
    source: r.source as InboxMessage["source"],
    body: r.body as string,
    authorName: (r.author_name as string) || null,
    sentAt: new Date(r.sent_at as Date).toISOString(),
    externalId: (r.external_id as string) || null,
  }));
}
