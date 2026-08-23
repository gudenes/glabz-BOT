# Roadmap: usabilidade do builder de fluxos

Registro de frente de trabalho · 23/08/2026 · repositório `gudenes/glabz-BOT`

> **Status: registrado, não iniciado.** Este documento existe pra não perder o contexto da
> discussão — as soluções aqui estão deliberadamente em aberto, pra serem desenhadas no momento
> da implementação.

## Por que esta frente existe

A premissa do produto é que **o próprio dono do negócio construa seu fluxo**, sem conhecimento
técnico. O builder atual não sustenta isso: ele assume que a pessoa entende variáveis,
ramificações e o encadeamento entre cards.

Essa frente é **distinta** do estudo de casos de uso
(`docs/estudo-casos-de-uso-e-integracoes.md`) e não compete com ele: aquele resolve "o cliente
encontra um template pronto que serve pro negócio dele"; este resolve "o cliente consegue
adaptar/criar sozinho quando o template não serve".

## 1. Visibilidade e sugestão de variáveis *(prioridade declarada do usuário)*

**Problema:** variáveis são o conceito mais abstrato do builder e hoje são praticamente
invisíveis. Quem monta um fluxo precisa saber que um nó de Ação de calendário produz
`slots_text`, `event_link` e `event_summary` pra conseguir usar `{{slots_text}}` na mensagem
seguinte — e a única pista disso é uma frase fixa no rodapé do painel de Detalhes
(`public/admin/flows.js:1016`), que só cobre o caso do calendário. Um `ask` que grava em
`varName` não anuncia isso em lugar nenhum.

**Consequência prática:** é o ponto onde o usuário leigo trava ou monta um fluxo quebrado (a
mensagem sai com `{{slots_text}}` literal pro cliente final, ou vazia).

**Direção (a desenhar):** uma área visível mostrando quais variáveis já existem naquele ponto do
fluxo, e sugestão contextual do que faz sentido usar no próximo card. Desenho da solução em
aberto — o usuário pediu explicitamente que sugestões sejam discutidas na hora de implementar.

**Complexidade:** média — exige calcular "quais variáveis existem neste ponto" percorrendo o
fluxo até o nó atual, e uma superfície de UI nova.

## 2. Teste de trecho isolado

**Problema:** o simulador (`POST /v1/flows/simulate`) sempre roda a conversa **desde o início**.
Pra testar um ramo que só é alcançado depois de 5 respostas, é preciso refazer as 5 respostas a
cada tentativa.

**Consequência:** iterar num trecho específico é lento e desestimula testar antes de publicar.

**Complexidade:** média — o engine já aceita um `state` inicial (é assim que o simulador
encadeia turnos), então a base existe; falta a UI e uma forma de montar um estado plausível
para o ponto escolhido.

## 3. Blocos reutilizáveis

**Problema:** trechos que se repetem entre fluxos (saudação, coleta de nome/contato,
encerramento, escalada pra humano) precisam ser remontados card a card toda vez.

**Consequência:** com o catálogo crescendo pra 10 templates, a manutenção multiplica — corrigir
o texto de encerramento vira 10 edições manuais.

**Complexidade:** média-alta — envolve decidir se o bloco é uma cópia (simples, mas duplica) ou
uma referência viva (melhor manutenção, mas muda o modelo de dados do fluxo).

## 4. Transcrição de áudio

**Problema:** o inbound já baixa o áudio recebido (`downloadInboundMedia`, `src/session.ts`),
mas o conteúdo falado **é descartado** — a mensagem que chega no fluxo é literalmente o texto
`"🎤 Áudio"` (`src/session.ts:465` + `mediaLabel`, `:677-680`).

**Consequência:** quem manda áudio hoje simplesmente não é atendido pelo bot. Em alguns
segmentos isso é a maioria dos contatos — o estudo de casos de uso apontou advocacia como o mais
afetado (cliente relata o caso inteiro por áudio).

**Nota:** essa também aparece na matriz de integrações do estudo (prioridade 4), porque destrava
o template C4. É a única desta lista que é ao mesmo tempo item de UX e de integração.

**Complexidade:** média — precisa de uma API de transcrição (custo por minuto) e de decidir o
comportamento quando a transcrição falha ou vem ruim.

## 5. Histórico de versões de fluxo

**Problema:** não há como ver o que mudou num fluxo nem voltar pra uma versão anterior.
Pendência antiga do projeto, anterior a esta discussão.

**Consequência:** editar um fluxo em produção é uma operação sem rede de segurança.

**Complexidade:** média — exige versionar `nodes`/`edges` a cada save e uma UI de comparação/
restauração.

## Ordem sugerida

1. **Variáveis visíveis** — maior impacto no objetivo declarado (leigo construir sozinho), e é o
   ponto onde a pessoa efetivamente trava hoje.
2. **Teste de trecho isolado** — melhora o ciclo de iteração de quem está montando.
3. **Histórico de versões** — rede de segurança, cresce em importância junto com o nº de clientes.
4. **Blocos reutilizáveis** — ganho de manutenção, mais relevante conforme o catálogo cresce.
5. **Transcrição de áudio** — alto valor, mas é a única com custo recorrente por uso e decisão
   de provedor; pode ser puxada pra frente se o segmento-alvo for de muito áudio.

---
*Frente registrada a partir de discussão em 23/08/2026. Ver
`docs/estudo-casos-de-uso-e-integracoes.md` pra frente de templates/integrações, e
`docs/arquitetura-to-be-roadmap_v2.md` pra frente de infraestrutura.*
