/**
 * Catálogo de templates de demo — base do onboarding self-service.
 *
 * Cada template nasce de um caso de uso real levantado em
 * docs/estudo-casos-de-uso-e-integracoes.md. São 10: 5 "simples" (sem
 * integração externa, funcionam de ponta a ponta hoje) e 5 "complexos".
 *
 * IMPORTANTE — templates com `simulated: true`: dependem de integração que
 * ainda NÃO existe (e-mail, planilha, pagamento, IA livre). Em vez de fingir
 * que funcionam, esses fluxos trazem um passo de mensagem que avisa o próprio
 * usuário que aquele trecho é simulação. Foi exatamente a falta desse aviso
 * (forceMock silencioso no demo de pilates) que deu a impressão de que o
 * Google Calendar "não estava integrado" quando estava.
 * Quando a integração existir, o passo simulado vira um nó `action` de verdade.
 */
import { randomUUID } from "node:crypto";
import type { Flow, FlowEdge, FlowNode } from "./types.js";
import { layoutFlow } from "./from-prompt.js";

export type TemplateComplexity = "simples" | "complexo";

export type TemplateMeta = {
  /** Identidade estável do template — não usar o nome, que o usuário renomeia. */
  slug: string;
  name: string;
  /** Segmento de negócio de origem (ver estudo). */
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
 */
export const CATALOG_REVISION = 1;

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

/** Aviso padrão de trecho simulado — some quando a integração real existir. */
function simulatedStep(id: string, what: string, detail: string): FlowNode {
  return {
    id,
    type: "message",
    x: 0,
    y: 0,
    data: {
      text: `_[Simulação — ${what} ainda não está integrado neste ambiente]_\n${detail}`,
    },
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

// ─────────────────────────────────────────────────────────────
// SIMPLES — funcionam de ponta a ponta hoje, sem integração
// ─────────────────────────────────────────────────────────────

/** S1 · qualquer segmento */
function s1Horarios(): TemplateDef {
  return {
    slug: "s1-horario-endereco",
    name: "Recado · Horário e endereço",
    segment: "Qualquer segmento",
    complexity: "simples",
    summary: "Responde horário de funcionamento, endereço e como chegar.",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("ask", "ask", { prompt: "Olá{{name_greet}}! 👋 Como posso ajudar?", varName: "resposta" }),
      n("intent", "llm_intent", {
        label: "O que a pessoa quer saber",
        prompt: "Classifique a dúvida. Responda só o slug.",
        intents: [
          { slug: "horario", description: "Horário de funcionamento, se está aberto agora" },
          { slug: "endereco", description: "Endereço, localização, como chegar, estacionamento" },
          { slug: "outro", description: "Qualquer outro assunto" },
        ],
      }),
      n("m_horario", "message", {
        text: "Nosso horário:\n*Seg a Sex:* 9h às 18h\n*Sábado:* 9h às 13h\n*Domingo:* fechado",
      }),
      n("m_endereco", "message", {
        text: "Estamos na *Rua Exemplo, 123* — Centro.\nTem estacionamento na porta 🚗",
      }),
      n("m_outro", "message", { text: "Vou te passar para alguém da equipe 🙂" }),
      n("h", "handoff", { reason: "duvida_geral", message: "Só um instante!" }),
      n("end", "end", { label: "Fim" }),
    ],
    edges: [
      e("t", "ask"),
      e("ask", "intent"),
      e("intent", "m_horario", "horario"),
      e("intent", "m_endereco", "endereco"),
      e("intent", "m_outro", "outro"),
      e("intent", "m_outro", "default"),
      e("m_horario", "end"),
      e("m_endereco", "end"),
      e("m_outro", "h"),
    ],
  };
}

/** S2 · advocacia, imobiliária, serviços */
function s2Lead(): TemplateDef {
  return {
    slug: "s2-captura-lead",
    name: "Captura de contato",
    segment: "Advocacia · Imobiliária · Serviços",
    complexity: "simples",
    summary: "Coleta nome, contato e necessidade, e entrega pra equipe com resumo.",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("m_ola", "message", {
        text: "Olá{{name_greet}}! 👋 Pra te atender melhor, preciso de duas informações rápidas.",
      }),
      n("ask_nome", "ask", { prompt: "Qual o seu *nome completo*?", varName: "nome" }),
      n("ask_need", "ask", {
        prompt: "Obrigado, {{nome}}! Me conta *o que você precisa* — pode escrever à vontade.",
        varName: "necessidade",
      }),
      n("ask_contato", "ask", {
        prompt: "Perfeito. Qual o *melhor contato* (telefone ou e-mail) pra retorno?",
        varName: "contato",
      }),
      n("m_ok", "message", {
        text: "Anotado ✅\n\n*Nome:* {{nome}}\n*Contato:* {{contato}}\n*Precisa de:* {{necessidade}}\n\nJá estou passando pra equipe!",
      }),
      n("h", "handoff", {
        reason: "lead_qualificado",
        message: "Alguém da equipe assume a conversa a partir de agora 🙂",
      }),
    ],
    edges: [
      e("t", "m_ola"),
      e("m_ola", "ask_nome"),
      e("ask_nome", "ask_need"),
      e("ask_need", "ask_contato"),
      e("ask_contato", "m_ok"),
      e("m_ok", "h"),
    ],
  };
}

/** S3 · salão, pet shop, clínica */
function s3MenuPreco(): TemplateDef {
  return {
    slug: "s3-menu-servicos",
    name: "Menu de serviços e preços",
    segment: "Salão · Pet shop · Clínica",
    complexity: "simples",
    summary: "Apresenta serviços, responde faixa de preço e encaminha o resto.",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("ask", "ask", {
        prompt:
          "Olá{{name_greet}}! 👋 Posso te ajudar com:\n\n• *Serviços* que oferecemos\n• *Preços*\n• *Agendar* um horário\n\nO que você prefere?",
        varName: "resposta",
      }),
      n("intent", "llm_intent", {
        label: "O que a pessoa quer",
        prompt: "Classifique. Responda só o slug.",
        intents: [
          { slug: "servicos", description: "Quer saber quais serviços existem" },
          { slug: "preco", description: "Quer saber preço, valor, quanto custa" },
          { slug: "agendar", description: "Quer marcar, agendar, reservar horário" },
          { slug: "outro", description: "Outro assunto" },
        ],
      }),
      n("m_servicos", "message", {
        text: "Trabalhamos com:\n• Serviço A\n• Serviço B\n• Serviço C\n\n_(edite este passo com os seus serviços)_",
      }),
      n("m_preco", "message", {
        text: "Nossos valores:\n• Serviço A — a partir de R$ 00\n• Serviço B — a partir de R$ 00\n\n_(edite com os seus preços)_\n\nO valor final depende do caso — posso te passar pra equipe confirmar.",
      }),
      n("h_agendar", "handoff", {
        reason: "quer_agendar",
        message: "Perfeito! Vou te passar pra equipe marcar seu horário 🗓",
      }),
      n("h_outro", "handoff", { reason: "outro_assunto", message: "Um instante que já te atendo!" }),
      n("end", "end", { label: "Fim" }),
    ],
    edges: [
      e("t", "ask"),
      e("ask", "intent"),
      e("intent", "m_servicos", "servicos"),
      e("intent", "m_preco", "preco"),
      e("intent", "h_agendar", "agendar"),
      e("intent", "h_outro", "outro"),
      e("intent", "h_outro", "default"),
      e("m_servicos", "end"),
      e("m_preco", "end"),
    ],
  };
}

