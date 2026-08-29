/**
 * Catálogo de templates — os fluxos prontos que o dono pode escolher no
 * onboarding, e a base do modo "template" (ver Flow.mode).
 *
 * Reconstruído em 29/08/2026 sobre o mesmo esqueleto do fluxo gerado
 * (buildSimpleFlow, simple-flow.ts). Antes eram 5 fluxos escritos à mão com
 * 10 a 12 cards e llm_intent — estruturalmente o formato COMPLETO, mas todos
 * rotulados "simples". Quem escolhia "simples" na tela recebia um fluxo de 12
 * cards. Medido, não estimado.
 *
 * A escolha do usuário (29/08) foi retirar os complexos e deixar só simples.
 * Como os cinco passam a ter a MESMA forma do que a IA gera, o dono pode
 * comparar template e fluxo gerado lado a lado — e qualquer correção no
 * esqueleto chega aos dois de uma vez, sem chance de divergirem.
 *
 * O que varia entre eles é só o texto: como o negócio se apresenta, o que a
 * IA sabe responder, e o que o bot diz ao chamar uma pessoa.
 */
import { randomUUID } from "node:crypto";
import type { Flow, FlowEdge, FlowNode } from "./types.js";
import { buildSimpleFlow, type SimpleFlowTexts } from "./simple-flow.js";
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
 * 3 = reconstruído sobre o esqueleto simples (29/08/2026).
 */
export const CATALOG_REVISION = 3;


function build(def: BuiltTemplate): Flow {
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

/** Só o blankFlow monta nó à mão agora; o resto vem do esqueleto. */
const n = (id: string, type: FlowNode["type"], data: Record<string, unknown>): FlowNode => ({
  id,
  type,
  x: 0,
  y: 0,
  data,
});

/** Um template é só isto: metadados + os textos que o esqueleto consome. */
type TemplateDef = TemplateMeta & SimpleFlowTexts;

/**
 * Os 5 — um segmento cada, mesma forma.
 *
 * `apresentacao` NÃO cumprimenta: o esqueleto põe "Oi{{name_greet}}!" antes,
 * e cumprimentar de novo sairia "Oi, Carlos! Olá! Aqui é da C3". Mesma regra
 * que o prompt da geração segue.
 */
const DEFS_TEXTS: TemplateDef[] = [
  {
    slug: "pilates-agendamento",
    name: "Pilates · atendimento",
    segment: "Estúdio de pilates",
    complexity: "simples",
    summary: "Responde sobre aula experimental, planos e horários pela base de conhecimento.",
    apresentacao: "Aqui é do nosso *estúdio de Pilates*. Como posso te ajudar?",
    context:
      "Estúdio de Pilates. Responda sobre a aula experimental, planos e mensalidades, horários " +
      "das turmas, o que levar (roupa confortável e meia antiderrapante) e como funciona a " +
      "avaliação inicial.",
    handoff: "Vou chamar alguém da equipe pra falar com você. Um instante!",
  },
  {
    slug: "academia-informacoes",
    name: "Academia · atendimento",
    segment: "Academia",
    complexity: "simples",
    summary: "Responde planos, horários e estrutura pela base de conhecimento.",
    apresentacao: "Aqui é da nossa *academia*. Como posso te ajudar?",
    context:
      "Academia. Responda sobre planos, mensalidade, formas de pagamento, fidelidade, promoções " +
      "vigentes, horário de funcionamento, aulas coletivas, equipamentos, vestiário e " +
      "estacionamento.",
    handoff: "Vou chamar alguém da recepção pra te ajudar. Só um momento!",
  },
  {
    slug: "padaria-encomenda",
    name: "Padaria · atendimento",
    segment: "Padaria e confeitaria",
    complexity: "simples",
    summary: "Responde cardápio, prazos e encomendas, e chama a equipe pra fechar o pedido.",
    apresentacao: "Aqui é da nossa *padaria*. Como posso te ajudar?",
    context:
      "Padaria e confeitaria. Responda sobre horário de funcionamento, itens do cardápio, " +
      "valores, prazo mínimo para encomenda, tamanhos e sabores disponíveis, e opções de " +
      "entrega ou retirada.",
    handoff: "Vou passar pra nossa equipe finalizar seu pedido. Um instante!",
  },
  {
    slug: "advocacia-triagem",
    name: "Advocacia · primeiro contato",
    segment: "Advocacia",
    complexity: "simples",
    summary: "Responde áreas de atuação e como funciona a primeira consulta.",
    apresentacao: "Aqui é do nosso escritório. Em que posso te ajudar?",
    context:
      "Escritório de advocacia. Responda sobre áreas de atuação, como funciona a primeira " +
      "consulta, documentos que costumam ser necessários e formas de atendimento (presencial " +
      "ou online). Nunca dê orientação jurídica sobre um caso específico — para isso, encaminhe " +
      "para um advogado.",
    handoff: "Um de nossos advogados vai analisar e retornar o contato com você.",
  },
  {
    slug: "odonto-triagem",
    name: "Odontologia · atendimento",
    segment: "Consultório odontológico",
    complexity: "simples",
    summary: "Responde convênios, procedimentos e horários, e chama a recepção quando precisa.",
    apresentacao: "Aqui é do nosso consultório odontológico. Como posso te ajudar?",
    context:
      "Consultório odontológico. Responda sobre convênios atendidos, procedimentos oferecidos, " +
      "horário de funcionamento e como agendar. Em caso de dor ou urgência, oriente a procurar " +
      "atendimento e chame a recepção. Nunca dê diagnóstico nem indique medicação.",
    handoff: "Vou chamar nossa recepção agora mesmo!",
  },
];

/** Metadados + o fluxo montado pelo esqueleto compartilhado. */
type BuiltTemplate = TemplateMeta & { nodes: FlowNode[]; edges: FlowEdge[] };

const DEFS: BuiltTemplate[] = DEFS_TEXTS.map((def) => {
  const built = buildSimpleFlow(def);
  return { ...def, nodes: built.nodes, edges: built.edges };
});


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
