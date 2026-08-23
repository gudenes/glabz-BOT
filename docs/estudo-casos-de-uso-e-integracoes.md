# Estudo: casos de uso reais, catálogo de templates e mapa de integrações

Documento de estudo · 23/08/2026 · repositório `gudenes/glabz-BOT`

## 1. Contexto e método

Hoje o produto oferece **2 templates de demo** e **2 connectors**. Isso é insuficiente pra
sustentar onboarding self-service de segmentos variados: um dentista, um advogado e uma
farmácia têm jornadas bem diferentes, e hoje todos cairiam num demo de pilates ou de consulta
genérica.

**O que este documento é:** um levantamento pra decisão — quais casos de uso reais o produto
precisa atender, que catálogo de templates isso implica, e quais integrações faltam.

**O que este documento não é:** especificação de implementação. Nenhum código foi escrito nesta
etapa (decisão explícita: estudo primeiro, decisão depois).

**Método:** capacidades atuais levantadas diretamente no código-fonte (cada afirmação técnica
abaixo tem arquivo:linha); cenários construídos a partir de jornadas típicas de atendimento por
WhatsApp nos segmentos escolhidos.

## 2. Panorama do que existe hoje

### 2.1 Tipos de nó (9) — `src/flows/types.ts:9-18`
`trigger` · `message` · `ask` · `condition` · `llm_intent` · `llm_extract` · `action` ·
`handoff` · `end`

### 2.2 Connectors (2) — `src/flows/connectors/`
| Connector | Operações | Modos de execução |
|---|---|---|
| `calendar` | `list_slots`, `create_event`, `cancel_event` | **mock** (default), **webhook** genérico, **Google Calendar nativo** (OAuth por cliente) |
| `http` | — (ignora `operation`) | POST JSON pra uma URL; devolve as chaves da resposta como variáveis |

### 2.3 Correção importante: Google Calendar **não** está faltando
A integração nativa com Google Calendar **existe, funciona e está em produção** (OAuth por
cliente, `src/google-oauth.ts` + `src/flows/connectors/google-calendar-provider.ts`, lista
horários livres via freebusy e cria/cancela eventos reais).

O que dá a impressão de que falta: os **dois demos atuais têm `forceMock: true` hardcoded**
(`src/flows/templates.ts:264-275` e `:287-298`), então quem abre um demo vê sempre horários
fictícios. É um problema de **curadoria do template**, não de capacidade da plataforma —
e é a primeira coisa que o catálogo novo precisa corrigir.

### 2.4 IA — hoje é mais limitada do que parece
São só **duas capacidades fechadas** (`src/flows/llm.ts`):
- `classifyIntent` — classifica a fala do cliente numa lista **pré-definida** de intenções.
- `extractDate` — extrai uma data livre do texto e normaliza.

**Não existe** um nó de IA que responda livremente (FAQ inteligente, triagem aberta,
resumo). Isso limita bastante os cenários abaixo — vários precisariam disso.

### 2.5 Geração de fluxo por IA nasce incapaz de integrar
O prompt do gerador (`src/flows/from-prompt.ts:26`) diz literalmente **"NÃO use condition nem
action"**, e limita a 10 nós / 3 intenções. Ou seja: todo fluxo gerado pelo Studio de IA é
necessariamente simples e **sem nenhuma integração externa** — vira sempre uma árvore de
mensagens terminando em handoff.

## 3. Oito cenários reais

### 3.1 Estúdio de pilates / academia *(caso-piloto real — C3 Pilates)*
**Jornada:** "quero marcar uma aula" · "tem horário quinta de manhã?" · "preciso remarcar" ·
"quanto custa o plano mensal?"
**O bot precisa:** entender preferência de dia/horário em linguagem livre → consultar agenda
real → oferecer horários → confirmar → agendar → lembrar antes da aula.
**Integrações:** Google Calendar ✅ (existe) · lembrete automático ❌ · plano/pagamento
recorrente ❌
**Hoje:** o núcleo funciona de verdade. Falta lembrete e cobrança.

### 3.2 Odontologia / clínica
**Jornada:** "aceita meu convênio?" · "quanto custa clareamento?" · "quero marcar avaliação" ·
"preciso remarcar minha consulta de terça"
**O bot precisa:** responder cobertura de convênio e faixa de preço (informação que muda e vive
numa planilha), agendar, e **encaminhar caso clínico** pro profissional certo.
**Integrações:** Calendar ✅ · consulta a tabela (convênios/preços) ❌ Sheets · confirmação por
e-mail ❌ · lembrete ❌
**Hoje:** agendamento sim; a parte de "consultar tabela" viraria texto fixo que desatualiza.

