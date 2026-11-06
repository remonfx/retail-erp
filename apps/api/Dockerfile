# API + worker image (same image, different command). Runs TypeScript through tsx to keep one source of truth.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @rc/api... --filter @rc/domain

FROM deps AS build
COPY packages/domain packages/domain
RUN pnpm --filter @rc/domain build

FROM base AS runtime
ENV NODE_ENV=production PORT=4000
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/packages/domain packages/domain
COPY --from=deps /app/packages/domain/node_modules packages/domain/node_modules
COPY apps/api apps/api
COPY db db
USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
