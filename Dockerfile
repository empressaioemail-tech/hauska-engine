# Lane E Phase E0 — retrieval-api Cloud Run image.
#
# Runs the Stream 1C HTTP service (services/retrieval-api) via tsx. No
# tsc build step: the workspace packages ship source-direct exports
# (`./src/*.ts`) per REPO_NOTES.md, and tsx transpiles on the fly.
#
# F1 Phase 0 / G2: production serves from Postgres (SUBSTRATE_DATABASE_URL
# → PgStorage). The image still ships snapshot.json for offline load /
# local-dev, but the Cloud Run boot path does NOT hydrate it into the
# heap when a substrate URL is configured.
FROM node:22-slim

# pnpm via corepack, pinned to the workspace packageManager version.
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app

# The retrieval-api consumes sibling packages through pnpm workspace
# links + source-direct exports, so the image needs the full monorepo,
# not just the service directory. node_modules is .dockerignore'd and
# reinstalled here for a clean, lockfile-resolved tree.
COPY . .

RUN pnpm install --frozen-lockfile=false

ENV PORT=8080
# Retained for local/dev snapshot-only boots. Production ignores this when
# SUBSTRATE_DATABASE_URL is set (postgres-serve). MEMORY_LIMIT_MIB must
# match the Cloud Run memory flag for the G2 headroom check.
ENV CORPUS_SNAPSHOT_PATH=/app/services/retrieval-api/corpus/snapshot.json
ENV MEMORY_LIMIT_MIB=1024

EXPOSE 8080

CMD ["pnpm", "--filter", "@hauska-engine/retrieval-api", "exec", "tsx", "src/index.ts"]
