/**
 * Carrega .env.local para os testes que chamam o modelo de verdade.
 *
 * O projeto não usa dotenv em produção (o Railway injeta as variáveis), então
 * isto vive só nos testes. O arquivo é ignorado pelo git — ver .gitignore.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadEnvLocal(): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    // Variável já definida no ambiente vence o arquivo.
    if (process.env[name]) continue;
    process.env[name] = trimmed.slice(eq + 1).trim();
  }
}

/** Há chave de IA disponível? Os testes contra o modelo real se pulam sem ela. */
export function hasLlmKey(): boolean {
  loadEnvLocal();
  return Boolean(
    process.env.GLABS_LLM_API_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY
  );
}
