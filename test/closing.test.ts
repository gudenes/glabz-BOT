/**
 * O que conta como "não preciso de mais nada".
 *
 * Esta é a regra que decide se o atendimento continua ou encerra, e errar
 * pros dois lados é ruim de jeitos diferentes: encerrar numa pergunta deixa o
 * cliente falando sozinho; não encerrar numa despedida faz o bot insistir
 * pra sempre — e foi o que reprovou um fluxo saudável na validação.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSING_REGEX, CLOSING_REPLY } from "../src/flows/simple-flow.ts";

const re = () => new RegExp(CLOSING_REGEX, "i");

test("despedidas encerram", () => {
  const frases = [
    "não", "Não", "nao", "nada", "só isso", "era só isso", "era só isso mesmo",
    "não, obrigado", "Não, obrigado, só isso mesmo.", "valeu", "vlw", "obrigada",
    "Obrigado!", "tudo certo", "tudo bem, obrigado", "não por enquanto",
    "ok, valeu", "tchau", "é isso, valeu", "não, tudo certo",
  ];
  for (const f of frases) assert.ok(re().test(f), `deveria encerrar: "${f}"`);
});

test("perguntas de verdade NÃO encerram, mesmo começando por 'não'", () => {
  // O caso perigoso: quase toda despedida começa com uma palavra que também
  // abre pergunta. Encerrar aqui seria pior do que perguntar de novo.
  const frases = [
    "não sei quanto custa",
    "não entendi o preço",
    "nao consigo achar o horario",
    "não, quero saber o horário",
    "quanto custa?",
    "tem aula de manhã?",
    "obrigado, mas e o valor da mensalidade?",
    "valeu, mas vocês abrem sábado?",
    "ok, e quanto custa?",
    "tudo bem, mas tem vaga?",
    "nada de mais, só queria saber o preço",
    "isso mesmo, e o valor?",
  ];
  for (const f of frases) assert.ok(!re().test(f), `NÃO deveria encerrar: "${f}"`);
});

test("a despedida usada na validação é reconhecida pela própria regra", () => {
  // Amarra as duas pontas. Elas moraram em arquivos diferentes e divergiram
  // em silêncio: a frase do cliente sintético não casava com a expressão, o
  // laço rodava até o limite e a validação reprovava um fluxo correto.
  assert.ok(re().test(CLOSING_REPLY), `"${CLOSING_REPLY}" tem que encerrar`);
});
