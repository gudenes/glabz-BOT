import { randomUUID } from "node:crypto";
import { db, hasDatabase } from "./db.js";
import { createUser, generateTempPassword, newId, type UserRecord } from "./auth.js";
import {
  deleteAccount,
  ensureAccount,
  listAccounts,
  upsertProduct,
  type AccountRecord,
} from "./registry.js";
import { deleteFlowsForClient, saveFlow } from "./flows/store.js";
import { allSeedTemplates } from "./flows/templates.js";
import type { Flow } from "./flows/types.js";

export type ClientRecord = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
};

export function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return s || "cliente";
}

export async function listClients(): Promise<ClientRecord[]> {
  if (!hasDatabase()) return [];
  const rows = await db()`
    SELECT id, name, slug, created_at FROM clients ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    createdAt: new Date(r.created_at as Date).toISOString(),
  }));
}

export async function getClient(id: string): Promise<ClientRecord | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`SELECT id, name, slug, created_at FROM clients WHERE id = ${id} LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    createdAt: new Date(r.created_at as Date).toISOString(),
  };
}

export async function getClientBySlug(slug: string): Promise<ClientRecord | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT id, name, slug, created_at FROM clients WHERE slug = ${slug} LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    createdAt: new Date(r.created_at as Date).toISOString(),
  };
}

export async function listClientUsers(clientId: string): Promise<UserRecord[]> {
  if (!hasDatabase()) return [];
  const rows = await db()`
    SELECT id, email, name, role, client_id, must_change_password, created_at
    FROM users WHERE client_id = ${clientId}
    ORDER BY created_at
  `;
  return rows.map((r) => ({
    id: r.id as string,
    email: r.email as string,
    name: (r.name as string) || null,
    role: r.role as "client",
    clientId: r.client_id as string,
    mustChangePassword: Boolean(r.must_change_password),
    createdAt: new Date(r.created_at as Date).toISOString(),
  }));
}

function pickTemplate(kind?: string): Flow {
  const all = allSeedTemplates();
  if (kind === "blank") {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      name: "Atendimento",
      product: "gestor",
      accountId: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: "n_trigger",
          type: "trigger",
          x: 80,
          y: 60,
          data: { label: "Mensagem recebida" },
        },
      ],
      edges: [],
    };
  }
  if (kind === "consulta") return all.find((f) => /consulta/i.test(f.name)) || all[0];
  if (kind === "pilates") return all.find((f) => /pilates|sess[aã]o/i.test(f.name)) || all[0];
  return all[0];
}

export async function provisionClient(input: {
  name: string;
  email: string;
  template?: string;
}): Promise<{
  client: ClientRecord;
  account: AccountRecord;
  user: UserRecord;
  tempPassword: string;
  flow: Flow;
}> {
  if (!hasDatabase()) throw new Error("Postgres obrigatório para criar cliente");
  const name = input.name.trim();
  if (name.length < 2) throw new Error("nome do cliente obrigatório");
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("e-mail inválido");

  let slug = slugify(name);
  const clash = await getClientBySlug(slug);
  if (clash) slug = `${slug}-${newId("").slice(0, 4)}`;

  const client: ClientRecord = {
    id: newId("cli"),
    name,
    slug,
    createdAt: new Date().toISOString(),
  };
  await db()`
    INSERT INTO clients (id, name, slug, created_at)
    VALUES (${client.id}, ${client.name}, ${client.slug}, ${client.createdAt})
  `;

  upsertProduct({ slug, name, defaultWebhookUrl: null });

  const account = ensureAccount({
    product: slug,
    externalTenantId: client.id,
    webhookUrl: "https://glabs.internal/noop",
    label: name,
    allowEmptyWebhook: true,
    clientId: client.id,
  });

  await db()`
    UPDATE accounts SET client_id = ${client.id} WHERE id = ${account.id}
  `.catch(() => undefined);

  const seed = pickTemplate(input.template);
  const flow = saveFlow({
    id: randomUUID(),
    name: seed.name.replace(/^Demo ·\s*/i, "") || "Atendimento",
    product: slug,
    accountId: account.id,
    status: "draft",
    nodes: seed.nodes,
    edges: seed.edges,
    clientId: client.id,
  });

  const tempPassword = generateTempPassword();
  const user = await createUser({
    email,
    password: tempPassword,
    name,
    role: "client",
    clientId: client.id,
    mustChangePassword: true,
  });

  return { client, account, user, tempPassword, flow };
}

export async function deleteClient(id: string): Promise<boolean> {
  const existing = await getClient(id);
  if (!existing) return false;
  const accounts = listAccounts({ clientId: id });
  for (const acc of accounts) {
    try {
      const { disconnect } = await import("./session.js");
      await disconnect(acc.id);
    } catch {
      /* sessão pode não estar no ar */
    }
    deleteAccount(acc.id);
  }
  deleteFlowsForClient(id);
  if (hasDatabase()) {
    await db()`DELETE FROM wa_messages WHERE client_id = ${id}`;
    await db()`DELETE FROM users WHERE client_id = ${id}`;
    await db()`DELETE FROM accounts WHERE client_id = ${id}`;
    await db()`DELETE FROM clients WHERE id = ${id}`;
  }
  return true;
}

export async function wipeAllClients(): Promise<{ deleted: string[] }> {
  const all = await listClients();
  const deleted: string[] = [];
  for (const c of all) {
    if (await deleteClient(c.id)) deleted.push(c.name);
  }
  return { deleted };
}
