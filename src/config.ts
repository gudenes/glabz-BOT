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
