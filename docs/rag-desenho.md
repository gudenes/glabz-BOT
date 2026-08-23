# RAG — busca semântica no histórico de atendimento

Documento de desenho · 23/08/2026 · repositório `gudenes/glabz-BOT`

> **Status: desenhado, não implementado.** Decisões técnicas abaixo têm base em teste empírico
> (registrado na seção 4), não em suposição. Pré-requisito de infraestrutura já resolvido:
> pgvector 0.8.6 ativo no Postgres do staging.

## 1. Problema

O card "Responder com IA" (`llm_answer`) hoje responde a partir de um **texto fixo** que o dono
do negócio escreve à mão. Funciona, mas não escala como produto: cada cliente precisaria manter
esse texto atualizado manualmente, e nada aproveita o que a equipe já respondeu no dia a dia.

O objetivo é que **o bot melhore sozinho conforme a equipe atende** — quando um humano responde
uma pergunta, essa resposta passa a estar disponível pra IA usar nas próximas.

Requisito declarado pelo usuário: a solução precisa servir a **empresas de qualquer porte**,
independentemente do volume de dados. Foi por isso que a alternativa de curadoria manual
(aprovar resposta por resposta) foi descartada como caminho principal — vira gargalo
operacional num SaaS com muitos clientes.

## 2. O que já existe e é reaproveitado

- **`wa_messages`** (Postgres) grava toda mensagem com `client_id`, `phone_e164`, `direction`
  e — crucialmente — `source`: `customer` · `bot` · `human`. É o `human` que identifica o que
  um atendente de verdade respondeu.
- **pgvector 0.8.6** habilitado (`ensureVectorExtension`, `src/db.ts`). A imagem do Postgres do
  Railway já trazia a extensão; bastou `CREATE EXTENSION`, sem trocar imagem nem migrar dados.
- **Card `llm_answer`** (`answerFreeform`, `src/flows/llm.ts`) já monta a chamada com contexto e
  já tem a instrução de **não inventar** — responde só com o que está no contexto e admite
  quando não sabe. Essa instrução é a última linha de defesa do desenho abaixo.

## 3. Restrição dura: provedor de embeddings

**xAI (Grok) não expõe API de embeddings.** Como o bot usa Grok pra gerar respostas, o RAG
obriga um **segundo provedor** só pra vetorizar texto.

Decidido: **OpenAI `text-embedding-3-small`**. Conta criada em 23/08/2026 pelo usuário.
Alternativa avaliada e adiada: modelo local (Transformers.js) — elimina o provedor externo e o
custo por consulta, mas pesa ~200 MB no build e exige escolher com cuidado um modelo
multilíngue de verdade (os pequenos e populares são fracos em português). Fica como opção
futura, por custo ou por privacidade.

**Custo:** ~US$ 0,02 por milhão de tokens. Uma pergunta típica de WhatsApp tem ~20 tokens — a
ordem de grandeza é de **dólares por milhões de perguntas**. Não é fator de decisão.

## 4. Decisões com base em teste

Testes rodados em 23/08/2026 contra a API real, em português, medindo similaridade de cosseno
entre uma "resposta guardada" e perguntas relevantes vs. irrelevantes.

### 4.1 O que indexar → **o par pergunta → resposta**

| Estratégia | Margem entre pior relevante e melhor irrelevante |
|---|---|
| Só a resposta do atendente | 0,020 |
| Só a pergunta do cliente | 0,040 |
| **Par pergunta → resposta** | **0,057** ✅ |

Indexar só a resposta é o pior caso — pergunta e resposta são textos de natureza diferente, e
comparar um com o outro é assimétrico. O par carrega os dois lados e sai melhor.

### 4.2 Qual modelo → **`text-embedding-3-small`**

| Modelo | Dimensões | Margem |
|---|---|---|
| `text-embedding-3-small` | 1536 | **0,058** |
| `text-embedding-3-large` | 3072 | −0,006 ❌ |

Resultado contraintuitivo: o modelo maior ficou **pior** — uma pergunta irrelevante pontuou
acima de uma relevante. Amostra pequena (6 frases), então não condena o modelo; mas serve
pra não pagar mais caro sem evidência. Ficamos com o menor, que é mais barato **e** melhor
neste teste.

### 4.3 Como filtrar → **top-k, não corte fixo**

