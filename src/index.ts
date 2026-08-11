/**
 * Glabs Bot — HTTP API multi-product / multi-tenant WhatsApp (Baileys)
 * + painel admin em /admin
 *
 * Auth API: Authorization: Bearer <GLABS_BOT_SECRET>
 *
 *   GET  /health
 *   GET  /admin  ·  /admin/*
 *   GET  /v1/dashboard
 *   GET/POST /v1/products
 *   GET/POST /v1/accounts
 *   GET/PATCH/DELETE /v1/accounts/:id
 *   GET  /v1/accounts/:id/status
 *   POST /v1/accounts/:id/connect · disconnect · send · profile
 *   GET/POST /v1/flows · GET/PUT/DELETE /v1/flows/:id
 *   POST /v1/flows/simulate · /v1/flows/:id/publish · /reset-state
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authDir,
  botSecret,
  dataDir,
  isProduction,
  listenPort,
  llmApiKey,
} from "./config.js";
import {
  deleteAccount,
  ensureAccount,
  getAccount,
  listAccounts,
  listProducts,
  updateAccount,
  upsertProduct,
} from "./registry.js";
import {
  connect,
  disconnect,
  restoreSessionsFromDisk,
  sendText,
  snapshot,
  updateProfile,
} from "./session.js";
import {
  deleteFlow,
  getFlow,
  listFlows,
  resetConversationToBot,
  saveFlow,
} from "./flows/store.js";
import { simulateFlowMessage } from "./flows/engine.js";
import type { Flow, FlowEdge, FlowNode } from "./flows/types.js";
import type { FlowSimState } from "./flows/engine.js";

const PORT = listenPort();
const SECRET = botSecret();

const __dirname = fileURLToPath(new URL(".", import.meta.url));
/** public/ ao lado de src/ no repo; no Docker COPY public → /app/public */
const PUBLIC_DIR = existsSync(join(__dirname, "../public"))
  ? join(__dirname, "../public")
  : join(process.cwd(), "public");

mkdirSync(dataDir(), { recursive: true });
mkdirSync(authDir(), { recursive: true });