/** S4 · qualquer segmento que agenda */
function s4PreAgendamento(): TemplateDef {
  return {
    slug: "s4-pre-agendamento",
    name: "Pré-agendamento (sem integração)",
    segment: "Qualquer segmento que agenda",
    complexity: "simples",
    summary: "Entende o dia que a pessoa prefere e passa pra equipe confirmar.",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("m_ola", "message", { text: "Olá{{name_greet}}! Vou te ajudar a marcar um horário 🗓" }),
      n("ask_nome", "ask", { prompt: "Qual o *seu nome*?", varName: "nome" }),
      n("ask_dia", "ask", {
        prompt: "Prazer, {{nome}}! Que *dia* seria melhor pra você?",
        varName: "resposta",
      }),
      n("extrai", "llm_extract", {
        label: "Extrair data",
        prompt: "Data que o cliente prefere para o atendimento.",
        varName: "data_confirmada",
      }),
      n("m_ok", "message", {
        text: "Anotei sua preferência para *{{data_confirmada}}* ✅\nVou confirmar a disponibilidade com a equipe.",
      }),
      n("ask_denovo", "ask", {
        prompt: "Não consegui entender a data 😅 Pode dizer de outro jeito? (ex.: *segunda de manhã*, *dia 15*)",
        varName: "resposta",
      }),
      n("h", "handoff", {
        reason: "pre_agendamento",
        message: "A equipe confirma o horário com você em instantes!",
      }),
    ],
    edges: [
      e("t", "m_ola"),
      e("m_ola", "ask_nome"),
      e("ask_nome", "ask_dia"),
      e("ask_dia", "extrai"),
      e("extrai", "m_ok", "ok"),
      e("extrai", "ask_denovo", "ambiguous"),
      e("extrai", "ask_denovo", "unclear"),
      e("ask_denovo", "extrai"),
      e("m_ok", "h"),
    ],
  };
}

