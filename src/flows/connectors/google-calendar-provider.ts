/**
 * Provider "google" do connector de calendário — usa a conexão OAuth do
 * cliente (src/google-oauth.ts) pra falar direto com a Google Calendar API.
 * Sem SDK do Google, só fetch cru (mesmo estilo do resto do projeto).
 */
import { getCalendarIdFor, getValidAccessToken } from "../../google-oauth.js";
import type { ConnectorResult } from "./types.js";

const TZ = "America/Sao_Paulo";
const TZ_OFFSET = "-03:00"; // Brasil não tem mais horário de verão desde 2019

type Slot = { id: string; label: string; start: string; end: string };

function isoAt(y: number, m: number, d: number, h: number, min: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m + 1)}-${pad(d)}T${pad(h)}:${pad(min)}:00${TZ_OFFSET}`;
}

/** Dia da semana em horário de Brasília (0=domingo). */
function brWeekday(d: Date): number {
  return new Date(d.getTime() - 3 * 60 * 60 * 1000).getUTCDay();
}

function brDateParts(d: Date): { y: number; m: number; day: number } {
  const shifted = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * Slots candidatos: dias úteis, horário comercial, próximos `daysAhead` dias.
 * Depois filtrados pelos horários ocupados (freebusy) e pelos já passados.
 */
function candidateSlots(opts: {
  daysAhead: number;
  startHour: number;
  endHour: number;
  slotMin: number;
}): Slot[] {
  const out: Slot[] = [];
  const now = new Date();
  for (let d = 0; d < opts.daysAhead; d++) {
    const day = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const weekday = brWeekday(day);
    if (weekday === 0 || weekday === 6) continue; // só dias úteis
    const { y, m, day: dNum } = brDateParts(day);
    for (let mins = opts.startHour * 60; mins < opts.endHour * 60; mins += opts.slotMin) {
      const h = Math.floor(mins / 60);
      const min = mins % 60;
      const start = isoAt(y, m, dNum, h, min);
      const endMins = mins + opts.slotMin;
      const end = isoAt(y, m, dNum, Math.floor(endMins / 60), endMins % 60);
      const weekdayLabel = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][weekday];
      out.push({
        id: `slot_${out.length + 1}`,
        label: `${weekdayLabel} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
        start,
        end,
      });
    }
  }
  return out;
}

function overlapsBusy(slot: Slot, busy: { start: string; end: string }[]): boolean {
  const s = new Date(slot.start).getTime();
  const e = new Date(slot.end).getTime();
  return busy.some((b) => {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return s < be && e > bs;
  });
}

async function googleFetch(
  accessToken: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(12_000),
  });
}

async function freeBusy(
  accessToken: string,
  calendarId: string,
  from: Date,
  to: Date
): Promise<{ start: string; end: string }[]> {
  const res = await googleFetch(accessToken, "https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: calendarId }],
    }),
  });
  if (!res.ok) throw new Error(`freebusy_${res.status}`);
  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
  };
  return data.calendars?.[calendarId]?.busy || [];
}

export async function googleListSlots(
  clientId: string,
  config: Record<string, unknown>
): Promise<ConnectorResult> {
  const accessToken = await getValidAccessToken(clientId);
  if (!accessToken) {
    return {
      ok: false,
      error: "not_connected",
      message: "Google Calendar não conectado pra este cliente.",
      source: "google",
    };
  }
  const calendarId = await getCalendarIdFor(clientId);
  const daysAhead = Number(config.daysAhead) || 14;
  const startHour = Number(config.startHour) || 9;
  const endHour = Number(config.endHour) || 18;
  const slotMin = Number(config.slotMinutes) || 60;
  const maxResults = Number(config.maxResults) || 5;

  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const busy = await freeBusy(accessToken, calendarId, now, horizon);
    const candidates = candidateSlots({ daysAhead, startHour, endHour, slotMin });
    const free = candidates
      .filter((s) => new Date(s.start).getTime() > now.getTime())
      .filter((s) => !overlapsBusy(s, busy))
      .slice(0, maxResults);

    return {
      ok: true,
      source: "google",
      vars: {
        slots_json: JSON.stringify(free),
        slots_text: free.map((s, i) => `${i + 1}) ${s.label}`).join("\n"),
        slots_count: String(free.length),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: "google_freebusy_failed",
      message: e instanceof Error ? e.message : "falha ao consultar o Google Calendar",
      source: "google",
    };
  }
}

export async function googleCreateEvent(
  clientId: string,
  vars: Record<string, string>,
  config: Record<string, unknown>
): Promise<ConnectorResult> {
  const accessToken = await getValidAccessToken(clientId);
  if (!accessToken) {
    return { ok: false, error: "not_connected", message: "Google Calendar não conectado.", source: "google" };
  }
  const calendarId = await getCalendarIdFor(clientId);

  const nome = vars.nome || vars.name || "Cliente";
  const escolha = (vars.horario || vars.escolha || vars.slot || "").trim();
  let slot: Slot | null = null;
  if (vars.slots_json) {
    try {
      const slots = JSON.parse(vars.slots_json) as Slot[];
      const idx = /^\d+$/.test(escolha) ? Number(escolha) - 1 : -1;
      slot = idx >= 0 ? slots[idx] || null : slots.find((s) => s.label === escolha) || null;
    } catch {
      /* keep null */
    }
  }
  if (!slot) {
    return {
      ok: false,
      error: "slot_invalido",
      message: "Não consegui identificar o horário escolhido.",
      source: "google",
    };
  }

  const title = String(config.title || `Sessão com ${nome}`);
  try {
    const res = await googleFetch(
      accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        body: JSON.stringify({
          summary: title,
          description: `Agendado via glabz-bot para ${nome}.`,
          start: { dateTime: slot.start, timeZone: TZ },
          end: { dateTime: slot.end, timeZone: TZ },
        }),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `google_${res.status}`, message: t.slice(0, 200), source: "google" };
    }
    const data = (await res.json()) as { id: string; htmlLink: string };
    return {
      ok: true,
      source: "google",
      vars: {
        event_id: data.id,
        event_link: data.htmlLink,
        event_label: slot.label,
        event_summary: `${nome} · ${slot.label}`,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: "google_create_failed",
      message: e instanceof Error ? e.message : "falha ao criar evento",
      source: "google",
    };
  }
}

export async function googleCancelEvent(
  clientId: string,
  vars: Record<string, string>
): Promise<ConnectorResult> {
  const accessToken = await getValidAccessToken(clientId);
  if (!accessToken) {
    return { ok: false, error: "not_connected", message: "Google Calendar não conectado.", source: "google" };
  }
  const calendarId = await getCalendarIdFor(clientId);
  const eventId = vars.event_id || "";
  if (!eventId) {
    return { ok: false, error: "sem_event_id", message: "Nenhum evento pra cancelar.", source: "google" };
  }
  try {
    const res = await googleFetch(
      accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" }
    );
    if (!res.ok && res.status !== 410) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `google_${res.status}`, message: t.slice(0, 200), source: "google" };
    }
    return {
      ok: true,
      source: "google",
      vars: { cancelled_event_id: eventId, cancel_status: "cancelled" },
    };
  } catch (e) {
    return {
      ok: false,
      error: "google_cancel_failed",
      message: e instanceof Error ? e.message : "falha ao cancelar evento",
      source: "google",
    };
  }
}
