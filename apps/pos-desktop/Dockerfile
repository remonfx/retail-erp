# POS (browser mode) for local trials. Production desktop = Tauri build.
FROM node:22-bookworm-slim
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain packages/domain
COPY apps/pos-desktop apps/pos-desktop
RUN pnpm install --frozen-lockfile --filter @rc/pos-desktop... && pnpm --filter @rc/domain build && cd apps/pos-desktop && npx vite build
WORKDIR /app/apps/pos-desktop
EXPOSE 1420
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "1420"]
