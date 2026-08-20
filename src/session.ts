/**
 * Sessão Baileys por accountId (1 número WhatsApp = 1 account no Glabs Bot).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import baileysDefault, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import { authDir, botSecret, logLevel } from "./config.js";
import { formatPhoneDisplay, toWhatsAppJid } from "./phone.js";
import { getAccount, type AccountRecord } from "./registry.js";
import { db, hasDatabase } from "./db.js";
import { sendEmailAlert, sendTelegramAlert } from "./notify.js";

/** Reconexões seguidas antes de considerar a queda "persistente" o bastante pra alertar
 * (evita spam de alerta em blips curtos de rede que já se resolvem sozinhos). */
const RECONNECT_ALERT_THRESHOLD = 5;

const makeWASocket: any = (baileysDefault as any)?.default ?? baileysDefault;
const logger = pino({ level: logLevel() });

const AUTH_ROOT = authDir();

export type SessionStatus = "disconnected" | "pending_qr" | "connected" | "error";

export type SessionSnapshot = {
  accountId: string;
  product: string | null;
  externalTenantId: string | null;
  status: SessionStatus;
  qrDataUrl: string | null;
  phoneE164: string | null;
  phoneDisplay: string | null;
  displayName: string | null;
  lastError: string | null;
  connectedAt: string | null;
};

type LiveSession = {
  accountId: string;
  status: SessionStatus;
  qrDataUrl: string | null;
  phoneE164: string | null;
  displayName: string | null;
  lastError: string | null;
  connectedAt: Date | null;
  sock: any | null;
  starting: boolean;
};

const sessions = new Map<string, LiveSession>();

function empty(accountId: string): LiveSession {
  return {
    accountId,
    status: "disconnected",
    qrDataUrl: null,
    phoneE164: null,
    displayName: null,
    lastError: null,
    connectedAt: null,
    sock: null,
    starting: false,
  };
}

function getOrCreate(accountId: string): LiveSession {
  let s = sessions.get(accountId);
  if (!s) {
    s = empty(accountId);
    sessions.set(accountId, s);
  }
  return s;
}

function accountMeta(accountId: string): Pick<AccountRecord, "product" | "externalTenantId"> | null {
  const acc = getAccount(accountId);
  if (!acc) return null;
  return { product: acc.product, externalTenantId: acc.externalTenantId };
}

export function snapshot(accountId: string): SessionSnapshot {
  const s = getOrCreate(accountId);
  const meta = accountMeta(accountId);
  return {
    accountId,
    product: meta?.product ?? null,
    externalTenantId: meta?.externalTenantId ?? null,
    status: s.status,
    qrDataUrl: s.qrDataUrl,
    phoneE164: s.phoneE164,
    phoneDisplay: formatPhoneDisplay(s.phoneE164),
    displayName: s.displayName,
    lastError: s.lastError,
    connectedAt: s.connectedAt?.toISOString() ?? null,
  };
}

function accountAuthPath(accountId: string) {
  return join(AUTH_ROOT, accountId);
}

/**
 * Persiste o status de conexão (Fase 1 do roadmap de infra) — sobrevive a restart do
 * processo. Fire-and-forget de propósito: uma falha aqui nunca pode derrubar o fluxo
 * de WhatsApp em si (mesmo espírito de postWebhook).
 */
async function persistStatus(s: LiveSession): Promise<void> {
  if (!hasDatabase()) return;
  try {
    await db()`
      INSERT INTO account_connection_status
        (account_id, status, phone_e164, display_name, last_error, connected_at, updated_at)
      VALUES
        (${s.accountId}, ${s.status}, ${s.phoneE164}, ${s.displayName}, ${s.lastError},
         ${s.connectedAt}, now())
      ON CONFLICT (account_id) DO UPDATE SET
        status = excluded.status,
        phone_e164 = excluded.phone_e164,
        display_name = excluded.display_name,
        last_error = excluded.last_error,
        connected_at = excluded.connected_at,
        updated_at = now()
    `;
  } catch (e) {
    console.error(`[wa:${s.accountId}] persistStatus failed:`, (e as Error).message);
  }
}

/**
 * Normaliza status persistido no boot, antes de restoreSessionsFromDisk() reconectar
 * de fato — sem isso, uma conta que ficasse "connected" na tabela num crash duro
 * (processo morto sem passar pelo evento `close`) continuaria aparecendo conectada
 * até a próxima transição real, mesmo já estando órfã.
 */