### 3.3 Advocacia
**Jornada:** "fui demitido, tenho direito a quê?" · "vocês pegam caso trabalhista?" ·
"quanto custa uma consulta?" · manda um **áudio longo** contando o caso
**O bot precisa:** triar a área do direito, qualificar se é um caso que o escritório aceita,
coletar um resumo do problema e agendar consulta. Muita gente manda áudio.
**Integrações:** transcrição de áudio ❌ · IA livre pra triagem ❌ · Calendar ✅ · registro do
lead ❌ (Sheets/CRM) · envio de contrato/procuração ❌ (assinatura eletrônica)
**Hoje:** o mais mal atendido dos oito — depende de IA livre + áudio, que não existem.

### 3.4 Farmácia
**Jornada:** "tem dipirona 500?" · "quanto custa?" · "vocês entregam no bairro X?" ·
"quero comprar, como pago?"
**O bot precisa:** consultar preço/estoque, calcular entrega, fechar pedido e **cobrar**.
**Integrações:** catálogo/estoque ❌ (Sheets ou ERP) · pagamento/Pix ❌ · notificação interna
pro balconista ⚠️ (parcial)
**Hoje:** praticamente nada do núcleo — é o cenário que mais depende de integração nova.

### 3.5 Salão de beleza / barbearia
**Jornada:** "corte com a Ana amanhã?" · "quanto tá a escova?" · "quero remarcar"
**O bot precisa:** agendar **por profissional específico** e por serviço (duração varia:
corte 30min, coloração 3h).
**Integrações:** Calendar ⚠️ — existe, mas hoje o connector assume **um único calendário por
cliente** (`getCalendarIdFor`) e **duração fixa** (`durationMin`); múltiplos profissionais e
duração por serviço exigiriam extensão.
**Hoje:** funciona pra salão de 1 profissional; quebra num com equipe.

### 3.6 Restaurante / delivery
**Jornada:** "manda o cardápio" · "quero 2 marmitas" · "quanto tá a taxa pro Centro?" ·
"cadê meu pedido?"
**O bot precisa:** mostrar cardápio, montar pedido (lista de itens!), calcular total, cobrar e
informar status.
**Integrações:** catálogo ❌ · pagamento ❌ · status do pedido ❌
**Limitação estrutural:** montar um carrinho exige **acumular uma lista** ao longo da conversa —
o engine hoje só tem variáveis simples (string→string), sem repetição/loop. Esse cenário é o que
mais foge da arquitetura atual.

### 3.7 Imobiliária
**Jornada:** "tem apê de 2 quartos até 300 mil?" · "quero ver esse imóvel" · "aceita
financiamento?"
**O bot precisa:** buscar imóveis por critério, mandar fotos/ficha, agendar visita com corretor,
registrar o lead.
**Integrações:** busca no catálogo ❌ · envio de mídia ⚠️ (a plataforma envia imagem, mas não há
connector que traga a ficha) · Calendar ✅ · CRM ❌
**Hoje:** só a visita agendada; a busca (o coração do caso) falta.

### 3.8 Pet shop / veterinária
**Jornada:** "banho e tosa pro meu golden sábado?" · "quanto custa pra porte grande?" ·
"preciso marcar consulta, ele tá vomitando"
**O bot precisa:** diferenciar serviço (banho vs. consulta urgente), preço por porte, agendar, e
**escalar urgência** pra humano na hora.
**Integrações:** Calendar ✅ · tabela de preço por porte ❌ · triagem de urgência ⚠️ (dá pra fazer
com `llm_intent` de forma limitada)
**Hoje:** parcialmente atendido — é dos mais viáveis depois do pilates.

## 4. Padrões recorrentes

Sete padrões aparecem repetidamente nos oito cenários. É daqui que sai a justificativa dos
templates e das integrações — não de escolha arbitrária:

| Padrão | Aparece em | Suporte hoje |
|---|---|---|
| **Agendar** (consultar disponibilidade real → confirmar) | 6 de 8 | ✅ completo |
| **Qualificar lead** (coletar dados → registrar → escalar) | 8 de 8 | ⚠️ coleta sim, registro não |
| **Consultar informação que muda** (preço, estoque, convênio) | 6 de 8 | ❌ |
| **Confirmar / lembrar** (e-mail, mensagem antes do compromisso) | 6 de 8 | ❌ |
| **Cobrar** (link de pagamento, Pix) | 3 de 8 | ❌ |
| **Escalar pra humano** com contexto | 8 de 8 | ✅ (`handoff`) |
| **Responder pergunta aberta** (FAQ real, não menu) | 8 de 8 | ❌ (só classificação fechada) |

