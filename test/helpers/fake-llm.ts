/**
 * IA falsa para os testes.
 *
 * Sem isto, todo teste rodava num ambiente onde `llmApiKey()` é vazio — e aí
 * o card "Responder com IA" SEMPRE falha e o fluxo segue pela saída "erro"
 * até o atendente humano. Resultado: a saída "ok", que é onde vive o laço de
 * continuação do fluxo simples, nunca era exercitada. Os testes passavam
 * verdes por um motivo que não vale em produção, e um fluxo que travava a
 * validação com a IA ligada foi liberado assim mesmo.
 *
 * Com o fetch trocado aqui, o caminho de sucesso passa a rodar de verdade.
 */
const real = { fetch: globalThis.fetch, key: process.env.XAI_API_KEY };

export type FakeLlm = {
  /** Quantas vezes a IA foi chamada — útil pra provar que o caminho rodou. */
  calls: number;
  restore(): void;
};

/**
 * Faz a IA responder `answer` a qualquer pergunta, sem sair pra rede.
 * `fail: true` reproduz o outro lado: a IA sem resposta, que deve cair no
 * atendente humano.
 */
export function fakeLlm(answer = "Resposta da IA.", opts: { fail?: boolean } = {}): FakeLlm {
  const state: FakeLlm = {
    calls: 0,
    restore() {
      globalThis.fetch = real.fetch;
      if (real.key === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = real.key;
    },
  };
  process.env.XAI_API_KEY = "test-key";
  globalThis.fetch = (async () => {
    state.calls += 1;
    if (opts.fail) return new Response("erro", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return state;
}
