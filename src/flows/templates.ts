import { randomUUID } from "node:crypto";
import type { Flow } from "./types.js";

/** Fluxo demo: capturar intenção + marcar consulta ou handoff. */
export function demoConsultationFlow(): Flow {
  const now = new Date().toISOString();
  const ids = {
    trigger: "n_trigger",
    welcome: "n_welcome",
    intent: "n_intent",
    askName: "n_ask_name",
    askWhen: "n_ask_when",
    confirm: "n_confirm",
    handoffBook: "n_handoff_book",
    handoff: "n_handoff",
    faq: "n_faq",
    end: "n_end",
  };

  return {
    id: randomUUID(),
    name: "Demo · Marcar consulta",
    product: "gestor",
    accountId: null,
    status: "live",
    createdAt: now,
    updatedAt: now,
    // 3 colunas: agendar | tronco+outro | humano
    nodes: [
      {
        id: ids.trigger,
        type: "trigger",
        x: 360,
        y: 36,
        data: { label: "Mensagem recebida" },
      },
      {
        id: ids.welcome,
        type: "message",
        x: 360,
        y: 186,
        data: {
          text:
            "Olá{{name_greet}}! Sou o assistente virtual 👋\n\nPosso te ajudar a *marcar uma consulta* ou te conectar com um atendente.\n\nPode me dizer o que precisa?",
        },
      },
      {
        id: ids.intent,
        type: "llm_intent",
        x: 360,
        y: 336,
        data: {
          label: "Capturar intenção",
          prompt:
            "Classifique a intenção do cliente em uma das opções. Responda APENAS o slug.",
          intents: [
            { slug: "marcar_consulta", description: "Quer agendar, marcar consulta, horário, visita" },
            { slug: "falar_humano", description: "Quer falar com pessoa, atendente, humano" },
            { slug: "outro", description: "Dúvida geral, outro assunto, não claro" },
          ],
        },
      },
      {
        id: ids.askName,
        type: "ask",
        x: 40,
        y: 500,
        data: {
          prompt: "Perfeito! Para agendar, qual o *seu nome*?",
          varName: "nome",
        },
      },
      {
        id: ids.askWhen,
        type: "ask",
        x: 40,
        y: 650,
        data: {
          prompt: "Obrigado, {{nome}}! Qual *dia e período* prefere? (ex.: amanhã de manhã)",
          varName: "quando",
        },
      },
      {
        id: ids.confirm,
        type: "message",
        x: 40,
        y: 800,
        data: {
          text:
            "Anotado ✅\n\n*Nome:* {{nome}}\n*Preferência:* {{quando}}\n\nVou passar para a equipe confirmar o horário. Um momento!",
        },
      },
      {
        id: ids.handoffBook,
        type: "handoff",
        x: 40,
        y: 950,
        data: {
          reason: "consulta_solicitada",
          message:
            "Pronto! Um atendente humano vai continuar daqui. Se preferir, pode ir adiantando documentos.",
        },
      },
      {
        id: ids.handoff,
        type: "handoff",
        x: 680,
        y: 500,
        data: {
          reason: "pedido_humano",
          message:
            "Claro! Vou te passar para um atendente agora.",
        },
      },
      {
        id: ids.faq,
        type: "message",
        x: 360,
        y: 500,
        data: {
          text:
            "Entendi. Posso ajudar com:\n• *Marcar consulta*\n• *Falar com atendente*\n\nÉ só digitar o que precisa 🙂",
        },
      },
      {
        id: ids.end,
        type: "end",
        x: 360,
        y: 650,
        data: { label: "Fim (aguarda nova msg)" },
      },
    ],
    edges: [
      { id: "e1", from: ids.trigger, to: ids.welcome },
      { id: "e2", from: ids.welcome, to: ids.intent },
      { id: "e3", from: ids.intent, to: ids.askName, label: "marcar_consulta" },
      { id: "e4", from: ids.intent, to: ids.handoff, label: "falar_humano" },
      { id: "e5", from: ids.intent, to: ids.faq, label: "outro" },
      { id: "e5b", from: ids.intent, to: ids.faq, label: "default" },
      { id: "e6", from: ids.askName, to: ids.askWhen },
      { id: "e7", from: ids.askWhen, to: ids.confirm },
      { id: "e8", from: ids.confirm, to: ids.handoffBook },
      { id: "e9", from: ids.faq, to: ids.end },
    ],
  };
}

