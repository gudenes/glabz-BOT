# Decisões do atendimento automático (27–31/08/2026)

Este documento registra **por que** o atendimento automático é do jeito que é. Não descreve o
código — o código está lá e muda; aqui ficam as razões, que são o que se perde primeiro.

Cada seção existe porque a decisão contrária **já foi tentada e falhou em produção**. Se você está
prestes a desfazer alguma delas, leia o motivo antes: é provável que o problema que você quer
resolver seja o mesmo que criou a regra.

---

## 1. O fluxo simples é montado por CÓDIGO, não desenhado pela IA

**`src/flows/simple-flow.ts` (`buildSimpleFlow`)**

A IA escreve **quatro textos** — nome, apresentação, contexto e mensagem de atendente. Ela não
escolhe tipo de card, saída nem ligação. `parseSimpleFlowTexts` **ignora** `nodes`/`edges` se o
modelo mandar.

### Por que

O fluxo simples nasceu quebrado **quatro vezes seguidas**, cada vez num formato diferente:

| PR | como veio quebrado |
|---|---|
| #76 | sem o card "Responder com IA" |
| #96 | `llm_answer` sem a saída "ok" — a IA acertava e o cliente ia pro atendente |
| #101 | sem card de espera: a IA gastava a resposta cumprimentando de volta o "oi" |
| #103 | laço falso — a pergunta "mais alguma coisa?" ligada direto no Fim |

O padrão era sempre o mesmo: escrevia-se uma garantia pro formato quebrado **daquela vez**, e a
geração seguinte inventava outro. A causa não era o modelo desobedecer — era deixá-lo desenhar o
grafo de um fluxo **cuja forma é fixa por definição**. "Simples" é uma forma só.

Depois dessa mudança, os defeitos que apareceram foram de comportamento e de tela, nunca mais
"nasceu quebrado".

### A forma, e o porquê de cada parte

```
trigger → ask "Oi{{name_greet}}! <apresentação>"      ← ask, NÃO message
        → llm_answer
             ok   → ask "mais alguma coisa?" → condition
                        despediu → message (despedida) → end
                        senão    → VOLTA pro llm_answer
             erro → handoff        (inclui "a IA não sabe" — ver seção 2)
```

- **`ask` na abertura, não `message`**: só o `ask` faz o motor parar e aguardar. Um `message` envia
  e segue na mesma passada, e a IA consumiria o "oi" como se fosse a pergunta.
- **`{{name_greet}}` fica no código**, não no texto da IA — por isso o prompt manda a apresentação
  **não** cumprimentar (sairia "Oi, Carlos! Olá! Aqui é...").
- **A saída "ok" volta pro MESMO card de IA**, em vez de duplicá-lo: é o que mantém o fluxo pequeno
  e faz a base de conhecimento valer pra toda pergunta seguinte.
- **A despedida antes do fim**: sem ela o bot emudecia quando o cliente encerrava — sumir no meio
  da conversa é pior do que não ter tido bot.
- **`end` não é beco**: o motor reinicia pelo gatilho na mensagem seguinte (`state.finished`).

O catálogo usa o **mesmo** `buildSimpleFlow`, então template e fluxo gerado não podem divergir — foi
divergindo que o catálogo acumulou os mesmos defeitos que se corrigia na geração.

**Ainda autora grafo, com a mesma fragilidade:** o fluxo **completo** e o assistente de IA do
builder (`edit-flow.ts`). O segundo é defensável — o dono pede e vê o resultado na hora. O primeiro
é o próximo passo natural.

---

## 2. A IA nunca aprende sozinha de conversa

**Aba Conhecimento → "Não soube responder"**

A caixa de entrada agrupa as perguntas que a IA não soube e oferece **"Ensinar"**, que abre o
formulário com a pergunta preenchida e a resposta **em branco**.

### Por que não automático

O bot não sabe se o negócio tem ração para cachorro de grande porte. Se "aprendesse" da conversa,
aprenderia o quê? Em agosto a extração automática salvou pares com **"Não foi mencionado."** como
resposta, e o bot passou a dizer isso a clientes reais. Aprender sem confirmação humana recria esse
problema em escala maior.

Quem sabe a resposta é o dono. Isso não é limitação — é o desenho.

### O que sustenta a lista

`ai_answer_log.fail_reason` separa **`fora_do_contexto`** (a IA não sabe → ensinável) de falha
técnica (`http_*`, `falha_na_chamada`…). Ver `classifyFailure`.

**Sem essa separação a lista seria ruído** — instabilidade de infra apareceria como pergunta a
ensinar, o dono abriria duas vezes e nunca mais voltaria. É por isso que o motivo da falha foi
implementado **antes** da tela, e não como detalhe.

A dispensa vive em `knowledge_gap_dismissed` e não numa coluna do log, porque é do **grupo** de
perguntas iguais: a mesma dúvida chega várias vezes e ensinar uma resolve todas. **Apagar a linha é
o desfazer** — por isso não há coluna de estado.

**Limitação assumida:** o agrupamento é por texto normalizado (`questionKey`), não por semelhança.
"ração p/ cão grande" conta separado de "vocês têm ração para cachorro de grande porte?". Semelhança
exigiria embeddings e erraria junto quando errasse — melhor duas linhas honestas que uma errada.

---

## 3. Quando a IA não sabe, ela transborda de verdade

**`isUnknownAnswer` / `UNKNOWN_TOKEN` em `src/flows/llm.ts`**

O modelo responde uma sentinela quando a informação não está no contexto, e o código transforma isso
em falha — que é o caminho do atendente.

### Por que

