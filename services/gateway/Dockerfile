# Gateway image.
#
# node:24-slim rather than alpine: @node-rs/argon2 and @confluentinc/kafka-javascript are
# native modules, and their glibc prebuilds are far better covered than musl. Alpine
# risks a source build for librdkafka at install time.
FROM node:24-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Reinstall with dev dependencies pruned; the native modules are rebuilt for this same
# base image, so the prebuilds fetched here are the ones that ship.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Migrations travel with the image so the migrate Job can run from the same artifact.
COPY migrations ./migrations

# Numeric, not `USER node`. With runAsNonRoot the kubelet has to verify the user is not
# root before starting the container, and it cannot resolve a name from the image — a
# named USER fails with CreateContainerConfigError. 1000 is the node image's `node` user.
USER 1000:1000
EXPOSE 4000

CMD ["node", "dist/index.js"]