/** S5 · pet shop, clínica, odonto */
function s5Triagem(): TemplateDef {
  return {
    slug: "s5-triagem-urgencia",
    name: "Triagem de urgência",
    segment: "Pet shop · Clínica · Odontologia",
    complexity: "simples",
    summary: "Separa urgência de rotina — urgência vai direto pra um humano.",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("ask", "ask", {
        prompt: "Olá{{name_greet}}! Me conta rapidamente *o que está acontecendo* pra eu te direcionar 🙂",
        varName: "relato",
      }),
      n("intent", "llm_intent", {
        label: "Urgência?",
        prompt:
          "Classifique o relato do cliente quanto à urgência do atendimento. Responda só o slug.",
        intents: [
          {
            slug: "urgente",
            description: "Emergência, dor forte, sangramento, acidente, piora súbita, algo que não pode esperar",
          },
          { slug: "rotina", description: "Consulta de rotina, retorno, check-up, agendamento comum" },
          { slug: "duvida", description: "Só uma dúvida, informação, preço, horário" },
        ],
      }),
      n("m_urgente", "message", {
        text: "Entendi que é *urgente* ⚠️\nEstou chamando alguém da equipe agora mesmo — aguarde só um instante.",
      }),
      n("h_urgente", "handoff", {
        reason: "urgencia",
        message: "🚨 Atendimento urgente — cliente relatou: {{relato}}",
      }),
      n("ask_rotina", "ask", {
        prompt: "Certo! Que *dia e período* costumam ser melhores pra você?",
        varName: "preferencia",
      }),
      n("h_rotina", "handoff", {
        reason: "rotina",
        message: "A equipe confirma seu horário em breve 🗓",
      }),
      n("m_duvida", "message", {
        text: "Posso te ajudar com informações! Vou passar sua dúvida pra equipe responder certinho.",
      }),
      n("h_duvida", "handoff", { reason: "duvida", message: "Um instante 🙂" }),
    ],
    edges: [
      e("t", "ask"),
      e("ask", "intent"),
      e("intent", "m_urgente", "urgente"),
      e("intent", "ask_rotina", "rotina"),
      e("intent", "m_duvida", "duvida"),
      e("intent", "m_duvida", "default"),
      e("m_urgente", "h_urgente"),
      e("ask_rotina", "h_rotina"),
      e("m_duvida", "h_duvida"),
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// COMPLEXOS
// ─────────────────────────────────────────────────────────────

/** C1 · integração REAL com Google Calendar (nada simulado aqui) */
function c1AgendamentoCalendar(): TemplateDef {
  return {
    slug: "c1-agendamento-calendar",
    name: "Agendamento completo (Google Calendar)",
    segment: "Pilates · Clínica · Pet shop",
    complexity: "complexo",
    summary:
      "Entende o dia, consulta horários livres reais na agenda do Google e cria o evento.",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("m_ola", "message", { text: "Olá{{name_greet}}! 👋 Vamos marcar seu horário." }),
      n("ask_nome", "ask", { prompt: "Qual o *seu nome*?", varName: "nome" }),
      n("ask_dia", "ask", {
        prompt: "Prazer, {{nome}}! Que *dia* você prefere?",
        varName: "resposta",
      }),
      n("extrai", "llm_extract", {
        label: "Extrair data",
        prompt: "Data que o cliente prefere para marcar o horário.",
        varName: "data_confirmada",
      }),
      n("ask_denovo", "ask", {
        prompt: "Não entendi bem a data 😅 Pode repetir? (ex.: *quinta de manhã*, *dia 20*)",
        varName: "resposta",
      }),
      n("busca", "action", {
        label: "Buscar horários livres",
        connector: "calendar",
        operation: "list_slots",
        config: { forceMock: false, provider: "google", targetDateVar: "data_confirmada", durationMin: 60 },
      }),
      // A busca pode voltar "ok" com zero horários — sem esta condição, o
      // cliente receberia uma lista vazia e ficaria sem saída.
      n("tem_slot", "condition", { field: "slots_count", op: "equals", value: "0" }),
      n("m_slots", "message", {
        text: "Encontrei estes horários:\n{{slots_text}}\n\nQual deles fica melhor?",
      }),
      n("ask_escolha", "ask", { prompt: "Responda com o *número* do horário 🙂", varName: "horario" }),
      n("cria", "action", {
        label: "Criar evento",
        connector: "calendar",
        operation: "create_event",
        config: { forceMock: false, provider: "google", durationMin: 60, title: "Atendimento — {{nome}}" },
      }),
      n("m_ok", "message", {
        text: "Prontinho, {{nome}}! ✅\n*{{event_label}}* está confirmado.\nAté lá! 😊",
      }),
      n("m_sem_horario", "message", {
        text: "Não encontrei horários livres nesse dia 😕\nQuer tentar outro dia?",
      }),
      n("h_erro", "handoff", {
        reason: "falha_agenda",
        message: "Tive um problema para acessar a agenda — vou te passar para a equipe.",
      }),
      n("end", "end", { label: "Fim" }),
    ],
    edges: [
      e("t", "m_ola"),
      e("m_ola", "ask_nome"),
      e("ask_nome", "ask_dia"),
      e("ask_dia", "extrai"),
      e("extrai", "busca", "ok"),
      e("extrai", "ask_denovo", "ambiguous"),
      e("extrai", "ask_denovo", "unclear"),
      e("ask_denovo", "extrai"),
      e("busca", "tem_slot", "ok"),
      e("busca", "h_erro", "erro"),
      e("tem_slot", "m_sem_horario", "true"),
      e("tem_slot", "m_slots", "false"),
      e("m_slots", "ask_escolha"),
      e("ask_escolha", "cria"),
      e("cria", "m_ok", "ok"),
      e("cria", "h_erro", "erro"),
      e("m_ok", "end"),
      e("m_sem_horario", "ask_dia"),
    ],
  };
}

/** C2 · depende de: e-mail */
function c2AgendamentoEmail(): TemplateDef {
  const base = c1AgendamentoCalendar();
  const nodes = base.nodes.filter((x) => x.id !== "m_ok");
  const edges = base.edges.filter((x) => x.to !== "m_ok" && x.from !== "m_ok");
  return {
    slug: "c2-agendamento-email",
    name: "Agendamento + confirmação por e-mail",
    segment: "Clínica · Odontologia",
    complexity: "complexo",
    simulated: true,
    summary:
      "Agenda na agenda real e envia a confirmação por e-mail para o cliente. (E-mail simulado)",
    nodes: [
      ...nodes,
      n("ask_email", "ask", {
        prompt: "Perfeito! Qual o seu *e-mail* para eu enviar a confirmação?",
        varName: "email",
      }),
      simulatedStep(
        "sim_email",
        "envio de e-mail",
        "Aqui o fluxo enviaria a confirmação para *{{email}}*.",
      ),
      n("m_ok2", "message", {
        text: "Prontinho, {{nome}}! ✅\n*{{event_label}}* está confirmado.\nEnviei os detalhes para *{{email}}* 📧",
      }),
    ],
    edges: [
      ...edges,
      e("cria", "ask_email", "ok"),
      e("ask_email", "sim_email"),
      e("sim_email", "m_ok2"),
      e("m_ok2", "end"),
    ],
  };
}

/** C3 · depende de: Google Sheets (catálogo/estoque) */
function c3Catalogo(): TemplateDef {
  return {
    slug: "c3-catalogo-pedido",
    name: "Consulta de catálogo e pedido",
    segment: "Farmácia · Restaurante",
    complexity: "complexo",
    simulated: true,
    summary:
      "Consulta preço/estoque numa planilha e monta o pedido. (Consulta à planilha simulada)",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("ask", "ask", {
        prompt: "Olá{{name_greet}}! 👋 Me diga *o que você procura* que eu verifico pra você.",
        varName: "produto",
      }),
      simulatedStep(
        "sim_busca",
        "consulta à planilha",
        "Aqui o fluxo consultaria *{{produto}}* na sua planilha de preços/estoque.",
      ),
      n("m_resultado", "message", {
        text: "Encontrei:\n\n• *{{produto}}* — R$ 00,00 — _em estoque_\n\n_(dados de exemplo — virão da planilha quando integrada)_",
      }),
      n("ask_quer", "ask", { prompt: "Quer fechar o pedido? (*sim* ou *não*)", varName: "resposta" }),
      n("cond", "condition", { field: "resposta", op: "contains", value: "sim" }),
      n("ask_entrega", "ask", {
        prompt: "Ótimo! Qual o *endereço de entrega* (ou retira no balcão)?",
        varName: "entrega",
      }),
      n("m_resumo", "message", {
        text: "Pedido anotado ✅\n*Item:* {{produto}}\n*Entrega:* {{entrega}}\n\nVou confirmar com a equipe!",
      }),
      n("h", "handoff", { reason: "pedido", message: "Já estou passando seu pedido 🛒" }),
      n("m_nao", "message", { text: "Sem problema! Se precisar de outra coisa, é só chamar 🙂" }),
      n("end", "end", { label: "Fim" }),
    ],
    edges: [
      e("t", "ask"),
      e("ask", "sim_busca"),
      e("sim_busca", "m_resultado"),
      e("m_resultado", "ask_quer"),
      e("ask_quer", "cond"),
      e("cond", "ask_entrega", "true"),
      e("cond", "m_nao", "false"),
      e("ask_entrega", "m_resumo"),
      e("m_resumo", "h"),
      e("m_nao", "end"),
    ],
  };
}

