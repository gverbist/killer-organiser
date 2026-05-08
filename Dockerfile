FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/killer.db

RUN groupadd --system --gid 10001 app \
 && useradd  --system --uid 10001 --gid app --home-dir /home/app --create-home app \
 && mkdir -p /data \
 && chown -R app:app /data /app

COPY --chown=app:app --from=deps /app/node_modules ./node_modules
COPY --chown=app:app server.js db.js package.json ./
COPY --chown=app:app public ./public

USER app
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/gm/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
