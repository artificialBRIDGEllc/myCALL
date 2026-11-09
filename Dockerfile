# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- run ----
FROM node:22-slim
# Fail closed: an image deployed without MYCALL_API_TOKEN refuses to start instead of serving calls openly.
ENV NODE_ENV=production PORT=8787 MYCALL_DATA_DIR=/data MYCALL_REQUIRE_TOKEN=true
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Data lives in /data: mount a persistent volume there (Railway volume, docker -v, or the GCP disk).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/server/index.js"]
