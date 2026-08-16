import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, hasDatabase } from "./db.js";

export type UserRole = "glabs" | "client";

export type UserRecord = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  clientId: string | null;
  mustChangePassword: boolean;
  createdAt: string;
};

export type SessionUser = UserRecord;

const SESSION_DAYS = 30;

function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hex] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hex) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  const bytes = randomBytes(8);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function newId(prefix = ""): string {
  const id = randomBytes(16).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

function rowToUser(r: {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  client_id: string | null;
  must_change_password: boolean;
  created_at: Date | string;
}): UserRecord {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    clientId: r.client_id,
    mustChangePassword: Boolean(r.must_change_password),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function findUserByEmail(email: string): Promise<(UserRecord & { passwordHash: string }) | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT id, email, name, role, client_id, must_change_password, created_at, password_hash
    FROM users WHERE lower(email) = ${email.trim().toLowerCase()}
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return { ...rowToUser(r as never), passwordHash: r.password_hash as string };
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT id, email, name, role, client_id, must_change_password, created_at
    FROM users WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToUser(rows[0] as never) : null;
}

export async function createUser(input: {
  email: string;
  password: string;
  name?: string | null;
  role: UserRole;
  clientId?: string | null;
  mustChangePassword?: boolean;
}): Promise<UserRecord> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("e-mail inválido");
  const id = newId("usr");
  const now = new Date();
  await db()`
    INSERT INTO users (id, email, password_hash, name, role, client_id, must_change_password, created_at)
    VALUES (
      ${id},
      ${email},
      ${hashPassword(input.password)},
      ${input.name?.trim() || null},
      ${input.role},
      ${input.clientId || null},
      ${Boolean(input.mustChangePassword)},
      ${now}
    )
  `;
  return {
    id,
    email,
    name: input.name?.trim() || null,
    role: input.role,
    clientId: input.clientId || null,
    mustChangePassword: Boolean(input.mustChangePassword),
    createdAt: now.toISOString(),
  };
}

export async function updatePassword(userId: string, next: string, clearTemp = true): Promise<void> {
  if (next.trim().length < 6) throw new Error("senha precisa ter ao menos 6 caracteres");
  await db()`
    UPDATE users
    SET password_hash = ${hashPassword(next)},
        must_change_password = ${clearTemp ? false : true}
    WHERE id = ${userId}
  `;
}

/** Nome do usuário logado — e-mail fica só-leitura (tratado como verificado). */
export async function updateProfile(userId: string, name: string): Promise<UserRecord | null> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("nome obrigatório");
  if (!hasDatabase()) throw new Error("Postgres obrigatório");
  await db()`UPDATE users SET name = ${trimmed} WHERE id = ${userId}`;
  return getUserById(userId);
}

export async function login(
  email: string,
  password: string
): Promise<{ user: UserRecord; sessionId: string } | null> {
  const found = await findUserByEmail(email);
  if (!found || !verifyPassword(password, found.passwordHash)) return null;
  const sessionId = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db()`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${sessionId}, ${found.id}, ${expires})
  `;
  const { passwordHash: _, ...user } = found;
  return { user, sessionId };
}

export async function logout(sessionId: string): Promise<void> {
  if (!sessionId || !hasDatabase()) return;
  await db()`DELETE FROM sessions WHERE id = ${sessionId}`;
}

export async function getSessionUser(sessionId: string): Promise<UserRecord | null> {
  if (!sessionId || !hasDatabase()) return null;
  const rows = await db()`
    SELECT u.id, u.email, u.name, u.role, u.client_id, u.must_change_password, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId} AND s.expires_at > now()
    LIMIT 1
  `;
  return rows[0] ? rowToUser(rows[0] as never) : null;
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export const SESSION_COOKIE = "glabs_sid";

export function sessionCookieHeader(sessionId: string, secure: boolean): string {
  const maxAge = SESSION_DAYS * 86400;
  return [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export async function seedAdmin(): Promise<void> {
  if (!hasDatabase()) return;
  const email = (process.env.GLABS_ADMIN_EMAIL || "admin@glabs.local").trim().toLowerCase();
  const password = process.env.GLABS_ADMIN_PASSWORD || "glabs-admin";
  const existing = await findUserByEmail(email);
  if (existing) return;
  await createUser({
    email,
    password,
    name: "GLabs",
    role: "glabs",
    mustChangePassword: !process.env.GLABS_ADMIN_PASSWORD,
  });
  console.log(`[glabs-bot] admin seed · ${email}`);
}

/** Token estável só para logs — não é o sid. */
export function sessionFingerprint(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}
