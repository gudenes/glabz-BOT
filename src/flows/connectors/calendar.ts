import type { ConnectorContext, ConnectorResult } from "./types.js";

export type CalendarOp = "list_slots" | "create_event" | "cancel_event";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Gera 3 slots demo a partir de preferência textual. */
function mockSlots(quando: string): { id: string; label: string; start: string }[] {
  const q = (quando || "").toLowerCase();
  const baseDay =
    q.includes("ter") ? "Terça" :
    q.includes("qua") ? "Quarta" :
    q.includes("qui") ? "Quinta" :
    q.includes("sex") ? "Sexta" :
    q.includes("sab") || q.includes("sáb") ? "Sábado" :
    q.includes("dom") ? "Domingo" :
    q.includes("amanh") ? "Amanhã" :
    "Próxima terça";

  const evening = /noite|18|19|20|tarde/.test(q);
  const morning = /manh|9|10|11/.test(q);

  const times = evening
    ? ["18:00", "19:00", "20:00"]
    : morning
      ? ["09:00", "10:00", "11:00"]
      : ["10:00", "14:00", "18:00"];

  return times.map((t, i) => ({
    id: `slot_${i + 1}`,
    label: `${baseDay} ${t}`,
    start: `${baseDay} ${t}`,
  }));
}

function formatSlotsText(slots: { label: string }[]): string {
  return slots.map((s, i) => `${i + 1}) ${s.label}`).join("\n");
}

async function callHttpWebhook(
  url: string,
  body: Record<string, unknown>
): Promise<ConnectorResult | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
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
        message: String(data.message || data.error || "Falha no calendário"),
        source: "http",
        vars: flattenVars(data.vars),
      };
    }
    return {
      ok: true,
      source: "http",
      vars: flattenVars(data.vars ?? data),
    };
  } catch (e) {
    return {
      ok: false,
      error: "http_failed",
      message: e instanceof Error ? e.message : "falha de rede",
      source: "http",
    };
  }
}

function flattenVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else if (Array.isArray(v) || typeof v === "object") {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/**
 * Connector calendário.
 * - Se `webhookUrl` (ou CALENDAR_WEBHOOK_URL) → HTTP
 * - Senão → mock determinístico (demo + simulador)
 */
export async function runCalendar(opts: {
  operation: CalendarOp | string;
  vars: Record<string, string>;
  config?: Record<string, unknown>;
  ctx?: ConnectorContext;
}): Promise<ConnectorResult> {
  const op = String(opts.operation || "list_slots") as CalendarOp;
  const vars = opts.vars || {};
  const config = opts.config || {};
  const webhookUrl =
    String(config.webhookUrl || process.env.CALENDAR_WEBHOOK_URL || "").trim() ||
    null;

  // Preferir HTTP se configurado (mesmo no simulador, se quiser real)
  const forceMock =
    config.forceMock === true ||
    (opts.ctx?.simulate && config.useMockInSim !== false && !webhookUrl);

  if (webhookUrl && !forceMock) {
    const remote = await callHttpWebhook(webhookUrl, {
      connector: "calendar",
      operation: op,
      vars,
      config: {
        calendarId: config.calendarId,
        durationMin: config.durationMin ?? 60,
        title: config.title,
      },
      product: opts.ctx?.product,
      accountId: opts.ctx?.accountId,
    });
    if (remote) {
      // Normaliza campos esperados se o remoto mandou slots[]
      if (remote.ok && remote.vars) {
        if (!remote.vars.slots_text && remote.vars.slots) {
          try {
            const arr = JSON.parse(remote.vars.slots) as { label?: string }[];
            if (Array.isArray(arr)) {
              remote.vars.slots_text = formatSlotsText(
                arr.map((s) => ({ label: s.label || String(s) }))
              );
            }
          } catch {
            /* keep */
          }
        }
      }
      return remote;
    }
  }

  // ── Mock ──────────────────────────────────────────────
  if (op === "list_slots") {
    const slots = mockSlots(vars.quando || vars.preferencia || vars.last || "");
    return {
      ok: true,
      source: "mock",
      vars: {
        slots_json: JSON.stringify(slots),
        slots_text: formatSlotsText(slots),
        slots_count: String(slots.length),
      },
    };
  }

  if (op === "create_event") {
    const nome = vars.nome || vars.name || "Cliente";
    const escolha = (vars.horario || vars.escolha || vars.slot || "").trim();
    let label = escolha;

    // Se escolheu "1"/"2"/"3", resolve via slots_json
    if (/^[123]$/.test(escolha) && vars.slots_json) {
      try {
        const slots = JSON.parse(vars.slots_json) as { label: string }[];
        const idx = Number(escolha) - 1;
        if (slots[idx]) label = slots[idx].label;
      } catch {
        /* keep */
      }
    }
    if (!label) label = vars.quando || "horário a confirmar";

    const eventId = `evt_mock_${slugify(nome)}_${Date.now().toString(36)}`;
    const eventLink = `https://cal.example/e/${eventId}`;

    return {
      ok: true,
      source: "mock",
      vars: {
        event_id: eventId,
        event_link: eventLink,
        event_label: label,
        event_summary: `${nome} · ${label}`,
      },
    };
  }

  if (op === "cancel_event") {
    const id = vars.event_id || "unknown";
    return {
      ok: true,
      source: "mock",
      vars: {
        cancelled_event_id: id,
        cancel_status: "cancelled",
      },
    };
  }

  return {
    ok: false,
    error: "unknown_operation",
    message: `Operação de calendário desconhecida: ${op}`,
    source: "mock",
  };
}
