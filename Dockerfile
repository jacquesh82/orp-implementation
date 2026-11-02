# syntax=docker/dockerfile:1

# OptiRelay showcase — image `orp-site` (R6), deployed by LeLab-infra
# (stacks/orp.mindlog.today.web). A single image serves:
#
#   /                the showcase         (apps/site)
#   /lab/            the test bench       (apps/lab)
#   /app/            withdrawn: redirected to /lab/ (purge service worker)
#   /download/       the Android APK      (apps/site/public/download, written
#                                          by apps/android-lab/rebuild.sh;
#                                          /telecharger/ redirects there)
#
# The context is the monorepo root: the bundles share the repository's
# @optirelay/* packages.

# --- Build stage --------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.2.0 --activate

# Dependencies first: this layer is only rebuilt when a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/optical/package.json packages/optical/
COPY packages/browser/package.json packages/browser/
COPY packages/elements/package.json packages/elements/
# Manifest only: the lockfile declares this workspace project, it is not built.
COPY apps/web/package.json apps/web/
COPY apps/lab/package.json apps/lab/
COPY apps/site/package.json apps/site/
RUN pnpm install --frozen-lockfile \
      --filter @optirelay/site... --filter @optirelay/lab...

COPY packages packages
COPY apps/lab apps/lab
COPY apps/site apps/site
RUN pnpm --filter @optirelay/lab build \
 && pnpm --filter @optirelay/site build \
 && mkdir -p /out \
 && cp -r apps/site/dist/. /out/ \
 && cp -r apps/lab/dist /out/lab

# --- Runtime stage ------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=build /out /usr/share/nginx/html
COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
# Probe on 127.0.0.1 and NOT `localhost`: in the container, `localhost`
# resolves first to IPv6 [::1], where nginx does not listen (R12).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
