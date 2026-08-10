# Glabs Bot — Baileys WhatsApp multi-product / multi-tenant
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install tsx@4.19.2 --no-save

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN test -f /app/src/index.ts && test -f /app/src/session.ts && test -f /app/public/admin/index.html

ENV NODE_ENV=production
ENV AUTH_DIR=/data
ENV LOG_LEVEL=warn
ENV PORT=3099
ENV HOSTNAME=0.0.0.0

EXPOSE 3099
RUN mkdir -p /data/auth_state

CMD ["npx", "tsx", "src/index.ts"]
