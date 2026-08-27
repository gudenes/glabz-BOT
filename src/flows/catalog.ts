/**
 * Catálogo de templates — os fluxos prontos que o dono pode escolher no
 * onboarding, e a base do modo "template" (ver Flow.mode).
 *
 * Reescrito do zero em 27/08/2026 a pedido do usuário. O catálogo anterior
 * tinha 10 templates escritos à mão que NUNCA foram exercitados por nada —
 * vários carregavam os mesmos defeitos que passamos a semana corrigindo nos
 * fluxos gerados (encerrar sem responder, ramo sem fallback humano, nenhum
 * card de IA). Agora são 5, cada um passando pela mesma validação automática
 * dos fluxos gerados (src/flows/validate.ts).
 *
 * Critério de escolha dos 5: PADRÕES DE ATENDIMENTO diferentes entre si, não
 * cinco variações do mesmo desenho. Um negócio que agenda, um que informa, um
 * que recebe pedido, um que qualifica lead e um que faz triagem cobrem quase
 * todo pequeno negócio — o segmento é só a roupagem.
 *
 * Arquitetura: todos seguem as mesmas regras dos fluxos gerados
 * (from-prompt.ts) — pergunta de nome no tronco, um card "Responder com IA"
 * alimentado pela base de conhecimento, fallback humano no "erro", e nunca
 * encerrar seco (ask de "mais alguma coisa?" voltando ao intent, com ramo de
 * encerramento levando a uma despedida). Foi o que aprendemos a semana toda;
 * não faz sentido o catálogo contradizer isso.
 */
import { randomUUID } from "node:crypto";
import type { Flow, FlowEdge, FlowNode } from "./types.js";
import { layoutFlow } from "./from-prompt.js";

export type TemplateComplexity = "simples" | "complexo";

export type TemplateMeta = {
  /** Identidade estável do template — não usar o nome, que o usuário renomeia. */
  slug: string;
  name: string;
  /** Segmento de negócio de origem. */
  segment: string;
  complexity: TemplateComplexity;
  /** Uma linha, pra tela de escolha no onboarding. */
  summary: string;
  /** true = contém passo que simula integração inexistente. */
  simulated?: boolean;
};

/**
 * Sobe quando o conteúdo de um template muda no código. Fluxos que ainda estão
 * na revisão anterior E não foram editados pelo usuário são atualizados no boot
 * (ver ensureSeedTemplates em store.ts).
 * 2 = catálogo reescrito (27/08/2026).
 */
export const CATALOG_REVISION = 2;

type TemplateDef = TemplateMeta & { nodes: FlowNode[]; edges: FlowEdge[] };

function build(def: TemplateDef): Flow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: def.name,
    product: "gestor",
    accountId: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    seedSlug: def.slug,
    seedRevision: CATALOG_REVISION,
    nodes: layoutFlow(def.nodes, def.edges),
    edges: def.edges,
  };
}

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
 * Tronco e encerramento comuns a todos os templates.
 *
 * Existe pra que os 5 não repitam (e não divirjam) a parte que já sabemos
 * estar certa: gatilho → boas-vindas → nome → entender intenção, e o
 * encerramento não-abrupto ("mais alguma coisa?" volta pro intent; o ramo
 * `encerrar` passa por uma despedida antes do fim).
 */
