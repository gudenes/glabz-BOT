import { flowModeOf, type Flow, type FlowNode } from "./types.js";
import { isClosingSlug, runFlowStep, type FlowSimState, type FlowTraceStep } from "./engine.js";
import { judgeAnswerQuality } from "./llm.js";
import { ensureFollowUpLoop, ensureOpeningAsk } from "./from-prompt.js";

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
 * ali). Ask com capturesIntent (o "mais alguma coisa?" — ver PR de loop de
 * encerramento) é caso especial: responder de novo com o mesmo testMessage
 * reclassificaria pra MESMA intenção sem fim — o teste nunca terminaria
 * dentro do limite de passos (falso negativo, não é bug do fluxo, é o
 * driver de teste repetindo a si mesmo). Recusar aqui exercita de brinde o
 * próprio caminho de encerramento gracioso. */
function syntheticAnswerFor(askNode: FlowNode | undefined, testMessage: string): string {
  if (askNode?.data?.capturesIntent) return "Não, obrigado, só isso mesmo.";
  const varName = String(askNode?.data?.varName || "");
  const v = varName.toLowerCase();
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
  // O pedido de teste ("quero saber sobre planos") só é enviado DEPOIS da
  // abertura genérica ("Oi"). Se o fluxo terminar antes disso, ele encerrou
  // sem nunca ouvir o que o cliente queria — bug grave, não um detalhe.
  let deliveredTestMessage = false;

  while (steps < MAX_STEPS) {
    steps += 1;
    if (text === testMessage) deliveredTestMessage = true;
    const result = await runFlowStep({ flow, state, text, simulate: true });
    trace.push(...result.trace);

    if (!intentChecked && targetSlug) {
      // Ignora classificação "default" aqui — é o resultado ESPERADO da
      // mensagem de abertura genérica ("Oi"), não um sinal de ramo errado.
      // Só conta como checagem de verdade quando a IA de fato comprometeu
      // com uma intenção real.
      const hit = result.trace.find((t) => {
        const slug = classificationSlug(t);
        return slug !== null && slug !== "default";
      });
      if (hit) {
        intentChecked = true;
        const gotSlug = classificationSlug(hit);
        if (gotSlug && gotSlug !== targetSlug) {
          // FAIL, não warn: cair no ramo errado é o fluxo não fazer o que
          // deveria — foi exatamente assim que uma validação "4 de 4
          // passaram" conviveu com um fluxo que encerrava na saudação.
          issues.push({
            severity: "fail",
            message: `testei o ramo "${targetSlug}" mas a IA classificou como "${gotSlug}" — o cliente cairia no ramo errado`,
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

    text = result.waitingFor
      ? syntheticAnswerFor(
          flow.nodes.find((n) => n.id === result.nodeId),
          testMessage
        )
      : testMessage;
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

  // Encerrou antes de o cliente conseguir dizer o que queria — o caso mais
  // grave e o mais fácil de passar batido, porque "chegou num Fim" sozinho
  // parece sucesso.
  //
  // Exceção: se um llm_answer chegou a rodar, o fluxo ATENDEU a mensagem do
  // cliente (respondeu, ou tentou e caiu no fallback humano) — terminar ali é
  // o desenho, não descaso. É exatamente o caso do fluxo simples, que
  // responde de cara sem perguntar nada antes. Sem esta exceção a checagem
  // reprovava todo fluxo simples; com ela, o cenário que a originou (fluxo
  // que só dá boas-vindas e encerra, sem responder nada) continua reprovando.
  const answered = trace.some((t) => t.type === "llm_answer");
  if (reachedTerminal && !deliveredTestMessage && !answered) {
    issues.push({
      severity: "fail",
      message: "o fluxo encerrou logo na saudação, antes de o cliente conseguir dizer o que precisava",
    });
  }

  const ok = reachedTerminal && !issues.some((i) => i.severity === "fail");
  return { id, label, ok, steps, trace, issues };
}

/**
 * Checagem ESTRUTURAL do llm_answer, feita no grafo e não na conversa.
 *
 * A validação por conversa não pega isto: quando a IA falha (sem chave, sem
 * base) o caso segue pelo "erro" e termina em handoff, que é desenho válido —
 * o ramo "ok" nunca chega a ser exercitado. Foi assim que passou um fluxo
 * simples com trigger → llm_answer --erro--> handoff e mais nada: o cliente
 * recebia a resposta certa e era passado pra um humano em seguida, porque
 * "erro" era a única saída e o motor a seguia até em caso de sucesso.
 *
 * Mesma lição do PR #74: severidade errada, ou checagem ausente, é tão ruim
 * quanto não ter validação. Aqui é `fail`, não `warn` — um llm_answer sem a
 * saída de sucesso torna o card inútil no melhor caso e enganoso no pior.
 */
/**
 * O fluxo aciona a IA sem nunca esperar o cliente falar?
 *
 * Reusa a MESMA função que repara a geração (ensureOpeningAsk): se ela diz
 * que repararia este fluxo, é porque falta a espera. Uma regra só, um
 * comportamento só — se o reparo mudar, a validação acompanha sozinha.
 *
 * A validação por conversa não pega isto sozinha: ela manda "Oi" e depois o
 * pedido de teste, e um fluxo que responde de cara ao "Oi" e encerra parece
 * ter atendido. Foi assim que passou o fluxo que o usuário viu encerrar
 * logo no "Olá".
 */
function openingAskIssues(flow: Flow): ValidationIssue[] {
  const { repaired } = ensureOpeningAsk(flow.nodes, flow.edges);
  if (!repaired) return [];
  return [
    {
      severity: "fail",
      message:
        "O fluxo aciona a IA sem antes perguntar o que o cliente precisa: a primeira " +
        "mensagem (quase sempre um \"oi\") vira a pergunta, e o atendimento acaba antes de " +
        "a pessoa dizer o que queria.",
    },
  ];
}

/**
 * O atendimento acaba depois de UMA resposta?
 *
 * Mesmo padrão das outras duas: reusa a função que repara a geração, então
 * regra e conserto não podem divergir. Só vale pro fluxo enxuto — o completo
 * fecha o laço pelo llm_intent, com a intenção reservada de encerramento.
 */
function followUpIssues(flow: Flow): ValidationIssue[] {
  if (flowModeOf(flow) !== "simples") return [];
  const { repaired } = ensureFollowUpLoop(flow.nodes, flow.edges);
  if (!repaired) return [];
  return [
    {
      severity: "warn",
      message:
        "Depois de responder, o atendimento encerra: o cliente não consegue fazer uma segunda " +
        "pergunta na mesma conversa.",
    },
  ];
}

function answerBranchIssues(flow: Flow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of flow.nodes) {
    if (node.type !== "llm_answer") continue;
    const outs = flow.edges.filter((e) => e.from === node.id);
    const has = (label: string) => outs.some((e) => (e.label || "") === label);
    if (!has("ok")) {
      issues.push({
        severity: "fail",
        message:
          `O card "Responder com IA" (${node.id}) não tem saída "ok": quando a IA responde ` +
          `certo, o atendimento segue pelo caminho errado.`,
      });
    }
    if (!has("erro")) {
      issues.push({
        severity: "fail",
        message:
          `O card "Responder com IA" (${node.id}) não tem saída "erro": quando a IA não souber ` +
          `responder, não há para onde ir.`,
      });
    }
  }
  return issues;
}

export async function validateFlow(flow: Flow): Promise<ValidationReport> {
  const intentNode = flow.nodes.find((n) => n.type === "llm_intent");
  const intents = (
    intentNode && Array.isArray(intentNode.data.intents) ? intentNode.data.intents : []
  ) as { slug?: string; description?: string }[];
  const allIntents = intents.filter((i) => i.slug?.trim());
  // O ramo de encerramento não é testável isoladamente e nem deveria ser: o
  // motor (isClosingSlug em engine.ts) só aceita encerrar quando o cliente
  // responde isso ao "posso ajudar com mais alguma coisa?" — encerrar na
  // saudação é justamente o bug que a guarda impede. Ele já é exercitado no
  // FIM de cada outro caso, porque syntheticAnswerFor responde esse ask com
  // uma recusa. Testar à parte só geraria um falso "falhou".
  const testableIntents = allIntents.filter((i) => !isClosingSlug(String(i.slug)));
  const validIntents = testableIntents.length ? testableIntents : allIntents;

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

  // Defeito de grafo vale pro fluxo inteiro, então entra em TODO caso: o
  // relatório mostra caso a caso, e um problema estrutural invisível em
  // metade deles esconderia a causa real.
  const structural = [
    ...openingAskIssues(flow),
    ...answerBranchIssues(flow),
    ...followUpIssues(flow),
  ];
  if (structural.length) {
    // Só `fail` reprova. Um `warn` estrutural (o fluxo funciona, mas é curto
    // demais) tem que aparecer no relatório SEM derrubar o placar — inverter
    // isso é o mesmo erro de severidade do PR #74, só que pro outro lado:
    // ali um `warn` escondeu um fluxo quebrado, aqui um `warn` reprovaria um
    // fluxo que funciona.
    const reprova = structural.some((i) => i.severity === "fail");
    for (const c of cases) {
      c.issues = [...structural, ...c.issues];
      if (reprova) c.ok = false;
    }
  }

  return {
    total: cases.length,
    passed: cases.filter((c) => c.ok).length,
    cases,
  };
}