**Leitura:** os dois padrões mais universais que **não** têm suporte são "consultar informação
que muda" e "responder pergunta aberta". São eles que separam um bot que parece uma URA de um
que parece atendimento.

## 5. Catálogo proposto — 10 templates

Legenda de viabilidade: ✅ dá pra fazer hoje · ⚠️ dá com mock/limitação · ❌ exige connector novo

### Simples (4-8 nós, sem integração obrigatória)

| # | Template | Segmento-alvo | O que faz | Viabilidade |
|---|---|---|---|---|
| S1 | **Recado + horário de funcionamento** | qualquer | Responde horário, endereço e formas de contato; fora do horário avisa quando volta | ✅ |
| S2 | **Captura de lead** | advocacia, imobiliária, serviços | Coleta nome, contato e o que precisa → entrega pro humano com resumo | ✅ |
| S3 | **Menu de serviços + preço** | salão, pet shop, clínica | Menu por intenção, responde faixa de preço, encaminha o que foge do script | ✅ |
| S4 | **Pré-agendamento (sem integração)** | qualquer | Entende preferência de dia/período e passa pro humano confirmar | ✅ (usa `llm_extract`) |
| S5 | **Triagem de urgência** | pet shop, clínica, odonto | Separa urgente de rotina; urgente vai direto pro humano, rotina segue no bot | ✅ |

### Complexos (12-20 nós, integração real + tratamento de erro)

| # | Template | Segmento-alvo | O que faz | Viabilidade |
|---|---|---|---|---|
| C1 | **Agendamento completo (Google Calendar real)** | pilates, clínica, pet shop | Preferência → data → horários **reais** → confirma → cria evento; trata "sem horário" e data ambígua | ✅ *(é o demo atual, mas com `forceMock: false`)* |
| C2 | **Agendamento + confirmação por e-mail** | clínica, odonto | C1 + envia confirmação por e-mail pro cliente final | ❌ e-mail |
| C3 | **Consulta de catálogo/preço + pedido** | farmácia, restaurante | Consulta tabela viva (produto/preço/estoque) → monta pedido → escala | ❌ Sheets |
| C4 | **Triagem inteligente + agendamento** | advocacia, clínica | IA livre entende o caso em texto **ou áudio** → qualifica → agenda ou descarta educadamente | ❌ IA livre + áudio |
| C5 | **Pedido com pagamento** | farmácia, restaurante, serviços | Escolhe item → total → gera link/Pix → confirma pagamento → libera | ❌ pagamento (+ Sheets) |

**Observação honesta sobre o catálogo:** hoje **6 dos 10** são implementáveis de imediato (os 5
simples + C1). Os outros 4 dependem de integração nova — e é exatamente por isso que a matriz
abaixo importa.

## 6. Matriz de integrações priorizada

| Prioridade | Integração | Destrava | Esforço | Exige do usuário |
|---|---|---|---|---|
| **1** | **E-mail** | C2 · confirmação/lembrete em 6 dos 8 cenários | Baixo | Conta num provedor (Resend/SMTP) |
| **2** | **Nó de IA livre** | C4 · "responder pergunta aberta" (8 de 8 cenários) | Baixo-médio | Nada — a chave de LLM já existe |
| **3** | **Google Sheets** | C3 · "consultar informação que muda" (6 de 8) | Médio | Só autorizar (reusa o OAuth Google existente) |
| **4** | **Transcrição de áudio** | C4 · advocacia e qualquer público que manda áudio | Médio | Conta de API de transcrição |
| **5** | **Pagamento (Pix/link)** | C5 · farmácia, restaurante, serviços | Médio-alto | Conta no gateway (Mercado Pago/Asaas) + dados fiscais |
| 6 | Lembrete agendado (disparo ativo) | Lembrete pré-consulta em 6 de 8 | Médio | Nada (infra própria) |
| 7 | CRM (RD/HubSpot/Pipedrive) | Registro de lead qualificado | Médio | Conta + API key |
| 8 | Assinatura eletrônica | Advocacia, imobiliária | Médio | Conta no provedor |

