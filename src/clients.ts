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
import { blankFlow, pickCatalogFlow } from "./flows/catalog.js";
import type { Flow } from "./flows/types.js";

export type ClientRecord = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  billingName: string | null;
  billingDocument: string | null;
  billingWhatsapp: string | null;
  billingZip: string | null;
  billingStreet: string | null;
  billingNumber: string | null;
  billingDistrict: string | null;
  billingComplement: string | null;
  bizRole: string | null;
  bizSize: string | null;
  bizSegment: string | null;
  bizAudience: string | null;
  bizSource: string | null;
  bizWebsite: string | null;
  bizProfileUpdatedAt: string | null;
};

function rowToClient(r: Record<string, unknown>): ClientRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    createdAt: new Date(r.created_at as Date).toISOString(),
    billingName: (r.billing_name as string) || null,
    billingDocument: (r.billing_document as string) || null,
    billingWhatsapp: (r.billing_whatsapp as string) || null,
    billingZip: (r.billing_zip as string) || null,
    billingStreet: (r.billing_street as string) || null,
    billingNumber: (r.billing_number as string) || null,
    billingDistrict: (r.billing_district as string) || null,
    billingComplement: (r.billing_complement as string) || null,
    bizRole: (r.biz_role as string) || null,
    bizSize: (r.biz_size as string) || null,
    bizSegment: (r.biz_segment as string) || null,
    bizAudience: (r.biz_audience as string) || null,
    bizSource: (r.biz_source as string) || null,
    bizWebsite: (r.biz_website as string) || null,
    bizProfileUpdatedAt: r.biz_profile_updated_at
      ? new Date(r.biz_profile_updated_at as Date).toISOString()
      : null,
  };
}

/** Só dígitos — usado pra CPF/CNPJ e CEP antes de validar/gravar. */
function onlyDigits(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

/** Valida CPF (11 dígitos) ou CNPJ (14 dígitos) pelo dígito verificador. */
export function isValidDocument(raw: string): boolean {
  const doc = onlyDigits(raw);
  if (doc.length === 11) return isValidCPF(doc);
  if (doc.length === 14) return isValidCNPJ(doc);
  return false;
}

function isValidCPF(cpf: string): boolean {
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return check === Number(cpf[10]);
}

function isValidCNPJ(cnpj: string): boolean {
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base: string): number => {
    const weights =
      base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * weights[i];
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };
  if (calc(cnpj.slice(0, 12)) !== Number(cnpj[12])) return false;
  return calc(cnpj.slice(0, 13)) === Number(cnpj[13]);
}

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
    SELECT id, name, slug, created_at,
      billing_name, billing_document, billing_whatsapp, billing_zip,
      billing_street, billing_number, billing_district, billing_complement,
      biz_role, biz_size, biz_segment, biz_audience, biz_source, biz_website, biz_profile_updated_at
    FROM clients ORDER BY created_at DESC
  `;
  return rows.map(rowToClient);
}

export async function getClient(id: string): Promise<ClientRecord | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT id, name, slug, created_at,
      billing_name, billing_document, billing_whatsapp, billing_zip,
      billing_street, billing_number, billing_district, billing_complement,
      biz_role, biz_size, biz_segment, biz_audience, biz_source, biz_website, biz_profile_updated_at
    FROM clients WHERE id = ${id} LIMIT 1
  `;
  const r = rows[0];
  return r ? rowToClient(r) : null;
}

export async function getClientBySlug(slug: string): Promise<ClientRecord | null> {
  if (!hasDatabase()) return null;
  const rows = await db()`
    SELECT id, name, slug, created_at,
      billing_name, billing_document, billing_whatsapp, billing_zip,
      billing_street, billing_number, billing_district, billing_complement,
      biz_role, biz_size, biz_segment, biz_audience, biz_source, biz_website, biz_profile_updated_at
    FROM clients WHERE slug = ${slug} LIMIT 1
  `;
  const r = rows[0];
  return r ? rowToClient(r) : null;
}

