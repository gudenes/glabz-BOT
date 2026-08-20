# Teste de carga — gate da Fase 3

Executado em 20/08/2026 · repositório `gudenes/glabz-BOT` · ambiente: **staging**
(`glabz-bot-staging.up.railway.app`), nunca produção.

## Contexto

A Fase 3 do roadmap (`docs/arquitetura-to-be-roadmap.md`, seção 4.3/4.4 — separar a sessão
Baileys do servidor HTTP num serviço "Gateway" dedicado) tem um gatilho explícito: só executar
com resultado de teste de carga real mostrando degradação, não estimativa. Este documento
registra esse teste e sua conclusão.

## O que foi testado

Conversas de 3 turnos via `POST /v1/flows/simulate` — mesmo código que uma mensagem real de
WhatsApp percorre (`processInboundFlow`/`simulateFlowMessage`), sem abrir nenhum socket
Baileys/WhatsApp de verdade. O flow usado (Pilatys · "Atendimento") só atinge os nós de IA
(`llm_intent`, `llm_extract`) a partir do 2º/3º turno da conversa — por isso o teste encadeia
estado entre chamadas em vez de disparar mensagens soltas, garantindo que o custo de CPU/IA
real seja exercitado.

## Por que não foram simuladas "N contas WhatsApp conectadas"

Não é possível sintetizar pareamento real do Baileys (exige um aparelho físico escaneando um
QR code), e gerar sockets Baileys em massa — mesmo só para obter um QR code, sem completar o
pareamento — abriria conexões reais para a infraestrutura do WhatsApp em volume, arriscando a
reputação do IP de saída compartilhado do serviço. Esse é exatamente o risco de ban que o
documento AS-IS (`docs/arquitetura-as-is.md`, seção 7) já registrava como fraqueza estrutural
de qualquer solução sobre o protocolo reverso do WhatsApp Web — rodar um teste de carga que
aumentasse justamente esse risco contrariaria o propósito do exercício.

O gargalo que o roadmap previu (seção 4.3 do TO-BE) é CPU — parsing de mensagem e chamadas de
IA — não quantidade de sockets abertos. O teste foi desenhado para medir exatamente isso.

## Resultados

Baseline do serviço em staging, ocioso, antes do teste: CPU ~0 vCPU, memória ~143 MB.

| Concorrência (usuários virtuais, 3 turnos cada) | Erros | CPU máx. do serviço | Memória máx. |
|---|---|---|---|
| 5 | 0% | — | ~148 MB |
| 15 | 0% | — | ~148 MB |
| 30 | 0% | — | ~148 MB |
| 60 | 0% | 0,005 vCPU | ~148 MB |
| 150 (450 chamadas tocando nós de IA) | 0% | **0,04 vCPU** (limite: 24) | ~194 MB |

Métrica nativa do Railway durante o pico de 150 usuários concorrentes: `p95 = 980ms` por
requisição HTTP individual — sem degradação perceptível frente ao baseline.

O atraso observado no tempo total "por usuário" (chegou a ~10s de p95 em 150 concorrentes,
somando os 3 turnos) vem da fila/latência do lado da API de LLM (xAI) sob rajada, ou do próprio
script de teste local — não da infraestrutura do Glabz-bot, confirmado pela métrica HTTP nativa
do Railway não ter degradado no mesmo intervalo.

## Conclusão

**Fase 3 não é necessária no volume testado.** Zero evidência de que separar o Gateway
resolveria algum problema hoje — o processo único aguenta 150 conversas simultâneas reais
(incluindo IA) com CPU/memória praticamente no chão. Se algum dia aparecer um limite de
verdade em escala, o suspeito mais provável não é o processo da aplicação — é o **rate limit
da própria API de LLM** (xAI), que é um problema diferente (fila/cache de chamada de IA, não
arquitetura de processo) e não seria resolvido pela Fase 3.

## Sobre o worker do outbox (Fase 2)

Não testado empiricamente por carga — não existe hoje uma forma segura de gerar tráfego real
sem uma conta WhatsApp conectada de verdade (mesma restrição do parágrafo acima). O teto de
throughput do worker é uma constante conhecida por desenho, não algo que precise de descoberta
empírica: `BATCH_SIZE=10` linhas reivindicadas a cada `POLL_INTERVAL_MS=5000` (`src/outbox.ts`)
≈ 120 linhas/minuto no pior caso (falhas instantâneas, sem espera de I/O). Ajustável via essas
duas constantes se algum dia for necessário.

## Como reproduzir

Script em `scratchpad/load-test.mjs` (fora do repositório, gerado durante a sessão) — roda
contra a URL de staging com o secret do serviço via variável de ambiente `STG_SECRET`. Não
precisa de nenhuma conta WhatsApp conectada; usa só o simulador de fluxo.

---
*Ver `docs/arquitetura-to-be-roadmap.md` seção 4.4 para o contexto do gatilho, e
`docs/arquitetura-as-is.md` seção 5.2 para o estado "capacidade desconhecida" que este teste
resolveu.*