/** C4 · depende de: IA livre + transcrição de áudio */
function c4TriagemInteligente(): TemplateDef {
  return {
    slug: "c4-triagem-inteligente",
    name: "Triagem inteligente + agendamento",
    segment: "Advocacia · Clínica",
    complexity: "complexo",
    simulated: true,
    summary:
      "Entende o caso relatado, qualifica e agenda ou encerra com educação. (Análise por IA livre simulada)",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("m_ola", "message", {
        text: "Olá{{name_greet}}! 👋 Me conte *o que aconteceu* com suas palavras — pode escrever à vontade.",
      }),
      n("ask_caso", "ask", { prompt: "Estou te ouvindo 🙂", varName: "caso" }),
      n("intent", "llm_intent", {
        label: "Área do caso",
        // As descrições precisam citar as áreas CONCRETAS do negócio — sem isso
        // a IA não tem como saber o que "nossa área" significa e joga quase tudo
        // em "indefinido". Editar esta lista é o primeiro passo ao usar o modelo.
        prompt:
          "Classifique o caso relatado pelo cliente conforme as áreas abaixo. Responda só o slug.",
        intents: [
          {
            slug: "atendemos",
            description:
              "Caso de direito trabalhista, previdenciário ou do consumidor — ex.: demissão, verbas não pagas, aposentadoria, cobrança indevida. (EDITE com as áreas do seu negócio)",
          },
          {
            slug: "nao_atendemos",
            description:
              "Caso claramente de outra área — ex.: criminal, tributário empresarial. (EDITE conforme o seu negócio)",
          },
          {
            slug: "indefinido",
            description: "O relato é curto ou vago demais para saber do que se trata",
          },
        ],
      }),
      simulatedStep(
        "sim_ia",
        "análise por IA",
        "Aqui a IA leria o relato completo e produziria um *resumo do caso* para a equipe.",
      ),
      n("ask_nome", "ask", { prompt: "Entendi. Qual o *seu nome completo*?", varName: "nome" }),
      n("ask_dia", "ask", {
        prompt: "Obrigado, {{nome}}. Que *dia* fica melhor para uma conversa?",
        varName: "resposta",
      }),
      n("extrai", "llm_extract", {
        label: "Extrair data",
        prompt: "Dia preferido para a consulta.",
        varName: "data_confirmada",
      }),
      n("m_ok", "message", {
        text: "Anotado ✅\n*{{nome}}* — preferência: *{{data_confirmada}}*\nA equipe confirma o horário com você.",
      }),
      n("h_ok", "handoff", { reason: "caso_qualificado", message: "Resumo do caso: {{caso}}" }),
      n("ask_denovo", "ask", {
        prompt: "Não entendi bem a data 😅 Pode dizer de outro jeito?",
        varName: "resposta",
      }),
      n("m_nao", "message", {
        text: "Obrigado por escrever! Esse assunto está fora da nossa área de atuação, então não conseguiria te ajudar bem 😕\nMas desejo que resolva logo!",
      }),
      n("ask_mais", "ask", {
        prompt: "Pode me dar *um pouco mais de detalhe* sobre o que aconteceu?",
        varName: "caso",
      }),
      // Uma tentativa de esclarecer e, se ainda assim não der pra classificar,
      // humano assume. Voltar pro llm_intent aqui prenderia o cliente num loop
      // (o engine não tem contador de tentativas).
      n("h_indefinido", "handoff", {
        reason: "triagem_inconclusiva",
        message: "Vou te passar pra equipe entender melhor seu caso 🙂",
      }),
      n("end", "end", { label: "Fim" }),
    ],
    edges: [
      e("t", "m_ola"),
      e("m_ola", "ask_caso"),
      e("ask_caso", "intent"),
      e("intent", "sim_ia", "atendemos"),
      e("intent", "m_nao", "nao_atendemos"),
      e("intent", "ask_mais", "indefinido"),
      e("intent", "ask_mais", "default"),
      e("ask_mais", "h_indefinido"),
      e("sim_ia", "ask_nome"),
      e("ask_nome", "ask_dia"),
      e("ask_dia", "extrai"),
      e("extrai", "m_ok", "ok"),
      e("extrai", "ask_denovo", "ambiguous"),
      e("extrai", "ask_denovo", "unclear"),
      e("ask_denovo", "extrai"),
      e("m_ok", "h_ok"),
      e("m_nao", "end"),
    ],
  };
}