/**
 * Fluxo demo estúdio de pilates — 4 colunas sem cruzar:
 *
 *                    [Início]
 *                        │
 *                  [Boas-vindas]
 *                        │
 *               [Entender o pedido]
 *        ┌──────────┬──────────┬──────────┐
 *     agendar    dúvida     admin    não entendeu
 *        │          │          │          │
 *      …fila…    …fila…     …fila…      fim
 */
export function demoPilatesFlow(): Flow {
  const now = new Date().toISOString();
  const ids = {
    trigger: "p_trigger",
    welcome: "p_welcome",
    intent: "p_intent",
    askName: "p_ask_name",
    askWhen: "p_ask_when",
    askLevel: "p_ask_level",
    confirm: "p_confirm",
    handoffBook: "p_handoff_book",
    askDoubt: "p_ask_doubt",
    doubtAck: "p_doubt_ack",
    handoffDoubt: "p_handoff_doubt",
    askAdmin: "p_ask_admin",
    adminAck: "p_admin_ack",
    handoffAdmin: "p_handoff_admin",
    clarify: "p_clarify",
    end: "p_end",
  };

  // 4 colunas com vão largo o bastante para as linhas não se sobreporem
  const COL = {
    agendar: 40,
    duvida: 340,
    admin: 640,
    outro: 940,
  };
  // Tronco centrado entre as 4 colunas
  const CX = Math.round((COL.agendar + COL.outro) / 2);
  const y0 = 36;
  const gap = 168; // cartão ~100 + degrau + labels sem colar

  return {
    id: randomUUID(),
    name: "Demo · Marcar sessão de pilates",
    product: "gestor",
    accountId: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: ids.trigger,
        type: "trigger",
        x: CX,
        y: y0,
        data: { label: "Cliente mandou mensagem" },
      },
      {
        id: ids.welcome,
        type: "message",
        x: CX,
        y: y0 + gap,
        data: {
          text:
            "Olá! 🧘‍♀️ Bem-vinda(o) ao estúdio.\n\nComo posso te ajudar?\n\n• Marcar uma sessão\n• Tirar uma dúvida\n• Atendimento administrativo",
        },
      },
      {
        id: ids.intent,
        type: "llm_intent",
        x: CX,
        y: y0 + gap * 2,
        data: {
          label: "Entender o pedido",
          prompt:
            "Você atende um estúdio de pilates. Classifique a mensagem em UMA intenção. Responda APENAS o slug.",
          intents: [
            {
              slug: "marcar_sessao",
              description:
                "marcar sessão, agendar aula, horários, vaga, pilates, treino, experimental, remarcar",
            },
            {
              slug: "tirar_duvida",
              description:
                "dúvida, pergunta, como funciona, valores, planos, iniciante, o que levar",
            },
            {
              slug: "atendimento_admin",
              description:
                "administrativo, boleto, nota fiscal, cancelar, mensalidade, contrato, financeiro",
            },
          ],
        },
      },
      // Coluna 1 — agendar
      {
        id: ids.askName,
        type: "ask",
        x: COL.agendar,
        y: y0 + gap * 3,
        data: {
          prompt: "Perfeito! Vamos marcar uma sessão 💪\n\nQual o *seu nome*?",
          varName: "nome",
        },
      },
      {
        id: ids.askWhen,
        type: "ask",
        x: COL.agendar,
        y: y0 + gap * 4,
        data: {
          prompt:
            "Oi, {{nome}}! Qual *dia e horário* prefere?\n(ex.: terça 18h)",
          varName: "quando",
        },
      },
      {
        id: ids.askLevel,
        type: "ask",
        x: COL.agendar,
        y: y0 + gap * 5,
        data: {
          prompt: "Você já pratica pilates ou é *primeira vez*?",
          varName: "nivel",
        },
      },
      {
        id: ids.confirm,
        type: "message",
        x: COL.agendar,
        y: y0 + gap * 6,
        data: {
          text:
            "Anotado ✅\n\nNome: {{nome}}\nQuando: {{quando}}\nNível: {{nivel}}\n\nVou chamar a equipe para confirmar a vaga.",
        },
      },
      {
        id: ids.handoffBook,
        type: "handoff",
        x: COL.agendar,
        y: y0 + gap * 7,
        data: {
          reason: "marcar_sessao_pilates",
          message:
            "Pronto! Um atendente do estúdio vai confirmar sua sessão por aqui 💚",
        },
      },
      // Coluna 2 — dúvida
      {
        id: ids.askDoubt,
        type: "ask",
        x: COL.duvida,
        y: y0 + gap * 3,
        data: {
          prompt: "Claro! Pode mandar sua *dúvida* com calma 👇",
          varName: "duvida",
        },
      },
      {
        id: ids.doubtAck,
        type: "message",
        x: COL.duvida,
        y: y0 + gap * 4,
        data: {
          text:
            "Entendi:\n\n“{{duvida}}”\n\nVou passar para a equipe responder ✨",
        },
      },
      {
        id: ids.handoffDoubt,
        type: "handoff",
        x: COL.duvida,
        y: y0 + gap * 5,
        data: {
          reason: "duvida_pilates",
          message: "Um atendente vai te responder em breve. Obrigada!",
        },
      },
      // Coluna 3 — admin
      {
        id: ids.askAdmin,
        type: "ask",
        x: COL.admin,
        y: y0 + gap * 3,
        data: {
          prompt:
            "Certo — assunto *administrativo*.\n\nO que você precisa?\n(ex.: boleto, cancelamento, nota fiscal)",
          varName: "pedido_admin",
        },
      },
      {
        id: ids.adminAck,
        type: "message",
        x: COL.admin,
        y: y0 + gap * 4,
        data: {
          text:
            "Recebi:\n\n“{{pedido_admin}}”\n\nEncaminhando para o administrativo 📋",
        },
      },
      {
        id: ids.handoffAdmin,
        type: "handoff",
        x: COL.admin,
        y: y0 + gap * 5,
        data: {
          reason: "admin_pilates",
          message: "Pronto! Nossa equipe administrativa continua por aqui.",
        },
      },
      // Coluna 4 — não entendeu (sem atravessar as outras)
      {
        id: ids.clarify,
        type: "message",
        x: COL.outro,
        y: y0 + gap * 3,
        data: {
          text:
            "Sem problemas! Me diga se você quer:\n\n1) Marcar uma sessão\n2) Tirar uma dúvida\n3) Atendimento administrativo",
        },
      },
      {
        id: ids.end,
        type: "end",
        x: COL.outro,
        y: y0 + gap * 4,
        data: { label: "Aguarda nova mensagem" },
      },
    ],
    edges: [
      { id: "pe1", from: ids.trigger, to: ids.welcome },
      { id: "pe2", from: ids.welcome, to: ids.intent },
      { id: "pe3", from: ids.intent, to: ids.askName, label: "marcar_sessao" },
      { id: "pe4", from: ids.intent, to: ids.askDoubt, label: "tirar_duvida" },
      { id: "pe5", from: ids.intent, to: ids.askAdmin, label: "atendimento_admin" },
      { id: "pe5b", from: ids.intent, to: ids.clarify, label: "default" },
      { id: "pe6", from: ids.askName, to: ids.askWhen },
      { id: "pe7", from: ids.askWhen, to: ids.askLevel },
      { id: "pe8", from: ids.askLevel, to: ids.confirm },
      { id: "pe9", from: ids.confirm, to: ids.handoffBook },
      { id: "pe10", from: ids.askDoubt, to: ids.doubtAck },
      { id: "pe11", from: ids.doubtAck, to: ids.handoffDoubt },
      { id: "pe12", from: ids.askAdmin, to: ids.adminAck },
      { id: "pe13", from: ids.adminAck, to: ids.handoffAdmin },
      { id: "pe14", from: ids.clarify, to: ids.end },
    ],
  };
}

/** Templates oficiais para seed / botão “Usar modelo”. */
export function allSeedTemplates(): Flow[] {
  return [demoConsultationFlow(), demoPilatesFlow()];
}
