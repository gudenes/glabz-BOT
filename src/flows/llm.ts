import { llmApiKey, llmBaseUrl, llmModel } from "../config.js";

/**
 * Classifica intenção com LLM (xAI/OpenAI-compatible).
 * Fallback: keywords se não houver API key ou se a chamada falhar.
 */
export async function classifyIntent(opts: {
  text: string;
  intents: { slug: string; description: string }[];
  systemHint?: string;
}): Promise<{ intent: string; source: "llm" | "keyword" | "default" }> {
  const intents = opts.intents.filter((i) => i.slug?.trim());
  if (!intents.length) return { intent: "default", source: "default" };

  const key = llmApiKey();
  if (key) {
    try {
      const slugs = intents.map((i) => i.slug).join(", ");
      const catalog = intents
        .map((i) => `- ${i.slug}: ${i.description}`)
        .join("\n");
      const res = await fetch(`${llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: llmModel(),
          temperature: 0,
          max_tokens: 40,
          messages: [
            {
              role: "system",
              content:
                (opts.systemHint ||
                  "Você classifica intenções de mensagens de WhatsApp em português.") +
                `\nResponda APENAS com um dos slugs: ${slugs}\n\nCatálogo:\n${catalog}`,
            },
            { role: "user", content: opts.text.slice(0, 800) },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
        const hit = intents.find(
          (i) =>
            raw === i.slug.toLowerCase() ||
            raw.includes(i.slug.toLowerCase())
        );
        if (hit) return { intent: hit.slug, source: "llm" };
      } else {
        console.warn("[flow/llm] HTTP", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.warn("[flow/llm] failed", (e as Error).message);
    }
  }

  // Keyword fallback
  const t = opts.text.toLowerCase();
  for (const i of intents) {
    const words = i.description
      .toLowerCase()
      .split(/[,;|/]/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2);
    if (words.some((w) => t.includes(w))) {
      return { intent: i.slug, source: "keyword" };
    }
    if (t.includes(i.slug.replace(/_/g, " "))) {
      return { intent: i.slug, source: "keyword" };
    }
  }

  // Heuristics for demo intents
  if (
    /sess[aã]o|pilates|aula|vaga|experimental|remarcar/.test(t) ||
    /consulta|agend|marcar|hor[aá]rio|visita|reuni[aã]o/.test(t)
  ) {
    const m = intents.find(
      (i) =>
        i.slug.includes("sessao") ||
        i.slug.includes("consulta") ||
        i.slug.includes("agend") ||
        i.slug.includes("marcar")
    );
    if (m) return { intent: m.slug, source: "keyword" };
  }
  if (/d[uú]vida|como funciona|valor|pre[cç]o|plano|iniciante/.test(t)) {
    const m = intents.find(
      (i) => i.slug.includes("duvida") || i.slug.includes("faq") || i.slug.includes("outro")
    );
    if (m) return { intent: m.slug, source: "keyword" };
  }
  if (
    /admin|boleto|nota fiscal|cancel|mensalidade|financeiro|contrato|rematr/.test(t)
  ) {
    const m = intents.find((i) => i.slug.includes("admin"));
    if (m) return { intent: m.slug, source: "keyword" };
  }
  if (/humano|atendente|pessoa|operador|algu[eé]m/.test(t)) {
    const m = intents.find((i) => i.slug.includes("humano") || i.slug.includes("atend"));
    if (m) return { intent: m.slug, source: "keyword" };
  }

  return { intent: "default", source: "default" };
}
