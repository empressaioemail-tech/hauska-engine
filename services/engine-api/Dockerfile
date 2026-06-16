# engine-api image — includes pysheds hydrology sidecar (ADR-008 step 4).
FROM node:22-bookworm AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY artifacts/hydrology-worker/requirements.txt /tmp/hydrology-requirements.txt
RUN pip3 install --break-system-packages -r /tmp/hydrology-requirements.txt

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/engine-api ./services/engine-api
COPY artifacts/hydrology-worker ./artifacts/hydrology-worker

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate \
  && pnpm install --frozen-lockfile=false

ENV PORT=8080
ENV HYDROLOGY_PYTHON=python3
WORKDIR /app
CMD ["pnpm", "--filter", "@hauska-engine/engine-api", "exec", "tsx", "src/index.ts"]
