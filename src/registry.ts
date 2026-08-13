/**
 * Registry em disco: products + WhatsApp accounts (1 número = 1 account).
 *
 * product  = slug do app GLabs (gestor, prontuario, …)
 * externalTenantId = tenantId no app cliente
 * accountId = UUID opaco no bot
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { registryPath } from "./config.js";

export type ProductRecord = {
  slug: string;
  name: string;
  /** Webhook default para accounts novos deste product (pode ser sobrescrito por account). */
  defaultWebhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountRecord = {
  id: string;
  product: string;
  externalTenantId: string;
  /** URL do webhook no app cliente (inbound + status). */
  webhookUrl: string;
  label: string | null;
  clientId?: string | null;
  createdAt: string;
  updatedAt: string;
};

type RegistryFile = {
  version: 1;
  products: ProductRecord[];
  accounts: AccountRecord[];
};

const DEFAULT_PRODUCTS: Omit<ProductRecord, "createdAt" | "updatedAt">[] = [
  { slug: "gestor", name: "Gestor de Seguros", defaultWebhookUrl: null },
  { slug: "prontuario", name: "Prontuário Contábil", defaultWebhookUrl: null },
];

function emptyRegistry(): RegistryFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    products: DEFAULT_PRODUCTS.map((p) => ({
      ...p,
      createdAt: now,
      updatedAt: now,
    })),
    accounts: [],
  };
}

function load(): RegistryFile {
  const path = registryPath();
  try {
    if (!existsSync(path)) return emptyRegistry();
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as RegistryFile;
    if (!data || data.version !== 1 || !Array.isArray(data.accounts)) {
      return emptyRegistry();
    }
    if (!Array.isArray(data.products) || data.products.length === 0) {
      data.products = emptyRegistry().products;
    }
    // Merge default products if missing
    const now = new Date().toISOString();
    for (const d of DEFAULT_PRODUCTS) {
      if (!data.products.some((p) => p.slug === d.slug)) {
        data.products.push({ ...d, createdAt: now, updatedAt: now });
      }
    }
    return data;
  } catch {
    return emptyRegistry();
  }
}

function save(reg: RegistryFile): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2), "utf8");
}

