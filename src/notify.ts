/**
 * Alerta operacional (Fase 1 do roadmap de infra) — hoje só Telegram, via fetch puro
 * (sem lib nova, mesmo espírito do connector do Google Calendar). Sem
 * TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID configurados, vira no-op silencioso — nunca
 * bloqueia nem derruba o fluxo de WhatsApp por causa de um alerta que falhou.
 */
import { telegramBotToken, telegramChatId, telegramConfigured } from "./config.js";

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
