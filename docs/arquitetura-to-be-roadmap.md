# Glabz-bot — Arquitetura TO BE e Roadmap

Documento complementar ao AS-IS · 17/08/2026 · repositório `gudenes/glabz-BOT`

> **Status em 20/08/2026:** Fases 0, 1 e 2 executadas e promovidas para produção (validadas
> primeiro em staging). O gate da Fase 3 (teste de carga) foi cumprido — resultado: Fase 3
> **não recomendada por enquanto** (sem evidência de necessidade no volume testado). Ver
> `docs/teste-de-carga-fase3-gate.md`.

## 1. Sumário executivo

O AS-IS mostra uma base tecnicamente mais sólida do que o esperado: persistência de sessão
via Railway Volume já resolvida, reconexão de socket com backoff já implementada. O risco real
não está na sessão WhatsApp cair — está no que acontece depois: ninguém é avisado quando isso
acontece, e uma mensagem que falha no envio simplesmente some, sem retry e sem registro
persistente.

Direção estratégica definida: manter Baileys (não migrar para a WhatsApp Cloud API oficial da
Meta no momento) e industrializar a infraestrutura de sessão — no mesmo espírito do que a
Z-API já resolveu para os clientes dela, mas sob controle próprio. O ICP (perfil de
cliente-alvo) ainda está em aberto; o roadmap abaixo foi desenhado para não depender dessa
decisão.

## 2. Benchmark de mercado — Baileys vs. Z-API vs. WhatsApp Cloud API

Ponto importante para o posicionamento comercial: o Z-API não é "mais seguro" por ser oficial
— ele também opera sobre o mesmo protocolo não documentado do WhatsApp Web. A vantagem dele é
de produtização: redundância, filas, suporte, SLA percebido. É exatamente essa camada de
industrialização que este roadmap propõe construir.

| | Glabz-bot hoje | Z-API | WhatsApp Cloud API (Meta) |
|---|---|---|---|
| **Protocolo** | Baileys — engenharia reversa, sessão própria | Também não-oficial por trás, vendido como infraestrutura gerenciada | Oficial — número verificado como Business Platform |
| **Sustentação da infra** | Você mesmo — sessão cai, você resolve | Redundância, isolamento por instância, retry e filas geridos pela Z-API | Meta — SLA de plataforma, porém regras rígidas de conteúdo/templates |
| **Risco de ban do número** | Alto e imprevisível — fraqueza estrutural de qualquer solução sobre protocolo reverso | Mesmo risco de fundo, mitigado por prática operacional | Baixíssimo — canal sancionado pela Meta |
| **Custo** | Sua VPS/Railway + seu tempo de manutenção | Planos com tarifa fixa e previsibilidade | Cobrança por conversa, via Meta ou BSPs |
| **Domínio/provisionamento próprio** | Não existe hoje | Multi-instância gerenciada pela Z-API | Número Business verificado; infra 100% Meta |

## 3. Diagnóstico de riscos priorizados

Cada item abaixo referencia a lacuna correspondente do documento AS-IS (seção 5 e 7).

| Risco | Causa raiz (AS-IS) | Severidade | Status (20/08) |
|---|---|---|---|
| Ninguém sabe quando uma sessão cai | Sem notificação ativa — só log + painel (AS-IS 5.5) | Alta | ✅ Resolvido — Fase 1 |
| Mensagem falha silenciosamente | Sem fila, sem retry no envio individual (AS-IS 5.3) | Alta | ✅ Resolvido — Fase 2 |
| Estado de conexão se perde a cada restart | Status só em memória, não persistido (AS-IS 5.4) | Média | ✅ Resolvido — Fase 1 |
| Capacidade desconhecida | Sem teste de carga documentado (AS-IS 5.2) | Média | ✅ Resolvido — gate cumprido |
| Ponto único de falha | Processo único: sessão + servidor HTTP juntos (AS-IS 5.2) | Média — baixo impacto hoje, cresce com volume | Sem gatilho pra agir (ver gate) |
| Onboarding trava em 100 usuários | App Google OAuth em modo Teste (AS-IS 4.4) | Baixa no curto prazo, alta se ICP virar self-service em volume | Em aberto |

## 4. Arquitetura alvo — visão geral

Evolução incremental, sem reescrita: cada fase entrega valor isolado e pode ser interrompida
sem deixar o sistema pior do que estava.

### 4.1 Fase 1 — Observabilidade mínima
**Esforço: baixo · Impacto: alto · Status: ✅ em produção**

