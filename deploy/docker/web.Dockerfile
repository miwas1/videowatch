FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/extension/package.json apps/extension/package.json
RUN npm ci

COPY apps/web/ apps/web/
COPY apps/extension/ apps/extension/
COPY scripts/ scripts/
COPY tsconfig.base.json ./

ARG VITE_API_BASE_URL=""
ARG VITE_API_TOKEN=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_API_TOKEN=$VITE_API_TOKEN

RUN npm run build:web

FROM caddy:2-alpine
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv/web
