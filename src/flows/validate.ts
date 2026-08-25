import type { Flow } from "./types.js";
import { runFlowStep, type FlowSimState, type FlowTraceStep } from "./engine.js";
import { judgeAnswerQuality } from "./llm.js";

/**
 * Validação automática de um fluxo: dirige uma conversa sintética por cada
 * ramo de intenção contra o MOTOR REAL (runFlowStep, o mesmo código do
 * "Testar" e da produção) — não é uma segunda opinião de LLM sobre o
 * desenho do fluxo, é rodar de verdade e ver onde trava. Ideia registrada
 * depois de 2 bugs reais em produção (PRs #69/#70) onde um fluxo gerado
 * parecia certo mas quebrava silenciosamente ao ser testado — este módulo
 * existe pra pegar essa classe de problema ANTES do dono descobrir sozinho.
 */

export type ValidationIssue = { severity: "warn" | "fail"; message: string };

export type ValidationCaseResult = {
  id: string;
  label: string;
  ok: boolean;
  steps: number;
  trace: FlowTraceStep[];
  issues: ValidationIssue[];
};

export type ValidationReport = {
  total: number;
  passed: number;
  cases: ValidationCaseResult[];
};

const MAX_STEPS = 12;
const GENERIC_OPENER = "Oi";

/** Detecta um passo de trace de llm_intent que É de fato uma classificação
 * (não a "ponte" pós-ask nem o "sem ramo correspondente" — ambos têm um
 * detail diferente, sem o sufixo "(fonte)" que classifyIntent sempre põe). */
function classificationSlug(step: FlowTraceStep): string | null {
  if (step.type !== "llm_intent") return null;
  const m = /^(.*?)\s+\((llm|keyword|default)\)$/.exec(step.detail || "");
  return m ? m[1] : null;
}

/** Resposta sintética plausível pra uma pergunta (ask) encontrada no
 * caminho — não sabe o que o ask pede de verdade, só tenta não travar a
 * conversa. Pra perguntas que parecem pedir "a dúvida em si", reaproveita
 * o texto de teste da própria intenção (é a coisa mais plausível de dizer
 * ali). */
function syntheticAnswerFor(varName: string, testMessage: string): string {
  const v = (varName || "").toLowerCase();
  if (v.includes("nome") || v.includes("name")) return "Cliente Teste";
  if (v.includes("telefone") || v.includes("phone") || v.includes("celular")) return "11999999999";
  if (v.includes("data") || v.includes("date") || v.includes("dia")) return "amanhã";
  if (v.includes("email") || v.includes("e-mail")) return "teste@exemplo.com";
  return testMessage;
}

async function runOneCase(
  flow: Flow,
  id: string,
  label: string,
  targetSlug: string | null,
  testMessage: string
): Promise<ValidationCaseResult> {
  let state: FlowSimState = { nodeId: null, waitingFor: null, vars: {}, mode: "bot" };
  let text = GENERIC_OPENER;
  const trace: FlowTraceStep[] = [];
  const issues: ValidationIssue[] = [];
  let steps = 0;
  let reachedTerminal = false;
  let intentChecked = false;

  while (steps < MAX_STEPS) {
    steps += 1;
    const result = await runFlowStep({ flow, state, text, simulate: true });
    trace.push(...result.trace);

    if (!intentChecked && targetSlug) {
      const hit = result.trace.find((t) => classificationSlug(t) !== null);
      if (hit) {
        intentChecked = true;
        const gotSlug = classificationSlug(hit);
        if (gotSlug && gotSlug !== targetSlug) {
          issues.push({
            severity: "warn",
            message: `testei o ramo "${targetSlug}" mas a IA classificou como "${gotSlug}" — descrições de intenção parecidas demais?`,
          });
        }
      }
    }

    for (const t of result.trace) {
      if (t.type === "llm_answer" && t.reply) {
        const judged = await judgeAnswerQuality({ question: text, answer: t.reply });
        if (!judged.ok) {
          issues.push({
            severity: "warn",
            message: `resposta da IA em "Responder com IA" ${judged.note || "parece fraca"} — considere preencher/melhorar o contexto do card`,
          });
        }
      }
    }

    if (result.handoff || result.trace.some((t) => t.type === "end")) {
      reachedTerminal = true;
      break;
    }

    text = result.waitingFor ? syntheticAnswerFor(result.waitingFor, testMessage) : testMessage;
    state = {
      nodeId: result.nodeId,
      waitingFor: result.waitingFor,
      vars: result.vars,
      mode: result.mode,
      finished: false,
    };
  }

  if (!reachedTerminal) {
    issues.push({
      severity: "fail",
      message: `não chegou num Fim/Passar-pra-atendente em ${MAX_STEPS} mensagens — pode estar preso num ciclo`,
    });
  }

  const ok = reachedTerminal && !issues.some((i) => i.severity === "fail");
  return { id, label, ok, steps, trace, issues };
}

export async function validateFlow(flow: Flow): Promise<ValidationReport> {
  const intentNode = flow.nodes.find((n) => n.type === "llm_intent");
  const intents = (
    intentNode && Array.isArray(intentNode.data.intents) ? intentNode.data.intents : []
  ) as { slug?: string; description?: string }[];
  const validIntents = intents.filter((i) => i.slug?.trim());

  const cases: ValidationCaseResult[] = [];
  if (!validIntents.length) {
    cases.push(await runOneCase(flow, "unico", "Fluxo (sem ramos por intenção)", null, "Olá, tudo bem?"));
  } else {
    for (const intent of validIntents) {
      const slug = String(intent.slug).trim();
      const desc = String(intent.description || "").trim() || slug;
      cases.push(await runOneCase(flow, `intent:${slug}`, `Ramo: ${desc}`, slug, desc));
    }
  }

  return {
    total: cases.length,
    passed: cases.filter((c) => c.ok).length,
    cases,
  };
}
