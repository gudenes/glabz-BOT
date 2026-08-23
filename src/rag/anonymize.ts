/**
 * Remove identificadores pessoais antes de qualquer texto virar vetor.
 *
 * Decisão registrada em docs/rag-desenho.md §5.1: o histórico de WhatsApp é
 * dado do CLIENTE FINAL (não da GLabs nem do dono do negócio), e indexar cria
 * uma cópia derivada dele. Perde-se pouco tirando os identificadores — a
 * resposta útil quase nunca depende de QUEM perguntou.
 *
 * Não é anonimização perfeita (nada baseado em regex é), mas cobre o que
 * aparece de fato numa conversa de atendimento.
 */

/** Substitutos legíveis — mantêm o texto natural pro modelo de embedding. */
const MASK = {
  phone: "[telefone]",
  email: "[email]",
  cpf: "[documento]",
  cnpj: "[documento]",
  cep: "[cep]",
  card: "[cartão]",
  name: "[nome]",
} as const;

/**
 * Telefone BR em formatos variados: +55 51 99999-9999, (51) 99999-9999,
 * 51999999999. Exige 10+ dígitos pra não engolir preço ou quantidade.
 */
const PHONE_RE = /(?:\+?55\s?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const CEP_RE = /\b\d{5}-?\d{3}\b/g;
/** Sequência longa de dígitos — cartão, conta. Depois dos demais, pra não roubar deles. */
const LONG_DIGITS_RE = /\b\d{13,19}\b/g;

/**
 * Mascara o nome da pessoa quando ele aparece no texto.
 *
 * Recebe o nome de fora (vem de `pushName`/`author_name` na mensagem) em vez de
 * tentar adivinhar por maiúsculas — chutar nome no texto acaba mascarando dia
 * da semana, bairro e nome de serviço, o que estraga a busca.
 *
 * Mascara TODAS as partes do nome, não só a primeira: "Ana Paula" precisa virar
 * "[nome]" inteiro. Mascarar só o primeiro deixava "[nome] Paula" — vazava o
 * sobrenome e ainda fazia duas respostas iguais parecerem diferentes,
 * quebrando o agrupamento por repetição.
 *
 * Partes coladas viram um único [nome], em vez de "[nome] [nome]".
 */
function maskKnownName(text: string, name?: string | null): string {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    // Preposições de sobrenome ("de", "da", "dos") são palavras comuns demais
    // pra mascarar — sozinhas não identificam ninguém.
    .filter((p) => p.length >= 3 && !/^(de|da|do|das|dos|e)$/i.test(p))
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return text;

  const nameRe = new RegExp(`\\b(?:${parts.join("|")})(?:\\s+(?:${parts.join("|")}))*\\b`, "gi");
  return text.replace(nameRe, MASK.name);
}

export function anonymize(text: string, opts?: { name?: string | null }): string {
  let out = String(text || "");

  // Ordem importa. Primeiro os formatos inconfundíveis (e-mail, CNPJ, CEP,
  // sequência muito longa); depois telefone; e CPF por último.
  //
  // Telefone antes de CPF de propósito: CPF sem pontuação e celular com DDD
  // têm ambos 11 dígitos e são indistinguíveis sem contexto. Nesta ordem,
  // "51998877665" vira [telefone] e "123.456.789-00" ainda vira [documento],
  // que é o resultado certo nos dois casos comuns. De qualquer forma o dado
  // sai — a ordem só decide o rótulo.
  out = out.replace(EMAIL_RE, MASK.email);
  out = out.replace(CNPJ_RE, MASK.cnpj);
  out = out.replace(CEP_RE, MASK.cep);
  out = out.replace(LONG_DIGITS_RE, MASK.card);
  out = out.replace(PHONE_RE, MASK.phone);
  out = out.replace(CPF_RE, MASK.cpf);
  out = maskKnownName(out, opts?.name);
  return out.replace(/\s+/g, " ").trim();
}
