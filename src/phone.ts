/**
 * Normaliza telefone → dígitos E.164 (sem +) e JID WhatsApp.
 *
 * - Com + ou 00: trata como internacional (não força 55).
 * - DDI conhecido no início (34, 55, 351, 1, …): mantém.
 * - 10–11 dígitos sem DDI: assume Brasil (55) — carteira local.
 * - ES: 9 dígitos começando com 6/7 → assume 34 (móvel).
 */

export function digitsOnly(input: string): string {
  return input.replace(/\D/g, "");
}

/** Mais longos primeiro para não casar "1" antes de "351", etc. */
const EXPLICIT_DDI_PREFIXES = [
  "598", // UY
  "595", // PY
  "593", // EC
  "591", // BO
  "351", // PT
  "57", // CO
  "56", // CL
  "55", // BR
  "54", // AR
  "49", // DE
  "44", // UK
  "39", // IT
  "34", // ES
  "33", // FR
  "31", // NL
  "32", // BE
  "41", // CH
  "43", // AT
  "46", // SE
  "47", // NO
  "48", // PL
  "52", // MX
  "61", // AU
  "81", // JP
  "86", // CN
  "91", // IN
  "1", // US/CA
].sort((a, b) => b.length - a.length);

function hasExplicitDdi(d: string): boolean {
  return EXPLICIT_DDI_PREFIXES.some((p) => {
    if (!d.startsWith(p)) return false;
    // DDI + pelo menos 8 dígitos nacionais (mínimo razoável E.164)
    return d.length >= p.length + 8 && d.length <= 15;
  });
}

/**
 * E.164 só dígitos (sem +).
 * Aceita: "+34 612…", "0034612…", "34612…", BR local "51999…".
 */
export function toE164(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const internationalHint =
    raw.startsWith("+") || raw.startsWith("00") || /^\s*\+/.test(raw);

  let d = digitsOnly(raw);
  // 00xx… (discagem internacional)
  if (d.startsWith("00") && d.length > 4) {
    d = d.slice(2);
  }

  if (!d || d.length < 8 || d.length > 15) return null;

  // Já veio com DDI reconhecido
  if (hasExplicitDdi(d)) return d;

  // Usuário marcou internacional (+ / 00) mas DDI não está na lista:
  // se tiver 10–15 dígitos, confia no E.164 cru (WhatsApp valida o resto).
  if (internationalHint && d.length >= 10 && d.length <= 15) {
    return d;
  }

  // Espanha: móvel nacional 9 dígitos (6xx / 7xx)
  if (d.length === 9 && /^[67]\d{8}$/.test(d)) {
    return `34${d}`;
  }

  // BR: DDD + número (10 ou 11) sem 55
  if (d.length === 10 || d.length === 11) {
    // Evita prefixar 55 em algo que já parece outro país (ex. 34… com 11 dígitos sem casar hasExplicit)
    if (d.startsWith("34") && d.length === 11) return d;
    return `55${d}`;
  }

  // Internacional longo sem + (ex. 34612345678 já coberto; 3519… etc.)
  if (d.length >= 12 && d.length <= 15) return d;

  return null;
}

/** @deprecated use toE164 */
export function toE164Br(input: string): string | null {
  return toE164(input);
}

export function toWhatsAppJid(input: string): string | null {
  const e164 = toE164(input);
  if (!e164) return null;
  return `${e164}@s.whatsapp.net`;
}

export function formatPhoneDisplay(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const d = digitsOnly(e164);
  if (d.startsWith("55") && d.length >= 12) {
    const rest = d.slice(2);
    const ddd = rest.slice(0, 2);
    const num = rest.slice(2);
    if (num.length === 9) return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
    if (num.length === 8) return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  }
  if (d.startsWith("34") && d.length === 11) {
    const n = d.slice(2);
    return `+34 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  if (d.startsWith("351") && d.length >= 12) {
    const n = d.slice(3);
    return `+351 ${n}`;
  }
  return `+${d}`;
}
