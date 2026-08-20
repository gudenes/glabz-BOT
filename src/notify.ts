/**
 * Alerta operacional (Fase 1 do roadmap de infra) — hoje só Telegram, via fetch puro
 * (sem lib nova, mesmo espírito do connector do Google Calendar). Sem
 * TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID configurados, vira no-op silencioso — nunca
 * bloqueia nem derruba o fluxo de WhatsApp por causa de um alerta que falhou.
 */
import { isProduction, telegramBotToken, telegramChatId, telegramConfigured } from "./config.js";
import { getAccount } from "./registry.js";
import { listClientUsers } from "./clients.js";

/** Sem client de teste em dev/staging, os alertas por e-mail sempre vão pra cá. */
const DEV_ALERT_EMAIL = "zabadal@gmail.com";

export async function sendTelegramAlert(text: string): Promise<void> {
  if (!telegramConfigured()) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${telegramBotToken()}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId(),
          text,
          parse_mode: "HTML",
        }),
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(`[notify] telegram ${res.status}: ${t.slice(0, 200)}`);
    }
  } catch (e) {
    console.error("[notify] telegram failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * E-mail que deve receber o alerta dessa account: em produção, o e-mail
 * cadastrado no onboarding do client dono da account (tabela users, mesmo
 * usuário que provisionClient() cria — reaproveita listClientUsers, já usada
 * pro card de perfil em impersonation). Fora de produção (dev/staging), sempre
 * DEV_ALERT_EMAIL — não faz sentido resolver client real num ambiente de teste.
 */
async function resolveAlertEmail(accountId: string): Promise<string | null> {
  if (!isProduction()) return DEV_ALERT_EMAIL;
  const clientId = getAccount(accountId)?.clientId;
  if (!clientId) return null;
  try {
    const users = await listClientUsers(clientId);
    return users[0]?.email || null;
  } catch (e) {
    console.error("[notify] resolveAlertEmail failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Alerta por e-mail — DÉBITO TÉCNICO DELIBERADO: ainda sem provedor escolhido
 * (Resend/SMTP/outro — decisão pendente). Toda a lógica de "pra quem enviar"
 * já está pronta e testável (produção → e-mail do onboarding do client; dev/
 * staging → DEV_ALERT_EMAIL); só falta trocar o console.log abaixo por uma
 * chamada HTTP de verdade quando o provedor for escolhido.
 */
export async function sendEmailAlert(
  accountId: string,
  subject: string,
  text: string
): Promise<void> {
  const to = await resolveAlertEmail(accountId);
  if (!to) return;
  console.log(`[notify] EMAIL (provedor pendente) to=${to} subject="${subject}" body="${text}"`);
}
