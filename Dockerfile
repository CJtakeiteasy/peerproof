FROM node:20-bookworm-slim

ARG PEERPROOF_COMMIT=""
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    PEERPROOF_COMMIT=$PEERPROOF_COMMIT

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/.peerproof/runs && chown -R node:node /app

USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
