<!--
  Descreva O QUE muda e POR QUÊ — não só o diff.
  Se corrige algo, diga qual era o comportamento errado.
-->

## O que muda


## Por quê


## Como foi testado


---

## Infraestrutura e documentação

> Marque a primeira caixa se este PR mexe em **qualquer** um destes:
> banco de dados (schema, extensão, imagem, migração) · Railway (serviço, volume,
> variável de ambiente, environment) · Dockerfile / railway.json · dependência nova ·
> integração externa nova · modelo de processo (worker, fila, réplica).

- [ ] **Este PR altera infraestrutura.**

Se marcou acima, confirme:

- [ ] Os documentos em [`docs/`](../docs/README.md) foram revisados e continuam verdadeiros.
- [ ] Se algum ficou desatualizado, criei a versão nova com sufixo `_v2` / `_v3`
      (sem editar o original in-loco) e atualizei `docs/README.md`.
- [ ] O impacto em **produção** está descrito acima (precisa de janela? backup?
      variável nova no Railway? é retrocompatível?).

<!--
  Por que este bloco existe: o projeto não tem CI, e a convenção de manter
  docs/ atualizado dependia só de alguém lembrar. Uma migração de banco chegou
  a ser planejada sem que nada avisasse sobre os documentos — daí este
  checklist. Não bloqueia o merge; serve pra ninguém esquecer.
-->
