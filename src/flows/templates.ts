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
