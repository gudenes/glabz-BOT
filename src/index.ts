/**
 * Glabs Bot — HTTP API multi-product / multi-tenant WhatsApp (Baileys)
 * + painel admin em /admin
 *
 * Auth API: Authorization: Bearer <GLABS_BOT_SECRET>
 *
 *   GET  /health
 *   GET  /admin  ·  /admin/*
 *   POST /v1/users (cria admin GLabs — glabs-only)
 *   GET  /v1/dashboard
 *   GET/POST /v1/products
 *   GET/POST /v1/accounts
 *   GET/PATCH/DELETE /v1/accounts/:id
 *   GET  /v1/accounts/:id/status
 *   POST /v1/accounts/:id/connect · disconnect · send · profile
 *   GET  /v1/accounts/:id/contacts
 *   GET/POST /v1/flows · GET/PUT/DELETE /v1/flows/:id
 *   POST /v1/flows/simulate · /v1/flows/:id/publish · /reset-state
 *   GET  /v1/portal · /v1/portal/dashboard
 *   PUT  /v1/portal/account/profile · /billing · /business
 *   POST /v1/inbox/import (glabs-only)
 *   GET  /v1/rag/answers
 *   POST /v1/rag/teach · GET /v1/rag/search
 *   POST /v1/rag/reindex · GET /v1/rag/knowledge · POST /v1/rag/knowledge/:id/suppress
 *   GET  /v1/integrations/google-calendar/connect · /callback · /status
 *   DELETE /v1/integrations/google-calendar
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authDir,
  BOOT_AT,
  botSecret,
  dataDir,
  gitInfo,
  googleOAuthConfigured,
  isProduction,
  listenPort,
  llmApiKey,
} from "./config.js";
import {
  buildAuthUrl,
  deleteGoogleCalendarLink,
  exchangeCodeForTokens,
  fetchGoogleEmail,
  getGoogleCalendarLink,
  saveGoogleCalendarLink,
} from "./google-oauth.js";
import { hasDatabase, migrate } from "./db.js";
import {
  SESSION_COOKIE,
  clearSessionCookieHeader,
  createUser,
  getSessionUser,
  login as loginUser,
  logout as logoutUser,
  parseCookie,
  sessionCookieHeader,
  seedAdmin,
  updatePassword,
  updateProfile as updateUserProfile,
  type UserRecord,
} from "./auth.js";
import {
  getClient,
  listClientUsers,
  listClients,
  provisionClient,
  wipeAllClients,
  deleteClient,
  updateClientBilling,
  updateClientBizProfile,
  type ClientBillingPatch,
  type ClientBizProfilePatch,
  type ClientRecord,
} from "./clients.js";
import {
  countActiveConversations,
  getMessageStats,
  listMessages,
  listThreads,
} from "./inbox.js";
import {
  deleteAccount,
  deleteProduct,
  ensureAccount,
  getAccount,
  isDefaultProduct,
  listAccounts,
  listProducts,
  updateAccount,
  upsertProduct,
} from "./registry.js";
import {
  connect,
  disconnect,
  listContacts,
  resetConnectionStatusOnBoot,
  restoreSessionsFromDisk,
  deleteSentMessage,
  editText,
  sendText,
  snapshot,
  updateProfile,
} from "./session.js";
import {
  deleteFlow,
  getFlow,
  listFlows,
  listFlowVersions,
  resetConversationToBot,
  restoreFlowVersion,
  saveFlow,
  setConversationHuman,
} from "./flows/store.js";
import { simulateFlowMessage } from "./flows/engine.js";
import { generateFlowFromPrompt } from "./flows/from-prompt.js";
import {
  buildFlowFromStudio,
  studioTurn,
  wantsBuild,
  wantsTest,
  type StudioMsg,
  type StudioMode,
} from "./flows/studio.js";
import { blankFlow, pickCatalogFlow, templateCatalog } from "./flows/catalog.js";
import { connectorCatalog } from "./flows/connectors/index.js";
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

function isSecureReq(req: IncomingMessage): boolean {
  const proto = String(req.headers["x-forwarded-proto"] || "");
  return proto === "https" || isProduction();
}

function setCookie(res: ServerResponse, header: string) {
  const prev = res.getHeader("set-cookie");
  if (!prev) res.setHeader("set-cookie", header);
  else if (Array.isArray(prev)) res.setHeader("set-cookie", [...prev, header]);
  else res.setHeader("set-cookie", [String(prev), header]);
}

type AuthCtx =
  | { kind: "secret" }
  | { kind: "user"; user: UserRecord };

async function resolveAuth(req: IncomingMessage): Promise<AuthCtx | null> {
  const header = req.headers.authorization ?? "";
  if (SECRET && (header === `Bearer ${SECRET}` || req.headers["x-bot-secret"] === SECRET || req.headers["x-worker-secret"] === SECRET)) {
    return { kind: "secret" };
  }
  const sid = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (sid) {
    const user = await getSessionUser(sid);
    if (user) return { kind: "user", user };
  }
  if (!SECRET && !hasDatabase()) return { kind: "secret" };
  return null;
}

function actingClientId(req: IncomingMessage, auth: AuthCtx): string | null {
  if (auth.kind === "user" && auth.user.role === "client") return auth.user.clientId;
  if (auth.kind === "user" && auth.user.role === "glabs") {
    const raw = String(req.headers["x-client-id"] || "").trim();
    return raw || null;
  }
  return null;
}

/**
 * Contexto passado pro coach do Studio — nome + perfil de negócio ("Dados da
 * conta"), quando existir. Um só lugar pra montar isso evita repetir o
 * mapeamento nos 3 pontos que chamam studioTurn/extractKnowledgeFromConversation.
 */
function studioContextFor(client: ClientRecord | null) {
  if (!client) return null;
  return {
    name: client.name,
    bizRole: client.bizRole,
    bizSize: client.bizSize,
    bizSegment: client.bizSegment,
    bizAudience: client.bizAudience,
  };
}

