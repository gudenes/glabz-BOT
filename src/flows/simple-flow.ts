/**
 * Esqueleto do fluxo SIMPLES, montado em código.
 *
 * Por que existe: o fluxo simples nasceu quebrado quatro vezes seguidas, cada
 * vez de um jeito diferente — sem card de resposta, sem saída "ok", sem card
 * de espera, e por fim com um laço falso (a pergunta "mais alguma coisa?"
 * ligada direto no Fim). O padrão era sempre o mesmo: escrevia-se uma
 * garantia pro formato quebrado da vez, e a geração seguinte inventava outro.
 *
 * A causa não era o modelo desobedecer: era deixar o modelo DESENHAR O GRAFO
 * de um fluxo cuja forma é fixa por definição. "Simples" é uma forma só. Aqui
 * o código monta a forma e a IA escreve apenas os textos do negócio — assim
 * uma resposta malformada produz textos genéricos, nunca um grafo quebrado.
 *
 * Mesmo princípio que `commonTrunk()` em catalog.ts já usava pros templates.
 */
import type { FlowEdge, FlowNode } from "./types.js";

/**
 * Expressão que reconhece "não preciso de mais nada".
 *
 * Reconhece por COMPOSIÇÃO, não por tamanho: a despedida tem que ser feita
 * só de palavras de encerramento, em qualquer combinação. Qualquer palavra de
 * conteúdo no meio ("sei", "quero", "quanto") desqualifica.
 *
 * A versão anterior limitava o que vinha DEPOIS da primeira palavra a 12
 * caracteres, e por isso "Não, obrigado, só isso mesmo." não era reconhecido —
 * justamente a frase que a validação usa como cliente sintético, o que fazia
 * o laço rodar até o limite e reprovar um fluxo saudável.
 *
 * O caso que importa continuar: "não sei quanto custa" e "não, quero saber o
 * horário" são PERGUNTAS. Encerrar nelas é pior do que perguntar de novo.
 */
const CLOSING_WORD =
  "(n[ãa]o|nada|s[óo] isso|era s[óo]( isso)?|isso mesmo|mesmo|valeu|vlw|obrigad\\w*|brigad\\w*|" +
  "tudo (certo|bem|ok)|ok|por (enquanto|agora)|é isso|de nada|at[ée] mais|tchau|falou|abra[çc]o)";

export const CLOSING_REGEX = `^\\s*${CLOSING_WORD}([\\s,.!;]+${CLOSING_WORD})*[\\s,.!]*$`;

/**
 * A despedida que a validação põe na boca do cliente sintético.
 *
 * Mora aqui, e não em validate.ts, de propósito: se a frase e a expressão
 * acima vivessem em arquivos diferentes elas poderiam divergir em silêncio —
 * foi exatamente o que aconteceu, e o sintoma foi um fluxo correto sendo
 * reprovado por "preso num ciclo". Há um teste amarrando as duas.
 */
export const CLOSING_REPLY = "Não, obrigado, só isso mesmo.";

/** Ids fixos: o esqueleto é sempre o mesmo, então não precisam ser gerados. */
export const SIMPLE_IDS = {
  trigger: "s_ini",
  opening: "s_abre",
  answer: "s_ia",
  followUp: "s_mais",
  decide: "s_dec",
  handoff: "s_hum",
  end: "s_fim",
} as const;

/** O que a IA escreve. Tudo string, tudo opcional — nada aqui desenha grafo. */
export type SimpleFlowTexts = {
  /** Nome do fluxo, só pra lista do dono. */
  name?: string;
  /** Apresentação do negócio + convite ("Aqui é da C3 Pilates. Como posso ajudar?"). */
  apresentacao?: string;
  /** Fatos do briefing que a IA usa pra responder. Vazio é válido: a base de conhecimento supre. */
  context?: string;
  /** O que o bot diz ao passar pra uma pessoa. */
  handoff?: string;
};

const FALLBACK = {
  name: "Atendimento",
  apresentacao: "Como posso te ajudar hoje?",
  handoff: "Vou chamar alguém da equipe pra te ajudar. Só um instante!",
};

const clean = (v: string | undefined, max: number): string =>
  String(v ?? "").trim().slice(0, max);

const n = (id: string, type: FlowNode["type"], data: Record<string, unknown>): FlowNode => ({
  id,
  type,
  x: 0,
  y: 0,
  data,
});

