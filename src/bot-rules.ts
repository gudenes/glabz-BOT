/**
 * Regras de quando e para quem o bot responde.
 *
 * Módulo puro de propósito: nada de I/O, nada de import de sessão ou de banco.
 * É o coração de uma decisão que, errada, faz o bot ficar mudo pra clientes
 * reais sem ninguém perceber — então tem que ser testável sozinho, sem
 * WhatsApp conectado.
 *
 * Regras AUSENTES significam "responde sempre", que é o comportamento de
 * quem nunca configurou nada. Nenhuma conta existente muda por causa deste
 * arquivo.
 */

/** Filtro por número: desligado, lista de permissão, ou lista de bloqueio. */
export type NumbersMode = "off" | "allow" | "block";

export type BotHours = {
  enabled: boolean;
  /** 0=domingo … 6=sábado. Vazio = nenhum dia, o que desliga na prática. */
  days: number[];
  /** "HH:MM" no fuso de `timezone`. */
  start: string;
  end: string;
};

export type BotRules = {
  numbers?: {
    mode: NumbersMode;
    list: string[];
  };
  /**
   * Fuso IANA ("America/Sao_Paulo"). Guardado junto porque um horário sem
   * fuso não quer dizer nada: o servidor roda em UTC, e "atende das 8 às 18"
   * viraria 5h–15h no relógio do dono.
   */
  timezone?: string;
  hours?: BotHours;
};

/** Fuso assumido quando a conta não escolheu — o do resto do produto. */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/**
 * Telefone em dígitos, no formato que dá pra comparar.
 *
 * O resto do sistema usa `replace(/\D/g,"")` puro, e pra comparar duas
 * pontas que vieram do MESMO lugar isso basta. Aqui não basta: um lado vem do
 * WhatsApp e o outro foi digitado à mão pelo dono, que escreve
 * "(11) 98765-4321", "+55 11 98765-4321" ou "11987654321" — tudo a mesma
 * pessoa.
 */
export function digitsOf(phone: string): string {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * Chave de comparação de telefone brasileiro, imune ao nono dígito.
 *
 * O problema real: o mesmo celular aparece como `5511987654321` (13 dígitos,
 * com o 9) ou `551187654321` (12, sem) dependendo de onde o número foi
 * cadastrado — números antigos circulam nas duas formas. Comparação literal
 * falharia, o dono acharia que ativou a lista e o bot ignoraria justamente
 * quem ele queria atender.
 *
 * Estratégia: reduzir a DDD + os 8 dígitos finais, que é a parte estável do
 * número. O DDI e o nono dígito somem da chave, então as duas formas colidem
 * de propósito.
 *
 * Número não-brasileiro (ou curto demais pra ter DDD) cai no digits puro —
 * não dá pra assumir estrutura de número que não conhecemos, e um palpite
 * errado aqui casaria pessoas diferentes.
 */
export function phoneKey(phone: string): string {
  let d = digitsOf(phone);
  if (!d) return "";
  // Tira o DDI do Brasil só quando o que sobra tem cara de número brasileiro
  // (10 dígitos = fixo com DDD, 11 = celular com DDD).
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  // DDD + 8 finais. Um celular com o 9 (11 dígitos) e o mesmo sem (10)
  // produzem a mesma chave.
  if (d.length === 10 || d.length === 11) return d.slice(0, 2) + d.slice(-8);
  return d;
}

/** O telefone está na lista? Compara por chave, não por texto. */
export function phoneInList(list: string[] | undefined, phone: string): boolean {
  const key = phoneKey(phone);
  if (!key) return false;
  return (list || []).some((entry) => {
    const k = phoneKey(entry);
    return k !== "" && k === key;
  });
}

/**
 * O bot pode responder a este número?
 *
 * Lista VAZIA nunca ativa o filtro, em nenhum dos dois modos. É uma escolha
 * deliberada: em "allow" uma lista vazia significaria "não responda a
 * ninguém", que é o pior estado possível pra se cair sem querer — o dono
 * escolhe o modo, ainda não digitou ninguém, e o atendimento morre calado.
 */
export function numbersAllow(rules: BotRules | undefined, phone: string): boolean {
  const cfg = rules?.numbers;
  if (!cfg || cfg.mode === "off") return true;
  const list = (cfg.list || []).filter((n) => phoneKey(n) !== "");
  if (!list.length) return true;
  const hit = phoneInList(list, phone);
  return cfg.mode === "allow" ? hit : !hit;
}

/**
 * Normaliza a lista que veio do formulário: descarta o que não tem dígito
 * nenhum e remove repetido (o mesmo número escrito de duas formas conta uma
 * vez só). Guarda os dígitos, não a chave — a chave perde informação e o dono
 * precisa reconhecer o que digitou quando reabrir a tela.
 */
export function normalizeNumberList(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const digits = digitsOf(String(item ?? ""));
    if (!digits) continue;
    const key = phoneKey(digits);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(digits);
  }
  return out;
}

