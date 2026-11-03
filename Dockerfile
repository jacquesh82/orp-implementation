# syntax=docker/dockerfile:1

# OptiRelay showcase — image `orp-site` (R6), deployed by LeLab-infra
# (stacks/orp.mindlog.today.web). A single image serves:
#
#   /                the showcase         (apps/site)
#   /studio/         OptiRelay Studio     (examples/studio — interactive demo
#                                          built on the npm @optirelay/* packages;
#                                          it replaces the bench)
#   /lab/            withdrawn: redirected to /studio/
#   /app/            withdrawn: redirected to /studio/ (purge service worker)
#   /download/       the Android APK      (apps/site/public/download, written
#                                          by native/android/rebuild.sh;
#                                          /telecharger/ redirects there)
#
# The context is the monorepo root: the showcase uses the repository's
# @optirelay/* packages; the Studio installs the PUBLISHED ones from npm (it is
# the example of an application using them).

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
# Manifests only for web, lab and the Hello world examples: the lockfile
# declares these workspace projects, they are not built.
COPY apps/web/package.json apps/web/
COPY apps/lab/package.json apps/lab/
COPY apps/site/package.json apps/site/
COPY examples/hello-world/package.json examples/hello-world/
COPY examples/secure-hello-world/package.json examples/secure-hello-world/
COPY examples/studio/package.json examples/studio/
RUN pnpm install --frozen-lockfile \
      --filter @optirelay/site... --filter @optirelay/example-studio...

COPY packages packages
COPY apps/site apps/site
COPY examples/studio examples/studio
RUN pnpm --filter @optirelay/site build \
 && pnpm --filter @optirelay/example-studio build \
 && mkdir -p /out \
 && cp -r apps/site/dist/. /out/ \
 && cp -r examples/studio/dist /out/studio

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
