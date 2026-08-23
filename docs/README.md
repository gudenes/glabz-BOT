# Documentação de arquitetura e produto — Glabz-bot

Referência técnica pra qualquer trabalho de infraestrutura/arquitetura no projeto. Antes de
propor ou implementar mudança estrutural (não é sobre features de produto), consultar esses
documentos primeiro.

## Arquitetura e infraestrutura

- **[arquitetura-as-is.md](./arquitetura-as-is.md)** — estado técnico da arquitetura na data do
  levantamento (17/08/2026): stack, dados, sessão WhatsApp/Baileys, processo, fila, reconexão,
  notificação. Diagnóstico, sem recomendação.
- **[arquitetura-to-be-roadmap_v2.md](./arquitetura-to-be-roadmap_v2.md)** *(versão vigente)* —
  diagnóstico de riscos priorizados, roadmap em fases (0–4), estratégia de ambientes
  dev/staging vs. produção, decisões estratégicas em aberto. v2 separa a Fase 3 em partes com
  gatilhos independentes (guard de erro barato vs. separar processo vs. sharding completo) e
  adiciona a Fase 4 (IP dedicado por cliente, estudo futuro).
  ([v1](./arquitetura-to-be-roadmap.md) preservada como histórico — não é mais a referência.)
- **[diagrama-ambientes-dev-vs-prod.png](./diagrama-ambientes-dev-vs-prod.png)** — diagrama
  comparativo dos dois ambientes Railway (staging/`develop` vs. production/`main`).
- **[teste-de-carga-fase3-gate.md](./teste-de-carga-fase3-gate.md)** — resultado do teste de
  carga que serviu de gate pra decisão sobre a Fase 3 (20/08/2026): metodologia, números reais
  de CPU/memória/latência, conclusão.

## Produto e roadmap funcional

- **[estudo-casos-de-uso-e-integracoes.md](./estudo-casos-de-uso-e-integracoes.md)** — estudo
  (23/08/2026) de 8 casos de uso reais por segmento, catálogo proposto de 10 templates
  (5 simples + 5 complexos), matriz de integrações priorizada e lacunas técnicas que os cenários
  revelam. Base pra decidir o que construir no builder/connectors.
- **[roadmap-ux-builder.md](./roadmap-ux-builder.md)** — frente de usabilidade do builder
  (registrada, não iniciada): variáveis visíveis/sugeridas, teste de trecho isolado, blocos
  reutilizáveis, transcrição de áudio, histórico de versões. Motivada pelo objetivo de o usuário
  leigo construir o próprio fluxo.

## Convenção de versionamento

**Esses documentos são referência viva — qualquer modificação estrutural relevante deve
consultá-los antes de ser proposta.** Se algo mudar de um jeito que invalide o que está escrito
aqui (nova decisão de arquitetura, fase concluída, prioridade revista):

- **Não editar o arquivo original in-loco.** Criar uma nova versão com sufixo `_v2`, `_v3` etc.
  (ex.: `arquitetura-to-be-roadmap_v2.md`), preservando o(s) anterior(es) no histórico do
  repositório.
- O documento mais recente (maior sufixo; sem sufixo = v1) é sempre a referência vigente.
  Atualizar este índice (`docs/README.md`) pra apontar pra versão atual quando isso acontecer.
- Motivo: manter rastreável a evolução das decisões de arquitetura ao longo do tempo, em vez de
  perder o "porquê" de decisões antigas quando elas mudam.
