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

# IFC/OpenShell requires NumPy 2 while the hydrology worker requires NumPy 1,
# so terrain IFC runs in an isolated venv rather than silently downgrading one.
COPY artifacts/ifc-worker/requirements.txt /tmp/ifc-requirements.txt
RUN python3 -m venv /opt/ifc-venv \
  && /opt/ifc-venv/bin/pip install --no-cache-dir -r /tmp/ifc-requirements.txt \
  && /opt/ifc-venv/bin/python -c "import ifcopenshell, numpy; print('IFC deps OK')"

# DXF/R2000 writer (ezdxf) — separate venv so hydrology NumPy 1 and IFC NumPy 2
# stay isolated. Revit Link CAD requires a full AC1015 graph (handles,
# BLOCK_RECORD, OBJECTS/LAYOUT); hand-rolled ENTITIES fragments fail Import/Link.
COPY artifacts/dxf-worker/requirements.txt /tmp/dxf-requirements.txt
RUN python3 -m venv /opt/dxf-venv \
  && /opt/dxf-venv/bin/pip install --no-cache-dir -r /tmp/dxf-requirements.txt \
  && /opt/dxf-venv/bin/python -c "import ezdxf; print('DXF deps OK:', ezdxf.__version__)"

# Fail the build if pysheds/rasterio/numpy can't import — this is the
# exact failure the runtime worker hits ("pysheds not installed"). Better
# to surface it at build time than to ship an image that silently falls
# back to native-D8 on every request. The native-D8 path remains the
# runtime fallback for per-request worker faults; this only guarantees
# the image itself has a loadable pysheds.
RUN python3 -c "import numpy, scipy, rasterio; from pysheds.grid import Grid; print('hydrology deps OK:', numpy.__version__, scipy.__version__, rasterio.__version__)"

# ── numba JIT cache, baked at build time ────────────────────────────
# pysheds' _sgrid kernels are eager-compiled numba @njit functions (most
# with cache=True). A cold worker process pays the full JIT compile —
# measured >45s on Cloud Run, which is precisely the production
# "pysheds worker exceeded 45000ms" timeout that forced every drainage
# request onto the native-D8 fallback (0 flow lines on flat TX terrain).
# Warm the kernels during the build so the cache=True compile artifacts
# ship in the image layer; runtime spawns then skip the bulk of the JIT.
ENV NUMBA_CACHE_DIR=/opt/numba-cache
COPY artifacts/hydrology-worker/warm.py /tmp/hydrology-warm.py
RUN mkdir -p /opt/numba-cache \
  && python3 /tmp/hydrology-warm.py \
  && echo "numba cache entries: $(find /opt/numba-cache -type f | wc -l)"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/engine-api ./services/engine-api
COPY artifacts/hydrology-worker ./artifacts/hydrology-worker
COPY artifacts/ifc-worker ./artifacts/ifc-worker
COPY artifacts/dxf-worker ./artifacts/dxf-worker

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate \
  && pnpm install --frozen-lockfile=false

ENV PORT=8080
ENV HYDROLOGY_PYTHON=python3
ENV IFC_PYTHON=/opt/ifc-venv/bin/python \
    IFC_WORKER_PATH=/app/artifacts/ifc-worker/run.py
ENV DXF_PYTHON=/opt/dxf-venv/bin/python \
    DXF_WORKER_PATH=/app/artifacts/dxf-worker/run.py
# 45s (the old default) is not enough headroom for the uncached subset of
# pysheds' eager-compiled kernels on a throttled cold instance. 120s stays
# inside the ldt spine call timeout (180s) and Cloud Run request timeout.
ENV HYDROLOGY_WORKER_TIMEOUT_MS=120000
WORKDIR /app
CMD ["pnpm", "--filter", "@hauska-engine/engine-api", "exec", "tsx", "src/index.ts"]