if (!SECRET && isProduction()) {
  console.error(
    "[glabs-bot] GLABS_BOT_SECRET obrigatório em produção. Defina a variável no Railway."
  );
} else if (!SECRET) {
  console.warn(
    "[glabs-bot] GLABS_BOT_SECRET vazio — ok só em dev local. Em produção use um secret."
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(raw);
}

function unauthorized(res: ServerResponse) {
  json(res, 401, { ok: false, reason: "unauthorized" });
}

function authorized(req: IncomingMessage): boolean {
  if (!SECRET) return true; // dev only
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${SECRET}`) return true;
  if (req.headers["x-bot-secret"] === SECRET) return true;
  if (req.headers["x-worker-secret"] === SECRET) return true;
  return false;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw || "{}") as T;
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  // only /admin and /admin/*
  let rel = urlPath;
  if (rel === "/admin") rel = "/admin/index.html";
  if (!rel.startsWith("/admin/")) return false;

  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { ok: false, reason: "forbidden" });
    return true;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback
    const index = join(PUBLIC_DIR, "admin/index.html");
    if (existsSync(index)) {
      const body = readFileSync(index);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return true;
    }
    json(res, 404, { ok: false, reason: "notFound" });
    return true;
  }

  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=300",
  });
  res.end(body);
  return true;
}

const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/$/, "") || "/";

    // ── Public: health + admin UI ─────────────────────────
    if (method === "GET" && path === "/health") {
      json(res, 200, {
        ok: true,
        service: "glabs-bot",
        version: "0.1.0",
      });
      return;
    }

    if (method === "GET" && (path === "/" || path === "/admin" || path.startsWith("/admin/"))) {
      if (path === "/") {
        res.writeHead(302, { location: "/admin" });
        res.end();
        return;
      }
      if (serveStatic(res, path === "/admin" ? "/admin" : path)) return;
    }

    if (!authorized(req)) {
      unauthorized(res);
      return;
    }

    // ── Dashboard (accounts + live session) ───────────────
    if (method === "GET" && path === "/v1/dashboard") {
      const products = listProducts();
      const accounts = listAccounts().map((account) => ({
        account,
        session: snapshot(account.id),
      }));
      json(res, 200, {
        ok: true,
        products,
        accounts,
        stats: {
          products: products.length,
          accounts: accounts.length,
          connected: accounts.filter((a) => a.session.status === "connected").length,
          pendingQr: accounts.filter((a) => a.session.status === "pending_qr").length,
        },
      });
      return;
    }

    // ── Products ──────────────────────────────────────────
    if (method === "GET" && path === "/v1/products") {
      json(res, 200, { ok: true, products: listProducts() });
      return;
    }

    if (method === "POST" && path === "/v1/products") {
      const body = parseJson<{
        slug?: string;
        name?: string;
        defaultWebhookUrl?: string | null;
      }>(await readBody(req));
      if (!body?.slug) {
        json(res, 400, { ok: false, reason: "slug obrigatório" });
        return;
      }
      try {
        const product = upsertProduct({
          slug: body.slug,
          name: body.name,
          defaultWebhookUrl: body.defaultWebhookUrl,
        });
        json(res, 200, { ok: true, product });
      } catch (e) {
        json(res, 400, {
          ok: false,
          reason: e instanceof Error ? e.message : "invalid",
        });
      }
      return;
    }

    // ── Flows (workflow builder) ──────────────────────────
    if (method === "GET" && path === "/v1/flows") {
      const product = url.searchParams.get("product") ?? undefined;
      const accountId = url.searchParams.get("accountId");
      json(res, 200, {
        ok: true,
        flows: listFlows({
          product,
          accountId: accountId === "" ? null : accountId ?? undefined,
        }),
        llmConfigured: Boolean(llmApiKey()),
      });
      return;
    }

    if (method === "POST" && path === "/v1/flows") {
      const body = parseJson<{
        id?: string;
        name?: string;
        product?: string;
        accountId?: string | null;
        status?: "draft" | "live";
        nodes?: FlowNode[];
        edges?: FlowEdge[];
      }>(await readBody(req));
      try {
        const flow = saveFlow({
          id: body?.id,
          name: body?.name || "Novo fluxo",
          product: body?.product || "gestor",
          accountId: body?.accountId ?? null,
          status: body?.status,
          nodes: body?.nodes || [],
          edges: body?.edges || [],
        });
        json(res, 200, { ok: true, flow });
      } catch (e) {
        json(res, 400, {
          ok: false,
          reason: e instanceof Error ? e.message : "invalid",
        });
      }
      return;
    }

    /** Simulador: testa o fluxo atual (rascunho ou live) sem WhatsApp. */
    if (method === "POST" && path === "/v1/flows/simulate") {
      const body = parseJson<{
        flowId?: string;
        nodes?: FlowNode[];
        edges?: FlowEdge[];
        name?: string;
        product?: string;
        text?: string;
        state?: Partial<FlowSimState> | null;
      }>(await readBody(req));

      const text = (body?.text || "").trim();
      if (!text) {
        json(res, 400, { ok: false, reason: "text obrigatório" });
        return;
      }

      let flow: Flow | null = null;
      if (body?.nodes && body?.edges) {
        flow = {
          id: body.flowId || "sim",
          name: body.name || "Simulação",
          product: body.product || "gestor",
          accountId: null,
          status: "draft",
          nodes: body.nodes,
          edges: body.edges,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      } else if (body?.flowId) {
        flow = getFlow(body.flowId);
      }

      if (!flow || !flow.nodes?.length) {
        json(res, 400, {
          ok: false,
          reason: "Envie nodes/edges do canvas ou um flowId válido",
        });
        return;
      }

      try {
        const { result, state: nextState } = await simulateFlowMessage({
          flow,
          state: body?.state,
          text,
        });
        json(res, 200, {
          ok: true,
          replies: result.replies,
          handoff: result.handoff,
          handoffReason: result.handoffReason,
          lastIntent: result.lastIntent,
          intentSource: result.intentSource,
          trace: result.trace,
          state: nextState,
          llmConfigured: Boolean(llmApiKey()),
        });
      } catch (e) {
        json(res, 500, {
          ok: false,
          reason: e instanceof Error ? e.message : "simulate failed",
        });
      }
      return;
    }

    const flowMatch = path.match(
      /^\/v1\/flows\/([a-zA-Z0-9_-]+)(?:\/(publish|unpublish|reset-state))?$/
    );
    if (flowMatch) {
      const flowId = flowMatch[1];
      const action = flowMatch[2] || "";

      if (method === "GET" && !action) {
        const flow = getFlow(flowId);
        if (!flow) {
          json(res, 404, { ok: false, reason: "flowNotFound" });
          return;
        }
        json(res, 200, { ok: true, flow });
        return;
      }

      if (method === "PUT" && !action) {
        const body = parseJson<{
          name?: string;
          product?: string;
          accountId?: string | null;
          status?: "draft" | "live";
          nodes?: FlowNode[];
          edges?: FlowEdge[];
        }>(await readBody(req));
        const existing = getFlow(flowId);
        if (!existing) {
          json(res, 404, { ok: false, reason: "flowNotFound" });
          return;
        }
        try {
          const flow = saveFlow({
            id: flowId,
            name: body?.name ?? existing.name,
            product: body?.product ?? existing.product,
            accountId:
              body?.accountId !== undefined ? body.accountId : existing.accountId,
            status: body?.status ?? existing.status,
            nodes: body?.nodes ?? existing.nodes,
            edges: body?.edges ?? existing.edges,
          });
          json(res, 200, { ok: true, flow });
        } catch (e) {
          json(res, 400, {
            ok: false,
            reason: e instanceof Error ? e.message : "invalid",
          });
        }
        return;
      }

      if (method === "DELETE" && !action) {
        const ok = deleteFlow(flowId);
        json(res, ok ? 200 : 404, {
          ok,
          reason: ok ? undefined : "flowNotFound",
        });
        return;
      }

      if (method === "POST" && action === "publish") {
        const existing = getFlow(flowId);
        if (!existing) {
          json(res, 404, { ok: false, reason: "flowNotFound" });
          return;
        }
        const flow = saveFlow({ ...existing, status: "live" });
        json(res, 200, { ok: true, flow });
        return;
      }

      if (method === "POST" && action === "unpublish") {
        const existing = getFlow(flowId);
        if (!existing) {
          json(res, 404, { ok: false, reason: "flowNotFound" });
          return;
        }
        const flow = saveFlow({ ...existing, status: "draft" });
        json(res, 200, { ok: true, flow });
        return;
      }

      if (method === "POST" && action === "reset-state") {
        const body = parseJson<{
          accountId?: string;
          phoneE164?: string;
        }>(await readBody(req));
        if (!body?.accountId || !body?.phoneE164) {
          json(res, 400, {
            ok: false,
            reason: "accountId e phoneE164 obrigatórios",
          });
          return;
        }
        resetConversationToBot(body.accountId, body.phoneE164);
        json(res, 200, { ok: true });
        return;
      }
    }

    // ── Accounts collection ───────────────────────────────
    if (method === "GET" && path === "/v1/accounts") {
      const product = url.searchParams.get("product") ?? undefined;
      const externalTenantId = url.searchParams.get("externalTenantId") ?? undefined;
      const accounts = listAccounts({ product, externalTenantId }).map((account) => ({
        account,
        session: snapshot(account.id),
      }));
      json(res, 200, { ok: true, accounts });
      return;
    }

    if (method === "POST" && path === "/v1/accounts") {
      const body = parseJson<{
        product?: string;
        externalTenantId?: string;
        webhookUrl?: string | null;
        label?: string | null;
      }>(await readBody(req));
      if (!body?.product || !body?.externalTenantId) {
        json(res, 400, {
          ok: false,
          reason: "product e externalTenantId obrigatórios",
        });
        return;
      }
      try {
        const account = ensureAccount({
          product: body.product,
          externalTenantId: body.externalTenantId,
          webhookUrl: body.webhookUrl,
          label: body.label,
        });
        json(res, 200, { ok: true, account, session: snapshot(account.id) });
      } catch (e) {
        json(res, 400, {
          ok: false,
          reason: e instanceof Error ? e.message : "invalid",
        });
      }
      return;
    }

    // ── Account by id ─────────────────────────────────────
    const accMatch = path.match(
      new RegExp(
        `^/v1/accounts/(${UUID_RE})(?:/(status|connect|disconnect|send|profile))?$`,
        "i"
      )
    );
    if (accMatch) {
      const accountId = accMatch[1];
      const action = (accMatch[2] ?? "").toLowerCase();

      if (method === "GET" && !action) {
        const account = getAccount(accountId);
        if (!account) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        json(res, 200, { ok: true, account, session: snapshot(accountId) });
        return;
      }

      if (method === "PATCH" && !action) {
        const body = parseJson<{ webhookUrl?: string; label?: string | null }>(
          await readBody(req)
        );
        try {
          const account = updateAccount(accountId, body ?? {});
          if (!account) {
            json(res, 404, { ok: false, reason: "accountNotFound" });
            return;
          }
          json(res, 200, { ok: true, account });
        } catch (e) {
          json(res, 400, {
            ok: false,
            reason: e instanceof Error ? e.message : "invalid",
          });
        }
        return;
      }

      if (method === "DELETE" && !action) {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        try {
          await disconnect(accountId);
        } catch {
          /* still remove registry */
        }
        deleteAccount(accountId);
        json(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && action === "status") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        json(res, 200, { ok: true, session: snapshot(accountId) });
        return;
      }

      if (method === "POST" && action === "connect") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        const session = await connect(accountId);
        json(res, 200, { ok: true, session });
        return;
      }

      if (method === "POST" && action === "disconnect") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        const session = await disconnect(accountId);
        json(res, 200, { ok: true, session });
        return;
      }

      if (method === "POST" && action === "send") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        const body = parseJson<{
          to?: string;
          body?: string;
          media?: {
            base64?: string;
            mimetype?: string;
            fileName?: string;
            kind?: "image" | "document";
          } | null;
          quoted?: {
            id?: string;
            fromMe?: boolean;
            text?: string;
          } | null;
        }>(await readBody(req));
        if (!body) {
          json(res, 400, { ok: false, reason: "invalidJson" });
          return;
        }
        const media =
          body.media?.base64 && body.media.mimetype
            ? {
                base64: body.media.base64,
                mimetype: body.media.mimetype,
                fileName: body.media.fileName,
                kind: body.media.kind,
              }
            : null;
        const quoted =
          body.quoted?.id
            ? {
                id: body.quoted.id,
                fromMe: body.quoted.fromMe,
                text: body.quoted.text,
              }
            : null;
        const result = await sendText(
          accountId,
          body.to ?? "",
          body.body ?? "",
          media,
          quoted
        );
        if (!result.ok) {
          json(res, 409, result);
          return;
        }
        json(res, 200, result);
        return;
      }

      if (method === "POST" && action === "profile") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        const body = parseJson<{
          displayName?: string;
          status?: string;
          pictureBase64?: string;
          removePicture?: boolean;
        }>(await readBody(req));
        if (!body) {
          json(res, 400, { ok: false, reason: "invalidJson" });
          return;
        }
        const result = await updateProfile(accountId, body);
        if (!result.ok) {
          json(res, 409, result);
          return;
        }
        json(res, 200, { ok: true, session: snapshot(accountId) });
        return;
      }
    }

    json(res, 404, { ok: false, reason: "notFound" });
  } catch (err) {
    console.error("[glabs-bot] unhandled:", err);
    json(res, 500, {
      ok: false,
      reason: err instanceof Error ? err.message : "internal",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[glabs-bot] :${PORT} data=${dataDir()} auth=${authDir()} public=${PUBLIC_DIR} production=${isProduction()}`
  );
  console.log(`[glabs-bot] admin UI → http://0.0.0.0:${PORT}/admin`);
  void restoreSessionsFromDisk();
});
