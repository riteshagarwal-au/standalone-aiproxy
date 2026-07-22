# syntax=docker/dockerfile:1
#
# Builds and runs @riteshagarwal-au/standalone-aiproxy (AIProxy_Process) as a
# standalone container. This Dockerfile lives in the package's own repo
# (rather than in AI-CareerCoach) since this is the canonical source the
# npm package is published from.
#
# Consumers (e.g. AI-CareerCoach's local docker-compose.yml) can either:
#   - build this image directly from this repo (git context / submodule /
#     local checkout path), or
#   - continue installing the published npm package from GitHub Packages
#     and running dist/index.js themselves (the existing pattern).
#
# This image builds from source (src/ + esbuild), not from the published
# package, since this repo IS that package's source of truth.

FROM node:20-slim AS build

WORKDIR /srv/proxy

COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/tsconfig.json app/esbuild.js ./
COPY app/src/ src/
RUN npm run build

FROM node:20-slim

WORKDIR /srv/proxy

# Only production dependencies are needed at runtime.
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /srv/proxy/dist/ dist/

ENV PROXY_PORT=3100
ENV PROXY_HOST=0.0.0.0
EXPOSE 3100

CMD ["node", "dist/index.js"]
