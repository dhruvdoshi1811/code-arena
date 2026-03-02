# Frontend image: static assets built by Vite, served by nginx.
#
# VITE_GATEWAY_URL is baked in at build time — Vite substitutes import.meta.env during
# the build, so it cannot be changed by an environment variable at runtime. The value is
# the ingress origin, which makes the API same-origin and removes CORS from the picture.
FROM node:24-slim AS build

ARG VITE_GATEWAY_URL=http://localhost
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