Antes, a IA escrevia *"Não tenho essa informação. Vou chamar alguém da equipe"* e o fluxo **seguia
em frente**, perguntando "mais alguma coisa?". O atendente prometido nunca chegava: **o bot mentia
para o cliente**. O prompt já mandava avisar, mas o código não tinha como saber — a chamada voltava
com sucesso.

Como prompt não garante nada, há também uma rede de frases, escrita a partir do que o modelo real
produziu. O cuidado que ela exige: distinguir **"a IA não sabe"** de **"a resposta é não"**. *"Não
temos piscina"* é resposta legítima vinda do contexto e não pode virar transbordo.

---

## 4. As travas do bot ficam na CONTA, não no cliente

**`AccountRecord.botRules` (`src/registry.ts`), gate em `handleInbound`**

Quatro controles, todos na aba WhatsApp: filtro de números, janela de atendimento, ritmo da conversa
("digitando…") e retorno automático ao bot.

### Por que na conta
É comportamento **daquele número** — um cliente com dois números pode querer regras diferentes em
cada um. E o gate roda no `handleInbound`, que já tem o `accountId` em mãos. De quebra, a leitura sai
de graça: `GET /v1/portal` já devolve a conta inteira.

### Barrar nunca descarta a mensagem
Quando uma trava barra, a execução cai no caminho "sem fluxo live" que já existia: **grava no inbox e
manda pro app como sempre**. Silenciar o bot não pode custar a mensagem do cliente — e a tela promete
isso em texto.

### O princípio que atravessa as quatro
**Nada pode calar o bot por engano.** Lista vazia, horário ligado sem dia, hora mal formada, fuso
inválido: tudo cai em "responde", nunca em "fica mudo". O pior desfecho dessa tela é o dono ativar
uma trava, esquecer, e o bot ignorar clientes reais em silêncio — por isso o cartão anuncia em
destaque o efeito atual da regra.

### Detalhes que custaram pensamento
- **Nono dígito**: `phoneKey()` reduz a DDD + 8 dígitos finais. O resto do sistema compara telefone
  com `replace(/\D/g,"")` puro, o que basta quando as duas pontas vêm do mesmo lugar — aqui uma vem
  do WhatsApp e a outra é digitada pelo dono.
- **Janela que vira a noite** (pizzaria 18:00→02:00): o dia marcado é o dia em que a janela
  **começa**.
- **Fuso configurável** usa `Intl`, e **não** `src/br-time.ts`, que é Brasília com offset fixo.
  Consequência conhecida: um cliente em Manaus tem o **bot** no fuso certo e a **agenda** ainda em
  Brasília.
- **Ritmo da conversa** é tempo **total mínimo**, não atraso somado: se a IA já levou 3s e o dono
  pediu 2s, não espera mais nada.
- **Retorno ao bot** conta do **último contato**, não do transbordo — senão a conversa voltaria pro
  bot no meio de um atendimento demorado, com o bot falando por cima do atendente. Ligado por
  padrão, 24h.

---

## 5. Estratégia de testes — e a armadilha que já custou caro

Quatro comandos, cada um cobrindo o que os outros não conseguem:

| comando | o quê | quando roda |
|---|---|---|
| `npm test` | lógica pura + IA falsa | sempre; rápido e sem custo |
| `npm run test:ui` | Chrome do sistema, geometria e pintura reais | ao mexer em tela |
| `npm run test:db` | SQL contra Postgres de verdade | ao mexer em consulta |
| `npm run test:llm` | modelo real | ao mexer em prompt; **gasta crédito** |

### ⚠️ A armadilha do falso verde

**Sem chave de IA, `llm_answer` SEMPRE falha e o fluxo vai pela saída "erro" até o handoff.** A saída
"ok" — onde vive o laço de continuação — nunca roda. Uma suíte inteira ficou verde por esse motivo e
liberou um fluxo que reprovava na validação em staging.

**Todo teste que envolve `llm_answer` tem que usar `test/helpers/fake-llm.ts`.**

### Sempre sabotar antes de confiar

Confirmar que um teste novo **reprova** quando o comportamento é desfeito. Nesta rodada a sabotagem
revelou quatro testes furados:

- um `\b` depois de "á" — não é caractere de palavra em regex JS, e o teste passava com "Olá!";
- expectativa errada sobre fuso inválido;
- a suíte inteira sem exercitar o caminho de sucesso da IA;
- um teste de tela medindo a **propriedade** `.hidden` em vez do que o navegador pinta — passou verde
  com os três painéis visíveis ao mesmo tempo.

O padrão dos quatro é o mesmo: **testar o que é fácil medir em vez do que importa**.

### O que continua fora de alcance

- **RAG / base de conhecimento**: precisa de pgvector, indisponível no ambiente de desenvolvimento.
- **WhatsApp real** (Baileys).
- **Qualidade do que o modelo escreve**: a IA falsa prova o encanamento, não o texto.
- **"Isso é incompreensível pra quem não é técnico"**: nenhum teste pega. Todos os casos desta
  rodada vieram do dono olhando a tela.

---

## Correções a documentos anteriores

Pela convenção do projeto, documento antigo não é editado no lugar. Ficam aqui as divergências:

- **`estudo-casos-de-uso-e-integracoes.md`** propõe um catálogo de 10 templates (5 simples + 5
  complexos). O catálogo atual tem **5**, todos simples e montados pelo mesmo esqueleto da seção 1.
  Os "complexos" foram retirados a pedido do dono: estavam rotulados "simples" mas tinham 10 a 12
  cards.
- **`rag-desenho.md`** se descreve como "desenhado, não implementado". O RAG **está implementado** —
  `knowledge_chunks`, busca por similaridade e o card "Responder com IA" em produção. As decisões de
  desenho do documento seguem valendo.