export type ClientBillingPatch = {
  billingName?: string | null;
  billingDocument?: string | null;
  billingWhatsapp?: string | null;
  billingZip?: string | null;
  billingStreet?: string | null;
  billingNumber?: string | null;
  billingDistrict?: string | null;
  billingComplement?: string | null;
};

/** Atualiza os dados de faturamento do cliente. Campos ausentes/undefined não são tocados. */
export async function updateClientBilling(
  clientId: string,
  patch: ClientBillingPatch
): Promise<ClientRecord | null> {
  if (!hasDatabase()) throw new Error("Postgres obrigatório");
  const existing = await getClient(clientId);
  if (!existing) return null;

  const document = patch.billingDocument !== undefined ? onlyDigits(patch.billingDocument || "") : undefined;
  if (document && !isValidDocument(document)) {
    throw new Error("CPF/CNPJ inválido");
  }
  const zip = patch.billingZip !== undefined ? onlyDigits(patch.billingZip || "") : undefined;

  await db()`
    UPDATE clients SET
      billing_name = ${patch.billingName !== undefined ? patch.billingName : existing.billingName},
      billing_document = ${document !== undefined ? document || null : existing.billingDocument},
      billing_whatsapp = ${patch.billingWhatsapp !== undefined ? patch.billingWhatsapp : existing.billingWhatsapp},
      billing_zip = ${zip !== undefined ? zip || null : existing.billingZip},
      billing_street = ${patch.billingStreet !== undefined ? patch.billingStreet : existing.billingStreet},
      billing_number = ${patch.billingNumber !== undefined ? patch.billingNumber : existing.billingNumber},
      billing_district = ${patch.billingDistrict !== undefined ? patch.billingDistrict : existing.billingDistrict},
      billing_complement = ${patch.billingComplement !== undefined ? patch.billingComplement : existing.billingComplement}
    WHERE id = ${clientId}
  `;
  return getClient(clientId);
}

export type ClientBizProfilePatch = {
  bizRole?: string | null;
  bizSize?: string | null;
  bizSegment?: string | null;
  bizAudience?: string | null;
  bizSource?: string | null;
  bizWebsite?: string | null;
};

/** Atualiza o bloco "sobre o negócio" (perfil/onboarding) do cliente. */
export async function updateClientBizProfile(
  clientId: string,
  patch: ClientBizProfilePatch
): Promise<ClientRecord | null> {
  if (!hasDatabase()) throw new Error("Postgres obrigatório");
  const existing = await getClient(clientId);
  if (!existing) return null;

  await db()`
    UPDATE clients SET
      biz_role = ${patch.bizRole !== undefined ? patch.bizRole : existing.bizRole},
      biz_size = ${patch.bizSize !== undefined ? patch.bizSize : existing.bizSize},
      biz_segment = ${patch.bizSegment !== undefined ? patch.bizSegment : existing.bizSegment},
      biz_audience = ${patch.bizAudience !== undefined ? patch.bizAudience : existing.bizAudience},
      biz_source = ${patch.bizSource !== undefined ? patch.bizSource : existing.bizSource},
      biz_website = ${patch.bizWebsite !== undefined ? patch.bizWebsite : existing.bizWebsite},
      biz_profile_updated_at = now()
    WHERE id = ${clientId}
  `;
  return getClient(clientId);
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

/**
 * Fluxo inicial do cliente novo. A escolha do template em si vive em
 * catalog.ts (`pickCatalogFlow`) — antes essa lógica estava duplicada aqui e
 * no endpoint /v1/flows/from-template, com defaults diferentes entre si.
 */
function pickTemplate(kind?: string): Flow {
  return pickCatalogFlow(kind) ?? blankFlow();
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
    billingName: null,
    billingDocument: null,
    billingWhatsapp: null,
    billingZip: null,
    billingStreet: null,
    billingNumber: null,
    billingDistrict: null,
    billingComplement: null,
    bizRole: null,
    bizSize: null,
    bizSegment: null,
    bizAudience: null,
    bizSource: null,
    bizWebsite: null,
    bizProfileUpdatedAt: null,
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
