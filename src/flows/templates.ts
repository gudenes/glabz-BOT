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
    nodes: [
      {
        id: ids.trigger,
        type: "trigger",
        x: 80,
        y: 40,
        data: { label: "Mensagem recebida" },
      },
      {
        id: ids.welcome,
        type: "message",
        x: 80,
        y: 160,
        data: {
          text:
            "Olá{{name_greet}}! Sou o assistente virtual 👋\n\nPosso te ajudar a *marcar uma consulta* ou te conectar com um atendente.\n\nPode me dizer o que precisa?",
        },
      },
      {
        id: ids.intent,
        type: "llm_intent",
        x: 80,
        y: 320,
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
        x: 360,
        y: 240,
        data: {
          prompt: "Perfeito! Para agendar, qual o *seu nome*?",
          varName: "nome",
        },
      },
      {
        id: ids.askWhen,
        type: "ask",
        x: 360,
        y: 400,
        data: {
          prompt: "Obrigado, {{nome}}! Qual *dia e período* prefere? (ex.: amanhã de manhã)",
          varName: "quando",
        },
      },
      {
        id: ids.confirm,
        type: "message",
        x: 360,
        y: 560,
        data: {
          text:
            "Anotado ✅\n\n*Nome:* {{nome}}\n*Preferência:* {{quando}}\n\nVou passar para a equipe confirmar o horário. Um momento!",
        },
      },
      {
        id: ids.handoff,
        type: "handoff",
        x: 640,
        y: 400,
        data: {
          reason: "consulta_solicitada",
          message:
            "Pronto! Um atendente humano vai continuar daqui. Se preferir, pode ir adiantando documentos.",
        },
      },
      {
        id: ids.faq,
        type: "message",
        x: 80,
        y: 500,
        data: {
          text:
            "Entendi. Posso ajudar com:\n• *Marcar consulta*\n• *Falar com atendente*\n\nÉ só digitar o que precisa 🙂",
        },
      },
      {
        id: ids.end,
        type: "end",
        x: 80,
        y: 640,
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
      { id: "e8", from: ids.confirm, to: ids.handoff },
      { id: "e9", from: ids.faq, to: ids.end },
    ],
  };
}

/**
 * Fluxo demo estúdio de pilates:
 * marcar sessão · tirar dúvida · atendimento administrativo
 */