Criar tabela `account_connection_status` no Postgres, alimentada pelos mesmos eventos que hoje
só viram `console.log` no handler `connection.update` — resolve a perda de estado a cada
restart (AS-IS 5.4) e vira fonte de verdade para o painel. No mesmo handler que já distingue
`loggedOut` de erro reconectável, disparar notificação externa (Telegram bot é o caminho mais
rápido — webhook simples, sem custo, sem infra nova). Prioridade máxima de alerta: `loggedOut`
(exige ação humana imediata). Prioridade secundária: reconexões que ultrapassam N tentativas.

### 4.2 Fase 2 — Fila de envio
**Esforço: médio · Impacto: alto · Status: ✅ em produção**

Decisão de partida: não há Redis provisionado hoje. Em vez de subir Redis + BullMQ de
imediato, começar com fila baseada em Postgres — tabela `outbox` com status
`pending/sent/failed` e um worker fazendo polling. Resolve com zero infraestrutura nova.
Migrar para Redis/BullMQ apenas quando o throughput tornar o polling um gargalo real — não
antes. Junto com a fila, implementar o retry/backoff no envio individual que hoje não existe
(AS-IS 5.3) — reaproveitando o mesmo padrão de backoff exponencial já usado na reconexão de
socket.

### 4.3 Fase 3 — Separação de processo (Gateway WhatsApp)
**Esforço: alto · Impacto: condicional ao volume · Status: ❌ não recomendada (gate cumprido, sem necessidade encontrada)**

Separar a camada de sessão Baileys do servidor HTTP/lógica de negócio em um serviço "Gateway"
dedicado, comunicando-se com o app principal via fila. Roteamento simples de accounts por
worker via tabela no Postgres (`account_id → worker_id`); ao escalar horizontalmente, novas
instâncias do Gateway recebem accounts por hash ou round-robin no provisionamento.

Gatilho para executar esta fase: resultado de um teste de carga real mostrando degradação —
não estimativa. Como o Node lida bem com I/O concorrente, o gargalo tende a aparecer primeiro
em CPU (parsing de mensagem, IA) do que em número de sockets abertos.

### 4.4 Pré-requisito transversal — confirmar antes da Fase 3
**Status: ✅ cumprido em 20/08/2026**

Rodar um teste de carga controlado (accounts simultâneas simuladas) para substituir a
incógnita atual (AS-IS 5.2) por um número real, evitando investir em separação de processo
antes da hora. Resultado detalhado em `docs/teste-de-carga-fase3-gate.md` — CPU do serviço
ficou em ~0,04 vCPU (de um limite de 24) mesmo com 150 conversas simultâneas tocando os nós de
IA do fluxo. Sem evidência de que a Fase 3 resolveria algo hoje.

## 5. Roadmap consolidado

| Fase | Entrega | Depende de | Esforço | Status |
|---|---|---|---|---|
| 1 | Status de conexão persistido + alerta ativo (Telegram) de sessão caída | Nada — pode começar já | Baixo | ✅ Produção |
| 2 | Fila de envio (Postgres outbox) + retry/backoff por mensagem | Fase 1 (reaproveita eventos de status) | Médio | ✅ Produção |
| 3 | Gateway WhatsApp separado do app principal | Teste de carga confirmando necessidade | Alto | ❌ Não recomendada |
| — | Migração Redis/BullMQ (se necessário) | Fila em Postgres virar gargalo real | Médio (adiável) | Sem gatilho |

## 6. Estratégia de ambientes — Dev/Homologação vs. Produção

**Status: ✅ implementado (Fase 0)**

A arquitetura das fases 1–3 acima descreve um único ambiente. Na prática, esse ambiente é
produção — e testar mudanças de fluxo, integração ou infraestrutura diretamente em produção
(com clients reais conectados) não é uma opção sustentável. A proposta abaixo separa isso em
dois ambientes apartados, mantendo um único repositório e o fluxo de deploy automático já
existente.

### 6.1 Modelo: um repositório, dois environments no Railway
Sem duplicar projeto ou repositório: dois environments do Railway (`staging` e `production`),
cada um acionado por um branch — `develop` para staging, `main` para production, preservando o
deploy automático no merge que já existe hoje. Cada environment tem seu próprio Postgres e seu
próprio Railway Volume — isolamento total de dados de teste em relação a dados de cliente
real. Staging usa um número de WhatsApp de teste/sandbox, nunca um número de cliente em
produção nem o número do C3 Pilates (hoje em Z-API). Credenciais de Grok e Google Calendar
podem ser as mesmas chaves, sinalizadas como uso de teste — não há necessidade de contas
separadas nesses dois serviços no curto prazo.

