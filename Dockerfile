# Build the web UI and run the wallet server in one small image.
# The server itself needs only Node + the repo; the container is published on
# the host's loopback (see docker-compose.yml), never on 0.0.0.0 of the host.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --no-audit --no-fund && cd web && npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
COPY web ./web
RUN cd web && npm run build

FROM node:24-slim
WORKDIR /app
ENV WEB_HOST=0.0.0.0
COPY package.json package-lock.json ./
# tsx runs the CLI in this image, so dev dependencies stay installed.
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/config ./config
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 8787
# Accounts live in data/users.json (mount ./data to keep them across restarts).
CMD ["npm", "run", "cli", "--", "serve", "8787"]