// América/São_Paulo é sempre UTC-3 (Brasil não tem mais horário de verão desde 2019) —
// o servidor roda em UTC puro, então os filtros de período do dashboard do portal
// (Hoje/Ontem/Mês passado/Este mês) precisam desse ajuste manual pra não virar o dia
// às 21h local em vez de meia-noite.
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;

function brLocalParts(d: Date): { y: number; m: number; day: number } {
  const shifted = new Date(d.getTime() - BR_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

function brMidnightUtc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day, 0, 0, 0) + BR_OFFSET_MS);
}

function resolveRangeBR(range: string): { from: Date; to: Date } {
  const { y, m, day } = brLocalParts(new Date());
  if (range === "yesterday") {
    const to = brMidnightUtc(y, m, day);
    return { from: new Date(to.getTime() - 24 * 60 * 60 * 1000), to };
  }
  if (range === "this_month") {
    return { from: brMidnightUtc(y, m, 1), to: brMidnightUtc(y, m + 1, 1) };
  }
  if (range === "last_month") {
    return { from: brMidnightUtc(y, m - 1, 1), to: brMidnightUtc(y, m, 1) };
  }
  // "today" (padrão)
  return { from: brMidnightUtc(y, m, day), to: brMidnightUtc(y, m, day + 1) };
}