function commonTrunk(opts: {
  welcome: string;
  intents: { slug: string; description: string }[];
  handoffText: string;
}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: [
      n("t_ini", "trigger", { label: "Mensagem recebida" }),
      n("t_ola", "message", { text: opts.welcome }),
      n("t_nome", "ask", { prompt: "Antes de continuar, qual o seu *nome*?", varName: "nome" }),
      n("t_int", "llm_intent", {
        label: "Entender o pedido",
        intents: [
          ...opts.intents,
          {
            slug: "encerrar",
            // Os termos curtos ("obrigado", "era só isso") não são enfeite:
            // quando a IA está fora do ar o motor cai num casamento por
            // palavra-chave sobre esta descrição, e sem eles um "não,
            // obrigado" não fecha a conversa — o cliente ficaria preso no
            // "posso ajudar com mais alguma coisa?". Só é perigoso à primeira
            // vista: a guarda do engine (isClosingSlug) só aceita encerrar
            // quando a resposta veio desse ask, então "obrigado, mas queria
            // saber o preço" no meio da conversa não encerra nada.
            description:
              "não precisa de mais nada, obrigado, era só isso, quer encerrar ou agradecer",
          },
        ],
      }),
      n("t_mais", "ask", {
        prompt: "Posso te ajudar com mais alguma coisa?",
        varName: "mais_algo",
        // Marca que a resposta deste ask É um novo pedido — sem isso o motor
        // trataria "quero saber o preço" como dado solto (ver engine.ts).
        capturesIntent: true,
      }),
      n("t_tchau", "message", { text: "Foi um prazer ajudar{{name_greet}}! Até mais 👋" }),
      n("t_fim", "end", { label: "Fim" }),
      n("t_hum", "handoff", { message: opts.handoffText }),
    ],
    edges: [
      e("t_ini", "t_ola"),
      e("t_ola", "t_nome"),
      e("t_nome", "t_int"),
      e("t_mais", "t_int"),
      e("t_int", "t_tchau", "encerrar"),
      e("t_tchau", "t_fim"),
    ],
  };
}

/** Card "Responder com IA" padrão: responde pela base e cai no humano se não souber. */
function aiAnswer(id: string, context: string): FlowNode {
  return n(id, "llm_answer", {
    label: "Responder com IA",
    context,
    varName: "resposta_ia",
    maxChars: 400,
  });
}

// ─────────────────────────────────────────────────────────────
// Os 5 templates — um padrão de atendimento cada
// ─────────────────────────────────────────────────────────────

/** AGENDAR — o cliente quer marcar um horário. */
function pilates(): TemplateDef {
  const trunk = commonTrunk({
    welcome: "Olá! 👋 Bem-vindo(a) ao nosso *estúdio de Pilates*!",
    intents: [
      { slug: "aula", description: "quer marcar aula, agendar, aula experimental, horário" },
      { slug: "duvida", description: "quer saber preço, planos, como funciona, o que precisa levar" },
    ],
    handoffText: "Vou chamar alguém da equipe pra falar com você{{name_greet}}. Um instante!",
  });
  return {
    slug: "pilates-agendamento",
    name: "Pilates · agendar aula experimental",
    segment: "Estúdio de pilates",
    complexity: "simples",
    summary: "Marca a aula experimental e responde dúvidas sobre planos e horários.",
    nodes: [
      ...trunk.nodes,
      n("p_quando", "ask", {
        prompt: "Que dia e horário funcionam melhor pra você{{name_greet}}?",
        varName: "preferencia",
      }),
      n("p_ok", "message", {
        text: "Anotei{{name_greet}}: *{{preferencia}}*. Já vou confirmar a disponibilidade e te retorno.",
      }),
      aiAnswer(
        "p_ia",
        "Estúdio de Pilates. A primeira aula é experimental. Responda sobre planos, horários, o que levar (roupa confortável e meia antiderrapante) e como funciona a avaliação inicial."
      ),
    ],
    edges: [
      ...trunk.edges,
      e("t_int", "p_quando", "aula"),
      e("p_quando", "p_ok"),
      e("p_ok", "t_mais"),
      e("t_int", "p_ia", "duvida"),
      e("p_ia", "t_mais", "ok"),
      e("p_ia", "t_hum", "erro"),
    ],
  };
}

/** INFORMAR — o cliente quer saber algo; quase tudo cai na base de conhecimento. */
function academia(): TemplateDef {
  const trunk = commonTrunk({
    welcome: "Olá! 👋 Bem-vindo(a) à nossa *academia*!",
    intents: [
      { slug: "planos", description: "quer saber planos, mensalidade, valores, promoção" },
      { slug: "estrutura", description: "quer saber horário, estrutura, aulas, estacionamento" },
    ],
    handoffText: "Vou chamar alguém da recepção pra te ajudar{{name_greet}}. Só um momento!",
  });
  return {
    slug: "academia-informacoes",
    name: "Academia · planos e informações",
    segment: "Academia",
    complexity: "simples",
    summary: "Responde planos, horários e estrutura usando a base de conhecimento.",
    nodes: [
      ...trunk.nodes,
      aiAnswer(
        "a_planos",
        "Academia. Responda sobre planos, mensalidade, formas de pagamento, fidelidade e promoções vigentes."
      ),
      aiAnswer(
        "a_estrut",
        "Academia. Responda sobre horário de funcionamento, aulas coletivas, equipamentos, vestiário e estacionamento."
      ),
    ],
    edges: [
      ...trunk.edges,
      e("t_int", "a_planos", "planos"),
      e("a_planos", "t_mais", "ok"),
      e("a_planos", "t_hum", "erro"),
      e("t_int", "a_estrut", "estrutura"),
      e("a_estrut", "t_mais", "ok"),
      e("a_estrut", "t_hum", "erro"),
    ],
  };
}

