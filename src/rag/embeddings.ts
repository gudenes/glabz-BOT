/**
 * Geração de embeddings (vetores) para a busca semântica.
 *
 * Provedor: OpenAI. xAI/Grok — que o bot usa pra gerar respostas — NÃO expõe
 * API de embeddings, então o RAG obriga um segundo provedor
 * (docs/rag-desenho.md §3).
 *
 * Modelo: text-embedding-3-small. Escolhido por teste, não por preço: o
 * -large teve desempenho PIOR na separação entre pergunta relevante e
 * irrelevante em português (§4.2). O menor ainda é mais barato.
 */
import { embeddingApiKey, embeddingModel } from "../config.js";

/** Gravado em cada linha: vetores de modelos diferentes não são comparáveis. */
export const EMBEDDING_MODEL_DEFAULT = "text-embedding-3-small";

const API_URL = "https://api.openai.com/v1/embeddings";
/** A API aceita lote; agrupar reduz round-trips na indexação inicial. */
const BATCH_SIZE = 96;

export function embeddingsConfigured(): boolean {
  return Boolean(embeddingApiKey());
}

/**
 * Texto que de fato vira vetor.
 *
 * Indexamos o PAR pergunta→resposta porque mede melhor que só a resposta
 * (§4.1: margem 0,057 contra 0,020). Pergunta e resposta são textos de
 * natureza diferente, e comparar pergunta-com-resposta é assimétrico.
 */
export function pairToText(question: string, answer: string): string {
  return `Pergunta: ${question}\nResposta: ${answer}`;
}

type EmbedResult =
  | { ok: true; vectors: number[][]; model: string; tokens: number }
  | { ok: false; reason: string };

export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  const key = embeddingApiKey();
  if (!key) return { ok: false, reason: "sem_chave_de_embedding" };
  if (!texts.length) return { ok: true, vectors: [], model: embeddingModel(), tokens: 0 };

  const model = embeddingModel();
  const vectors: number[][] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: slice }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[rag] embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
        return { ok: false, reason: `http_${res.status}` };
      }
      const data = (await res.json()) as {
        data?: { embedding: number[]; index: number }[];
        usage?: { total_tokens?: number };
      };
      // A API não garante ordem — reordenar pelo index é obrigatório, senão o
      // vetor de um par acaba salvo em outro (erro silencioso e difícil de achar).
      const sorted = (data.data || []).slice().sort((a, b) => a.index - b.index);
      if (sorted.length !== slice.length) {
        return { ok: false, reason: "resposta_incompleta" };
      }
      for (const item of sorted) vectors.push(item.embedding);
      tokens += data.usage?.total_tokens ?? 0;
    } catch (e) {
      console.warn("[rag] embeddings falhou:", e instanceof Error ? e.message : e);
      return { ok: false, reason: "falha_na_chamada" };
    }
  }

  return { ok: true, vectors, model, tokens };
}

/** Formato que o pgvector aceita em texto: "[0.1,0.2,...]". */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