export async function resetConnectionStatusOnBoot(): Promise<void> {
  if (!hasDatabase()) return;
  try {
    await db()`
      UPDATE account_connection_status SET status = 'disconnected', updated_at = now()
      WHERE status <> 'disconnected'
    `;
  } catch (e) {
    console.error("[glabs-bot] resetConnectionStatusOnBoot failed:", (e as Error).message);
  }
}

/**
 * Aguarda QR (pending_qr + data URL) ou connected, ou timeout.
 * Sem isso o HTTP devolve "disconnected" antes do evento Baileys e a UI não mostra o QR.
 */
async function waitForPairingState(
  accountId: string,
  s: LiveSession,
  timeoutMs = 25_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (s.status === "connected") return;
    if (s.status === "pending_qr" && s.qrDataUrl) return;
    if (s.status === "error") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (s.status === "disconnected" && !s.lastError) {
    s.lastError =
      "Timeout aguardando QR. Clique em Conectar de novo ou Atualizar em alguns segundos.";
  }
  console.warn(
    `[wa:${accountId}] waitForPairing timeout status=${s.status} hasQr=${Boolean(s.qrDataUrl)}`
  );
}

export async function connect(accountId: string): Promise<SessionSnapshot> {
  if (!getAccount(accountId)) {
    const s = getOrCreate(accountId);
    s.status = "error";
    s.lastError = "Account não encontrada. Provisionar com POST /v1/accounts.";
    return snapshot(accountId);
  }

  const s = getOrCreate(accountId);
  if (s.status === "connected" && s.sock) return snapshot(accountId);

  // Já gerando QR / reconectando: só espera o estado útil
  if (s.starting || s.status === "pending_qr") {
    await waitForPairingState(accountId, s);
    return snapshot(accountId);
  }

  s.starting = true;
  s.lastError = null;
  s.status = "disconnected";
  s.qrDataUrl = null;

  try {
    await bootSocket(accountId, s, 0);
    await waitForPairingState(accountId, s);
  } catch (err) {
    s.status = "error";
    s.lastError = err instanceof Error ? err.message : "falha ao iniciar sessão";
    s.starting = false;
    console.error(`[wa:${accountId}] boot failed:`, s.lastError);
  }

  return snapshot(accountId);
}

