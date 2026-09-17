FROM oven/bun:1.3.9-debian AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/ineffa/package.json ./packages/ineffa/package.json
COPY packages/ineffa-kook/package.json ./packages/ineffa-kook/package.json
RUN bun install --frozen-lockfile --production

FROM dependencies AS build
RUN bun install --frozen-lockfile
COPY packages ./packages
COPY src ./src
COPY web ./web
COPY tsconfig.json vite.config.ts ./
RUN bun run build

FROM oven/bun:1.3.9-debian AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep openssh-client python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/packages ./packages
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/dist ./dist
RUN mkdir -p /app/.ineffa /app/workspace && chown -R bun:bun /app/.ineffa /app/workspace
USER bun
ENV NODE_ENV=production INEFFA_HOST=0.0.0.0 INEFFA_PORT=4097
EXPOSE 4097
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:4097/api/health', {headers:{Authorization:'Bearer '+process.env.INEFFA_TOKEN}}); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "src/main.ts"]
