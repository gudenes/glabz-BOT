/**
 * Config do Glabs Bot — defaults de produto; env só para override e secret.
 *
 * Railway: PORT da plataforma; AUTH_DIR em volume montado (ex. /data/auth_state).
 */

export function listenPort(): number {
  const n = Number(process.env.PORT);
  return Number.isFinite(n) && n > 0 ? n : 3099;
}

/** Onde grava auth Baileys + registry de accounts/products. */
export function dataDir(): string {
  if (process.env.AUTH_DIR?.trim()) return process.env.AUTH_DIR.trim();
  if (process.env.DATA_DIR?.trim()) return process.env.DATA_DIR.trim();
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    return "/data";
  }
  return "./data";
}

export function authDir(): string {
  return `${dataDir()}/auth_state`;
}

export function registryPath(): string {
  return `${dataDir()}/registry.json`;
}

export function flowsPath(): string {
  return `${dataDir()}/flows.json`;
}

export function flowStatesPath(): string {
  return `${dataDir()}/flow_states.json`;
}

export function flowHistoryPath(): string {
  return `${dataDir()}/flow_history.json`;
}

/** Momento em que este processo subiu — proxy de "quando foi feito o deploy". */
export const BOOT_AT = new Date().toISOString();

/**
 * Info do commit git rodando neste processo.
 * Railway injeta RAILWAY_GIT_* automaticamente em deploys vindos do GitHub.
 * Fora do Railway (dev local), sem essas vars — fica null (UI mostra "local/dev").
 */
export function gitInfo(): {
  commit: string | null;
  branch: string | null;
  message: string | null;
} {
  return {
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null,
    branch: process.env.RAILWAY_GIT_BRANCH?.trim() || null,
    message: process.env.RAILWAY_GIT_COMMIT_MESSAGE?.trim() || null,
  };
}

/** Secret compartilhado entre bot e apps clientes (Bearer). */
export function botSecret(): string {
  return (
    process.env.GLABS_BOT_SECRET?.trim() ||
    process.env.WHATSAPP_WORKER_SECRET?.trim() ||
    ""
  );
}

export function logLevel(): string {
  return process.env.LOG_LEVEL?.trim() || "warn";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT);
}

/** LLM para nó de intenção (xAI / OpenAI-compatible). */
export function llmApiKey(): string {
  return (
    process.env.GLABS_LLM_API_KEY?.trim() ||
    process.env.XAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export function llmBaseUrl(): string {
  return (
    process.env.GLABS_LLM_BASE_URL?.trim() ||
    process.env.XAI_BASE_URL?.trim() ||
    "https://api.x.ai/v1"
  );
}

export function llmModel(): string {
  return process.env.GLABS_LLM_MODEL?.trim() || "grok-4-1-fast-non-reasoning";
}

export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL?.trim() ||
    process.env.DATABASE_PRIVATE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    ""
  );
}

/** OAuth do Google (Calendar) — Client ID/Secret criados uma vez no Google Cloud Console. */
export function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() || "";
}

export function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
}

export function googleRedirectUri(): string {
  return (
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `http://localhost:${listenPort()}/v1/integrations/google-calendar/callback`
  );
}

export function googleOAuthConfigured(): boolean {
  return Boolean(googleClientId() && googleClientSecret());
}

/**
 * Chave usada pra cifrar refresh_token em repouso (AES-256-GCM).
 * Em produção precisa vir de TOKEN_ENCRYPTION_KEY (ou reaproveita botSecret());
 * sem nenhuma das duas, sobe só em dev com uma chave fixa — nunca em produção.
 */
/** Bot do Telegram pra alerta operacional (Fase 1 do roadmap de infra). Opcional —
 * sem essas duas vars, sendTelegramAlert() (src/notify.ts) vira no-op silencioso. */
export function telegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

export function telegramChatId(): string {
  return process.env.TELEGRAM_CHAT_ID?.trim() || "";
}

export function telegramConfigured(): boolean {
  return Boolean(telegramBotToken() && telegramChatId());
}

export function tokenEncryptionKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY?.trim() || botSecret();
  if (key) return key;
  if (isProduction()) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY (ou GLABS_BOT_SECRET) obrigatório em produção pra cifrar tokens salvos"
    );
  }
  return "dev-only-insecure-key-nao-usar-em-producao";
}
