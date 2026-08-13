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
