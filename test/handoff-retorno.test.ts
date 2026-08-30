/**
 * Retorno automático da conversa ao bot, exercitado pelo motor.
 *
 * Os unitários em bot-rules cobrem a REGRA (quando o prazo venceu). Aqui é o
 * comportamento: o motor devolve mesmo? e o relógio reinicia a cada contato?
 *
 * Este segundo ponto não é detalhe — contar do momento do transbordo, e não
 * do último contato, devolveria a conversa ao bot no meio de um atendimento
 * demorado, com o bot falando por cima do atendente.
 *
 * Usa uma pasta de dados descartável: o estado de conversa vive em disco.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "glabz-handoff-"));

type Store = typeof import("../src/flows/store.ts");
type Registry = typeof import("../src/registry.ts");
let store: Store;
let registry: Registry;
let processInboundFlow: typeof import("../src/flows/engine.ts").processInboundFlow;
let flowStatesPath: typeof import("../src/config.ts").flowStatesPath;
let accountId = "";
const TEL = "5511999998888";

before(async () => {
  store = await import("../src/flows/store.ts");
  registry = await import("../src/registry.ts");
  ({ processInboundFlow } = await import("../src/flows/engine.ts"));
  ({ flowStatesPath } = await import("../src/config.ts"));
  const { buildSimpleFlow } = await import("../src/flows/simple-flow.ts");
  const { layoutFlow } = await import("../src/flows/from-prompt.ts");

  accountId = registry.ensureAccount({
    product: "gestor",
    externalTenantId: "t1",
    webhookUrl: "https://exemplo.com/hook",
  }).id;
  const b = buildSimpleFlow({ apresentacao: "Aqui é da C3." });
  store.saveFlow({
    name: "Teste",
    product: "gestor",
    accountId,
    status: "live",
    nodes: layoutFlow(b.nodes, b.edges),
    edges: b.edges,
  } as never);
});

/**
 * Deixa a conversa em atendimento humano, parada há N horas.
 *
 * Escreve o arquivo direto porque `upsertConversationState` força
 * `updatedAt = agora` — o que é o certo em produção (é ele que reinicia o
 * relógio) mas impede envelhecer o estado por ali.
 */
function emAtendimentoHumano(horasParado: number): void {
  store.upsertConversationState({
    accountId,
    phoneE164: TEL,
    mode: "human",
    flowId: null,
    nodeId: null,
    waitingFor: null,
    vars: {},
    updatedAt: "",
  });
  const caminho = flowStatesPath();
  const arquivo = JSON.parse(readFileSync(caminho, "utf8"));
  const alvo = arquivo.states.find((s: { phoneE164: string }) => s.phoneE164 === TEL);
  alvo.updatedAt = new Date(Date.now() - horasParado * 3600000).toISOString();
  writeFileSync(caminho, JSON.stringify(arquivo));
}

const escrever = () =>
  processInboundFlow({ accountId, product: "gestor", phoneE164: TEL, text: "oi, voltei" });

test("dentro do prazo, a conversa segue com a pessoa", async () => {
  registry.updateAccount(accountId, { botRules: undefined });
  for (const horas of [0.1, 5, 23]) {
    emAtendimentoHumano(horas);
    assert.equal(await escrever(), null, `${horas}h parado: o bot não fala por cima`);
  }
});

test("passado o prazo, o bot volta a atender", async () => {
  registry.updateAccount(accountId, { botRules: undefined });
  for (const horas of [25, 24 * 30]) {
    emAtendimentoHumano(horas);
    const r = await escrever();
    assert.ok(r, `${horas}h parado: o bot devia voltar`);
    assert.ok(r.replies.length > 0, "e atender de verdade");
    assert.equal(store.getConversationState(accountId, TEL)?.mode, "bot", "estado virou bot");
  }
});

test("o relógio reinicia a cada contato, não conta do transbordo", async () => {
  // O caso que isto protege: atendimento demorado, com o cliente escrevendo
  // ao longo do dia. Contando do transbordo, o bot entraria no meio dele.
  registry.updateAccount(accountId, { botRules: undefined });
  emAtendimentoHumano(23);
  assert.equal(await escrever(), null, "ainda com a pessoa");

  const depois = store.getConversationState(accountId, TEL);
  const idadeSegundos = (Date.now() - new Date(depois?.updatedAt || 0).getTime()) / 1000;
  assert.ok(idadeSegundos < 5, `o contato reiniciou o prazo (idade: ${idadeSegundos.toFixed(1)}s)`);
  assert.equal(depois?.mode, "human", "e continua com a pessoa");
});

test("o dono pode desligar: aí nunca volta sozinho", async () => {
  registry.updateAccount(accountId, {
    botRules: { numbers: { mode: "off", list: [] }, handoffReturnMs: 0 },
  });
  emAtendimentoHumano(24 * 365);
  assert.equal(await escrever(), null, "um ano parado e ainda com a pessoa");
});

test("o dono pode encurtar o prazo", async () => {
  registry.updateAccount(accountId, {
    botRules: { numbers: { mode: "off", list: [] }, handoffReturnMs: 3600000 },
  });
  emAtendimentoHumano(0.5);
  assert.equal(await escrever(), null, "meia hora: ainda com a pessoa");
  emAtendimentoHumano(2);
  assert.ok(await escrever(), "duas horas: o bot volta");
});