/** C5 · depende de: pagamento (+ catálogo) */
function c5Pagamento(): TemplateDef {
  return {
    slug: "c5-pedido-pagamento",
    name: "Pedido com pagamento",
    segment: "Farmácia · Restaurante · Serviços",
    complexity: "complexo",
    simulated: true,
    summary:
      "Fecha o pedido e envia link de pagamento/Pix para o cliente. (Cobrança simulada)",
    nodes: [
      n("t", "trigger", { label: "Mensagem recebida" }),
      n("ask_item", "ask", {
        prompt: "Olá{{name_greet}}! 👋 O que você gostaria de pedir?",
        varName: "item",
      }),
      n("ask_qtd", "ask", { prompt: "Quantas unidades de *{{item}}*?", varName: "quantidade" }),
      n("m_total", "message", {
        text: "Seu pedido:\n*{{quantidade}}x {{item}}*\n\nTotal: *R$ 00,00*\n_(valor de exemplo — virá do catálogo quando integrado)_",
      }),
      n("ask_pagar", "ask", {
        prompt: "Confirma o pedido? (*sim* para gerar o pagamento)",
        varName: "resposta",
      }),
      n("cond", "condition", { field: "resposta", op: "contains", value: "sim" }),
      simulatedStep(
        "sim_pag",
        "geração de cobrança",
        "Aqui o fluxo geraria um *link de pagamento / Pix* com o valor do pedido.",
      ),
      n("m_link", "message", {
        text: "Aqui está seu pagamento 💳\n\n`https://exemplo.com/pagamento/000`\n\nAssim que o pagamento cair, já preparamos seu pedido!",
      }),
      n("h", "handoff", {
        reason: "pedido_aguardando_pagamento",
        message: "Pedido: {{quantidade}}x {{item}} — aguardando pagamento",
      }),
      n("m_nao", "message", { text: "Tudo bem! Se mudar de ideia é só chamar 🙂" }),
      n("end", "end", { label: "Fim" }),
    ],
    edges: [
      e("t", "ask_item"),
      e("ask_item", "ask_qtd"),
      e("ask_qtd", "m_total"),
      e("m_total", "ask_pagar"),
      e("ask_pagar", "cond"),
      e("cond", "sim_pag", "true"),
      e("cond", "m_nao", "false"),
      e("sim_pag", "m_link"),
      e("m_link", "h"),
      e("m_nao", "end"),
    ],
  };
}

const DEFS: TemplateDef[] = [
  s1Horarios(),
  s2Lead(),
  s3MenuPreco(),
  s4PreAgendamento(),
  s5Triagem(),
  c1AgendamentoCalendar(),
  c2AgendamentoEmail(),
  c3Catalogo(),
  c4TriagemInteligente(),
  c5Pagamento(),
];

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
 * Seleção única de template — antes estava duplicada em clients.ts e no
 * endpoint /v1/flows/from-template, com defaults diferentes entre si.
 * Aceita o slug do catálogo, "blank", ou os apelidos antigos.
 */
export function pickCatalogFlow(kind?: string | null): Flow | null {
  const k = (kind || "").trim().toLowerCase();
  if (!k || k === "blank") return null;

  const bySlug = DEFS.find((d) => d.slug === k);
  if (bySlug) return build(bySlug);

  // Apelidos antigos, pra não quebrar quem já chamava assim.
  if (k === "consulta") return build(DEFS.find((d) => d.slug === "s4-pre-agendamento")!);
  if (k === "pilates") return build(DEFS.find((d) => d.slug === "c1-agendamento-calendar")!);

  return null;
}
