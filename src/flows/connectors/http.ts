import type { ConnectorContext, ConnectorResult } from "./types.js";

/**
 * Connector HTTP genérico — POST JSON para URL configurada no nó.
 * Body: { vars, config, product, accountId }
 * Resposta esperada: { ok, vars?, error?, message? }
 */
export async function runHttp(opts: {
  vars: Record<string, string>;
  config?: Record<string, unknown>;
  ctx?: ConnectorContext;
}): Promise<ConnectorResult> {
  const config = opts.config || {};
  const url = String(config.url || config.webhookUrl || "").trim();
  if (!url) {
    return {
      ok: false,
      error: "missing_url",
      message: "Configure a URL do webhook no passo Ação.",
      source: "http",
    };
  }

  try {
    const method = String(config.method || "POST").toUpperCase();
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(typeof config.headers === "object" && config.headers
          ? (config.headers as Record<string, string>)
          : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify({
        vars: opts.vars,
        config: {
          ...config,
          // não reenviar secrets se houver
          headers: undefined,
        },
        product: opts.ctx?.product,
        accountId: opts.ctx?.accountId,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        ok: false,
        error: `http_${res.status}`,
        message: t.slice(0, 200) || `HTTP ${res.status}`,
        source: "http",
      };
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.ok === false) {
      return {
        ok: false,
        error: String(data.error || "remote_error"),
        message: String(data.message || "Falha no webhook"),
        source: "http",
      };
    }

    const vars: Record<string, string> = {};
    const raw = (data.vars && typeof data.vars === "object" ? data.vars : data) as Record<
      string,
      unknown
    >;
    for (const [k, v] of Object.entries(raw)) {
      if (k === "ok" || k === "error" || k === "message") continue;
      if (v == null) continue;
      vars[k] =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : JSON.stringify(v);
    }

    return { ok: true, vars, source: "http" };
  } catch (e) {
    return {
      ok: false,
      error: "http_failed",
      message: e instanceof Error ? e.message : "falha de rede",
      source: "http",
    };
  }
}
