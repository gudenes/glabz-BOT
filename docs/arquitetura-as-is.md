# Glabz-bot — Arquitetura AS-IS

Documento de referência técnica · Atualizado em 17/08/2026 · repositório `gudenes/glabz-BOT`

> Reconstituído em 20/08/2026 a partir do original (Google Docs, pasta `tmp/Glabz` no Drive)
> — seções 1–5.1 extraídas do texto original; seções 5.2–7 reconstruídas a partir do
> levantamento técnico verificado nesta mesma sessão (respostas às 13 perguntas sobre a
> arquitetura Baileys, com citação de arquivo:linha em cada uma).

## 1. Sumário executivo

O Glabz-bot é um SaaS multi-tenant de atendimento via WhatsApp: cada cliente conecta seu
próprio número, desenha o fluxo de conversa num builder visual sem código e pode integrar
automações reais (hoje, Google Calendar). O caso-piloto que guia o desenvolvimento é o
C3 Pilates.

Este documento descreve o estado atual (AS IS) da arquitetura técnica, com foco especial na
camada de sessão WhatsApp (Baileys), levantada diretamente no código-fonte em 17/08/2026. Não
contém recomendações — o diagnóstico e o plano de evolução estão no documento complementar
"Glabz-bot — Arquitetura TO BE e Roadmap" (`docs/arquitetura-to-be-roadmap.md`).

## 2. Propósito e proposta de valor

Permitir que uma empresa ofereça atendimento automatizado via WhatsApp sem escrever código:
conecta o número, desenha o fluxo visualmente e, opcionalmente, conecta integrações reais
(ex.: agendamento direto no Google Calendar). O objetivo é validar um fluxo completo — cliente
manda mensagem, o bot entende o pedido, agenda horário de verdade — a fundo com o C3 Pilates
antes de virar produto padrão oferecido a outros clientes.

## 3. Conceitos de domínio

- **client**: o cliente de verdade da GLabs (empresa). Tem login próprio, dados de faturamento
  e perfil de negócio. Vive no Postgres.
- **account**: um número de WhatsApp conectado (sessão via Baileys, conexão por QR code). Um
  client normalmente tem 1 account.
- **flow**: a automação desenhada no builder visual (`/admin/flows.html`) — árvore de nós:
  `trigger`, `message`, `ask`, `llm_intent`, `llm_extract`, `condition`, `action`, `handoff`,
  `end`.
- **product**: conceito mais antigo, namespace solto (ex.: "gestor", "prontuario"). Ainda vive
  em JSON em disco, não migrado para Postgres.

## 4. Arquitetura técnica geral

### 4.1 Stack e deploy
- Node.js + TypeScript, um único serviço HTTP (sem framework), servido via Railway.
- Deploy automático: qualquer merge na branch `main` dispara build + deploy no Railway. Não
  existe gate de aprovação separado nem CI formal (sem GitHub Actions) — o merge na main já é
  o deploy para produção.
- Fluxo de trabalho: branch por funcionalidade/correção → PR no GitHub → merge manual após
  teste local → deploy automático.
- Verificação pré-deploy: manual — `npx tsc --noEmit` (typecheck) + scripts ad-hoc + Chrome
  headless (Puppeteer) simulando o navegador. Sem suíte de testes automatizados.

### 4.2 Dados

| Armazenamento | Conteúdo | Observação |
|---|---|---|
| Postgres (Railway) | `clients`, `users`/`sessions` (login), `wa_messages` (histórico), `google_calendar_links` (tokens OAuth cifrados) | Modelo de dados "novo" |
| Arquivo JSON em disco (`registry.json`, `flows.json`) | `products`, `accounts`, `flows` | Modelo "antigo", ainda não migrado — dois modelos convivem em paralelo |

### 4.3 IA
Usada em dois pontos do builder: classificação de intenção (`llm_intent`) e extração de data
livre em texto (`llm_extract` — ex.: "segunda-feira", "amanhã", "dia 17"). Provedor: xAI/Grok,
com fallback determinístico (regras/palavras-chave) quando não há chave de API configurada.

### 4.4 Integração Google Calendar
Nativa via OAuth por cliente — não é mock nem webhook genérico. O cliente conecta o Google
Calendar dele pelo próprio portal; o bot lista horários livres reais (via freebusy) e
cria/cancela eventos direto na API do Google. Token cifrado em repouso (AES-256-GCM).

Restrição atual: app OAuth ainda em modo "Teste" no Google Cloud Console — funciona, mas
limitado a 100 usuários cadastrados manualmente. Sair disso exige verificação pública do
Google, ainda não feita.

### 4.5 Portal do cliente
Self-service, com seções: WhatsApp / Fluxo / Conversas / Testar / Publicações / Dashboards /
Dados da conta / Integrações. Admin da GLabs pode "impersonar" (visualizar como) qualquer
client para dar suporte, sem precisar da senha dele.

## 5. Infraestrutura de sessão WhatsApp (Baileys)

Levantamento feito diretamente no código-fonte em 17/08/2026 (`src/session.ts`,
`src/config.ts`, `railway.json`, `README.md`, `package.json`).

### 5.1 Persistência de sessão
- Biblioteca: Baileys, engenharia reversa do protocolo WhatsApp Web, conexão inicial por QR
  code.
- Estado de autenticação salvo via `useMultiFileAuthState(dir)` do Baileys — múltiplos
  arquivos JSON (`creds.json`, `app-state-sync-*.json`, `pre-key-*.json` etc.), não um único
  arquivo.
