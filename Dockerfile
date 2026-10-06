# Build the Devin adapter from the source checked into this repository. It is
# launched by the application per configured account; no separate service or
# build-time GitHub checkout is required.
FROM golang:1.27.1-alpine AS devin-build
WORKDIR /src
COPY runtime/devin2api/go.mod runtime/devin2api/go.sum ./
COPY runtime/devin2api/outputs ./outputs
RUN go mod download
COPY runtime/devin2api/cmd ./cmd
COPY runtime/devin2api/internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/devin-2api ./cmd/devin-2api

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000 DEVIN2API_BINARY=/usr/local/bin/devin-2api
RUN apk add --no-cache ca-certificates
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/.output ./.output
COPY --from=build /app/.worker ./.worker
COPY --from=build /app/db ./db
COPY --from=devin-build /out/devin-2api /usr/local/bin/devin-2api
COPY ops/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chmod 0755 /usr/local/bin/devin-2api
USER node
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