export function listProducts(): ProductRecord[] {
  return load().products.slice().sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getProduct(slug: string): ProductRecord | null {
  const s = slug.trim().toLowerCase();
  return load().products.find((p) => p.slug === s) ?? null;
}

/**
 * Cria ou atualiza um product (slug livre, ex.: "gestor", "prontuario", "quemcuida").
 */
export function upsertProduct(input: {
  slug: string;
  name?: string;
  defaultWebhookUrl?: string | null;
}): ProductRecord {
  const reg = load();
  const slug = normalizeProductSlug(input.slug);
  if (!slug) throw new Error("slug inválido (use letras, números e hífen)");

  const now = new Date().toISOString();
  const existing = reg.products.find((p) => p.slug === slug);
  if (existing) {
    if (input.name?.trim()) existing.name = input.name.trim();
    if (input.defaultWebhookUrl !== undefined) {
      existing.defaultWebhookUrl = normalizeUrl(input.defaultWebhookUrl);
    }
    existing.updatedAt = now;
    save(reg);
    return existing;
  }

  const created: ProductRecord = {
    slug,
    name: input.name?.trim() || slug,
    defaultWebhookUrl: normalizeUrl(input.defaultWebhookUrl ?? null),
    createdAt: now,
    updatedAt: now,
  };
  reg.products.push(created);
  save(reg);
  return created;
}

export function listAccounts(filter?: {
  product?: string;
  externalTenantId?: string;
  clientId?: string;
}): AccountRecord[] {
  let list = load().accounts;
  if (filter?.product) {
    const p = filter.product.trim().toLowerCase();
    list = list.filter((a) => a.product === p);
  }
  if (filter?.externalTenantId) {
    list = list.filter((a) => a.externalTenantId === filter.externalTenantId);
  }
  if (filter?.clientId) {
    list = list.filter(
      (a) => a.clientId === filter.clientId || a.externalTenantId === filter.clientId
    );
  }
  return list;
}

export function getAccount(accountId: string): AccountRecord | null {
  return load().accounts.find((a) => a.id === accountId) ?? null;
}

export function findAccount(
  product: string,
  externalTenantId: string
): AccountRecord | null {
  const p = product.trim().toLowerCase();
  return (
    load().accounts.find(
      (a) => a.product === p && a.externalTenantId === externalTenantId
    ) ?? null
  );
}

/**
 * Garante account para (product, externalTenantId). Idempotente.
 * Se o product não existir, cria com o slug informado.
 */
export function ensureAccount(input: {
  product: string;
  externalTenantId: string;
  webhookUrl?: string | null;
  label?: string | null;
  allowEmptyWebhook?: boolean;
  clientId?: string | null;
}): AccountRecord {
  const productSlug = normalizeProductSlug(input.product);
  if (!productSlug) throw new Error("product inválido");
  const tenantId = input.externalTenantId?.trim();
  if (!tenantId) throw new Error("externalTenantId obrigatório");

  const reg = load();
  const now = new Date().toISOString();

  let product = reg.products.find((p) => p.slug === productSlug);
  if (!product) {
    product = {
      slug: productSlug,
      name: productSlug,
      defaultWebhookUrl: null,
      createdAt: now,
      updatedAt: now,
    };
    reg.products.push(product);
  }

  const existing = reg.accounts.find(
    (a) => a.product === productSlug && a.externalTenantId === tenantId
  );

  let webhook =
    normalizeUrl(input.webhookUrl) ||
    existing?.webhookUrl ||
    product.defaultWebhookUrl;

  if (!webhook && !input.allowEmptyWebhook) {
    throw new Error(
      "webhookUrl obrigatório (informe na account ou defaultWebhookUrl no product)"
    );
  }
  if (!webhook) webhook = "https://glabs.internal/noop";

  if (existing) {
    // Não deixa dev local (localhost) sobrescrever webhook de produção
    const nextIsLoopback = isLoopbackWebhook(webhook);
    const prevIsPublic =
      Boolean(existing.webhookUrl) && !isLoopbackWebhook(existing.webhookUrl);
    if (nextIsLoopback && prevIsPublic) {
      // mantém existing.webhookUrl
    } else {
      existing.webhookUrl = webhook;
    }
    if (input.label !== undefined) existing.label = input.label?.trim() || null;
    if (input.clientId) existing.clientId = input.clientId;
    existing.updatedAt = now;
    save(reg);
    return existing;
  }

  const created: AccountRecord = {
    id: randomUUID(),
    product: productSlug,
    externalTenantId: tenantId,
    webhookUrl: webhook,
    label: input.label?.trim() || null,
    clientId: input.clientId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  reg.accounts.push(created);
  save(reg);
  return created;
}

export function updateAccount(
  accountId: string,
  patch: { webhookUrl?: string; label?: string | null }
): AccountRecord | null {
  const reg = load();
  const acc = reg.accounts.find((a) => a.id === accountId);
  if (!acc) return null;
  if (patch.webhookUrl !== undefined) {
    const u = normalizeUrl(patch.webhookUrl);
    if (!u) throw new Error("webhookUrl inválida");
    acc.webhookUrl = u;
  }
  if (patch.label !== undefined) acc.label = patch.label?.trim() || null;
  acc.updatedAt = new Date().toISOString();
  save(reg);
  return acc;
}

export function deleteAccount(accountId: string): boolean {
  const reg = load();
  const before = reg.accounts.length;
  reg.accounts = reg.accounts.filter((a) => a.id !== accountId);
  if (reg.accounts.length === before) return false;
  save(reg);
  return true;
}

function normalizeProductSlug(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!s || s.length > 64) return null;
  return s;
}

function normalizeUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const u = raw.trim().replace(/\/$/, "");
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/** localhost / 127.0.0.1 — não deve substituir webhook público em produção. */
function isLoopbackWebhook(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url);
  }
}
