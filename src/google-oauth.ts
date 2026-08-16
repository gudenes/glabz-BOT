/**
 * OAuth do Google (Calendar) — 1 conexão por cliente.
 *
 * Fluxo: cliente clica "Conectar" no portal → buildAuthUrl() → consentimento no
 * Google → volta pro /callback com um `code` → exchangeCodeForTokens() → salva
 * o refresh_token cifrado em google_calendar_links. Daí em diante, o connector
 * (src/flows/connectors/calendar.ts) chama getValidAccessToken() antes de cada
 * operação — o access_token é sempre renovado na hora via refresh_token, não
 * fica cacheado (uso é esporádico, não vale a pena a complexidade de cache).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, hasDatabase } from "./db.js";
import {
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  tokenEncryptionKey,
} from "./config.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "openid",
  "email",
].join(" ");

// ── Cifra do refresh_token (AES-256-GCM) ──────────────────────────────────

function encKey(): Buffer {
  return createHash("sha256").update(tokenEncryptionKey()).digest();
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

function decrypt(stored: string): string {
  const [ivB64, tagB64, encB64] = stored.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ── URL de autorização ─────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPES,
    access_type: "offline",
    prompt: "consent", // garante refresh_token mesmo em reconexão
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// ── Troca code/refresh_token por access_token ──────────────────────────────

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`google_token_${res.status}: ${t.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  return postToken({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: googleRedirectUri(),
    grant_type: "authorization_code",
  });
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return postToken({
    refresh_token: refreshToken,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    grant_type: "refresh_token",
  });
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email || null;
  } catch {
    return null;
  }
}

// ── Persistência (google_calendar_links) ────────────────────────────────────

export type GoogleCalendarLink = {
  clientId: string;
  googleEmail: string;
  calendarId: string;
  scope: string;
  connectedAt: string;
};

export async function saveGoogleCalendarLink(input: {
  clientId: string;
  googleEmail: string;
  refreshToken: string;
  scope: string;
  calendarId?: string;
}): Promise<void> {
  if (!hasDatabase()) throw new Error("Postgres obrigatório");
  const encToken = encrypt(input.refreshToken);
  await db()`
    INSERT INTO google_calendar_links (client_id, google_email, calendar_id, refresh_token_enc, scope)
    VALUES (${input.clientId}, ${input.googleEmail}, ${input.calendarId || "primary"}, ${encToken}, ${input.scope})
    ON CONFLICT (client_id) DO UPDATE SET
      google_email = EXCLUDED.google_email,
      calendar_id = EXCLUDED.calendar_id,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      scope = EXCLUDED.scope,
      updated_at = now()
  `;
}

export async function getGoogleCalendarLink(clientId: string): Promise<GoogleCalendarLink | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT client_id, google_email, calendar_id, scope, connected_at
    FROM google_calendar_links WHERE client_id = ${clientId} LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    clientId: r.client_id as string,
    googleEmail: r.google_email as string,
    calendarId: r.calendar_id as string,
    scope: r.scope as string,
    connectedAt: new Date(r.connected_at as Date).toISOString(),
  };
}

export async function deleteGoogleCalendarLink(clientId: string): Promise<boolean> {
  if (!hasDatabase()) return false;
  const rows = await db()`
    DELETE FROM google_calendar_links WHERE client_id = ${clientId} RETURNING client_id
  `;
  return rows.length > 0;
}

/**
 * Access token pronto pra uso, renovado na hora a partir do refresh_token
 * salvo. Retorna null se o cliente não conectou o Google Calendar.
 */
export async function getValidAccessToken(clientId: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT refresh_token_enc FROM google_calendar_links WHERE client_id = ${clientId} LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  const refreshToken = decrypt(r.refresh_token_enc as string);
  const token = await refreshAccessToken(refreshToken);
  return token.access_token;
}

export async function getCalendarIdFor(clientId: string): Promise<string> {
  const link = await getGoogleCalendarLink(clientId);
  return link?.calendarId || "primary";
}
