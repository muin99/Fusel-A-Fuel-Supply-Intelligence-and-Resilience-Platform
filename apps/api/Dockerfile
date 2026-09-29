# syntax=docker/dockerfile:1
# Build context = repo root (pnpm workspace)
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter api...
COPY apps/api apps/api
RUN pnpm --filter api build && pnpm --filter api test
RUN pnpm --filter api deploy --prod /out && cp -r apps/api/dist /out/dist

FROM node:24-alpine AS runtime
ARG APP_VERSION=1.0.0
LABEL org.opencontainers.image.version=$APP_VERSION
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://localhost:4000/api/health/live || exit 1
CMD ["node", "dist/main.js"]
