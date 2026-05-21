# Lane E Phase E0 — retrieval-api Cloud Run image.
#
# Runs the Stream 1C HTTP service (services/retrieval-api) via tsx. No
# tsc build step: the workspace packages ship source-direct exports
# (`./src/*.ts`) per REPO_NOTES.md, and tsx transpiles on the fly. The
# production service is read-only and boots from a committed corpus
# snapshot (CORPUS_SNAPSHOT_PATH), so the image carries no live-ingest
# or database dependency.
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
ENV CORPUS_SNAPSHOT_PATH=/app/services/retrieval-api/corpus/snapshot.json

EXPOSE 8080

CMD ["pnpm", "--filter", "@hauska-engine/retrieval-api", "exec", "tsx", "src/index.ts"]
