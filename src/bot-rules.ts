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

export type BotRules = {
  numbers?: {
    mode: NumbersMode;
    list: string[];
  };
};

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
  // Nada configurado = campo ausente, e conta sem o campo se comporta como
  // sempre. Guardar `{mode:"off"}` funcionaria igual, mas suja o registry.
  if (mode === "off" && !list.length) return undefined;
  return { numbers: { mode, list } };
}