function requireGlabs(auth: AuthCtx | null): auth is AuthCtx {
  if (!auth) return false;
  if (auth.kind === "secret") return true;
  return auth.kind === "user" && auth.user.role === "glabs";
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

/**
 * Guard de "raio de impacto" (registrado em docs/arquitetura-to-be-roadmap_v2.md).
 * Hoje é 1 processo só segurando as sessões WhatsApp de todos os clientes — um
 * erro não tratado que escape dos try/catch locais (ex.: um bug disparado pela
 * mensagem de UM cliente específico) derrubaria o processo inteiro, ou seja,
 * TODAS as contas de TODOS os clientes ao mesmo tempo, não só a que causou o
 * problema.
 *
 * Log + alerta, sem derrubar o processo — na maioria dos casos (erro isolado
 * de uma conta específica), as outras contas seguem rodando sem impacto,
 * porque cada uma vive no seu próprio LiveSession (session.ts), sem estado
 * global compartilhado entre elas além do Map de lookup.
 *
 * Rajada de erros (não um caso isolado) é sinal de corrupção real — aí sim é
 * mais seguro deixar o Railway reiniciar limpo (restartPolicyType: ON_FAILURE,
 * railway.json) do que continuar rodando quebrado.
 */
const FATAL_ERROR_WINDOW_MS = 60_000;
const FATAL_ERROR_THRESHOLD = 5;
let recentFatalErrors: number[] = [];

function handleFatalError(kind: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[glabs-bot] ${kind} não tratado:`, detail);

  void import("./notify.js")
    .then(({ sendTelegramAlert }) =>
      sendTelegramAlert(
        `🔴 <b>Erro fatal não tratado</b> (${kind})\n<code>${detail.slice(0, 500)}</code>`
      )
    )
    .catch(() => undefined);

  const now = Date.now();
  recentFatalErrors = recentFatalErrors.filter((t) => now - t < FATAL_ERROR_WINDOW_MS);
  recentFatalErrors.push(now);
  if (recentFatalErrors.length >= FATAL_ERROR_THRESHOLD) {
    console.error(
      `[glabs-bot] ${recentFatalErrors.length} erros fatais em ${FATAL_ERROR_WINDOW_MS / 1000}s — ` +
        `reiniciando processo (Railway restartPolicy cuida do resto)`
    );
    process.exit(1);
  }
}

process.on("uncaughtException", (err) => handleFatalError("uncaughtException", err));
process.on("unhandledRejection", (reason) => handleFatalError("unhandledRejection", reason));

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

    // ── Auth (público) ────────────────────────────────────
    if (method === "POST" && path === "/v1/auth/login") {
      if (!hasDatabase()) {
        json(res, 503, { ok: false, reason: "Postgres não configurado" });
        return;
      }
      const body = parseJson<{ email?: string; password?: string }>(await readBody(req));
      const result = await loginUser(body?.email || "", body?.password || "");
      if (!result) {
        json(res, 401, { ok: false, reason: "e-mail ou senha inválidos" });
        return;
      }
      setCookie(res, sessionCookieHeader(result.sessionId, isSecureReq(req)));
      json(res, 200, { ok: true, user: result.user });
      return;
    }

    if (method === "POST" && path === "/v1/auth/logout") {
      const sid = parseCookie(req.headers.cookie, SESSION_COOKIE);
      if (sid) await logoutUser(sid);
      setCookie(res, clearSessionCookieHeader(isSecureReq(req)));
      json(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/v1/auth/me") {
      const sid = parseCookie(req.headers.cookie, SESSION_COOKIE);
      const user = sid ? await getSessionUser(sid) : null;
      if (!user) {
        unauthorized(res);
        return;
      }
      json(res, 200, { ok: true, user, db: hasDatabase() });
      return;
    }

    const auth = await resolveAuth(req);
    if (!auth) {
      unauthorized(res);
      return;
    }

    // ── Versão do backend (git commit rodando + uptime) ───
    if (method === "GET" && path === "/v1/version") {
      const git = gitInfo();
      json(res, 200, {
        ok: true,
        commit: git.commit,
        commitShort: git.commit ? git.commit.slice(0, 7) : null,
        branch: git.branch,
        message: git.message,
        bootAt: BOOT_AT,
        env: isProduction() ? "production" : "local",
      });
      return;
    }

    if (method === "POST" && path === "/v1/auth/change-password") {
      if (auth.kind !== "user") {
        json(res, 400, { ok: false, reason: "só usuários com senha" });
        return;
      }
      const body = parseJson<{ password?: string }>(await readBody(req));
      try {
        await updatePassword(auth.user.id, body?.password || "");
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "invalid" });
      }
      return;
    }

    // ── Clients (GLabs cria; portal lê o próprio) ─────────
    // ── Admins GLabs (não confundir com login de client) ──
    // seedAdmin() (auth.ts) só cria 1 admin, no primeiro boot, se nenhum
    // existir ainda — não dá pra adicionar um segundo admin por ali. Essa
    // rota cobre isso: só glabs-admin/secret pode criar outro glabs-admin.
    if (method === "POST" && path === "/v1/users") {
      if (!requireGlabs(auth)) {
        unauthorized(res);
        return;
      }
      const body = parseJson<{ email?: string; password?: string; name?: string }>(
        await readBody(req)
      );
      if (!body?.email || !body?.password) {
        json(res, 400, { ok: false, reason: "email e password obrigatórios" });
        return;
      }
      try {
        const user = await createUser({
          email: body.email,
          password: body.password,
          name: body.name || null,
          role: "glabs",
        });
        json(res, 200, { ok: true, user });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "invalid" });
      }
      return;
    }

    if (method === "GET" && path === "/v1/clients") {
      if (!requireGlabs(auth)) {
        unauthorized(res);
        return;
      }
      const clients = await listClients();
      json(res, 200, { ok: true, clients });
      return;
    }

    if (method === "POST" && path === "/v1/clients/wipe") {
      if (!requireGlabs(auth)) {
        unauthorized(res);
        return;
      }
      try {
        const result = await wipeAllClients();
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "wipe" });
      }
      return;
    }

    if (method === "POST" && path === "/v1/clients") {
      if (!requireGlabs(auth)) {
        unauthorized(res);
        return;
      }
      const body = parseJson<{ name?: string; email?: string; template?: string }>(
        await readBody(req)
      );
      try {
        const created = await provisionClient({
          name: body?.name || "",
          email: body?.email || "",
          template: body?.template,
        });
        json(res, 200, { ok: true, ...created });
      } catch (e) {
        json(res, 400, {
          ok: false,
          reason: e instanceof Error ? e.message : "invalid",
        });
      }
      return;
    }

    const clientDel = path.match(/^\/v1\/clients\/([a-zA-Z0-9_-]+)$/);
    if (method === "DELETE" && clientDel) {
      if (!requireGlabs(auth)) {
        unauthorized(res);
        return;
      }
      const ok = await deleteClient(clientDel[1]);
      json(res, ok ? 200 : 404, { ok, reason: ok ? undefined : "notFound" });
      return;
    }

    if (method === "GET" && path === "/v1/portal") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const client = await getClient(clientId);
      if (!client) {
        json(res, 404, { ok: false, reason: "cliente não encontrado" });
        return;
      }
      const accounts = listAccounts({ clientId }).map((account) => ({
        account,
        session: snapshot(account.id),
      }));
      const flows = listFlows({ product: client.slug, clientId });
      const live = flows.find((f) => f.status === "live") || null;
      const users = await listClientUsers(client.id);
      json(res, 200, {
        ok: true,
        client,
        accounts,
        flows,
        liveFlow: live
          ? { id: live.id, name: live.name, status: live.status, publishedAt: live.publishedAt, updatedAt: live.updatedAt }
          : null,
        users: users.map((u) => ({ id: u.id, email: u.email, name: u.name })),
        llmConfigured: Boolean(llmApiKey()),
        impersonating: auth.kind === "user" && auth.user.role === "glabs",
      });
      return;
    }

    if (method === "GET" && path === "/v1/portal/dashboard") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const range = String(url.searchParams.get("range") || "today");
      const { from, to } = resolveRangeBR(range);
      const accountsList = listAccounts({ clientId }).map((account) => snapshot(account.id));
      const periodStats = await getMessageStats(clientId, from, to);
      const totals = periodStats.reduce(
        (acc, p) => ({ in: acc.in + p.in, out: acc.out + p.out }),
        { in: 0, out: 0 }
      );
      const conversations = await countActiveConversations(clientId, from, to);
      const seriesFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
      const rawSeries = await getMessageStats(clientId, seriesFrom, new Date());
      // getMessageStats só traz dias com mensagem — preenche os 30 dias corridos
      // (horário de Brasília) com zero, senão o gráfico comprime o eixo X pros
      // poucos dias que tiveram atividade em vez do período real.
      const byDate = new Map(rawSeries.map((p) => [p.date, p]));
      const series: typeof rawSeries = [];
      const { y, m, day } = brLocalParts(new Date());
      for (let i = 29; i >= 0; i--) {
        // Só o rótulo do dia calendário (BR-local) — não é um instante real,
        // então não soma o offset de novo aqui (getMessageStats já devolve
        // a data nesse mesmo formato "como se fosse UTC").
        const date = new Date(Date.UTC(y, m, day - i)).toISOString().slice(0, 10);
        series.push(byDate.get(date) || { date, in: 0, out: 0 });
      }
      json(res, 200, {
        ok: true,
        range,
        accounts: {
          total: accountsList.length,
          connected: accountsList.filter((s) => s.status === "connected").length,
          pendingQr: accountsList.filter((s) => s.status === "pending_qr").length,
          disconnected: accountsList.filter(
            (s) => s.status !== "connected" && s.status !== "pending_qr"
          ).length,
        },
        totals,
        conversations,
        series,
      });
      return;
    }

    if (method === "PUT" && path === "/v1/portal/account/profile") {
      if (auth.kind !== "user") {
        json(res, 400, { ok: false, reason: "só usuários logados" });
        return;
      }
      // Em modo impersonation (admin GLabs vendo o portal "como" um client),
      // esse formulário edita o próprio login do admin por padrão — mas o que
      // a tela mostra ali é o dono da conta do client sendo visualizado. Sem
      // esse desvio, salvar aqui reescreveria o nome do admin, não do client
      // (era exatamente o bug: o card sempre lia/gravava auth.user, nunca o
      // usuário de fato dono do client em impersonation).
      let targetUserId = auth.user.id;
      if (auth.user.role === "glabs") {
        const clientId = actingClientId(req, auth);
        const clientUser = clientId ? (await listClientUsers(clientId))[0] : null;
        if (clientUser) targetUserId = clientUser.id;
      }
      const body = parseJson<{ name?: string }>(await readBody(req));
      try {
        const user = await updateUserProfile(targetUserId, body?.name || "");
        json(res, 200, { ok: true, user: user ? { name: user.name, email: user.email } : null });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "invalid" });
      }
      return;
    }

    if (method === "PUT" && path === "/v1/portal/account/billing") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const body = parseJson<ClientBillingPatch>(await readBody(req));
      try {
        const client = await updateClientBilling(clientId, body ?? {});
        json(res, client ? 200 : 404, { ok: Boolean(client), client });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "invalid" });
      }
      return;
    }

    if (method === "PUT" && path === "/v1/portal/account/business") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const body = parseJson<ClientBizProfilePatch>(await readBody(req));
      try {
        const client = await updateClientBizProfile(clientId, body ?? {});
        json(res, client ? 200 : 404, { ok: Boolean(client), client });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "invalid" });
      }
      return;
    }

    // ── Integração Google Calendar (OAuth) ────────────────
    if (method === "GET" && path === "/v1/integrations/google-calendar/status") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const link = await getGoogleCalendarLink(clientId);
      json(res, 200, {
        ok: true,
        configured: googleOAuthConfigured(),
        connected: Boolean(link),
        email: link?.googleEmail || null,
        connectedAt: link?.connectedAt || null,
      });
      return;
    }

    if (method === "GET" && path === "/v1/integrations/google-calendar/connect") {
      const clientId =
        auth.kind === "user" && auth.user.role === "client"
          ? auth.user.clientId
          : auth.kind === "user" && auth.user.role === "glabs"
            ? url.searchParams.get("clientId")
            : null;
      if (!clientId || !googleOAuthConfigured()) {
        res.writeHead(302, { location: "/admin/portal.html?google_error=1" });
        res.end();
        return;
      }
      const nonce = randomBytes(16).toString("hex");
      setCookie(
        res,
        [
          `gcal_oauth_state=${nonce}:${clientId}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          "Max-Age=600",
          isSecureReq(req) ? "Secure" : "",
        ]
          .filter(Boolean)
          .join("; ")
      );
      res.writeHead(302, { location: buildAuthUrl(nonce) });
      res.end();
      return;
    }

    if (method === "GET" && path === "/v1/integrations/google-calendar/callback") {
      const backTo = "/admin/portal.html?view=integrations";
      const fail = (reason: string) => {
        console.warn("[google-oauth] callback failed:", reason);
        res.writeHead(302, { location: `${backTo}&google_error=${encodeURIComponent(reason)}` });
        res.end();
      };
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const cookieState = parseCookie(req.headers.cookie, "gcal_oauth_state");
      setCookie(res, "gcal_oauth_state=; Path=/; Max-Age=0");

      if (url.searchParams.get("error")) {
        fail(url.searchParams.get("error") || "denied");
        return;
      }
      if (!code || !returnedState || !cookieState || returnedState !== cookieState.split(":")[0]) {
        fail("state_invalid");
        return;
      }
      const clientId = cookieState.split(":").slice(1).join(":");
      if (!clientId) {
        fail("state_invalid");
        return;
      }
      try {
        const tokens = await exchangeCodeForTokens(code);
        if (!tokens.refresh_token) {
          // Já tinha conectado antes e o Google não reemitiu refresh_token
          // (não deveria acontecer com prompt=consent, mas por segurança).
          fail("no_refresh_token");
          return;
        }
        const email = await fetchGoogleEmail(tokens.access_token);
        await saveGoogleCalendarLink({
          clientId,
          googleEmail: email || "conta Google",
          refreshToken: tokens.refresh_token,
          scope: tokens.scope,
        });
        res.writeHead(302, { location: `${backTo}&google_connected=1` });
        res.end();
      } catch (e) {
        console.warn("[google-oauth] callback exception:", e instanceof Error ? e.stack || e.message : e);
        fail(e instanceof Error ? e.message.slice(0, 60) : "unknown");
      }
      return;
    }

    if (method === "DELETE" && path === "/v1/integrations/google-calendar") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const ok = await deleteGoogleCalendarLink(clientId);
      json(res, 200, { ok });
      return;
    }

    if (path === "/v1/inbox/threads" && method === "GET") {
      const clientId = actingClientId(req, auth);
      const acc = clientId ? listAccounts({ clientId })[0] : null;
      if (!acc) {
        json(res, 400, { ok: false, reason: "sem conta WhatsApp neste projeto" });
        return;
      }
      json(res, 200, { ok: true, threads: await listThreads(acc.id), accountId: acc.id });
      return;
    }

    if (path.startsWith("/v1/inbox/threads/") && method === "GET") {
      const phone = decodeURIComponent(path.slice("/v1/inbox/threads/".length).replace(/\/messages$/, ""));
      const clientId = actingClientId(req, auth);
      const acc = clientId ? listAccounts({ clientId })[0] : null;
      if (!acc) {
        json(res, 400, { ok: false, reason: "sem conta" });
        return;
      }
      json(res, 200, { ok: true, messages: await listMessages(acc.id, phone) });
      return;
    }

    if (path === "/v1/inbox/send" && method === "POST") {
      const clientId = actingClientId(req, auth);
      const acc = clientId ? listAccounts({ clientId })[0] : null;
      if (!acc) {
        json(res, 400, { ok: false, reason: "sem conta" });
        return;
      }
      const body = parseJson<{
        phone?: string;
        body?: string;
        media?: {
          base64?: string;
          mimetype?: string;
          fileName?: string;
          kind?: "image" | "document" | "audio" | "video";
        } | null;
      }>(await readBody(req));
      const author =
        auth.kind === "user" ? auth.user.name || auth.user.email : "Atendente";
      const media =
        body?.media?.base64 && body.media.mimetype
          ? {
              base64: body.media.base64,
              mimetype: body.media.mimetype,
              fileName: body.media.fileName,
              kind: body.media.kind,
            }
          : null;
      setConversationHuman(acc.id, body?.phone || "", "inbox");
      const result = await sendText(
        acc.id,
        body?.phone || "",
        body?.body || "",
        media,
        null,
        { source: "human", authorName: author }
      );
      if (!result.ok) {
        json(res, 409, result);
        return;
      }
      json(res, 200, result);
      return;
    }

    if (path === "/v1/inbox/mode" && method === "POST") {
      const clientId = actingClientId(req, auth);
      const acc = clientId ? listAccounts({ clientId })[0] : null;
      if (!acc) {
        json(res, 400, { ok: false, reason: "sem conta" });
        return;
      }
      const body = parseJson<{ phone?: string; mode?: string }>(await readBody(req));
      const phone = body?.phone || "";
      if (body?.mode === "bot") resetConversationToBot(acc.id, phone);
      else setConversationHuman(acc.id, phone, "inbox");
      json(res, 200, { ok: true, mode: body?.mode === "bot" ? "bot" : "human" });
      return;
    }

    // ── Dashboard (accounts + live session) ───────────────
    if (method === "GET" && path === "/v1/dashboard") {
      const clientId = actingClientId(req, auth);
      const products = listProducts();
      const accounts = listAccounts(clientId ? { clientId } : undefined).map((account) => ({
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

    const productDel = path.match(/^\/v1\/products\/([a-zA-Z0-9_-]+)$/);
    if (method === "DELETE" && productDel) {
      const slug = productDel[1];
      if (isDefaultProduct(slug)) {
        json(res, 400, {
          ok: false,
          reason: "product padrão (gestor/prontuario) não pode ser removido",
        });
        return;
      }
      const accountsInUse = listAccounts({ product: slug }).length;
      const flowsInUse = listFlows({ product: slug }).length;
      if (accountsInUse > 0 || flowsInUse > 0) {
        json(res, 400, {
          ok: false,
          reason: `em uso: ${accountsInUse} account(s) e ${flowsInUse} flow(s) — remova primeiro`,
          accountsInUse,
          flowsInUse,
        });
        return;
      }
      const ok = deleteProduct(slug);
      json(res, ok ? 200 : 404, { ok, reason: ok ? undefined : "productNotFound" });
      return;
    }

    // ── Flows (workflow builder) ──────────────────────────
    if (method === "GET" && path === "/v1/flows") {
      const scoped =
        (auth.kind === "user" && auth.user.role === "client" && auth.user.clientId) ||
        (auth.kind === "user" && auth.user.role === "glabs"
          ? String(req.headers["x-client-id"] || url.searchParams.get("clientId") || "").trim()
          : "");
      const clientId = scoped || actingClientId(req, auth);
      const product =
        (clientId && (await getClient(clientId))?.slug) ||
        url.searchParams.get("product") ||
        undefined;
      const accountId = url.searchParams.get("accountId");
      json(res, 200, {
        ok: true,
        flows: listFlows({
          product,
          clientId,
          accountId: accountId === "" ? null : accountId ?? undefined,
        }),
        llmConfigured: Boolean(llmApiKey()),
      });
      return;
    }

    if (method === "POST" && path === "/v1/flows/studio") {
      const clientId = actingClientId(req, auth);
      const client = clientId ? await getClient(clientId) : null;
      const body = parseJson<{
        messages?: StudioMsg[];
        action?: "chat" | "build" | "test" | "extract_knowledge";
        phase?: string;
        mode?: "flow" | "knowledge";
      }>(await readBody(req));
      const mode: StudioMode = body?.mode === "knowledge" ? "knowledge" : "flow";
      const messages = (body?.messages || []).filter(
        (m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim()
      );
      if (!messages.length) {
        json(res, 400, { ok: false, reason: "escreve uma mensagem" });
        return;
      }
      // Extração nunca é inferida por texto livre (diferente de build/test
      // abaixo) — só roda quando o frontend pede explicitamente, no fim de
      // uma conversa já encerrada.
      if (body?.action === "extract_knowledge") {
        try {
          const ctx = studioContextFor(client);
          const { extractKnowledgeFromConversation } = await import("./rag/knowledge-extraction.js");
          const { pairs, bizProfile } = await extractKnowledgeFromConversation(messages, ctx);
          // Perfil de negócio grava direto, sem tela de revisão: é metadado
          // da própria conta (nunca aparece pra cliente final, diferente dos
          // pares de conhecimento), e só preenche o que ainda estava vazio —
          // nunca sobrescreve o que o dono já preencheu em "Dados da conta".
          if (clientId && client) {
            const patch: Record<string, string> = {};
            if (bizProfile.role && !client.bizRole) patch.bizRole = bizProfile.role;
            if (bizProfile.size && !client.bizSize) patch.bizSize = bizProfile.size;
            if (bizProfile.segment && !client.bizSegment) patch.bizSegment = bizProfile.segment;
            if (bizProfile.audience && !client.bizAudience) patch.bizAudience = bizProfile.audience;
            if (Object.keys(patch).length) {
              await updateClientBizProfile(clientId, patch).catch(() => undefined);
            }
          }
          json(res, 200, { ok: true, kind: "knowledge", pairs });
        } catch (e) {
          json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "ia" });
        }
        return;
      }
      // Modo conhecimento nunca builda — nem por ação explícita nem por
      // inferência de texto livre (defesa em profundidade: o frontend desse
      // modo nem mostra o botão "Montar o fluxo", mas qualquer request pode
      // ser forjado).
      if (mode === "knowledge" && body?.action === "build") {
        json(res, 400, { ok: false, reason: "modo conhecimento não monta fluxo" });
        return;
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      const inPreview = body?.phase === "preview";
      const action =
        mode === "knowledge"
          ? "chat"
          : body?.action === "build" || (!inPreview && body?.action !== "test" && wantsBuild(lastUser))
            ? "build"
            : body?.action === "test" || (!inPreview && wantsTest(lastUser))
              ? "test"
              : "chat";
      try {
        const ctx = studioContextFor(client);
        if (action === "build") {
          const gen = await buildFlowFromStudio(messages, ctx);
          const flow = saveFlow({
            name: gen.name,
            product: client?.slug || "gestor",
            accountId: clientId ? listAccounts({ clientId })[0]?.id ?? null : null,
            clientId,
            status: "draft",
            nodes: gen.nodes,
            edges: gen.edges,
          });
          json(res, 200, {
            ok: true,
            kind: "flow",
            phase: "ready",
            as: "coach",
            say: "Pronto. Abri o fluxo no builder — ajusta o que quiser e publica.",
            flow,
          });
          return;
        }
        if (action === "test") {
          const turn = await studioTurn(
            [
              ...messages,
              {
                role: "user",
                content:
                  "Sim. Vamos testar agora. A partir daqui eu falo como o cliente. Não altere o fluxo no meio do ensaio — só interpreta o bot.",
              },
            ],
            ctx
          );
          json(res, 200, {
            ok: true,
            kind: "chat",
            phase: "preview",
            as: "bot",
            say: turn.say,
          });
          return;
        }
        const history = inPreview
          ? messages.map((m, i, arr) =>
              m.role === "user" && i === arr.length - 1
                ? {
                    ...m,
                    content: `[ensaio — falo como cliente, não é pedido de mudança]\n${m.content}`,
                  }
                : m
            )
          : messages;
        const turn = await studioTurn(history, ctx, mode);
        json(res, 200, { ok: true, kind: "chat", ...turn });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "ia" });
      }
      return;
    }

    if (method === "POST" && path === "/v1/flows/from-prompt") {
      const clientId = actingClientId(req, auth);
      const client = clientId ? await getClient(clientId) : null;
      const body = parseJson<{ prompt?: string }>(await readBody(req));
      const prompt = body?.prompt?.trim() || "";
      if (prompt.length < 8) {
        json(res, 400, { ok: false, reason: "conte o que o atendimento deve fazer" });
        return;
      }
      try {
        const gen = await generateFlowFromPrompt(prompt);
        const flow = saveFlow({
          name: gen.name,
          product: client?.slug || "gestor",
          accountId: clientId ? listAccounts({ clientId })[0]?.id ?? null : null,
          clientId,
          status: "draft",
          nodes: gen.nodes,
          edges: gen.edges,
        });
        json(res, 200, { ok: true, flow });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "ia" });
      }
      return;
    }

    // Importa histórico de conversa (ex.: cliente vindo de outro sistema, ou
    // popular ambiente de teste). glabs-only: escreve direto no histórico sem
    // passar pelo WhatsApp, então não pode ficar exposto ao cliente.
    if (method === "POST" && path === "/v1/inbox/import") {
      if (!requireGlabs(auth)) {
        unauthorized(res);
        return;
      }
      const body = parseJson<{
        accountId?: string;
        messages?: {
          phone?: string;
          direction?: "in" | "out";
          source?: "customer" | "bot" | "human";
          body?: string;
          authorName?: string | null;
          sentAt?: string;
        }[];
      }>(await readBody(req));

      if (!body?.accountId || !Array.isArray(body.messages)) {
        json(res, 400, { ok: false, reason: "accountId e messages obrigatórios" });
        return;
      }
      if (!getAccount(body.accountId)) {
        json(res, 404, { ok: false, reason: "account não encontrada" });
        return;
      }

      const { recordMessage } = await import("./inbox.js");
      let imported = 0;
      for (const m of body.messages) {
        if (!m?.phone || !m?.body) continue;
        try {
          await recordMessage({
            accountId: body.accountId,
            phone: m.phone,
            direction: m.direction === "out" ? "out" : "in",
            source: m.source === "human" ? "human" : m.source === "bot" ? "bot" : "customer",
            body: m.body,
            authorName: m.authorName ?? null,
            sentAt: m.sentAt,
          });
          imported++;
        } catch (e) {
          console.warn("[inbox/import] falhou:", e instanceof Error ? e.message : e);
        }
      }
      json(res, 200, { ok: true, imported, received: body.messages.length });
      return;
    }

    // ── Base de conhecimento (RAG) ────────────────────────
    // Sempre escopado ao cliente do contexto — nunca aceita client_id do body
    // (isolamento estrutural, docs/rag-desenho.md §5.4).
    if (method === "POST" && path === "/v1/rag/reindex") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const { reindexClient } = await import("./rag/index-store.js");
      const result = await reindexClient(clientId);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    // Busca na base — útil pra conferir o que a IA veria antes de responder.
    if (method === "GET" && path === "/v1/rag/search") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) {
        json(res, 400, { ok: false, reason: "parâmetro q obrigatório" });
        return;
      }
      const { embedTexts } = await import("./rag/embeddings.js");
      const { searchKnowledge } = await import("./rag/index-store.js");
      const emb = await embedTexts([q]);
      if (!emb.ok) {
        json(res, 400, { ok: false, reason: emb.reason });
        return;
      }
      const hits = await searchKnowledge(clientId, emb.vectors[0], {
        topK: Number(url.searchParams.get("topK")) || 4,
      });
      json(res, 200, { ok: true, query: q, hits });
      return;
    }

    // Ensinar a IA diretamente (sem depender de histórico acumulado).
    if (method === "POST" && path === "/v1/rag/teach") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const body = parseJson<{ question?: string; answer?: string }>(await readBody(req));
      if (!body?.question || !body?.answer) {
        json(res, 400, { ok: false, reason: "question e answer obrigatórios" });
        return;
      }
      const { teachManual } = await import("./rag/index-store.js");
      const r = await teachManual(clientId, body.question, body.answer);
      json(res, r.ok ? 200 : 400, r);
      return;
    }

    // Salva em lote pares revisados pelo dono (ex.: extraídos de uma conversa
    // do Studio, ou de um texto colado) — uma chamada só em vez do frontend
    // disparar N requests. Cada teachManual já é independente; não há
    // transação cross-row em nenhum outro caminho do RAG hoje, então o loop
    // aqui não perde nada.
    if (method === "POST" && path === "/v1/rag/teach-batch") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const body = parseJson<{
        pairs?: { question?: string; answer?: string }[];
        origin?: string;
      }>(await readBody(req));
      const pairs = (body?.pairs || []).filter(
        (p) => p?.question?.trim() && p?.answer?.trim()
      ) as { question: string; answer: string }[];
      if (!pairs.length) {
        json(res, 400, { ok: false, reason: "nenhum par válido" });
        return;
      }
      // Default "onboarding" preserva o comportamento anterior; "pasted" e
      // "website" vêm dos outros dois jeitos de gerar candidatos na aba
      // Conhecimento (ver /v1/rag/extract-from-text e /v1/rag/extract-from-website).
      const origin =
        body?.origin === "pasted" ? "pasted" : body?.origin === "website" ? "website" : "onboarding";
      const { teachManual } = await import("./rag/index-store.js");
      let saved = 0;
      for (const p of pairs) {
        const r = await teachManual(clientId, p.question, p.answer, origin);
        if (r.ok) saved++;
      }
      json(res, saved > 0 ? 200 : 400, { ok: saved > 0, saved, total: pairs.length });
      return;
    }

    // Extrai pares pergunta→resposta de um texto colado (site, cardápio,
    // política, mensagem padrão do WhatsApp) — mesmo espírito da extração
    // de conversa do Studio (POST /v1/flows/studio {action:"extract_
    // knowledge"}), só que a fonte é um bloco de texto solto em vez de um
    // histórico de chat. Também nunca grava sozinho — só devolve candidatos
    // pra revisão (ver /v1/rag/teach-batch).
    if (method === "POST" && path === "/v1/rag/extract-from-text") {
      const clientId = actingClientId(req, auth);
      const client = clientId ? await getClient(clientId) : null;
      const body = parseJson<{ text?: string }>(await readBody(req));
      const text = String(body?.text || "").trim();
      if (!text) {
        json(res, 400, { ok: false, reason: "cole um texto" });
        return;
      }
      try {
        const ctx = studioContextFor(client);
        const { extractKnowledgeFromText } = await import("./rag/knowledge-extraction.js");
        const pairs = await extractKnowledgeFromText(text, ctx);
        json(res, 200, { ok: true, pairs });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "ia" });
      }
      return;
    }

    // Mesma extração de conhecimento do texto colado, só que a fonte é o
    // site do próprio cliente — endpoint próprio (em vez de detectar "isso
    // parece uma URL" dentro do texto colado) porque fica mais claro pro
    // usuário o que cada campo faz, e porque a origem salva difere (ver
    // teach-batch abaixo: origin='website', tag própria "do site").
    if (method === "POST" && path === "/v1/rag/extract-from-website") {
      const clientId = actingClientId(req, auth);
      const client = clientId ? await getClient(clientId) : null;
      const body = parseJson<{ url?: string }>(await readBody(req));
      const url = String(body?.url || "").trim();
      if (!url) {
        json(res, 400, { ok: false, reason: "informe a URL do site" });
        return;
      }
      try {
        const { fetchSiteText } = await import("./rag/fetch-site-text.js");
        const text = await fetchSiteText(url);
        const ctx = studioContextFor(client);
        const { extractKnowledgeFromText } = await import("./rag/knowledge-extraction.js");
        const pairs = await extractKnowledgeFromText(text, ctx);
        json(res, 200, { ok: true, pairs });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "ia" });
      }
      return;
    }

    // Rastro das respostas da IA — "por que ela respondeu isso?"
    if (method === "GET" && path === "/v1/rag/answers") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const { listAiAnswers } = await import("./rag/answer-log.js");
      const answers = await listAiAnswers(clientId, Number(url.searchParams.get("limit")) || 50);
      json(res, 200, { ok: true, answers });
      return;
    }

    if (method === "GET" && path === "/v1/rag/knowledge") {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const { listKnowledge } = await import("./rag/index-store.js");
      json(res, 200, { ok: true, chunks: await listKnowledge(clientId) });
      return;
    }

    const ragSuppress = path.match(/^\/v1\/rag\/knowledge\/([\w-]+)\/suppress$/);
    if (method === "POST" && ragSuppress) {
      const clientId = actingClientId(req, auth);
      if (!clientId) {
        json(res, 400, { ok: false, reason: "sem cliente no contexto" });
        return;
      }
      const { suppressChunk } = await import("./rag/index-store.js");
      const ok = await suppressChunk(clientId, ragSuppress[1]);
      json(res, ok ? 200 : 404, { ok });
      return;
    }

    // Integrações disponíveis no nó Ação — a UI monta os selects a partir daqui
    // em vez de repetir a lista em HTML.
    if (method === "GET" && path === "/v1/flows/connectors") {
      json(res, 200, { ok: true, connectors: connectorCatalog() });
      return;
    }

    // Catálogo de templates (metadados só — sem nodes/edges), pra tela de escolha.
    if (method === "GET" && path === "/v1/flows/templates") {
      json(res, 200, { ok: true, templates: templateCatalog() });
      return;
    }

    if (method === "POST" && path === "/v1/flows/from-template") {
      const clientId = actingClientId(req, auth);
      const client = clientId ? await getClient(clientId) : null;
      const body = parseJson<{ template?: string }>(await readBody(req));
      // Seleção vive em catalog.ts — antes esta rota reimplementava a mesma
      // lógica de clients.ts, com default diferente (aqui "pilates", lá o
      // primeiro do array).
      const seed = pickCatalogFlow(body?.template);
      try {
        const flow = saveFlow({
          name: seed ? seed.name : "Novo fluxo",
          product: client?.slug || "gestor",
          accountId: clientId ? listAccounts({ clientId })[0]?.id ?? null : null,
          clientId,
          status: "draft",
          nodes: seed ? seed.nodes : blankFlow().nodes,
          edges: seed ? seed.edges : blankFlow().edges,
        });
        json(res, 200, { ok: true, flow });
      } catch (e) {
        json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "invalid" });
      }
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
        const clientId = actingClientId(req, auth);
        const client = clientId ? await getClient(clientId) : null;
        const flow = saveFlow({
          id: body?.id,
          name: body?.name || "Novo fluxo",
          product: client?.slug || body?.product || "gestor",
          accountId: body?.accountId ?? null,
          clientId,
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
        // O builder manda nodes/edges do canvas pra permitir testar sem salvar.
        // O clientId PRECISA vir junto: sem ele o card de IA não consulta a base
        // de conhecimento (o RAG exige saber de qual cliente é a base), e o
        // "Testar" respondia sem o que a equipe ensinou — parecendo que o RAG
        // não funcionava. Preferimos o clientId do fluxo salvo, caindo pro
        // contexto da requisição quando o fluxo ainda não existe.
        const saved = body.flowId ? getFlow(body.flowId) : null;
        flow = {
          id: body.flowId || "sim",
          name: body.name || "Simulação",
          product: body.product || "gestor",
          accountId: null,
          clientId: saved?.clientId ?? actingClientId(req, auth),
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
        const existing = getFlow(flowId);
        if (!existing) {
          json(res, 404, { ok: false, reason: "flowNotFound" });
          return;
        }
        const clientId = actingClientId(req, auth);
        if (clientId && existing.clientId && existing.clientId !== clientId) {
          json(res, 403, { ok: false, reason: "forbidden" });
          return;
        }
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

    // ── Histórico de versões de um fluxo ──────────────────
    const versionMatch = path.match(
      /^\/v1\/flows\/([a-zA-Z0-9_-]+)\/versions(?:\/([a-zA-Z0-9_-]+)\/restore)?$/
    );
    if (versionMatch) {
      const flowId = versionMatch[1];
      const versionId = versionMatch[2];

      if (method === "GET" && !versionId) {
        if (!getFlow(flowId)) {
          json(res, 404, { ok: false, reason: "flowNotFound" });
          return;
        }
        const versions = listFlowVersions(flowId).map((v) => ({
          id: v.id,
          savedAt: v.savedAt,
          name: v.snapshot.name,
          product: v.snapshot.product,
          status: v.snapshot.status,
          nodeCount: v.snapshot.nodes.length,
        }));
        json(res, 200, { ok: true, versions });
        return;
      }

      if (method === "POST" && versionId) {
        const flow = restoreFlowVersion(flowId, versionId);
        if (!flow) {
          json(res, 404, { ok: false, reason: "versionNotFound" });
          return;
        }
        json(res, 200, { ok: true, flow });
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
        `^/v1/accounts/(${UUID_RE})(?:/(status|connect|disconnect|send|profile|contacts))?$`,
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

      if (method === "GET" && action === "contacts") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        json(res, 200, listContacts(accountId));
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
            kind?: "image" | "document" | "audio" | "video";
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

      if (method === "POST" && action === "edit") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        const body = parseJson<{ to?: string; externalId?: string; body?: string }>(
          await readBody(req),
        );
        if (!body?.to || !body.externalId) {
          json(res, 400, { ok: false, reason: "missingFields" });
          return;
        }
        const result = await editText(
          accountId,
          body.to,
          body.externalId,
          body.body ?? "",
        );
        json(res, result.ok ? 200 : 409, result);
        return;
      }

      if (method === "POST" && action === "delete") {
        if (!getAccount(accountId)) {
          json(res, 404, { ok: false, reason: "accountNotFound" });
          return;
        }
        const body = parseJson<{ to?: string; externalId?: string }>(
          await readBody(req),
        );
        if (!body?.to || !body.externalId) {
          json(res, 400, { ok: false, reason: "missingFields" });
          return;
        }
        const result = await deleteSentMessage(accountId, body.to, body.externalId);
        json(res, result.ok ? 200 : 409, result);
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

void (async () => {
  try {
    await migrate();
    await seedAdmin();
    // Normaliza status persistido ANTES de reconectar de verdade — sem isso, uma
    // conta que tenha morrido num crash duro (sem passar pelo evento `close`)
    // continuaria "connected" na tabela até a próxima transição real.
    await resetConnectionStatusOnBoot();
  } catch (e) {
    console.error("[glabs-bot] migrate/seed:", e);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[glabs-bot] :${PORT} data=${dataDir()} auth=${authDir()} public=${PUBLIC_DIR} production=${isProduction()} db=${hasDatabase()}`
    );
    console.log(`[glabs-bot] admin UI → http://0.0.0.0:${PORT}/admin`);
    void restoreSessionsFromDisk();
    void import("./outbox.js").then(({ startOutboxWorker }) => startOutboxWorker());
  });
})();
