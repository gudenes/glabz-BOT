/**
 * Persistência da base de conhecimento (knowledge_chunks).
 *
 * Todo acesso filtra por client_id — isolamento entre clientes é estrutural,
 * não opcional no call site (docs/rag-desenho.md §5.4). Um vazamento aqui
 * significaria a farmácia lendo conversa do estúdio de pilates.
 */
import { randomUUID } from "node:crypto";
import { db, hasDatabase, isVectorReady } from "../db.js";
import { extractQAPairs, type QAPair } from "./extract.js";
import { embedTexts, pairToText, toPgVector, embeddingsConfigured } from "./embeddings.js";

export type IndexResult = {
  ok: boolean;
  indexed: number;
  skipped: number;
  tokens: number;
  reason?: string;
};

/** Chave estável do par — permite reindexar sem duplicar. */
function chunkKey(clientId: string, pair: QAPair): string {
  return `${clientId}|${pair.question}|${pair.answer}`;
}

/**
 * Reindexa a base de um cliente a partir do histórico.
 *
 * Em lote, não a cada mensagem: mais barato (a API cobra por chamada de token)
 * e, principalmente, não acopla o caminho de atendimento a uma chamada externa
 * — uma indisponibilidade da OpenAI não pode atrasar a resposta ao cliente
 * final (§6, etapa 3).
 */
export async function reindexClient(clientId: string): Promise<IndexResult> {
  if (!hasDatabase()) return { ok: false, indexed: 0, skipped: 0, tokens: 0, reason: "sem_banco" };
  if (!isVectorReady()) {
    return { ok: false, indexed: 0, skipped: 0, tokens: 0, reason: "pgvector_indisponivel" };
  }
  if (!embeddingsConfigured()) {
    return { ok: false, indexed: 0, skipped: 0, tokens: 0, reason: "sem_chave_de_embedding" };
  }

  const pairs = await extractQAPairs(clientId);
  if (!pairs.length) return { ok: true, indexed: 0, skipped: 0, tokens: 0 };

  // Já indexados nesta mesma revisão: pula pra não pagar embedding de novo.
  const existentes = (await db()`
    SELECT question, answer, occurrences
    FROM knowledge_chunks
    WHERE client_id = ${clientId}
  `) as unknown as { question: string; answer: string; occurrences: number }[];
  const jaTem = new Map(
    existentes.map((r) => [chunkKey(clientId, r as QAPair), r.occurrences])
  );

  const novos = pairs.filter((p) => {
    const anterior = jaTem.get(chunkKey(clientId, p));
    // Reindexa se é novo OU se a frequência mudou (o peso precisa acompanhar).
    return anterior === undefined || anterior !== p.occurrences;
  });

  if (!novos.length) {
    return { ok: true, indexed: 0, skipped: pairs.length, tokens: 0 };
  }

  const res = await embedTexts(novos.map((p) => pairToText(p.question, p.answer)));
  if (!res.ok) {
    return { ok: false, indexed: 0, skipped: 0, tokens: 0, reason: res.reason };
  }

  let indexed = 0;
  for (let i = 0; i < novos.length; i++) {
    const p = novos[i];
    const vec = toPgVector(res.vectors[i]);
    try {
      await db()`
        INSERT INTO knowledge_chunks
          (id, client_id, question, answer, embedding, occurrences, source_message_ids, origin, embedding_model)
        VALUES (
          ${randomUUID()}, ${clientId}, ${p.question}, ${p.answer},
          ${vec}::vector, ${p.occurrences}, ${p.sourceIds}, 'imported', ${res.model}
        )
        ON CONFLICT DO NOTHING
      `;
      indexed++;
    } catch (e) {
      console.warn("[rag] falha ao gravar chunk:", e instanceof Error ? e.message : e);
    }
  }

  return { ok: true, indexed, skipped: pairs.length - novos.length, tokens: res.tokens };
}

/**
 * Ensina a IA diretamente, sem depender de histórico.
 *
 * Três usos que o histórico sozinho não cobre:
 * - Cliente novo não tem meses de atendimento acumulado, mas já sabe o que
 *   responde todo dia — pode escrever de uma vez.
 * - Correção: quando a IA responde errado, adicionar a resposta certa é mais
 *   direto do que esperar alguém repetir no WhatsApp.
 * - Teste: alimentar a base sem precisar plugar número real.
 *
 * Entra na mesma tabela da extração automática — a origem não muda como a
 * busca funciona. source_message_ids fica vazio, marcando que veio daqui.
 */
