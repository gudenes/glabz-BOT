/**
 * Descoberta de variáveis disponíveis num ponto do fluxo.
 *
 * O builder sempre dependeu de o usuário SABER que um "Perguntar" grava em
 * {{resposta}} ou que a Ação de calendário devolve {{slots_text}} — a única
 * pista era uma frase fixa no rodapé do painel, só sobre calendário. Pra quem
 * não é técnico, esse é o ponto onde o fluxo quebra sem aviso: a mensagem sai
 * com "{{slots_text}}" literal pro cliente final.
 *
 * Aqui a lista é calculada de verdade: caminha o grafo de trás pra frente a
 * partir do nó selecionado e junta o que cada passo anterior produz.
 */

/** Sempre disponíveis — o engine injeta em toda conversa. Sem nodeId: não
 * nascem de nenhum card, o próprio motor coloca. */
const SYSTEM_VARS = [
  { name: "name_greet", from: "sistema", nodeId: null, hint: "Nome do contato já formatado (', João' ou vazio)" },
  { name: "pushName", from: "sistema", nodeId: null, hint: "Nome que o contato usa no WhatsApp" },
  { name: "last", from: "sistema", nodeId: null, hint: "Última mensagem enviada pelo cliente" },
];

/**
 * Campos que o motor de fato interpola (`render()` em src/flows/engine.ts):
 * texto da Mensagem, pergunta do Perguntar e texto do Atendente. Escrever
 * {{var}} em qualquer OUTRO campo (ex.: título do evento na Ação, contexto do
 * Responder com IA) não substitui nada — por isso esses ficam de fora do
 * índice de uso: dizer "usada" ali seria mentira útil pra ninguém.
 */
const INTERPOLATED_FIELDS = ["text", "prompt", "message"];

/**
 * Índice reverso: qual variável é usada por quais cards. Complementa
 * producedBy/varsAvailableAt, que só dizem de onde a variável VEM.
 * Devolve Map<nomeDaVar, string[] de nodeIds> na ordem dos nós do fluxo.
 */
export function varUsageIndex(flow) {
  const index = new Map();
  for (const node of flow?.nodes || []) {
    const d = node.data || {};
    const used = new Set(
      INTERPOLATED_FIELDS.flatMap((f) => (typeof d[f] === "string" ? varsUsedIn(d[f]) : []))
    );
    for (const name of used) {
      if (!index.has(name)) index.set(name, []);
      index.get(name).push(node.id);
    }
  }
  return index;
}

/** Variáveis que cada tipo de passo produz. */
function producedBy(node) {
  const d = node.data || {};
  const out = [];
  const label = String(d.label || "").trim();

  if (node.type === "ask" && d.varName) {
    out.push({ name: String(d.varName), from: "Perguntar", hint: "Resposta que o cliente digitou" });
  }
  if (node.type === "llm_extract") {
    if (d.varName) {
      out.push({ name: String(d.varName), from: "Extrair data", hint: "Data normalizada (AAAA-MM-DD)" });
    }
    out.push({
      name: "date_extract_status",
      from: "Extrair data",
      hint: "ok · ambiguous · unclear",
    });
  }
  if (node.type === "llm_intent") {
    out.push({ name: "last_intent", from: "Entender intenção", hint: "Código da intenção detectada" });
    out.push({ name: "pre_answer", from: "Entender intenção", hint: "O que o cliente já tinha dito" });
  }
  if (node.type === "action") {
    const connector = String(d.connector || "calendar");
    const operation = String(d.operation || "list_slots");
    const src = label || "Ação";
    if (connector === "calendar") {
      if (operation === "list_slots") {
        out.push({ name: "slots_text", from: src, hint: "Horários livres já formatados em lista" });
        out.push({ name: "slots_count", from: src, hint: "Quantos horários foram encontrados" });
        out.push({ name: "slots_json", from: src, hint: "Horários em formato técnico (JSON)" });
      }
      if (operation === "create_event") {
        out.push({ name: "event_label", from: src, hint: "Horário marcado, legível (ex.: Quinta 10:00)" });
        out.push({ name: "event_link", from: src, hint: "Link do evento na agenda" });
        out.push({ name: "event_summary", from: src, hint: "Resumo do evento" });
        out.push({ name: "event_id", from: src, hint: "Identificador do evento" });
      }
      if (operation === "cancel_event") {
        out.push({ name: "cancel_status", from: src, hint: "Situação do cancelamento" });
        out.push({ name: "cancelled_event_id", from: src, hint: "Identificador do evento cancelado" });
      }
    } else {
      // HTTP devolve o que o serviço mandar — não dá pra saber os nomes aqui.
      out.push({ name: "last_action_ok", from: src, hint: "1 se a integração respondeu certo, 0 se falhou" });
    }
  }
  return out;
}

/**
 * Variáveis existentes quando o fluxo CHEGA em `nodeId`, ou seja: produzidas
 * por passos que vêm antes dele. Sobe pelas edges (to → from) a partir do nó,
 * então só entra o que realmente pode ter acontecido antes.
 *
 * Ramificação: um passo em outro ramo do fluxo não aparece — se não há caminho
 * até aqui, aquela variável não existe neste ponto.
 */
export function varsAvailableAt(flow, nodeId) {
  const nodes = flow?.nodes || [];
  const edges = flow?.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const ancestors = new Set();
  const queue = edges.filter((e) => e.to === nodeId).map((e) => e.from);
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || ancestors.has(cur)) continue;
    ancestors.add(cur);
    for (const e of edges.filter((x) => x.to === cur)) queue.push(e.from);
  }

  const seen = new Map();
  for (const v of SYSTEM_VARS) seen.set(v.name, v);
  for (const id of ancestors) {
    const node = byId.get(id);
    if (!node) continue;
    for (const v of producedBy(node)) {
      // Primeiro passo que produz a variável fica como origem exibida.
      if (!seen.has(v.name)) seen.set(v.name, { ...v, nodeId: node.id });
    }
  }
  return [...seen.values()];
}

/** Variáveis usadas num texto ({{assim}}).
 * O padrão espelha o `render()` do motor (src/flows/engine.ts): só
 * letras/números/underscore. Aceitar ponto aqui marcaria {{a.b}} como "usada"
 * enquanto o motor a deixaria crua no texto — divergência silenciosa. */
export function varsUsedIn(text) {
  return [...String(text || "").matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
}

/**
 * Variáveis citadas no nó que NÃO existem naquele ponto — a causa raiz do
 * "{{slots_text}}" aparecendo cru pro cliente final.
 *
 * Mesmos campos de INTERPOLATED_FIELDS, e pelo mesmo motivo: `config.title`
 * (título do evento na Ação) ficava aqui, mas o motor NUNCA o interpola —
 * avisar "essa variável não existe" num campo que não substitui variável
 * nenhuma aponta pro problema errado.
 */
export function unknownVarsIn(flow, node) {
  if (!node) return [];
  const available = new Set(varsAvailableAt(flow, node.id).map((v) => v.name));
  const d = node.data || {};
  const texts = INTERPOLATED_FIELDS.map((f) => d[f]).filter((x) => typeof x === "string");
  const used = new Set(texts.flatMap(varsUsedIn));
  return [...used].filter((v) => !available.has(v));
}