As margens medidas são apertadas (0,02–0,06). Um limiar absoluto ("traga tudo acima de 0,4")
seria frágil: calibrado num negócio, quebra no outro.

**Decisão:** buscar os **N melhores** (top-k, começar com 3–5) e deixar a decisão final com a
IA, que já tem instrução de usar só o contexto e admitir quando não sabe. A proteção contra
resposta ruim fica na **geração**, não no filtro. Um corte mínimo bem baixo pode existir só
pra descartar lixo absoluto — não pra separar relevante de irrelevante.

## 5. Decisões de produto

### 5.1 Privacidade → **anonimizar antes de indexar**

Conversa de WhatsApp contém dado pessoal (nome, telefone, e em clínica/escritório coisas mais
sensíveis). Indexar cria uma cópia derivada desse dado.

**Decisão:** remover identificadores (nome, telefone, documento) do texto **antes** de gerar o
vetor. Perde-se pouco — a resposta útil quase nunca depende de quem perguntou.

Consequências a respeitar na implementação:
- O dado é do **cliente final**, não da GLabs nem do dono do negócio.
- "Excluam meus dados" precisa apagar **mensagem e vetor** — o vetor não pode ficar órfão.

### 5.2 Qualidade da fonte → **frequência dá peso + marcar o que não serve**

Risco levantado pelo usuário: um atendente responde errado uma vez e a IA passa a repetir com
confiança.

**Decisão — três camadas, nenhuma exigindo aprovação prévia (que não escalaria):**
1. **Frequência como sinal** — resposta dada muitas vezes pesa mais que uma isolada.
2. **Marcação negativa** — qualquer um pode marcar "não use isso" e o item sai da base.
3. **Instrução de não inventar** — já existe em `answerFreeform`; segura parte do estrago
   mesmo quando algo ruim chega na busca.

### 5.3 Convivência com o contexto manual → **complementa, e o manual vence**

O campo "o que a IA sabe sobre o seu negócio" **continua existindo** e tem precedência: é a
verdade oficial (preço, horário, política). O RAG entra como camada adicional, com o histórico.
Em conflito entre os dois, o texto manual ganha — ele foi escrito de propósito, o histórico é
subproduto.

### 5.4 Isolamento entre clientes → **por construção**

A busca **jamais** pode cruzar clientes. `wa_messages` tem `client_id`; o filtro precisa ser
estrutural (não opcional no call site), porque um vazamento aqui significa a farmácia lendo
conversa do estúdio de pilates.

## 6. Esboço da implementação

Ordem sugerida, cada etapa entregando algo verificável:

1. **Tabela de embeddings** — vetor + referência ao par de origem + `client_id` + contagem de
   frequência + flag de marcação negativa. Índice vetorial do pgvector.
2. **Extração de pares** — varrer `wa_messages` isolando "pergunta do cliente → resposta com
   `source = human`", anonimizar, agrupar repetições.
3. **Indexação** — gerar embeddings em lote (não a cada mensagem: mais barato e evita
   acoplar o caminho de atendimento a uma chamada externa).
4. **Busca no card** — `llm_answer` passa a consultar a base do próprio cliente e juntar os
   top-k ao contexto manual.
5. **Marcação negativa** — na UI, tirar da base o que não deve ser usado.

## 7. Em aberto

- **Chave própria da OpenAI pro glabz-bot** — a criada em 23/08 foi exposta em chat durante o
  teste e deve ser revogada; além disso, convém não compartilhar conta/cota com outros
  projetos do usuário (o `/opt/quemcuida` já usa OpenAI pra Whisper).
- **Reindexação ao trocar de modelo** — vetores de modelos diferentes não são comparáveis.
  Trocar de embedding depois obriga regerar toda a base. Com pouco dado é trivial; com anos de
  histórico, não.
- **Quando o RAG vale a pena por cliente** — com histórico pequeno a busca traz pouca coisa
  relevante e pode piorar a resposta. Vale medir a partir de quanto ele começa a ajudar.

---
*Ver `docs/estudo-casos-de-uso-e-integracoes.md` (o "responder pergunta aberta" aparecia nos 8
de 8 cenários) e `docs/arquitetura-to-be-roadmap_v2.md` pro roadmap de infraestrutura.*
