/**
 * Postgres (Railway / local). Sem DATABASE_URL o app sobe só com JSON em disco
 * — útil em dev. Em produção o banco é a fonte da verdade.
 */
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";

export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL?.trim() ||
    process.env.DATABASE_PRIVATE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    ""
  );
}

export function hasDatabase(): boolean {
  return Boolean(databaseUrl());
}

let sql: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (!sql) {
    const url = databaseUrl();
    if (!url) throw new Error("DATABASE_URL ausente");
    sql = postgres(url, {
      max: 8,
      idle_timeout: 20,
      connect_timeout: 15,
      ssl:
        /rlwy\.net|up\.railway\.app/.test(url) && !url.includes(".railway.internal")
          ? "require"
          : undefined,
    });
  }
  return sql;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('glabs', 'client')),
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_webhook_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  product TEXT NOT NULL,
  external_tenant_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL DEFAULT '',
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product, external_tenant_id)
);

CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  nodes JSONB NOT NULL DEFAULT '[]',
  edges JSONB NOT NULL DEFAULT '[]',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_states (
  account_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  mode TEXT NOT NULL,
  flow_id TEXT,
  node_id TEXT,
  waiting_for TEXT,
  vars JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_id TEXT,
  phone_e164 TEXT NOT NULL,
  direction TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'customer',
  body TEXT NOT NULL,
  author_name TEXT,
  external_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_client ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_accounts_client ON accounts(client_id);
CREATE INDEX IF NOT EXISTS idx_flows_client ON flows(client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_thread ON wa_messages(account_id, phone_e164, sent_at);
CREATE INDEX IF NOT EXISTS idx_wa_msg_client ON wa_messages(client_id, sent_at DESC);
`;

export async function migrate(): Promise<void> {
  if (!hasDatabase()) return;
  await db().unsafe(SCHEMA);
}

export function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