export function demoPilatesFlow(): Flow {
  const now = new Date().toISOString();
  const ids = {
    trigger: "p_trigger",
    welcome: "p_welcome",
    intent: "p_intent",
    // marcar sessão
    askName: "p_ask_name",
    askWhen: "p_ask_when",
    askLevel: "p_ask_level",
    confirm: "p_confirm",
    handoffBook: "p_handoff_book",
    // dúvida
    askDoubt: "p_ask_doubt",
    doubtAck: "p_doubt_ack",
    handoffDoubt: "p_handoff_doubt",
    // admin
    askAdmin: "p_ask_admin",
    adminAck: "p_admin_ack",
    handoffAdmin: "p_handoff_admin",
    // fallback
    clarify: "p_clarify",
    end: "p_end",
  };

  return {
    id: randomUUID(),
    name: "Demo · Marcar sessão de pilates",
    // product alinhado à conta demo do Gestor; troque no builder se precisar
    product: "gestor",
    accountId: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: ids.trigger,
        type: "trigger",
        x: 60,
        y: 40,
        data: { label: "Mensagem recebida" },
      },
      {
        id: ids.welcome,
        type: "message",
        x: 60,
        y: 150,
        data: {
          text:
            "Olá{{name_greet}}! 🧘‍♀️ Bem-vinda(o) ao estúdio.\n\nComo posso te ajudar hoje?\n\n• *Marcar uma sessão*\n• *Tirar uma dúvida*\n• *Atendimento administrativo*\n\nPode escrever com suas palavras 🙂",
        },
      },
      {
        id: ids.intent,
        type: "llm_intent",
        x: 60,
        y: 300,
        data: {
          label: "Entender o pedido",
          prompt:
            "Você atende um estúdio de pilates. Classifique a mensagem do cliente em UMA intenção. Responda APENAS o slug.",
          intents: [
            {
              slug: "marcar_sessao",
              description:
                "marcar sessão, agendar aula, horários, vaga, pilates, treino, aula experimental, remarcar",
            },
            {
              slug: "tirar_duvida",
              description:
                "dúvida, pergunta, como funciona, valores, planos, iniciante, gravidez, dor, o que levar",
            },
            {
              slug: "atendimento_admin",
              description:
                "administrativo, boleto, nota fiscal, cancelar, mensalidade, contrato, financeiro, rematrícula",
            },
          ],
        },
      },
      // ── Marcar sessão ───────────────────────────────────
      {
        id: ids.askName,
        type: "ask",
        x: 340,
        y: 160,
        data: {
          prompt: "Perfeito! Vamos *marcar uma sessão* 💪\n\nQual o *seu nome*?",
          varName: "nome",
        },
      },
      {
        id: ids.askWhen,
        type: "ask",
        x: 340,
        y: 300,
        data: {
          prompt:
            "Oi, {{nome}}! Qual *dia e horário* prefere?\n(ex.: terça 18h, ou amanhã de manhã)",
          varName: "quando",
        },
      },
      {
        id: ids.askLevel,
        type: "ask",
        x: 340,
        y: 440,
        data: {
          prompt:
            "Você já pratica pilates ou é *primeira vez*?\n(assim a equipe prepara a aula certinha)",
          varName: "nivel",
        },
      },
      {
        id: ids.confirm,
        type: "message",
        x: 340,
        y: 580,
        data: {
          text:
            "Anotado ✅\n\n*Nome:* {{nome}}\n*Quando:* {{quando}}\n*Nível:* {{nivel}}\n\nVou chamar a equipe para *confirmar a vaga*. Um instante!",
        },
      },
      {
        id: ids.handoffBook,
        type: "handoff",
        x: 340,
        y: 720,
        data: {
          reason: "marcar_sessao_pilates",
          message:
            "Pronto! Um atendente do estúdio vai confirmar sua sessão e te retornar por aqui 💚",
        },
      },
      // ── Tirar dúvida ─────────────────────────────────────
      {
        id: ids.askDoubt,
        type: "ask",
        x: 620,
        y: 240,
        data: {
          prompt: "Claro! Pode mandar sua *dúvida* com calma 👇",
          varName: "duvida",
        },
      },
      {
        id: ids.doubtAck,
        type: "message",
        x: 620,
        y: 380,
        data: {
          text:
            "Entendi sua dúvida:\n\n„{{duvida}}“\n\nVou passar para a equipe responder com carinho ✨",
        },
      },
      {
        id: ids.handoffDoubt,
        type: "handoff",
        x: 620,
        y: 520,
        data: {
          reason: "duvida_pilates",
          message: "Um atendente vai te responder em breve. Obrigada pela paciência!",
        },
      },
      // ── Administrativo ───────────────────────────────────
      {
        id: ids.askAdmin,
        type: "ask",
        x: 900,
        y: 240,
        data: {
          prompt:
            "Certo — assunto *administrativo*.\n\nPode detalhar o que precisa?\n(ex.: boleto, cancelamento, nota fiscal, rematrícula)",
          varName: "pedido_admin",
        },
      },
      {
        id: ids.adminAck,
        type: "message",
        x: 900,
        y: 380,
        data: {
          text:
            "Recebi:\n\n„{{pedido_admin}}“\n\nEncaminhando para o atendimento administrativo 📋",
        },
      },
      {
        id: ids.handoffAdmin,
        type: "handoff",
        x: 900,
        y: 520,
        data: {
          reason: "admin_pilates",
          message:
            "Pronto! Nossa equipe administrativa continua por aqui. Qualquer doc que precisar, pode enviar nesta conversa.",
        },
      },
      // ── Fallback ─────────────────────────────────────────
      {
        id: ids.clarify,
        type: "message",
        x: 60,
        y: 480,
        data: {
          text:
            "Sem problemas! Me diga se você quer:\n\n1️⃣ *Marcar uma sessão*\n2️⃣ *Tirar uma dúvida*\n3️⃣ *Atendimento administrativo*\n\nÉ só responder com o número ou em texto 🙂",
        },
      },
      {
        id: ids.end,
        type: "end",
        x: 60,
        y: 640,
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
