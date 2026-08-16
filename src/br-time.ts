/**
 * Datas em horário de Brasília — o servidor roda em UTC puro (sem TZ setado),
 * e o Brasil não tem mais horário de verão desde 2019, então um offset fixo
 * de -03:00 já resolve sem precisar de lib de timezone.
 */
export const BR_OFFSET_MS = 3 * 60 * 60 * 1000;

export const BR_WEEKDAY_NAMES = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

export function brLocalParts(d: Date): { y: number; m: number; day: number } {
  const shifted = new Date(d.getTime() - BR_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/** Dia da semana em horário de Brasília (0=domingo). */
export function brWeekday(d: Date): number {
  return new Date(d.getTime() - BR_OFFSET_MS).getUTCDay();
}

export function brMidnightUtc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day, 0, 0, 0) + BR_OFFSET_MS);
}

/** "YYYY-MM-DD" do dia calendário em horário de Brasília. */
export function brDateIso(d: Date): string {
  const { y, m, day } = brLocalParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m + 1)}-${pad(day)}`;
}
