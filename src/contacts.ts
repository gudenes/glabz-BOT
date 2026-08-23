import { toE164 } from "./phone.js";

export type AgendaContact = {
  phoneE164: string;
  name: string;
};

function bareFromJid(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? "";
}

function phoneFromJid(jid: string): string | null {
  if (!jid) return null;
  if (
    jid.includes("@g.us") ||
    jid.includes("@broadcast") ||
    jid.includes("@newsletter") ||
    jid.includes("@lid")
  ) {
    return null;
  }
  return toE164(bareFromJid(jid));
}

/**
 * Converte um Contact do Baileys em linha da agenda. Grupos, LID sem PN e o próprio
 * número caem fora.
 */
export function contactFromBaileys(raw: unknown, selfPhone?: string | null): AgendaContact | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === "string" ? c.id : "";
  const pn =
    (typeof c.phoneNumber === "string" && c.phoneNumber) ||
    (typeof c.pn === "string" && c.pn) ||
    (typeof c.notifyPn === "string" && c.notifyPn) ||
    (typeof c.pnJid === "string" && c.pnJid) ||
    "";

  const phone = phoneFromJid(pn) ?? phoneFromJid(id);
  if (!phone) return null;
  if (selfPhone && phone === selfPhone) return null;

  const nameRaw = [c.name, c.notify, c.verifiedName, c.displayName, c.username].find(
    (v) => typeof v === "string" && v.trim(),
  ) as string | undefined;
  const name = nameRaw?.trim() || phone;
  return { phoneE164: phone, name };
}

export function ingestContacts(
  map: Map<string, AgendaContact>,
  list: unknown[],
  selfPhone?: string | null,
): void {
  for (const raw of list) {
    const row = contactFromBaileys(raw, selfPhone);
    if (!row) continue;
    const prev = map.get(row.phoneE164);
    if (!prev || (prev.name === prev.phoneE164 && row.name !== row.phoneE164)) {
      map.set(row.phoneE164, row);
    }
  }
}