const e = (from: string, to: string, label?: string): FlowEdge => ({
  id: `e_${from}_${to}${label ? `_${label}` : ""}`,
  from,
  to,
  ...(label ? { label } : {}),
});

/**
 * Monta o fluxo simples: 7 cards, sempre os mesmos, sempre ligados igual.
 *
 * A conversa que isso produz:
 *   cliente "oi" → bot cumprimenta e PERGUNTA o que a pessoa precisa, e espera
 *   cliente pergunta → IA responde pela base de conhecimento
 *   bot "mais alguma coisa?" → se a pessoa perguntar outra coisa, VOLTA pra IA;
 *                              se ela se despedir, encerra
 *   IA não soube → passa pra uma pessoa
 *
 * Duas decisões que a forma carrega:
 * - o card de abertura é um `ask`, não uma mensagem. Só o `ask` faz o motor
 *   parar e aguardar; uma mensagem seguiria em frente na mesma passada e a IA
 *   gastaria a resposta cumprimentando de volta.
 * - a saída "ok" volta pro MESMO card de IA em vez de duplicá-lo. É o que
 *   mantém o fluxo pequeno e faz a base de conhecimento valer pra toda
 *   pergunta seguinte, não só pra primeira.
 */
export function buildSimpleFlow(texts: SimpleFlowTexts | null | undefined): {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const t = texts || {};
  const id = SIMPLE_IDS;

  // O cumprimento com o nome fica do lado do CÓDIGO: assim o nome do WhatsApp
  // aparece sempre, e a IA não precisa acertar a escrita de um token.
  // {{name_greet}} vira ", João" quando o WhatsApp informa o contato e some
  // quando não informa (ver render() em engine.ts) — funciona nos dois casos
  // sem deixar frase quebrada.
  const opening = `Oi{{name_greet}}! ${clean(t.apresentacao, 400) || FALLBACK.apresentacao}`;

  const nodes: FlowNode[] = [
    n(id.trigger, "trigger", { label: "Mensagem recebida" }),
    n(id.opening, "ask", { prompt: opening, varName: "pedido" }),
    n(id.answer, "llm_answer", {
      label: "Responder com IA",
      context: clean(t.context, 2000),
      varName: "resposta_ia",
      maxChars: 400,
    }),
    n(id.followUp, "ask", {
      prompt: "Consigo te ajudar com mais alguma coisa?",
      varName: "mais_algo",
      // Marca que a resposta a esta pergunta é um NOVO pedido do cliente, e
      // não um dado solto. No motor a marca só é lida junto de um llm_intent,
      // que este fluxo não tem — então aqui ela é inerte. Quem depende dela é
      // a validação: sem isso o cliente sintético nunca se despede, o laço
      // roda até o limite de passos e um fluxo saudável é reprovado por
      // "preso num ciclo".
      capturesIntent: true,
    }),
    // Dá SAÍDA ao laço. Sem ele o bot responderia até um "não, obrigado" e
    // perguntaria de novo, pra sempre. Ver CLOSING_REGEX: "não" e "valeu"
    // encerram, "não sei quanto custa" não.
    n(id.decide, "condition", { field: "last", op: "regex", value: CLOSING_REGEX }),
    n(id.handoff, "handoff", { message: clean(t.handoff, 400) || FALLBACK.handoff }),
    n(id.end, "end", { label: "Fim" }),
  ];

  const edges: FlowEdge[] = [
    e(id.trigger, id.opening),
    e(id.opening, id.answer),
    e(id.answer, id.followUp, "ok"),
    e(id.answer, id.handoff, "erro"),
    e(id.followUp, id.decide),
    e(id.decide, id.end, "true"),
    e(id.decide, id.answer, "false"),
  ];

  return { name: clean(t.name, 80) || FALLBACK.name, nodes, edges };
}

/**
 * Lê a resposta da LLM como TEXTOS, nunca como grafo.
 *
 * Aceita o JSON cru (com ou sem cerca de markdown) e ignora qualquer campo
 * que não seja um dos quatro textos — se o modelo insistir em mandar
 * `nodes`/`edges`, eles simplesmente não são lidos. É essa recusa que impede
 * um formato inventado de chegar no canvas.
 */
export function parseSimpleFlowTexts(raw: string): SimpleFlowTexts {
  const jsonText = String(raw || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Modelo respondeu em prosa: os padrões cobrem, e o fluxo sai válido.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const src = parsed as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    name: str(src.name),
    apresentacao: str(src.apresentacao),
    context: str(src.context),
    handoff: str(src.handoff),
  };
}
