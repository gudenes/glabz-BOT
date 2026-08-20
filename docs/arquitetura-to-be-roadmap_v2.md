# Glabz-bot — Arquitetura TO BE e Roadmap (v2)

Documento complementar ao AS-IS · v1 em 17/08/2026 · **v2 em 20/08/2026** · repositório
`gudenes/glabz-BOT`

> Substitui `arquitetura-to-be-roadmap.md` (v1) como referência vigente, conforme convenção em
> `docs/README.md`. O v1 é preservado no histórico do repositório — não editado in-loco.
>
> **O que mudou da v1 pra v2:** a Fase 3 estava tratando "separar processo" como uma coisa só,
> misturando duas justificativas diferentes (performance vs. isolamento de falha) sob um único
> gatilho (teste de carga). Esta versão separa isso, registra um guard de mitigação já
> implementado, e adiciona uma nova Fase 4 (estudo futuro, não decidida) sobre IP dedicado por
> cliente.

## 1. Sumário executivo

*(sem mudança da v1 — ver contexto completo em `arquitetura-to-be-roadmap.md`)*

O AS-IS mostra uma base tecnicamente mais sólida do que o esperado. Direção estratégica:
manter Baileys, industrializar a infraestrutura de sessão de forma incremental. Ver seção 8
desta v2 pra status consolidado de tudo que já foi executado.

## 2. Benchmark de mercado

*(sem mudança da v1 — Baileys vs. Z-API vs. WhatsApp Cloud API, ver documento original)*

## 3. Diagnóstico de riscos priorizados (atualizado)

| Risco | Causa raiz | Severidade | Status (20/08) |
|---|---|---|---|
| Ninguém sabe quando uma sessão cai | Sem notificação ativa (AS-IS 5.5) | Alta | ✅ Resolvido — Fase 1 |
| Mensagem falha silenciosamente | Sem fila/retry (AS-IS 5.3) | Alta | ✅ Resolvido — Fase 2 |
| Estado de conexão se perde a cada restart | Status só em memória (AS-IS 5.4) | Média | ✅ Resolvido — Fase 1 |
| Capacidade desconhecida (CPU/performance) | Sem teste de carga (AS-IS 5.2) | Média | ✅ Resolvido — gate cumprido, sem necessidade de ação |
| **Erro de UM cliente derruba as contas de TODOS os clientes juntas** | Processo único: todas as sessões WhatsApp no mesmo processo, sem guard de erro fatal | **Alta** — cresce linearmente com o nº de clientes ativos | ✅ Mitigado (parcial) — guard global de erro |
| Onboarding trava em 100 usuários | App Google OAuth em modo Teste (AS-IS 4.4) | Baixa no curto prazo | Em aberto |
| Contaminação de reputação de IP entre clientes | Todos os clientes saem pelo mesmo IP de egress do Railway | A avaliar (ver Fase 4) | Não iniciado — estudo futuro |

**Nota importante sobre a linha em negrito:** esse risco **não é o mesmo** que "capacidade
desconhecida". Um é sobre volume/CPU (resolvido por teste de carga); o outro é sobre **quantos
clientes ficam fora do ar ao mesmo tempo quando algo dá errado** — é uma pergunta de
confiabilidade, não de performance, e por isso não devia ter ficado atrás do mesmo gatilho
("esperar teste de carga mostrar degradação"). Essa separação é a principal correção desta v2.

## 4. Arquitetura alvo — visão geral

Fases 1 e 2: sem mudança da v1 (ambas ✅ em produção — status de conexão persistido + alerta,
fila de reenvio). Ver documento original ou seção 8 desta v2 pro resumo consolidado.

### 4.3 Fase 3 — dividida em duas partes com gatilhos independentes

A v1 tratava "separar o Gateway" como uma decisão só, gatilhada por teste de carga. Na
prática, existem dois níveis de isolamento diferentes, com custo e gatilho próprios:

#### Fase 3a — Guard de erro fatal (mitigação barata, sem separar processo)
**Esforço: baixo · Status: ✅ implementado, em produção**

