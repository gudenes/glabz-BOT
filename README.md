# Glabs Bot

Microserviço WhatsApp (Baileys) multi-**product** e multi-**tenant** da GLabs.

Um lugar para conectar números, enviar mensagens, receber inbound e atualizar perfil — consumido pelo Gestor de Seguros, Prontuário Contábil e futuros apps.

## Conceitos

| Termo | Significado |
|-------|-------------|
| **product** | App cliente (`gestor`, `prontuario`, …) |
| **externalTenantId** | `tenantId` no app |
| **account** | 1 número WhatsApp (sessão Baileys) |

## API (v1)

Auth: `Authorization: Bearer $GLABS_BOT_SECRET`

| Método | Path |
|--------|------|
| GET | `/health` |
| GET/POST | `/v1/products` |
| GET/POST | `/v1/accounts` |
| GET/PATCH | `/v1/accounts/:id` |
| GET | `/v1/accounts/:id/status` |
| POST | `/v1/accounts/:id/connect` · `disconnect` · `send` · `profile` |

### Provisionar account (idempotente)

```bash
curl -s -X POST "$BOT_URL/v1/accounts" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "product": "gestor",
    "externalTenantId": "clxxx…",
    "webhookUrl": "https://gestor.example.com/api/webhooks/glabs-bot",
    "label": "Sustentare"
  }'
```

### Webhook (bot → app)

```json
{
  "type": "message",
  "accountId": "…",
  "product": "gestor",
  "externalTenantId": "…",
  "phoneE164": "5551999999999",
  "body": "Olá",
  "externalId": "ABC123",
  "sentAt": "…",
  "pushName": "Cliente"
}
```

`type: "status"` para ticks de entrega.

## Painel admin

UI embutida (sem app extra):

- **URL:** `https://glabs-bot-production.up.railway.app/admin`
- Login com o mesmo `GLABS_BOT_SECRET`
- Overview, products, contas, QR, envio teste, perfil, remover conta

## Local

```bash
export GLABS_BOT_SECRET=dev-secret
npm install
npm run dev   # :3099 → http://127.0.0.1:3099/admin
```

## Railway

1. Deploy deste diretório como serviço.
2. Variáveis: `GLABS_BOT_SECRET`, `AUTH_DIR=/data`.
3. Volume em `/data` (persistir sessões + registry).
4. Domínio público HTTPS para os apps chamarem.

## Env

| Var | Descrição |
|-----|-----------|
| `GLABS_BOT_SECRET` | Bearer entre bot e apps |
| `AUTH_DIR` / `DATA_DIR` | Root de dados (default `/data` no Railway) |
| `PORT` | Default 3099 |
| `LOG_LEVEL` | Default `warn` |
