import { runCalendar } from "./calendar.js";
import { runHttp } from "./http.js";
import type { ConnectorContext, ConnectorResult } from "./types.js";

export type { ConnectorContext, ConnectorResult } from "./types.js";

export type ConnectorRun = (opts: {
  operation: string;
  vars: Record<string, string>;
  config: Record<string, unknown>;
  ctx?: ConnectorContext;
}) => Promise<ConnectorResult>;

export type ConnectorSpec = {
  /** Nome exibido na UI. */
  label: string;
  /** Operações suportadas — a UI monta o select a partir daqui. */
  operations: { value: string; label: string }[];
  /** Operação assumida quando o nó não especifica. */
  defaultOperation: string;
  run: ConnectorRun;
};

/**
 * Registro de connectors.
 *
 * Era um if/else hardcoded aqui dentro, e a UI tinha a mesma lista repetida em
 * HTML — adicionar uma integração significava mexer nos dois lugares e lembrar
 * de todos os pontos. Agora este objeto é a fonte única: o backend despacha por
 * ele e a UI monta os selects a partir de GET /v1/flows/connectors.
 */
export const CONNECTORS: Record<string, ConnectorSpec> = {
  calendar: {
    label: "Calendário",
    defaultOperation: "list_slots",
    operations: [
      { value: "list_slots", label: "Listar horários livres" },
      { value: "create_event", label: "Criar evento" },
      { value: "cancel_event", label: "Cancelar evento" },
    ],
    run: ({ operation, vars, config, ctx }) => runCalendar({ operation, vars, config, ctx }),
  },
  http: {
    label: "HTTP / webhook",
    defaultOperation: "request",
    // O connector http é um passa-tudo: quem define o que acontece é o serviço
    // do outro lado, então não há operações a escolher.
    operations: [{ value: "request", label: "Chamar a URL" }],
    run: ({ vars, config, ctx }) => runHttp({ vars, config, ctx }),
  },
};

/** Metadados pra UI — sem expor as funções. */
export function connectorCatalog(): {
  slug: string;
  label: string;
  operations: { value: string; label: string }[];
  defaultOperation: string;
}[] {
  return Object.entries(CONNECTORS).map(([slug, spec]) => ({
    slug,
    label: spec.label,
    operations: spec.operations,
    defaultOperation: spec.defaultOperation,
  }));
}

/**
 * Executa o connector do nó `action`.
 * data do nó:
 *   connector: slug registrado em CONNECTORS
 *   operation: string (ex. list_slots)
 *   config?: { webhookUrl, url, durationMin, ... }
 *   label?: string
 */
export async function runAction(opts: {
  connector: string;
  operation?: string;
  vars: Record<string, string>;
  config?: Record<string, unknown>;
  ctx?: ConnectorContext;
}): Promise<ConnectorResult> {
  const connector = (opts.connector || "calendar").toLowerCase();
  const spec = CONNECTORS[connector];

  if (!spec) {
    return {
      ok: false,
      error: "unknown_connector",
      message: `Integração desconhecida: ${connector}`,
      source: "none",
    };
  }

  const operation = opts.operation || spec.defaultOperation;
  if (!spec.operations.some((o) => o.value === operation)) {
    return {
      ok: false,
      error: "unknown_operation",
      message: `Operação "${operation}" não existe em ${spec.label}`,
      source: "none",
    };
  }

  return spec.run({ operation, vars: opts.vars, config: opts.config || {}, ctx: opts.ctx });
}