Um `process.on('uncaughtException'/'unhandledRejection')` global: loga + alerta (Telegram),
mas não derruba o processo pra um erro isolado — cada conta WhatsApp vive no seu próprio
`LiveSession` (`src/session.ts`), sem estado global compartilhado além do `Map` de lookup, então
na maioria dos casos um bug disparado pela mensagem de UM cliente não afeta as contas dos
outros. Só derruba o processo de propósito (deixando o Railway reiniciar limpo) se os erros
vierem em rajada (5+ em 60s) — sinal de corrupção real, não caso isolado.

**O que isso resolve:** boa parte do cenário "erro não tratado de um cliente derruba todo
mundo", sem nenhum dos custos da separação de processo abaixo.
**O que isso não resolve:** um travamento de verdade do processo Node (ex.: erro fatal dentro
do próprio binário do Baileys, estouro de memória) ainda derruba tudo — só reduz a superfície,
não elimina.

#### Fase 3b — Separar o Gateway WhatsApp do app principal (isolamento entre camadas)
**Esforço: médio-alto · Status: não iniciado, sem gatilho definido**

Separar a camada de sessão Baileys do servidor HTTP/lógica de negócio em um serviço "Gateway"
dedicado, comunicando-se com o app principal via fila. Isola dois domínios de falha diferentes
um do outro: um crash no app principal (bug de lógica de fluxo) não derruba mais o WhatsApp, e
vice-versa.

**Importante — o que isso NÃO dá de graça:** com uma única instância do Gateway, todas as
contas de todos os clientes continuam no mesmo processo *dentro* do Gateway — um erro que
escape do guard da Fase 3a ainda derruba todas as contas juntas, só que isolado da metade HTTP
do sistema. Não é o cenário "um worker cai, os outros seguem".

#### Fase 3c — Sharding real (múltiplos workers, contas particionadas)
**Esforço: alto · Status: não iniciado, sem gatilho definido — avaliar só se o nº de clientes justificar**

Esse é o passo que de fato entrega "se um worker cair, as contas dos outros workers
continuam". Envolve, além da Fase 3b:

- **Rodar múltiplas réplicas do Gateway simultaneamente** (Railway: `numReplicas` > 1) — custo
  proporcional ao número de réplicas, mesmo que cada uma fique ociosa a maior parte do tempo
  (o teste de carga mostrou uso de CPU/memória hoje muito abaixo do limite com processo único —
  ver `docs/teste-de-carga-fase3-gate.md`).
- **Tabela de sharding** (`account_id → worker_id`) — cada réplica só reconecta as contas
  atribuídas a ela; hoje `restoreSessionsFromDisk()` reconecta tudo, sem esse conceito.
- **Risco técnico real se malfeito:** duas réplicas tentando conectar a mesma conta ao mesmo
  tempo é exatamente o cenário de "sessão duplicada" já registrado como risco de ban no AS-IS —
  essa lógica precisa estar certa, não é só "mais um componente".
- **Armazenamento compartilhado ou particionado** entre réplicas pro `auth_state`, e lógica de
  rebalanceamento quando o número de réplicas muda.