- Caminho: `AUTH_DIR/auth_state/<accountId>/` (`src/session.ts:107`, `accountAuthPath`;
  `src/config.ts:22`).
- Persistência real via Railway Volume: variável `AUTH_DIR=/data` coincide com
  `RAILWAY_VOLUME_MOUNT_PATH=/data` nas variáveis de ambiente do serviço.
- Confirmado empiricamente: em múltiplos redeploys, o boot restaurou as sessões do disco e
  reconectou sozinho — não é filesystem efêmero.
- A sessão só se perde se: (a) o volume for apagado/recriado, ou (b) o WhatsApp deslogar do
  lado do celular (`loggedOut`) — nesse caso o código apaga o diretório de auth e força novo QR
  (`src/session.ts:281-289`, offsets originais; ver `bootSocket`/`connection.update`).

### 5.2 Modelo de processo
- **Mesmo processo**: não existe processo/worker separado para a sessão WhatsApp — um único
  `createServer` do `node:http` (`src/index.ts`) roda junto com toda a lógica Baileys, no mesmo
  comando de start (`npx tsx src/index.ts`, `railway.json`).
- **Tudo dentro do mesmo processo Node**: cada account vira um objeto em memória
  (`Map<accountId, LiveSession>`, `src/session.ts`) com seu próprio socket Baileys —
  multiplexado via event loop assíncrono, não paralelismo real de CPU.
- **Nenhum teste de carga documentado** até a data do levantamento original — nem no código,
  comentários ou README havia registro de quantas accounts simultâneas o serviço aguenta. (Ver
  `docs/teste-de-carga-fase3-gate.md` para o teste feito depois, em 20/08/2026.)

### 5.3 Fila / envio de mensagens
- Envio **síncrono, chamada direta**: `sendText()` era `await`ado direto tanto no handler HTTP
  quanto no fluxo automático (`handleInbound` → `sendText`). Sem fila no meio.
- **Sem Redis no projeto Railway** — só `glabs-bot` (app) e `Postgres` como serviços. Nenhuma
  lib de fila (`ioredis`, `bull`, `bullmq`) nas dependências.
- **Sem retry/backoff no envio de mensagem em si.** Se `sock.sendMessage()` falhasse,
  `sendText()` só capturava o erro e devolvia `{ok:false, reason}` — quem chamava decidia o que
  fazer (no fluxo automático, só logava um warning e seguia). O retry/backoff que existia era
  só pra reconexão do socket (ver 5.4), não pro envio de mensagem individual.
  (Resolvido na Fase 2 do roadmap — ver `docs/arquitetura-to-be-roadmap.md`.)

### 5.4 Reconexão / detecção de queda
- **Reconecta sozinho**, com backoff exponencial: `delay = min(30s, 1s × 2^tentativa)`,
  sem limite de tentativas (continua tentando indefinidamente enquanto não for `loggedOut`).
- **Diferencia queda recuperável de exigir novo QR**: no handler `connection.update`, se o
  código de erro for `DisconnectReason.loggedOut` → não tenta reconectar, apaga a auth e exige
  novo QR. Qualquer outro código (ex.: `408`, "conexão instável") → reconecta sozinho com
  backoff.
- **Status só em memória, só enquanto o processo está de pé.** Não existia tabela no Postgres
  pra status de conexão — era um `Map` em memória. Todo restart mostrava tudo como
  "disconnected" por alguns segundos até `restoreSessionsFromDisk()` reconectar cada uma.
  (Resolvido na Fase 1 do roadmap — tabela `account_connection_status`.)

### 5.5 Notificação
- **Só o painel + logs — sem alerta ativo.** Quando uma sessão caía, o código só fazia
  `console.log`/`console.error` (visível nos logs do Railway) e atualizava o `lastError`
  exposto no admin/portal se alguém abrisse a tela. Não existia nenhuma chamada de
  webhook/e-mail/Slack disparada em queda de conexão — se ninguém estivesse olhando o painel,
  ninguém ficava sabendo que uma sessão caiu.
  (Resolvido na Fase 1 do roadmap — alerta Telegram + stub de e-mail.)

## 6. Estado dos ambientes (17/08/2026, antes da Fase 0)

Um único ambiente Railway (produção), sem separação dev/staging — testar mudança de fluxo,
integração ou infraestrutura acontecia direto em produção, com clients reais conectados.
(Resolvido na Fase 0 do roadmap — ambiente `staging` separado, branch `develop`.)

## 7. Débitos técnicos registrados nesta data

- Modelo de dados dividido entre Postgres (`clients`/`users`) e JSON em disco
  (`products`/`accounts`/`flows`) — convivem em paralelo, sem migração planejada.
- App OAuth do Google em modo "Teste" (limite de 100 usuários).
- Studio de IA (onboarding por entrevista conversacional) construído mas não validado a fundo.
- Itens de UX do builder pendentes (histórico de versões de fluxo, atalho de teclado pra
  apagar nó).
- Isolamento de IP por conta/worker: separar processo em workers não isola rede
  automaticamente — todas as réplicas de um mesmo serviço no Railway saem pelos mesmos IPs.

---
*Este documento descreve o estado técnico em 17/08/2026. Para o diagnóstico de riscos, o
roadmap de evolução em fases e as decisões estratégicas em aberto, ver
`docs/arquitetura-to-be-roadmap.md`. Para o resultado do teste de carga que serviu de gate
pra Fase 3, ver `docs/teste-de-carga-fase3-gate.md`.*