/** PEDIR — o cliente quer encomendar algo; o fluxo coleta o pedido. */
function padaria(): TemplateDef {
  const trunk = commonTrunk({
    welcome: "Olá! 👋 Bem-vindo(a) à nossa *padaria*!",
    intents: [
      { slug: "encomenda", description: "quer fazer encomenda, pedido, bolo, salgado, festa" },
      { slug: "duvida", description: "quer saber horário, cardápio, preço, entrega" },
    ],
    handoffText: "Vou passar seu pedido pra nossa equipe finalizar{{name_greet}}. Um instante!",
  });
  return {
    slug: "padaria-encomenda",
    name: "Padaria · encomendas",
    segment: "Padaria e confeitaria",
    complexity: "simples",
    summary: "Coleta o que o cliente quer encomendar, quando precisa, e passa pra equipe.",
    nodes: [
      ...trunk.nodes,
      n("b_oque", "ask", {
        prompt: "O que você gostaria de encomendar{{name_greet}}?",
        varName: "item",
      }),
      n("b_quando", "ask", {
        prompt: "Pra quando você precisa de *{{item}}*?",
        varName: "entrega",
      }),
      n("b_resumo", "message", {
        text: "Anotado{{name_greet}}: *{{item}}* para *{{entrega}}*. Já confirmo com a equipe e te retorno com o valor.",
      }),
      aiAnswer(
        "b_ia",
        "Padaria e confeitaria. Responda sobre horário de funcionamento, itens do cardápio, prazo mínimo para encomenda e opções de entrega ou retirada."
      ),
    ],
    edges: [
      ...trunk.edges,
      e("t_int", "b_oque", "encomenda"),
      e("b_oque", "b_quando"),
      e("b_quando", "b_resumo"),
      e("b_resumo", "t_hum"),
      e("t_int", "b_ia", "duvida"),
      e("b_ia", "t_mais", "ok"),
      e("b_ia", "t_hum", "erro"),
    ],
  };
}

/** QUALIFICAR — entende o caso antes de passar pro humano (lead qualificado). */
function advocacia(): TemplateDef {
  const trunk = commonTrunk({
    welcome: "Olá! 👋 Você fala com nosso *escritório de advocacia*.",
    intents: [
      { slug: "caso", description: "tem um caso, precisa de advogado, quer consultoria jurídica" },
      { slug: "duvida", description: "quer saber como funciona o atendimento, honorários, área de atuação" },
    ],
    handoffText:
      "Obrigado{{name_greet}}. Um de nossos advogados vai analisar e retornar o contato com você.",
  });
  return {
    slug: "advocacia-triagem",
    name: "Advocacia · primeiro contato",
    segment: "Advocacia",
    complexity: "simples",
    summary: "Entende o caso em linhas gerais antes de passar pro advogado.",
    nodes: [
      ...trunk.nodes,
      n("j_area", "ask", {
        prompt:
          "Pra direcionar ao advogado certo{{name_greet}}: sua questão é mais na área trabalhista, família, cível ou outra?",
        varName: "area",
      }),
      n("j_resumo", "ask", {
        prompt: "Me conta em poucas linhas o que aconteceu — sem detalhes sensíveis por aqui.",
        varName: "relato",
      }),
      n("j_ok", "message", {
        text: "Obrigado{{name_greet}}. Registrei sua questão de *{{area}}* e já encaminho pro advogado responsável.",
      }),
      aiAnswer(
        "j_ia",
        "Escritório de advocacia. Responda sobre áreas de atuação, como funciona a primeira consulta e formas de atendimento. NUNCA dê orientação jurídica sobre um caso concreto — nesses casos diga que um advogado vai avaliar."
      ),
    ],
    edges: [
      ...trunk.edges,
      e("t_int", "j_area", "caso"),
      e("j_area", "j_resumo"),
      e("j_resumo", "j_ok"),
      e("j_ok", "t_hum"),
      e("t_int", "j_ia", "duvida"),
      e("j_ia", "t_mais", "ok"),
      e("j_ia", "t_hum", "erro"),
    ],
  };
}