export async function teachManual(
  clientId: string,
  question: string,
  answer: string,
  origin: string = "manual"
): Promise<{ ok: boolean; reason?: string }> {
  if (!hasDatabase() || !isVectorReady()) return { ok: false, reason: "pgvector_indisponivel" };
  if (!embeddingsConfigured()) return { ok: false, reason: "sem_chave_de_embedding" };
  const q = question.trim();
  const a = answer.trim();
  if (q.length < 3 || a.length < 3) return { ok: false, reason: "texto_muito_curto" };

  const res = await embedTexts([pairToText(q, a)]);
  if (!res.ok) return { ok: false, reason: res.reason };

  try {
    await db()`
      INSERT INTO knowledge_chunks
        (id, client_id, question, answer, embedding, occurrences, source_message_ids, origin, embedding_model)
      VALUES (
        ${randomUUID()}, ${clientId}, ${q}, ${a},
        ${toPgVector(res.vectors[0])}::vector, 1, ${[]}, ${origin}, ${res.model}
      )
    `;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "falha_ao_gravar" };
  }
}

export type KnowledgeHit = {
  id: string;
  question: string;
  answer: string;
  occurrences: number;
  score: number;
  /** manual · imported · onboarding — só em listKnowledge (diagnóstico/UI). */
  origin?: string;
};

/**
 * Busca os trechos mais próximos da pergunta, dentro do cliente informado.
 *
 * top-k em vez de corte fixo de similaridade: as margens medidas em português
 * são apertadas (0,02–0,06) e um limiar absoluto calibrado num negócio quebra
 * no outro (§4.3). Quem decide o que usar é a IA na geração, que já tem
 * instrução de responder só com o contexto.
 *
 * `minScore` existe apenas pra descartar lixo absoluto, não pra separar
 * relevante de irrelevante.
 */
export async function searchKnowledge(
  clientId: string,
  queryVector: number[],
  opts?: { topK?: number; minScore?: number }
): Promise<KnowledgeHit[]> {
  if (!hasDatabase() || !isVectorReady()) return [];
  const topK = opts?.topK ?? 4;
  const minScore = opts?.minScore ?? 0.15;
  const vec = toPgVector(queryVector);

  const rows = (await db()`
    SELECT id, question, answer, occurrences,
           1 - (embedding <=> ${vec}::vector) AS score
    FROM knowledge_chunks
    WHERE client_id = ${clientId} AND NOT suppressed
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${topK}
  `) as unknown as KnowledgeHit[];

  return rows.filter((r) => Number(r.score) >= minScore);
}

/** Marcação negativa: tira da busca sem apagar o histórico de origem (§5.2). */
export async function suppressChunk(clientId: string, chunkId: string): Promise<boolean> {
  if (!hasDatabase() || !isVectorReady()) return false;
  const rows = await db()`
    UPDATE knowledge_chunks SET suppressed = true, updated_at = now()
    WHERE id = ${chunkId} AND client_id = ${clientId}
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Mesma marcação negativa de suppressChunk, em lote — um UPDATE só em vez de
 * N chamadas (a lista da aba Conhecimento pode ter dezenas de itens). Continua
 * sendo remoção SUAVE: sai da busca, o histórico de origem fica (§5.2).
 */
export async function suppressChunks(clientId: string, chunkIds: string[]): Promise<number> {
  if (!hasDatabase() || !isVectorReady()) return 0;
  const ids = chunkIds.filter((id) => typeof id === "string" && id.trim());
  if (!ids.length) return 0;
  const rows = await db()`
    UPDATE knowledge_chunks SET suppressed = true, updated_at = now()
    WHERE client_id = ${clientId} AND id = ANY(${ids}) AND NOT suppressed
    RETURNING id
  `;
  return rows.length;
}

/**
 * Limpa a base inteira do cliente. Endpoint separado do lote por ids de
 * propósito: listKnowledge devolve no máximo `limit` itens, então "limpar
 * tudo" mandando os ids visíveis deixaria pra trás o que não coube na tela —
 * exatamente o oposto do que o nome promete.
 */
export async function suppressAllKnowledge(clientId: string): Promise<number> {
  if (!hasDatabase() || !isVectorReady()) return 0;
  const rows = await db()`
    UPDATE knowledge_chunks SET suppressed = true, updated_at = now()
    WHERE client_id = ${clientId} AND NOT suppressed
    RETURNING id
  `;
  return rows.length;
}

export async function listKnowledge(clientId: string, limit = 100): Promise<KnowledgeHit[]> {
  if (!hasDatabase() || !isVectorReady()) return [];
  return (await db()`
    SELECT id, question, answer, occurrences, origin, 0 AS score
    FROM knowledge_chunks
    WHERE client_id = ${clientId} AND NOT suppressed
    ORDER BY occurrences DESC, updated_at DESC
    LIMIT ${limit}
  `) as unknown as KnowledgeHit[];
}