export async function restoreSessionsFromDisk(): Promise<void> {
  let names: string[] = [];
  try {
    const { readdirSync, statSync } = await import("node:fs");
    names = readdirSync(AUTH_ROOT).filter((n) => {
      try {
        return (
          statSync(join(AUTH_ROOT, n)).isDirectory() &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)
        );
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }
  if (names.length === 0) return;
  console.log(`[glabs-bot] restaurando ${names.length} sessão(ões) do disco…`);
  for (const accountId of names) {
    if (!getAccount(accountId)) {
      console.warn(`[glabs-bot] auth em disco sem registry: ${accountId} (ignorado no restore)`);
      continue;
    }
    try {
      await connect(accountId);
    } catch (e) {
      console.error(`[wa:${accountId}] restore failed:`, (e as Error).message);
    }
  }
}

async function bootSocket(accountId: string, s: LiveSession, attempt: number): Promise<void> {
  const dir = accountAuthPath(accountId);
  mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const alreadyRegistered = Boolean((state.creds as { registered?: boolean } | undefined)?.registered);
  if (alreadyRegistered) {
    s.status = "disconnected";
    s.qrDataUrl = null;
    s.lastError = null;
    console.log(`[wa:${accountId}] credenciais em disco — reconectando sem QR…`);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger as any,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  s.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", ({ messages, type }: any) => {
    if (type !== "notify") return;
    for (const m of messages ?? []) {
      void handleInbound(accountId, m, sock);
    }
  });

  sock.ev.on("messages.update", (updates: any[]) => {
    for (const u of updates ?? []) {
      const id = u?.key?.id as string | undefined;
      const st = u?.update?.status;
      if (!id || st === undefined || st === null) continue;
      if (u?.key?.fromMe === false) continue;
      const mapped = mapWaStatus(Number(st));
      if (!mapped) continue;
      void postStatusUpdate(accountId, id, mapped);
    }
  });

  sock.ev.on("connection.update", async (u: any) => {
    if (u.qr) {
      const regNow = Boolean(
        (sock.authState?.creds as { registered?: boolean } | undefined)?.registered ||
          alreadyRegistered
      );
      if (regNow && s.status !== "pending_qr") {
        console.log(`[wa:${accountId}] QR ignorado (sessão registrada — aguardando open)`);
        return;
      }
      try {
        s.qrDataUrl = await QRCode.toDataURL(u.qr, {
          margin: 2,
          width: 320,
          color: { dark: "#111827", light: "#ffffff" },
        });
      } catch (e) {
        console.error(`[wa:${accountId}] qr encode failed:`, (e as Error).message);
      }
      s.status = "pending_qr";
      s.phoneE164 = null;
      s.displayName = null;
      s.connectedAt = null;
      console.log(`[wa:${accountId}] QR gerado`);
      void persistStatus(s);
    }

    if (u.connection === "open") {
      const me = sock.user?.id ?? "";
      const phone = me.split(":")[0]?.split("@")[0] ?? null;
      s.status = "connected";
      s.qrDataUrl = null;
      s.phoneE164 = phone;
      s.displayName = sock.user?.name ?? null;
      s.connectedAt = new Date();
      s.lastError = null;
      s.starting = false;
      console.log(`[wa:${accountId}] conectado como ${phone ?? me}`);
      void persistStatus(s);
    }

    if (u.connection === "close") {
      const code = (u.lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[wa:${accountId}] fechou code=${code} loggedOut=${loggedOut}`);
      s.sock = null;
      s.qrDataUrl = null;
      s.starting = false;

      if (loggedOut) {
        s.status = "disconnected";
        s.phoneE164 = null;
        s.displayName = null;
        s.connectedAt = null;
        s.lastError = "Sessão encerrada no celular. Conecte de novo e escaneie o QR.";
        void persistStatus(s);
        void sendTelegramAlert(
          `🔴 <b>WhatsApp desconectado</b> (account <code>${accountId}</code>)\n` +
            `Sessão encerrada no celular — precisa escanear um novo QR code.`
        );
        void sendEmailAlert(
          accountId,
          "WhatsApp desconectado",
          `A sessão do WhatsApp (account ${accountId}) foi encerrada no celular — precisa escanear um novo QR code pra reconectar.`
        );
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return;
      }

      s.status = "disconnected";
      s.lastError = `Conexão caiu (código ${code ?? "?"}). Reconectando…`;
      void persistStatus(s);
      if (attempt + 1 === RECONNECT_ALERT_THRESHOLD) {
        void sendTelegramAlert(
          `🟡 <b>WhatsApp instável</b> (account <code>${accountId}</code>)\n` +
            `Já são ${RECONNECT_ALERT_THRESHOLD} tentativas de reconexão seguidas (código ${code ?? "?"}).`
        );
        void sendEmailAlert(
          accountId,
          "WhatsApp instável",
          `A sessão do WhatsApp (account ${accountId}) já tentou reconectar ${RECONNECT_ALERT_THRESHOLD} vezes seguidas (código ${code ?? "?"}).`
        );
      }
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      setTimeout(() => {
        void bootSocket(accountId, s, attempt + 1);
      }, delay);
    }
  });
}

export async function disconnect(accountId: string): Promise<SessionSnapshot> {
  const s = getOrCreate(accountId);
  try {
    if (s.sock?.logout) await s.sock.logout();
    else if (s.sock?.end) s.sock.end(undefined);
  } catch (e) {
    console.error(`[wa:${accountId}] logout:`, (e as Error).message);
  }
  s.sock = null;
  s.status = "disconnected";
  s.qrDataUrl = null;
  s.phoneE164 = null;
  s.displayName = null;
  s.connectedAt = null;
  s.starting = false;
  s.lastError = null;
  try {
    rmSync(accountAuthPath(accountId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  void persistStatus(s);
  return snapshot(accountId);
}

async function postWebhook(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const acc = getAccount(accountId);
  if (!acc?.webhookUrl || acc.webhookUrl.includes("glabs.internal")) {
    return;
  }
  const secret = botSecret();
  const body = {
    ...payload,
    accountId,
    product: acc.product,
    externalTenantId: acc.externalTenantId,
  };
  try {
    const res = await fetch(acc.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(
        `[wa:${accountId}] webhook ${res.status} → ${acc.webhookUrl}: ${t.slice(0, 200)}`
      );
    }
  } catch (err) {
    console.error(
      `[wa:${accountId}] webhook fetch failed → ${acc.webhookUrl}:`,
      (err as Error).message
    );
  }
}

async function handleInbound(accountId: string, m: any, sock: any): Promise<void> {
  try {
    if (m?.key?.fromMe) return;
    const jid: string = m?.key?.remoteJid ?? "";
    if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) {
      return;
    }

    const phone = resolvePeerPhone(m);
    if (!phone || phone.length < 8) {
      console.warn(`[wa:${accountId}] inbound ignorado: sem PN (remoteJid=${jid})`);
      return;
    }

    const unwrapped = unwrapMessageContent(m.message);
    const text = extractTextFromContent(unwrapped);
    const media = await downloadInboundMedia(m, unwrapped, sock, accountId);
    if (!text && !media) return;

    const quote = extractQuotedContext(unwrapped);
    const bodyText = text || mediaLabel(media);
    const meta = accountMeta(accountId);
    const product = meta?.product || "gestor";

    void import("./inbox.js")
      .then(({ recordMessage }) =>
        recordMessage({
          accountId,
          phone,
          direction: "in",
          source: "customer",
          body: bodyText,
          authorName: m?.pushName ?? null,
          externalId: m?.key?.id ?? null,
          sentAt: new Date(Number(m?.messageTimestamp || 0) * 1000 || Date.now()),
        })
      )
      .catch(() => undefined);

    // ── Flow engine (atendimento automático) ───────────────
    try {
      const { processInboundFlow } = await import("./flows/engine.js");
      const flowResult = await processInboundFlow({
        accountId,
        product,
        phoneE164: phone,
        text: bodyText,
        pushName: m?.pushName ?? null,
      });

      if (flowResult) {
        for (const reply of flowResult.replies) {
          try {
            await sendText(accountId, phone, reply);
          } catch (e) {
            console.warn(`[wa:${accountId}] flow reply failed:`, (e as Error).message);
          }
        }

        if (flowResult.handoff) {
          await postWebhook(accountId, {
            type: "handoff",
            phoneE164: phone,
            body: bodyText,
            externalId: m?.key?.id ?? null,
            sentAt: new Date(
              Number(m?.messageTimestamp || 0) * 1000 || Date.now()
            ).toISOString(),
            pushName: m?.pushName ?? null,
            reason: flowResult.handoffReason || "handoff",
            vars: flowResult.vars,
          });
        }

        // Sempre espelha a msg do user no app (histórico); bot replies já foram no WA
        await postWebhook(accountId, {
          type: "message",
          phoneE164: phone,
          body: bodyText,
          externalId: m?.key?.id ?? null,
          sentAt: new Date(
            Number(m?.messageTimestamp || 0) * 1000 || Date.now()
          ).toISOString(),
          pushName: m?.pushName ?? null,
          media: media ?? undefined,
          quoted: quote ?? undefined,
          botHandled: !flowResult.handoff,
          flowVars: flowResult.vars,
        });

        console.log(
          `[wa:${accountId}] inbound de ${phone} → flow` +
            `${flowResult.handoff ? " handoff" : ""}` +
            ` replies=${flowResult.replies.length}`
        );
        return;
      }
    } catch (e) {
      console.warn(`[wa:${accountId}] flow engine:`, (e as Error).message);
    }

    // ── Sem fluxo live: só webhook (comportamento clássico) ─
    await postWebhook(accountId, {
      type: "message",
      phoneE164: phone,
      body: bodyText,
      externalId: m?.key?.id ?? null,
      sentAt: new Date(Number(m?.messageTimestamp || 0) * 1000 || Date.now()).toISOString(),
      pushName: m?.pushName ?? null,
      media: media ?? undefined,
      quoted: quote ?? undefined,
    });
    console.log(
      `[wa:${accountId}] inbound de ${phone}${media ? ` +${media.kind}` : ""} → app ok`
    );
  } catch (err) {
    console.error(`[wa:${accountId}] inbound failed:`, (err as Error).message);
  }
}

/** WhatsApp aninha mídia em ephemeral / viewOnce / documentWithCaption. */
function unwrapMessageContent(msg: any): any {
  if (!msg || typeof msg !== "object") return msg;
  if (msg.ephemeralMessage?.message) return unwrapMessageContent(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage?.message) return unwrapMessageContent(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2?.message) return unwrapMessageContent(msg.viewOnceMessageV2.message);
  if (msg.viewOnceMessageV2Extension?.message) {
    return unwrapMessageContent(msg.viewOnceMessageV2Extension.message);
  }
  if (msg.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(msg.documentWithCaptionMessage.message);
  }
  if (msg.editedMessage?.message) return unwrapMessageContent(msg.editedMessage.message);
  if (msg.botInvokeMessage?.message) return unwrapMessageContent(msg.botInvokeMessage.message);
  return msg;
}

type InboundMedia = {
  kind: "audio" | "image" | "document";
  mimetype: string;
  base64: string;
  fileName?: string;
  ptt?: boolean;
};

const MAX_INBOUND_MEDIA_BYTES = 6_000_000;

async function downloadInboundMedia(
  fullMsg: any,
  content: any,
  sock: any,
  accountId: string
): Promise<InboundMedia | null> {
  if (!content || !sock) return null;

  let kind: InboundMedia["kind"] | null = null;
  let mimetype = "application/octet-stream";
  let fileName: string | undefined;
  let ptt: boolean | undefined;

  if (content.audioMessage) {
    kind = "audio";
    mimetype = content.audioMessage.mimetype || "audio/ogg; codecs=opus";
    ptt = Boolean(content.audioMessage.ptt);
    fileName = ptt ? "voice.ogg" : "audio.ogg";
  } else if (content.imageMessage) {
    kind = "image";
    mimetype = content.imageMessage.mimetype || "image/jpeg";
    fileName = "image.jpg";
  } else if (content.stickerMessage) {
    kind = "image";
    mimetype = content.stickerMessage.mimetype || "image/webp";
    fileName = "sticker.webp";
  } else if (content.documentMessage) {
    kind = "document";
    mimetype = content.documentMessage.mimetype || "application/octet-stream";
    fileName = content.documentMessage.fileName || "document";
  } else if (content.videoMessage) {
    // vídeo: trata como documento para download/reprodução simples
    kind = "document";
    mimetype = content.videoMessage.mimetype || "video/mp4";
    fileName = "video.mp4";
  } else {
    return null;
  }

  try {
    // Baileys precisa da mensagem completa com key; force content desaninhado
    const forDownload = { ...fullMsg, message: content };
    const buf = (await downloadMediaMessage(
      forDownload,
      "buffer",
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage?.bind(sock),
      }
    )) as Buffer;

    if (!buf?.length) {
      console.warn(`[wa:${accountId}] media download empty kind=${kind}`);
      return null;
    }
    if (buf.length > MAX_INBOUND_MEDIA_BYTES) {
      console.warn(
        `[wa:${accountId}] media too large kind=${kind} bytes=${buf.length} — só placeholder`
      );
      return null;
    }

    console.log(`[wa:${accountId}] media ok kind=${kind} bytes=${buf.length} mime=${mimetype}`);
    return {
      kind,
      mimetype,
      base64: buf.toString("base64"),
      fileName,
      ptt,
    };
  } catch (err) {
    console.error(
      `[wa:${accountId}] media download failed kind=${kind}:`,
      (err as Error).message
    );
    return null;
  }
}

function mediaLabel(media: InboundMedia | null): string {
  if (!media) return "";
  if (media.kind === "audio") return media.ptt ? "🎤 Áudio" : "🔊 Áudio";
  if (media.kind === "image") return "🖼 Imagem";
  return `📎 ${media.fileName || "Documento"}`;
}

function resolvePeerPhone(m: any): string | null {
  const bare = (jid?: string | null) => {
    if (!jid) return "";
    return jid.split("@")[0]?.split(":")[0] ?? "";
  };

  const key = m?.key ?? {};
  const candidates = [
    key.senderPn,
    key.remoteJidAlt,
    key.participantAlt,
    key.participant,
    key.remoteJid,
  ];

  for (const c of candidates) {
    if (typeof c !== "string" || !c) continue;
    if (c.includes("@s.whatsapp.net") || c.includes("@c.us")) {
      const n = bare(c);
      if (n.length >= 10) return n;
    }
  }

  for (const c of candidates) {
    if (typeof c !== "string" || !c) continue;
    if (c.includes("@lid")) continue;
    const n = bare(c);
    if (/^\d{10,15}$/.test(n)) return n;
  }

  return null;
}

function mapWaStatus(
  code: number
): "pending" | "sent" | "delivered" | "read" | "failed" | null {
  switch (code) {
    case 0:
      return "failed";
    case 1:
      return "pending";
    case 2:
      return "sent";
    case 3:
      return "delivered";
    case 4:
    case 5:
      return "read";
    default:
      return null;
  }
}

async function postStatusUpdate(
  accountId: string,
  externalId: string,
  status: string
): Promise<void> {
  try {
    await postWebhook(accountId, {
      type: "status",
      externalId,
      status,
    });
    console.log(`[wa:${accountId}] tick ${externalId} → ${status}`);
  } catch (err) {
    console.error(`[wa:${accountId}] status post failed:`, (err as Error).message);
  }
}

function extractTextFromContent(msg: any): string | null {
  if (!msg) return null;
  if (typeof msg.conversation === "string" && msg.conversation.trim()) return msg.conversation;
  if (typeof msg.extendedTextMessage?.text === "string" && msg.extendedTextMessage.text.trim()) {
    return msg.extendedTextMessage.text;
  }
  if (typeof msg.imageMessage?.caption === "string" && msg.imageMessage.caption.trim()) {
    return msg.imageMessage.caption;
  }
  if (typeof msg.videoMessage?.caption === "string" && msg.videoMessage.caption.trim()) {
    return msg.videoMessage.caption;
  }
  if (typeof msg.documentMessage?.caption === "string" && msg.documentMessage.caption.trim()) {
    return msg.documentMessage.caption;
  }
  // mídia pura — label vem de mediaLabel
  if (msg.imageMessage) return null;
  if (msg.documentMessage) return null;
  if (msg.audioMessage) return null;
  if (msg.stickerMessage) return null;
  if (msg.videoMessage) return null;
  return null;
}

/** Reply-to / citação inbound (contextInfo). */
function extractQuotedContext(
  msg: any
): { stanzaId: string; text: string; participant?: string } | null {
  if (!msg) return null;
  const ctx =
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    null;
  if (!ctx?.stanzaId) return null;
  const q = ctx.quotedMessage;
  let text = "";
  if (q) {
    text =
      q.conversation ||
      q.extendedTextMessage?.text ||
      q.imageMessage?.caption ||
      q.documentMessage?.caption ||
      (q.imageMessage ? "[imagem]" : "") ||
      (q.audioMessage ? "[áudio]" : "") ||
      (q.documentMessage?.fileName ? `[doc: ${q.documentMessage.fileName}]` : "") ||
      "";
  }
  return {
    stanzaId: String(ctx.stanzaId),
    text: String(text || "").slice(0, 500),
    participant: ctx.participant ? String(ctx.participant) : undefined,
  };
}

export type SendMediaInput = {
  /** data URL ou base64 puro */
  base64: string;
  mimetype: string;
  fileName?: string;
  /** image | document (default: infere pelo mime) */
  kind?: "image" | "document";
};

/** Citação WhatsApp (reply-to): key da mensagem original. */
export type QuotedMessageInput = {
  /** id externo (wamid / Baileys key.id) */
  id: string;
  /** fromMe no WhatsApp */
  fromMe?: boolean;
  /** trecho para o protocol (conversation) */
  text?: string;
};

export async function sendText(
  accountId: string,
  to: string,
  body: string,
  media?: SendMediaInput | null,
  quoted?: QuotedMessageInput | null,
  meta?: { source?: "bot" | "human"; authorName?: string | null }
): Promise<{ ok: true; externalId: string | null } | { ok: false; reason: string }> {
  const s = getOrCreate(accountId);
  if (s.status !== "connected" || !s.sock) {
    return { ok: false, reason: "WhatsApp desconectado. Conecte e escaneie o QR." };
  }
  const text = (body ?? "").trim();
  if (!media && !text) return { ok: false, reason: "Mensagem vazia." };
  if (text.length > 4000) return { ok: false, reason: "Mensagem muito longa (máx. 4000)." };

  const jid = toWhatsAppJid(to);
  if (!jid) {
    return {
      ok: false,
      reason:
        "Telefone inválido. Use internacional com DDI (ex.: +34 612 345 678 ou +55 51 99999-9999).",
    };
  }

  const sendOpts =
    quoted?.id
      ? {
          quoted: {
            key: {
              remoteJid: jid,
              id: quoted.id,
              fromMe: Boolean(quoted.fromMe),
            },
            message: {
              conversation: (quoted.text || " ").slice(0, 500),
            },
          },
        }
      : undefined;

  try {
    let result: any;
    if (media?.base64) {
      let raw = media.base64.trim();
      if (raw.includes(",")) raw = raw.split(",")[1] ?? raw;
      const buf = Buffer.from(raw, "base64");
      if (buf.length < 20) return { ok: false, reason: "Arquivo inválido ou vazio." };
      if (buf.length > 8_000_000) {
        return { ok: false, reason: "Arquivo muito grande (máx. ~8 MB)." };
      }

      let mime = (media.mimetype || "").toLowerCase().trim();
      const fileName =
        media.fileName?.trim() ||
        (mime.startsWith("image/") ? "image.jpg" : "document.bin");
      if (!mime || mime === "application/octet-stream") {
        mime = guessMimeFromName(fileName);
      }
      const isImage = media.kind === "image" || mime.startsWith("image/");

      if (isImage) {
        result = await s.sock.sendMessage(
          jid,
          {
            image: buf,
            caption: text || undefined,
            mimetype: mime.startsWith("image/") ? mime : "image/jpeg",
          },
          sendOpts
        );
      } else {
        result = await s.sock.sendMessage(
          jid,
          {
            document: buf,
            mimetype: mime || "application/octet-stream",
            fileName,
            caption: text || undefined,
          },
          sendOpts
        );
      }
      console.log(
        `[wa:${accountId}] enviou ${isImage ? "image" : "document"} → ${jid} name=${fileName} mime=${mime} bytes=${buf.length}${quoted?.id ? " quoted" : ""}`
      );
    } else {
      result = await s.sock.sendMessage(jid, { text }, sendOpts);
      console.log(`[wa:${accountId}] enviou texto → ${jid}${quoted?.id ? " quoted" : ""}`);
    }

    const externalId = result?.key?.id ?? null;
    const preview = text || (media ? "[mídia]" : "");
    void import("./inbox.js")
      .then(({ recordMessage }) =>
        recordMessage({
          accountId,
          phone: to,
          direction: "out",
          source: meta?.source || "bot",
          body: preview,
          authorName: meta?.authorName || (meta?.source === "human" ? "Atendente" : "Bot"),
          externalId,
        })
      )
      .catch(() => undefined);
    return { ok: true, externalId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "falha no envio";
    console.error(`[wa:${accountId}] send failed:`, msg);
    return { ok: false, reason: msg };
  }
}

function guessMimeFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".doc")) return "application/msword";
  if (n.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".xlsx"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".txt")) return "text/plain";
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".ogg") || n.endsWith(".opus")) return "audio/ogg";
  return "application/octet-stream";
}

/**
 * Atualiza nome / recado / foto do perfil da sessão conectada.
 */
export async function updateProfile(
  accountId: string,
  input: {
    displayName?: string;
    status?: string;
    /** base64 JPEG/PNG ou data URL */
    pictureBase64?: string;
    removePicture?: boolean;
  }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = getOrCreate(accountId);
  if (s.status !== "connected" || !s.sock) {
    return { ok: false, reason: "WhatsApp desconectado." };
  }

  try {
    const me = s.sock.user?.id;
    if (!me) return { ok: false, reason: "JID da sessão indisponível." };

    if (input.displayName?.trim()) {
      await s.sock.updateProfileName(input.displayName.trim());
      s.displayName = input.displayName.trim();
    }
    if (input.status?.trim()) {
      await s.sock.updateProfileStatus(input.status.trim());
    }
    if (input.removePicture) {
      await s.sock.removeProfilePicture(me);
    } else if (input.pictureBase64?.trim()) {
      let raw = input.pictureBase64.trim();
      if (raw.includes(",")) raw = raw.split(",")[1] ?? raw;
      const buf = Buffer.from(raw, "base64");
      if (buf.length < 100) return { ok: false, reason: "Imagem inválida ou muito pequena." };
      if (buf.length > 2_000_000) return { ok: false, reason: "Imagem muito grande (máx. ~2MB)." };
      await s.sock.updateProfilePicture(me, buf);
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "falha ao atualizar perfil";
    console.error(`[wa:${accountId}] profile failed:`, msg);
    return { ok: false, reason: msg };
  }
}
