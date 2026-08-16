/** Resultado padronizado de qualquer connector. */
export type ConnectorResult = {
  ok: boolean;
  /** vars a mergear no estado do fluxo */
  vars?: Record<string, string>;
  error?: string;
  message?: string;
  /** mock | http | ... */
  source?: string;
};

export type ConnectorContext = {
  accountId?: string | null;
  product?: string;
  clientId?: string | null;
  /** true no simulador — preferir mock se não houver webhook */
  simulate?: boolean;
};
