# API + worker + migrate + seed image (same image, different command).
FROM node:22-bookworm-slim
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain packages/domain
COPY apps/api apps/api
COPY db db
RUN pnpm install --frozen-lockfile --filter @rc/api... && pnpm --filter @rc/domain build
WORKDIR /app/apps/api
ENV NODE_ENV=production PORT=4000 RC_MIGRATIONS_DIR=/app/db/migrations
EXPOSE 4000
CMD ["node", "--import", "tsx", "src/server.ts"]
