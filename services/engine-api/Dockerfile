# engine-api image — includes pysheds hydrology sidecar (ADR-008 step 4).
FROM node:22-bookworm AS base

# pysheds + rasterio need native GDAL / GEOS / PROJ libraries and their
# headers to import (rasterio links libgdal at import time; a missing
# libgdal is the "pysheds not installed in Cloud Run worker" degradation).
# build-essential + python3-dev let pip build any wheels that lack a
# manylinux build for this base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv python3-dev \
       build-essential \
       libgdal-dev gdal-bin \
       libgeos-dev \
       libproj-dev proj-bin proj-data \
       libspatialindex-dev \
  && rm -rf /var/lib/apt/lists/*

# rasterio's build needs GDAL's config on PATH / discoverable.
ENV GDAL_CONFIG=/usr/bin/gdal-config \
    CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

WORKDIR /app

COPY artifacts/hydrology-worker/requirements.txt /tmp/hydrology-requirements.txt
RUN pip3 install --break-system-packages -r /tmp/hydrology-requirements.txt

# Fail the build if pysheds/rasterio/numpy can't import — this is the
# exact failure the runtime worker hits ("pysheds not installed"). Better
# to surface it at build time than to ship an image that silently falls
# back to native-D8 on every request. The native-D8 path remains the
# runtime fallback for per-request worker faults; this only guarantees
# the image itself has a loadable pysheds.
RUN python3 -c "import numpy, rasterio; from pysheds.grid import Grid; print('hydrology deps OK:', numpy.__version__, rasterio.__version__)"

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
