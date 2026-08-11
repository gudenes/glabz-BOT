import { runCalendar } from "./calendar.js";
import { runHttp } from "./http.js";
import type { ConnectorContext, ConnectorResult } from "./types.js";

export type { ConnectorContext, ConnectorResult } from "./types.js";

/**
 * Executa o connector do nó `action`.
 * data do nó:
 *   connector: "calendar" | "http"
 *   operation: string (ex. list_slots)
 *   config?: { webhookUrl, url, durationMin, ... }
 *   label?: string
 */
export async function runAction(opts: {
  connector: string;
  operation?: string;
  vars: Record<string, string>;
  config?: Record<string, unknown>;
  ctx?: ConnectorContext;
}): Promise<ConnectorResult> {
  const connector = (opts.connector || "calendar").toLowerCase();
  const config = opts.config || {};

  if (connector === "calendar") {
    return runCalendar({
      operation: opts.operation || "list_slots",
      vars: opts.vars,
      config,
      ctx: opts.ctx,
    });
  }

  if (connector === "http") {
    return runHttp({
      vars: opts.vars,
      config,
      ctx: opts.ctx,
    });
  }

  return {
    ok: false,
    error: "unknown_connector",
    message: `Integração desconhecida: ${connector}`,
    source: "none",
  };
}
