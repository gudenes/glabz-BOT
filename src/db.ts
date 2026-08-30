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

-- Dados da conta do portal: faturamento (editável pelo cliente) e perfil de negócio.
-- Colunas soltas em vez de tabela própria — são poucas, 1:1 com clients, sem join extra.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_document TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_whatsapp TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_zip TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_street TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_number TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_district TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_complement TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_role TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_size TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_segment TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_audience TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_source TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_website TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS biz_profile_updated_at TIMESTAMPTZ;

-- Integração Google Calendar por cliente (OAuth) — 1 conexão por cliente por enquanto.
-- refresh_token_enc fica cifrado (AES-256-GCM, ver tokenEncryptionKey() em config.ts),
-- nunca gravado em texto puro.
CREATE TABLE IF NOT EXISTS google_calendar_links (
  client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  refresh_token_enc TEXT NOT NULL,
  scope TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Status de conexão WhatsApp por account, persistido (Fase 1 do roadmap de infra).
-- Espelha o SessionSnapshot que já existe em memória em session.ts — sobrevive a
-- restart do processo, vira fonte de verdade pro painel logo após o boot (antes
-- de restoreSessionsFromDisk() reconectar de fato) e alimenta o alerta no Telegram.
CREATE TABLE IF NOT EXISTS account_connection_status (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  phone_e164 TEXT,
  display_name TEXT,
  last_error TEXT,
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fila de reenvio (Fase 2) — só recebe linha quando um envio síncrono falha;
-- o caminho feliz continua indo direto por sendText(), sem passar por aqui.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  body TEXT NOT NULL,
  media JSONB,
  quoted JSONB,
  meta JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_users_client ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_accounts_client ON accounts(client_id);
CREATE INDEX IF NOT EXISTS idx_flows_client ON flows(client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_thread ON wa_messages(account_id, phone_e164, sent_at);
CREATE INDEX IF NOT EXISTS idx_wa_msg_client ON wa_messages(client_id, sent_at DESC);
-- Dedup de mensagem que chega por dois caminhos (envio pela API + eco do
-- WhatsApp) — ver recordMessage. Não é único de propósito: a tabela já está em
-- produção e pode ter repetições antigas, e um índice único que falhe no boot
-- derrubaria o serviço por causa de algo cosmético.
CREATE INDEX IF NOT EXISTS idx_wa_msg_external ON wa_messages(account_id, external_id);

-- Registro de cada resposta do card de IA: o que foi perguntado, o que a IA
-- respondeu e QUE TRECHOS ela viu pra chegar lá. Sem isso, "por que a IA
-- respondeu isso?" fica sem resposta — foi a falta desse rastro que deixou um
-- bug de RAG passar despercebido (fluxo sem clientId pulava a base em silêncio).
--
-- Fica no schema principal (não no vetorial) de propósito: é justamente onde o
-- RAG NÃO está disponível que saber "foi pulado, e por quê" mais importa.
CREATE TABLE IF NOT EXISTS ai_answer_log (
  id TEXT PRIMARY KEY,
  -- CASCADE: a pergunta é do cliente final; apagar o cliente leva o rastro junto.
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  flow_id TEXT,
  node_id TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  -- ok · pulado · falhou · erro
  rag_status TEXT,
  rag_reason TEXT,
  -- trechos consultados, com score — é o que explica a resposta
  rag_hits JSONB NOT NULL DEFAULT '[]',
  -- o campo "O que a IA sabe sobre o seu negócio" do card estava preenchido
  -- e entrou no prompt. Ao contrário do RAG, isso não é uma busca — é
  -- sempre incluído quando existe, então aqui só registra "existia ou não".
  used_manual_context BOOLEAN NOT NULL DEFAULT false,
  simulated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Tabela já existia em produção/staging antes deste campo — ALTER cobre quem
-- já rodou o CREATE TABLE acima sem ele.
ALTER TABLE ai_answer_log ADD COLUMN IF NOT EXISTS used_manual_context BOOLEAN NOT NULL DEFAULT false;
-- POR QUE a resposta não veio. Antes só ficava a resposta nula, e isso misturava
-- duas coisas muito diferentes: a IA não ter a informação (oportunidade de
-- ensinar) e a chamada ter falhado (problema de infra). Sem separar, a tela de
-- pendências listaria instabilidade como se fosse pergunta a ensinar — e o dono
-- aprenderia a ignorá-la.
-- Nulo em linha antiga e em resposta bem-sucedida.
ALTER TABLE ai_answer_log ADD COLUMN IF NOT EXISTS fail_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_log_client ON ai_answer_log(client_id, created_at DESC);

-- Perguntas que o dono já tratou na caixa de entrada de pendências.
--
-- Fica em tabela própria, e não numa coluna do log, porque a dispensa é do
-- GRUPO de perguntas iguais, não de uma linha: a mesma dúvida chega várias
-- vezes e ensinar uma vez resolve todas. A chave é a pergunta normalizada
-- (ver questionKey em rag/answer-log.ts).
--
-- Apagar a linha é o "desfazer" — por isso não há coluna de estado.
CREATE TABLE IF NOT EXISTS knowledge_gap_dismissed (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, question_key)
);
`;

/** Dimensões do vetor — ver EMBEDDING_MODEL em src/rag/embeddings.ts. */
export const EMBEDDING_DIMS = 1536;

/**
 * Schema do RAG — separado do principal porque depende do tipo `vector`, que
 * só existe onde a extensão pgvector está disponível. O dev local (PG14 sem a
 * extensão) precisa continuar subindo normalmente, sem RAG.
 *
 * Desenho e justificativa das decisões: docs/rag-desenho.md
 */
const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  -- ON DELETE CASCADE não é detalhe: apagar um cliente TEM que levar junto os
  -- vetores derivados das conversas dele (privacidade, ver rag-desenho.md §5.1).
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Pergunta e resposta — anonimizadas quando origin='imported' (dado de
  -- cliente final em histórico de WhatsApp); cruas nos demais casos, porque
  -- vêm do próprio dono do negócio (ver anonymize.ts e rag-desenho.md §5.1).
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  -- Indexamos o PAR pergunta→resposta: mede melhor que só a resposta (§4.1).
  embedding vector(${EMBEDDING_DIMS}) NOT NULL,
  -- Frequência = sinal de confiança: resposta repetida pesa mais que isolada (§5.2).
  occurrences INT NOT NULL DEFAULT 1,
  -- Marcação negativa: tira da busca sem apagar o histórico de origem (§5.2).
  suppressed BOOLEAN NOT NULL DEFAULT false,
  -- Rastreabilidade: permite refazer/remover quando a mensagem de origem sair.
  source_message_ids TEXT[] NOT NULL DEFAULT '{}',
  -- manual (ensinado avulso na aba Conhecimento) · imported (extraído de
  -- histórico respondido por humano) · onboarding (coletado no chat do
  -- Studio) · pasted (extraído de texto colado pelo dono, ex.: cardápio,
  -- política) · website (extraído automaticamente do site do próprio
  -- cliente, via URL). Só exibição/diagnóstico — não muda como a busca
  -- funciona.
  origin TEXT NOT NULL DEFAULT 'manual',
  -- Vetores de modelos diferentes não são comparáveis — guardar qual gerou
  -- permite detectar base misturada e reindexar (§7).
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Tabela já existia em staging/produção antes deste campo — ALTER cobre quem
-- já rodou o CREATE TABLE acima sem ele.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';

-- Todo acesso filtra por client_id (isolamento entre clientes, §5.4).
CREATE INDEX IF NOT EXISTS idx_knowledge_client
  ON knowledge_chunks(client_id) WHERE NOT suppressed;

-- HNSW (e não ivfflat) porque pode ser criado com a tabela vazia — ivfflat
-- exige dados presentes pra treinar as listas.
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
`;

/**
 * Habilita pgvector se a imagem do Postgres tiver a extensão disponível.
 *
 * É pré-requisito pra busca semântica no histórico de atendimento (RAG) — ver
 * docs/. Falha de propósito em silêncio (só loga): nem toda imagem traz a
 * extensão compilada, e o app tem que subir normalmente sem ela. Enquanto não
 * existir, nada no produto depende disso.
 *
 * Roda separado do SCHEMA porque `CREATE EXTENSION` exige privilégio que nem
 * todo ambiente concede — se fosse junto, um erro aqui derrubaria todas as
 * migrations.
 */
export async function ensureVectorExtension(): Promise<boolean> {
  if (!hasDatabase()) return false;
  try {
    await db().unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    const rows = await db().unsafe(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
    );
    const version = (rows[0] as { extversion?: string } | undefined)?.extversion;
    console.log(`[glabs-bot] pgvector disponível (v${version ?? "?"})`);
    return true;
  } catch (e) {
    console.warn(
      "[glabs-bot] pgvector NÃO disponível nesta imagem do Postgres:",
      e instanceof Error ? e.message : e
    );
    return false;
  }
}

/** true quando o RAG tem onde funcionar (extensão + tabelas prontas). */
let vectorReady = false;
export function isVectorReady(): boolean {
  return vectorReady;
}

export async function migrate(): Promise<void> {
  if (!hasDatabase()) return;
  await db().unsafe(SCHEMA);

  // O schema vetorial só roda onde a extensão existe — sem ela o app sobe
  // igual, apenas sem RAG (dev local em PG14, por exemplo).
  if (await ensureVectorExtension()) {
    try {
      await db().unsafe(VECTOR_SCHEMA);
      vectorReady = true;
      console.log("[glabs-bot] schema do RAG pronto (knowledge_chunks)");
    } catch (e) {
      console.error(
        "[glabs-bot] falhou ao criar schema do RAG:",
        e instanceof Error ? e.message : e
      );
    }
  }
}

export function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