- **Roteamento worker-aware** na API/painel (saber pra qual worker mandar "conectar essa
  conta").

**Gatilho:** não é teste de carga (isso já foi respondido — ver `docs/teste-de-carga-fase3-gate.md`,
CPU do processo único folgadíssima). É uma decisão de **quantos clientes reais** o produto tem
e o quanto "um cliente com problema pode derrubar os outros por algumas dezenas de segundos até
o restart automático" pesa como risco de negócio. Com poucos clientes, a Fase 3a já cobre a
maior parte do risco a um custo bem menor.

### 4.4 Fase 4 (nova) — IP dedicado por cliente
**Esforço: a estimar · Status: estudo futuro, não decidida, não iniciada**

Levantada em discussão com o usuário em 20/08/2026: hoje todas as contas WhatsApp de todos os
clientes saem pelo mesmo IP de egress compartilhado do Railway — isso vale mesmo se a Fase 3b/3c
forem implementadas (separar processo não isola rede automaticamente no Railway; todas as
réplicas de um serviço saem pelos mesmos IPs).

**O que envolveria, se decidido no futuro:**
- Um serviço de proxy terceiro (IP dedicado por conta) — custo recorrente por IP.
- Configuração de proxy no Baileys/`ws` na criação do socket (`bootSocket`, `session.ts`) —
  não existe hoje.
- Mapeamento conta → IP, mantido **estável** (trocar IP com frequência é, por si só, sinal
  suspeito pro WhatsApp).

**Risco que mitigaria:** "contaminação de reputação" — se um número de um cliente tiver
comportamento ruim e o WhatsApp associar isso ao IP de origem, outros clientes saindo pelo
mesmo IP podem ser afetados por tabela, mesmo sem culpa própria.

**O que NÃO garante:** não é bala de prata — o WhatsApp usa vários outros sinais de detecção
de abuso além de IP (padrão de envio, taxa de denúncia, idade da conta). Um proxy de baixa
qualidade (faixa de IP já catalogada como datacenter/proxy) pode inclusive **piorar** o risco em
vez de reduzir — proxy residencial/IP móvel de verdade custa significativamente mais que
datacenter genérico.

**Por que fica como Fase 4 (estudo, não execução):** não bloqueia nada do roadmap técnico
atual, e o custo/complexidade só se justifica com volume real de clientes — decisão de negócio,
não técnica, avaliar quando o ICP e a escala estiverem mais definidos (ver seção 7).

## 5. Roadmap consolidado (atualizado)

| Fase | Entrega | Depende de | Esforço | Status |
|---|---|---|---|---|
| 1 | Status de conexão persistido + alerta ativo | Nada | Baixo | ✅ Produção |
| 2 | Fila de envio (outbox) + retry/backoff | Fase 1 | Médio | ✅ Produção |
| 3a | Guard global de erro fatal | Nada | Baixo | ✅ Produção |
| 3b | Gateway WhatsApp separado do app principal | Decisão de negócio (não teste de carga) | Médio-alto | Não iniciado |
| 3c | Sharding de contas entre múltiplos workers | 3b + volume de clientes que justifique | Alto | Não iniciado |
| 4 | IP dedicado por cliente (proxy) | Decisão de negócio, ICP definido | A estimar | Estudo futuro |
| — | Migração Redis/BullMQ | Fila em Postgres virar gargalo real (não observado) | Médio (adiável) | Sem gatilho |

## 6. Estratégia de ambientes

*(sem mudança da v1 — ✅ implementado: environments `staging`/`production` no Railway,
branches `develop`/`main`. Ver documento original pra detalhamento completo.)*

## 7. Decisões estratégicas em aberto (atualizado)

- Definição do ICP — influencia diretamente se as Fases 3c e 4 chegam a fazer sentido algum
  dia.
- Quando/como migrar o C3 Pilates para produção de verdade.
- Migração do modelo de dados (`products`/`accounts`/`flows` de JSON pra Postgres).
- Verificação pública do app Google OAuth (limite de 100 usuários).
- Validação do Studio de IA.
- Prioridade dos itens de UX pendentes do builder.
- **Nova:** avaliar Fase 4 (IP dedicado) quando o ICP/volume de clientes estiver mais claro —
  não é urgente, mas vale não esquecer.

## 8. Status consolidado de execução (20/08/2026)

- ✅ Fase 0 — ambientes `staging`/`production` separados.
- ✅ Fase 1 — status de conexão persistido + alerta (Telegram configurado como no-op até
  credenciais; stub de e-mail com lógica de destinatário pronta, provedor pendente — débito
  técnico deliberado).
- ✅ Fase 2 — fila de reenvio (outbox) com retry/backoff.
- ✅ Fase 3a — guard global de erro fatal.
- ✅ Gate de teste de carga cumprido — Fase 3b/3c não recomendadas no volume atual.
- 🔲 Fase 4 — estudo futuro, não iniciada.

---
*Este documento parte do diagnóstico técnico em `docs/arquitetura-as-is.md` e da v1
(`docs/arquitetura-to-be-roadmap.md`, preservada como histórico). Ver
`docs/teste-de-carga-fase3-gate.md` pro resultado que decidiu não avançar a Fase 3b/3c por
performance.*