### 6.2 Staging deliberadamente mais simples que produção
O ambiente de staging não replica a Fase 3 (Gateway WhatsApp separado). Com baixo volume de
teste, não há necessidade de separar o processo — isso mantém o ambiente mais barato e mais
simples de depurar. As Fases 1 e 2 (status de conexão e fila outbox) são replicadas em staging
porque são baratas e porque validar essas mudanças antes de produção é exatamente o ponto de
ter um ambiente separado.

Diagrama comparativo dos dois ambientes: `docs/diagrama-ambientes-dev-vs-prod.png` —
componentes cinza são idênticos em ambos; roxo tracejado existe só em produção (Fase 3, hoje
não implementada em nenhum dos dois).

### 6.3 Comparativo por componente

| Componente | Staging | Produção |
|---|---|---|
| Processo da aplicação | Único (HTTP + lógica + Baileys no mesmo processo) | Fases 1–2 no app principal; Fase 3 separaria o Gateway WhatsApp (não implementada) |
| Postgres | Instância própria, dados de teste | Instância própria, dados reais de clientes |
| Railway Volume (`auth_state`) | Próprio, sessão de teste | Próprio, sessões dos clients reais |
| Número de WhatsApp | Número de teste/sandbox dedicado | Números reais dos clients |
| Grok / Google Calendar | Mesma chave, uso sinalizado como teste | Mesma chave, uso de produção |
| Alerta (Telegram) | Canal separado, opcional | Canal de operação, acompanhado pela equipe GLabs |
| `registry.json` / `flows.json` | Mesmo débito técnico do AS-IS, isolado em disco próprio | Mesmo débito técnico do AS-IS — não endereçado por este roadmap |

### 6.4 Particularidades assumidas — a confirmar
- Postgres e Volume totalmente separados por ambiente (não uma única instância com schemas
  diferentes) — mais seguro contra mistura de dados de teste com dados reais, ao custo de mais
  um recurso gerenciado.
- Staging usa um número de WhatsApp dedicado só para teste, distinto de qualquer número de
  cliente em uso.
- Alerta do staging no Telegram é opcional e, se existir, fica em canal separado do canal de
  operação de produção.

## 7. Decisões estratégicas em aberto

Itens que não bloqueiam o roadmap técnico acima, mas precisam de decisão de negócio antes da
comercialização:

- Definição do ICP (perfil de cliente-alvo) — hoje em aberto; influencia se vale priorizar
  self-service em volume ou atendimento de poucos clientes com alto toque.
- Quando/como migrar o C3 Pilates para produção de verdade, e qual número de WhatsApp de teste
  usar (não pode ser o mesmo do Z-API já em uso).
- Migração do modelo de dados: unificar `products`/`accounts`/`flows` (hoje em JSON) para o
  Postgres.
- Verificação pública do app Google OAuth — necessária para ultrapassar o limite de 100
  usuários testadores.
- Validação a fundo do Studio de IA (onboarding por entrevista conversacional) como caminho de
  aquisição de clientes novos.
- Prioridade dos itens de UX pendentes do builder (histórico de versões de fluxo, atalho para
  apagar nó).
- Isolamento de IP por conta/worker (Fase 3, hoje não necessária): separar processo em workers
  não isola rede automaticamente — todas as réplicas de um mesmo serviço no Railway saem pelos
  mesmos IPs. IP dedicado por conta exigiria um serviço de proxy adicional (custo e
  complexidade extra); avaliar só se o risco de ban em escala justificar.

## 8. Débito técnico deliberado (registrado em 20/08/2026)

Dois canais de alerta da Fase 1 foram construídos com a lógica de destinatário pronta, mas sem
provedor/credencial configurados ainda — decisão explícita do usuário, não pendência esquecida:

- **Telegram**: falta criar o bot (`@BotFather`) e configurar `TELEGRAM_BOT_TOKEN`/
  `TELEGRAM_CHAT_ID`.
- **E-mail**: falta escolher provedor (Resend/SMTP/outro) e trocar o `console.log` placeholder
  em `sendEmailAlert()` (`src/notify.ts`) por uma chamada HTTP de verdade. Resolução de
  destinatário já funciona (produção → e-mail do onboarding do client; dev/staging →
  `zabadal@gmail.com`).

---
*Este documento parte do diagnóstico técnico registrado em `docs/arquitetura-as-is.md`
(17/08/2026) e do brainstorm de arquitetura realizado na mesma data.*