/** Saneia o que chegou da API antes de gravar. Desconhecido vira padrão seguro. */
export function normalizeBotRules(input: unknown): BotRules | undefined {
  const src = (input || {}) as Record<string, unknown>;
  const numbersSrc = (src.numbers || {}) as Record<string, unknown>;
  const mode: NumbersMode =
    numbersSrc.mode === "allow" || numbersSrc.mode === "block" ? numbersSrc.mode : "off";
  const list = normalizeNumberList(numbersSrc.list);

  const hoursSrc = (src.hours || {}) as Record<string, unknown>;
  const start = parseHhMm(String(hoursSrc.start ?? "")) === null ? "08:00" : String(hoursSrc.start);
  const end = parseHhMm(String(hoursSrc.end ?? "")) === null ? "18:00" : String(hoursSrc.end);
  const days = Array.isArray(hoursSrc.days)
    ? [...new Set(hoursSrc.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
        .sort((a, b) => a - b)
    : [];
  // Marcar "ligado" sem escolher dia nenhum é engano, não configuração — e
  // aceitar isso calaria o bot pra sempre. Vale como desligado.
  const hoursOn = hoursSrc.enabled === true && days.length > 0;

  const tz = typeof src.timezone === "string" && isValidTimezone(src.timezone) ? src.timezone : null;

  // Nada configurado = campo ausente, e conta sem o campo se comporta como
  // sempre. Guardar `{mode:"off"}` funcionaria igual, mas suja o registry.
  if (mode === "off" && !list.length && !hoursOn) return undefined;

  const out: BotRules = { numbers: { mode, list } };
  if (hoursOn) out.hours = { enabled: true, days, start, end };
  if (tz) out.timezone = tz;
  return out;
}

/** Fuso que o Intl deste runtime reconhece — evita gravar lixo digitado. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Que dia e que horas são, agora, no fuso da conta.
 *
 * NÃO reaproveita src/br-time.ts de propósito: aquele módulo assume Brasília
 * com offset FIXO (-03:00, sem horário de verão), o que é correto pro que ele
 * atende mas não serve pra um fuso escolhido pelo dono. Aqui o Intl resolve
 * fuso e horário de verão sozinho, sem dependência nova (o Node do projeto
 * tem ICU completo — 418 fusos, verificado).
 *
 * Consequência conhecida: um cliente em Manaus teria o BOT no fuso certo e a
 * AGENDA ainda em Brasília, que continua usando br-time. Unificar é trabalho
 * à parte.
 */
export function zonedNow(now: Date, timezone: string): { weekday: number; minutes: number } {
  const tz = timezone || DEFAULT_TIMEZONE;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
  } catch {
    // Fuso inválido (dado antigo, digitação): cai no padrão em vez de
    // estourar. Um erro aqui derrubaria o atendimento inteiro.
    return zonedNow(now, DEFAULT_TIMEZONE);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = WEEK.indexOf(get("weekday"));
  // "24" aparece à meia-noite em alguns ambientes com hour12:false.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { weekday: weekday < 0 ? 0 : weekday, minutes: hour * 60 + minute };
}

/** "HH:MM" → minutos desde a meia-noite. Formato inválido devolve null. */
export function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * O bot está dentro da janela de atendimento agora?
 *
 * Janela que VIRA A NOITE é caso real, não exceção: pizzaria das 18:00 às
 * 02:00. Quando o fim é menor ou igual ao início, a janela cruza a
 * meia-noite, e o dia marcado é o dia em que ela COMEÇA — 01:00 de terça
 * pertence à janela que abriu segunda.
 */
export function isWithinHours(rules: BotRules | undefined, now: Date = new Date()): boolean {
  const h = rules?.hours;
  if (!h || !h.enabled) return true;
  const start = parseHhMm(h.start);
  const end = parseHhMm(h.end);
  // Horário mal formado não pode calar o bot — o dono não teria como
  // perceber a causa.
  if (start === null || end === null) return true;
  const days = Array.isArray(h.days) ? h.days : [];
  if (!days.length) return true;

  const { weekday, minutes } = zonedNow(now, rules?.timezone || DEFAULT_TIMEZONE);
  if (end > start) return days.includes(weekday) && minutes >= start && minutes < end;
  // Vira a noite: ou é depois da abertura hoje, ou é antes do fechamento e a
  // janela abriu ontem.
  const yesterday = (weekday + 6) % 7;
  if (minutes >= start) return days.includes(weekday);
  if (minutes < end) return days.includes(yesterday);
  return false;
}

/** O bot pode responder agora, a esta pessoa? Junta as duas travas. */
export function botShouldAnswer(
  rules: BotRules | undefined,
  phone: string,
  now: Date = new Date()
): { ok: true } | { ok: false; reason: "numbers" | "hours" } {
  if (!numbersAllow(rules, phone)) return { ok: false, reason: "numbers" };
  if (!isWithinHours(rules, now)) return { ok: false, reason: "hours" };
  return { ok: true };
}