/** TRIAR — separa urgente de rotina e trata cada um diferente. */
function odonto(): TemplateDef {
  const trunk = commonTrunk({
    welcome: "Olá! 👋 Você fala com nosso *consultório odontológico*.",
    intents: [
      { slug: "urgencia", description: "está com dor, quebrou dente, inchaço, sangramento, urgência" },
      { slug: "consulta", description: "quer marcar consulta, avaliação, limpeza, retorno" },
      { slug: "duvida", description: "quer saber convênio, valores, horário, tratamentos" },
    ],
    handoffText: "Vou chamar nossa recepção agora mesmo{{name_greet}}!",
  });
  return {
    slug: "odonto-triagem",
    name: "Odontologia · urgência e consultas",
    segment: "Consultório odontológico",
    complexity: "simples",
    summary: "Separa urgência de consulta de rotina e responde dúvidas sobre convênio.",
    nodes: [
      ...trunk.nodes,
      n("o_urg", "message", {
        text: "Entendi{{name_greet}}, vamos priorizar seu atendimento. Estou chamando a recepção agora.",
      }),
      n("o_quando", "ask", {
        prompt: "Que dia e turno ficam melhor pra você{{name_greet}}?",
        varName: "preferencia",
      }),
      n("o_ok", "message", {
        text: "Anotei: *{{preferencia}}*. Vou confirmar na agenda e já te retorno.",
      }),
      aiAnswer(
        "o_ia",
        "Consultório odontológico. Responda sobre convênios aceitos, formas de pagamento, horário de atendimento e tipos de tratamento. NUNCA dê diagnóstico ou orientação clínica — nesses casos diga que o dentista precisa avaliar."
      ),
    ],
    edges: [
      ...trunk.edges,
      e("t_int", "o_urg", "urgencia"),
      e("o_urg", "t_hum"),
      e("t_int", "o_quando", "consulta"),
      e("o_quando", "o_ok"),
      e("o_ok", "t_mais"),
      e("t_int", "o_ia", "duvida"),
      e("o_ia", "t_mais", "ok"),
      e("o_ia", "t_hum", "erro"),
    ],
  };
}

const DEFS: TemplateDef[] = [pilates(), academia(), padaria(), advocacia(), odonto()];

/** Metadados dos templates — pra telas de escolha, sem carregar nodes/edges. */
export function templateCatalog(): TemplateMeta[] {
  return DEFS.map(({ slug, name, segment, complexity, summary, simulated }) => ({
    slug,
    name,
    segment,
    complexity,
    summary,
    ...(simulated ? { simulated } : {}),
  }));
}

/** Fluxos completos do catálogo (instâncias novas a cada chamada). */
export function catalogFlows(): Flow[] {
  return DEFS.map(build);
}

/** Slugs do catálogo — usado pelos testes e pela poda de seeds antigos. */
export function catalogSlugs(): string[] {
  return DEFS.map((d) => d.slug);
}

/** Fluxo vazio — só o gatilho, pra quem prefere montar do zero. */
export function blankFlow(): Flow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: "Atendimento",
    product: "gestor",
    accountId: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    nodes: [n("n_trigger", "trigger", { label: "Mensagem recebida" })].map((node) => ({
      ...node,
      x: 80,
      y: 60,
    })),
    edges: [],
  };
}

/**
 * Seleção única de template. Aceita o slug do catálogo ou "blank".
 *
 * Os apelidos antigos ("pilates", "consulta") foram removidos junto com os
 * templates que apontavam — eles usavam asserção não-nula, então deixá-los
 * apontando pra template inexistente derrubaria a criação de cliente com
 * TypeError. Nada mais os chama: provisionClient não semeia mais fluxo
 * (PR #79) e o <select> do admin foi atualizado.
 */
export function pickCatalogFlow(kind?: string | null): Flow | null {
  const k = (kind || "").trim().toLowerCase();
  if (!k || k === "blank") return null;
  const bySlug = DEFS.find((d) => d.slug === k);
  return bySlug ? build(bySlug) : null;
}
