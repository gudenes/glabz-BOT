/**
 * Catálogo: os 5 templates têm que ser o MESMO esqueleto do fluxo gerado.
 *
 * Antes eram fluxos escritos à mão de 10 a 12 cards, todos rotulados
 * "simples" — quem escolhia "simples" na tela recebia um fluxo de 12 cards.
 * O rótulo mentia e ninguém tinha como saber, porque nada comparava as duas
 * coisas. É o que este arquivo passa a fazer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogFlows, catalogSlugs, templateCatalog, pickCatalogFlow, blankFlow, CATALOG_REVISION } from "../src/flows/catalog.ts";
import { buildSimpleFlow, SIMPLE_IDS } from "../src/flows/simple-flow.ts";
import { validateFlow } from "../src/flows/validate.ts";

test("todo template é o esqueleto simples, com forma idêntica à do fluxo gerado", () => {
  // Referência: o mesmo esqueleto que a geração produz.
  const ref = buildSimpleFlow({ apresentacao: "x", context: "y", handoff: "z" });
  const refForma = ref.edges.map((e) => `${e.from}-${e.label || ""}->${e.to}`).sort();

  for (const flow of catalogFlows()) {
    const nome = flow.seedSlug || flow.name;
    assert.equal(flow.nodes.length, 7, `${nome}: 7 cards`);
    assert.deepEqual(
      flow.edges.map((e) => `${e.from}-${e.label || ""}->${e.to}`).sort(),
      refForma,
      `${nome}: ligações idênticas às do fluxo gerado`
    );
    // O card de continuação volta pra IA — o defeito que o dono viu num fluxo
    // gerado era exatamente este ir pro fim.
    const volta = flow.edges.find((e) => e.from === SIMPLE_IDS.decide && e.label === "false");
    assert.equal(volta?.to, SIMPLE_IDS.answer, `${nome}: continuação volta pra IA`);
  }
});

test("os textos são de verdade e específicos do segmento", () => {
  for (const flow of catalogFlows()) {
    const nome = flow.seedSlug || flow.name;
    const abertura = String(flow.nodes.find((n) => n.id === SIMPLE_IDS.opening)?.data.prompt || "");
    const contexto = String(flow.nodes.find((n) => n.id === SIMPLE_IDS.answer)?.data.context || "");
    const handoff = String(flow.nodes.find((n) => n.id === SIMPLE_IDS.handoff)?.data.message || "");

    assert.match(abertura, /\{\{name_greet\}\}/, `${nome}: abertura usa o nome do contato`);
    // O esqueleto já cumprimenta; cumprimentar de novo sairia "Oi, Carlos! Olá!".
    const depoisDoCumprimento = abertura.replace(/^Oi\{\{name_greet\}\}!\s*/, "");
    // Sem `\b` no fim de propósito: "á" não é caractere de palavra em regex
    // JS, então `/olá\b/` NÃO casa com "Olá!" — o teste passava por engano até
    // uma sabotagem mostrar isso.
    assert.doesNotMatch(
      depoisDoCumprimento,
      /^(oi|ol[áa]|bom dia|boa tarde|boa noite)(\s|[,!.]|$)/i,
      `${nome}: apresentação não cumprimenta de novo`
    );
    assert.ok(contexto.length > 40, `${nome}: contexto com conteúdo real`);
    assert.ok(handoff.length > 10, `${nome}: mensagem de atendente escrita`);
  }
});

test("nenhum template rotulado simples é grande", () => {
  const porSlug = new Map(catalogFlows().map((f) => [f.seedSlug, f]));
  for (const meta of templateCatalog()) {
    const flow = porSlug.get(meta.slug);
    assert.ok(flow, `${meta.slug}: template existe`);
    if (meta.complexity === "simples") {
      assert.ok(flow.nodes.length <= 7, `${meta.slug}: rotulado simples e tem ${flow.nodes.length} cards`);
      assert.ok(
        !flow.nodes.some((n) => n.type === "llm_intent"),
        `${meta.slug}: rotulado simples não pode ramificar por intenção`
      );
    }
  }
});

test("todos passam na validação automática", async () => {
  for (const flow of catalogFlows()) {
    const r = await validateFlow({ ...flow, mode: "simples" });
    const falhas = r.cases.flatMap((c) => c.issues).filter((i) => i.severity === "fail");
    assert.deepEqual(falhas, [], `${flow.seedSlug}: sem reprovação`);
    assert.equal(r.passed, r.total, `${flow.seedSlug}: ${r.passed}/${r.total}`);
  }
});

test("seleção por slug e fluxo em branco continuam funcionando", () => {
  const slugs = catalogSlugs();
  assert.equal(slugs.length, 5);
  for (const slug of slugs) {
    const f = pickCatalogFlow(slug);
    assert.ok(f, `${slug}: encontrado`);
    assert.equal(f.seedSlug, slug);
    assert.equal(f.seedRevision, CATALOG_REVISION, `${slug}: marcado na revisão atual`);
  }
  // Apelido inexistente não pode derrubar quem chama (já causou 500 na criação
  // de cliente quando havia asserção não-nula aqui).
  assert.equal(pickCatalogFlow("nao-existe"), null);
  assert.equal(pickCatalogFlow("blank"), null);
  assert.equal(pickCatalogFlow(""), null);
  assert.equal(pickCatalogFlow(null), null);
  assert.equal(blankFlow().nodes.length, 1);
});

test("cards posicionados: sem x/y todos empilhariam no canto do canvas", () => {
  for (const flow of catalogFlows()) {
    const posicoes = new Set(flow.nodes.map((n) => `${n.x},${n.y}`));
    assert.equal(posicoes.size, flow.nodes.length, `${flow.seedSlug}: nenhum card sobreposto`);
  }
});

test("nenhum cartão mostra regra técnica no lugar do nome", () => {
  // O dono do negócio chegou a ver `last regex "^\s*(n[ãa]o|nada|..."` no meio
  // do fluxo dele. Regra crua vive no painel lateral; no cartão vai o que a
  // decisão significa.
  const feio = /regex|\^\\s\*|\{\{\s*\}\}|undefined|\[object/i;
  for (const flow of catalogFlows()) {
    for (const node of flow.nodes) {
      const label = String((node.data as { label?: string }).label ?? "");
      if (!label) continue;
      assert.doesNotMatch(label, feio, `${flow.seedSlug}/${node.id}: nome legível`);
    }
    const cond = flow.nodes.find((n) => n.type === "condition");
    assert.ok(cond, `${flow.seedSlug}: tem a decisão de encerramento`);
    assert.ok(
      String((cond.data as { label?: string }).label || "").length > 3,
      `${flow.seedSlug}: a decisão tem nome escrito, senão o cartão cai na regra crua`
    );
  }
});