**Dois atalhos que valem destacar:**
- **E-mail** já é um débito técnico aberto: `sendEmailAlert` (`src/notify.ts`) tem a resolução de
  destinatário pronta e testada, faltando só escolher o provedor. Resolver isso entrega **duas
  coisas de uma vez** (alerta operacional interno + confirmação pro cliente final).
- **Google Sheets** reaproveita todo o fluxo de OAuth já construído pro Calendar
  (`src/google-oauth.ts`) — muda o escopo e a API chamada, não a arquitetura de autenticação.

**Por que "IA livre" está tão alto:** é a única da lista que aparece nos 8 cenários, custa pouco
(a integração com LLM já existe e é usada por `classifyIntent`/`extractDate`) e é o que mais
muda a percepção de qualidade — sem ela, todo fluxo vira menu de URA.

## 7. Lacunas técnicas que os cenários revelam

Problemas reais no código que hoje passam despercebidos porque só existem 2 demos simples, mas
que atrapalham assim que o catálogo crescer:

1. **Colisão de variáveis** — `Object.assign(vars, result.vars)` (`src/flows/engine.ts:281-283`)
   é global, sem namespace por nó. Dois `action` do mesmo tipo no mesmo fluxo sobrescrevem um ao
   outro (dois `list_slots` colidem em `slots_json`). Vira problema real em C3/C5.
2. **Seeds sobrescrevem edições a cada boot** — `ensureSeedTemplates`
   (`src/flows/store.ts:38-41`) reescreve `nodes`/`edges` de qualquer fluxo cujo **nome** bata com
   um seed. Se o cliente editar um demo, perde no próximo deploy. **Precisa resolver antes** de
   publicar um catálogo maior.
3. **Dispatcher hardcoded** — `runAction` (`src/flows/connectors/index.ts:25-47`) é if/else. Vale
   virar um registry (`Record<string, ConnectorFn>`) antes de adicionar N connectors.
4. **`operation` ignorado fora do calendar** — o `http` descarta a operação
   (`connectors/index.ts:34-40`) e a UI força `"request"` pra qualquer connector não-calendar
   (`public/admin/flows.js:1075`). Qualquer connector novo multi-operação esbarra nisso.
5. **Gerador por IA proibido de integrar** — `from-prompt.ts:26`. Enquanto isso não mudar, o
   Studio nunca vai gerar um fluxo do nível dos complexos.
6. **Seleção de template duplicada** — `pickTemplate` (`src/clients.ts:240-263`) e a rota
   `/v1/flows/from-template` (`src/index.ts:1096-1128`) implementam a mesma lógica com defaults
   diferentes. Com 10 templates, isso precisa virar um lugar só.
7. **Sem estrutura de lista/repetição** — o engine só tem variáveis string→string. Carrinho de
   pedido (C5, restaurante) não tem como ser representado hoje sem gambiarra.
8. **Calendário assume 1 agenda e duração fixa** — limita salão/clínica com múltiplos
   profissionais (cenário 3.5).

## 8. Recomendação de sequência

**Etapa 1 — arrumar a casa (antes de escalar o catálogo):** itens 2 e 6 da seção 7 (seeds
sobrescrevendo edição, e seleção de template duplicada). São baratos e viram dor de cabeça
garantida com 10 templates em vez de 2.

**Etapa 2 — publicar os 6 templates viáveis hoje:** os 5 simples + C1 com Google Calendar
**real** (`forceMock: false`), corrigindo de saída o problema da seção 2.3. Já multiplica por 3 o
que o cliente encontra no onboarding, sem depender de nenhuma integração nova.

**Etapa 3 — integrações por ordem de alavancagem:** e-mail (destrava C2 + resolve débito
existente) → nó de IA livre (destrava C4 e melhora todos) → Sheets (destrava C3).

**Etapa 4 — reavaliar:** pagamento, transcrição e os itens 6-8 da matriz têm custo maior e
dependem de decisões de negócio (ICP, quanto o cliente paga) que ainda estão em aberto — ver
`docs/arquitetura-to-be-roadmap_v2.md` seção 7.

**Fora desta sequência:** a frente de usabilidade do builder está registrada separadamente em
`docs/roadmap-ux-builder.md` — não compete com esta, resolve outro problema (o cliente conseguir
construir sozinho, em vez de escolher um template pronto).

---
*Estudo levantado a partir do código-fonte em 23/08/2026. Ver `docs/arquitetura-as-is.md` pro
estado geral da arquitetura e `docs/arquitetura-to-be-roadmap_v2.md` pro roadmap de
infraestrutura (frente distinta desta).*
