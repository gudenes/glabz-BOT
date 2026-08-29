/**
 * Servidor mínimo que serve o portal real e responde a API com dados falsos.
 *
 * O portal é carregado como módulo ES, então `file://` não serve (o navegador
 * bloqueia). Um servidor local resolve, e de quebra permite responder
 * `/v1/...` com fixtures — assim a tela sobe inteira, com o CSS e o JS de
 * verdade, sem banco, sem WhatsApp e sem login.
 *
 * A diferença pro que eu fazia antes: os testes de tela usavam um DOM
 * montado à mão, que não tem layout nem pintura. Aqui é o Chrome renderizando
 * os arquivos que vão pra produção.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export type Fixtures = Record<string, unknown>;

/** Respostas padrão: um cliente conectado, sem fluxo publicado ainda. */
export function fixturesPadrao(over: Fixtures = {}): Fixtures {
  return {
    "/v1/auth/me": { ok: true, user: { id: "u1", email: "dono@exemplo.com", name: "Carlos", role: "client", clientId: "c1" } },
    "/v1/portal": {
      ok: true,
      client: { id: "c1", name: "C3 Pilates", slug: "c3-pilates" },
      accounts: [
        {
          account: { id: "a1", product: "c3-pilates", clientId: "c1", label: null },
          session: { accountId: "a1", status: "disconnected", qrDataUrl: null, phoneE164: null },
        },
      ],
      flows: [],
      liveFlow: null,
      users: [{ id: "u1", email: "dono@exemplo.com", name: "Carlos" }],
      llmConfigured: true,
      impersonating: false,
    },
    "/v1/portal/dashboard": { ok: true, totals: {}, series: [] },
    "/v1/rag/knowledge": { ok: true, items: [] },
    "/v1/inbox/threads": { ok: true, threads: [] },
    "/v1/flows/templates": { ok: true, templates: [] },
    ...over,
  };
}

export type PortalServer = { url: string; close(): Promise<void> };

export async function servirPortal(fixtures: Fixtures = fixturesPadrao()): Promise<PortalServer> {
  const raiz = join(process.cwd(), "public");

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const rota = url.pathname;

    // API falsa: qualquer /v1/... conhecido devolve fixture; o resto devolve
    // um ok vazio, pra nenhuma chamada inesperada derrubar a tela.
    if (rota.startsWith("/v1/")) {
      const corpo = fixtures[rota] ?? { ok: true };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(corpo));
      return;
    }

    // Estático, preso dentro de public/ (normalize evita ../ escapando).
    const rel = normalize(rota === "/" ? "/admin/portal.html" : rota).replace(/^(\.\.[/\\])+/, "");
    try {
      const buf = await readFile(join(raiz, rel));
      res.writeHead(200, { "content-type": TIPOS[extname(rel)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404).end("nao encontrado");
    }
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const porta = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${porta}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
