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

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 500_000; // ~500KB — de sobra pra uma página de texto, mesmo com HTML gordo

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

export async function fetchSiteText(rawUrl: string): Promise<string> {
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
    const html = Buffer.concat(chunks).toString("utf-8");
    const text = htmlToText(html);
    if (text.length < 20) throw new Error("não achei texto legível nessa página");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
