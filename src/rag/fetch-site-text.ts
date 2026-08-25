/**
 * Busca o texto legível de um site que o dono informou (item 5b da lista de
 * observações) — a alternativa mais simples e sem risco de ToS ao scraping
 * de redes sociais: só o próprio site do cliente, sob URL que ele mesmo deu.
 *
 * Cuidado central: deixar o servidor buscar uma URL escolhida por quem usa o
 * portal é um vetor clássico de SSRF (o servidor vira uma sonda pra rede
 * interna — outros serviços do Railway, metadata endpoint de nuvem, etc.).
 * Por isso: só http(s), resolve o host e recusa IP privado/loopback/link-
 * local ANTES de buscar, timeout curto, teto de tamanho de resposta.
 */
import dns from "node:dns/promises";
import net from "node:net";

const FETCH_TIMEOUT_MS = 15_000;
// Sites reais (Wix, WordPress cheio de plugin, Squarespace) facilmente passam
// de 1-2MB de HTML bruto só em script/tracking/CSS inline — o texto útil de
// verdade é uma fração pequena disso, removida depois por htmlToText(). Um
// teto pensado pra "página de texto" (500KB) estourava em teste real com
// site comum. 6MB ainda protege contra download de arquivo grande/binário
// mislabeled, sem barrar página de negócio normal.
const MAX_BYTES = 6_000_000;

/** true se o IP (v4 ou v6) é privado, loopback, link-local ou reservado. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7)); // IPv4 mapeado
    return false;
  }
  return true; // não reconhecido — trata como suspeito, recusa por padrão
}

async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new Error("não consegui resolver esse endereço");
  }
  if (!addresses.length || addresses.some(isPrivateIp)) {
    throw new Error("essa URL aponta pra um endereço não permitido");
  }
}

/** Remove tags/scripts/styles e devolve texto legível, colapsado. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function fetchRawHtml(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("só http/https são aceitos");
  }
  await assertPublicHost(url.hostname);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "glabz-bot-onboarding/1.0 (+https://glabz.app)" },
    });
    if (!res.ok) throw new Error(`site respondeu HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error("essa URL não parece ser uma página de texto/HTML");
    }
    // Node não expõe IP final pós-redirect sem inspecionar manualmente cada
    // hop — o check de host acima cobre a URL de entrada; redirects pra IP
    // privado ficam como risco residual aceito (mitigado pelo timeout curto
    // e teto de tamanho, e pelo fato de ninguém confiar na resposta pra nada
    // além de virar texto pra revisão humana antes de salvar).
    const reader = res.body?.getReader();
    if (!reader) throw new Error("resposta vazia");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("página grande demais");
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSiteText(rawUrl: string): Promise<string> {
  const text = htmlToText(await fetchRawHtml(rawUrl));
  if (text.length < 20) throw new Error("não achei texto legível nessa página");
  return text;
}

const MAX_EXTRA_PAGES = 3;
const PER_PAGE_TEXT_CAP = 3000; // cada página cede espaço pras outras terem chance no teto do LLM

// Trechos de URL/texto de link que sinalizam página com conhecimento de
// atendimento (não é exaustivo, é heurística — melhor perder um link
// relevante do que virar um crawler genérico do site inteiro).
const RELEVANT_LINK_HINTS = [
  "sobre", "about", "quem-somos", "quemsomos",
  "contato", "contact", "fale-conosco", "faleconosco",
  "faq", "perguntas", "duvidas", "dúvidas",
  "servico", "serviço", "service",
  "preco", "preço", "price", "planos",
  "horario", "horário", "atendimento",
];

function sameHost(a: string, b: string): boolean {
  try {
    const na = new URL(a).hostname.replace(/^www\./, "");
    const nb = new URL(b).hostname.replace(/^www\./, "");
    return na === nb;
  } catch {
    return false;
  }
}

/** Acha até `max` links do MESMO domínio cujo endereço ou texto visível
 * sugere conteúdo relevante (sobre/contato/faq/etc.) — via regex, não um
 * parser de HTML de verdade (o projeto não tem um; suficiente pra achar
 * `<a href>`). */
function pickRelevantLinks(html: string, baseUrl: string, max: number): string[] {
  const seen = new Set<string>([baseUrl]);
  const found: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && found.length < max) {
    let abs: string;
    try {
      abs = new URL(m[1].trim(), baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(abs) || !sameHost(abs, baseUrl)) continue;
    const linkText = m[2].replace(/<[^>]+>/g, " ").toLowerCase();
    const haystack = (abs + " " + linkText).toLowerCase();
    if (!RELEVANT_LINK_HINTS.some((hint) => haystack.includes(hint))) continue;
    seen.add(abs);
    found.push(abs);
  }
  return found;
}

/**
 * Busca a home do site + até `maxExtraPages` páginas relacionadas do MESMO
 * domínio (sobre/contato/faq/etc., achadas a partir dos links da home) —
 * item 5b, "procurar em outras páginas do domínio". As páginas extras
 * buscam em paralelo e falha individual não derruba o resto (Promise.
 * allSettled) — só a home é obrigatória.
 */
export async function fetchSiteKnowledgeText(
  rootUrl: string,
  opts?: { maxExtraPages?: number }
): Promise<string> {
  const maxExtra = opts?.maxExtraPages ?? MAX_EXTRA_PAGES;
  const rootHtml = await fetchRawHtml(rootUrl);
  const rootText = htmlToText(rootHtml).slice(0, PER_PAGE_TEXT_CAP);
  if (rootText.length < 20) throw new Error("não achei texto legível nessa página");

  const extraUrls = maxExtra > 0 ? pickRelevantLinks(rootHtml, rootUrl, maxExtra) : [];
  const extraResults = await Promise.allSettled(
    extraUrls.map(async (u) => ({
      url: u,
      text: htmlToText(await fetchRawHtml(u)).slice(0, PER_PAGE_TEXT_CAP),
    }))
  );

  const parts = [`--- Página principal: ${rootUrl} ---\n${rootText}`];
  for (const r of extraResults) {
    if (r.status === "fulfilled" && r.value.text.length >= 20) {
      parts.push(`--- ${r.value.url} ---\n${r.value.text}`);
    }
  }
  return parts.join("\n\n");
}
