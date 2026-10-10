FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
RUN apk add --no-cache libcap \
 && addgroup -g 10002 web && adduser -D -u 10002 -G web web \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && mkdir -p /data /config && chown -R web:web /data /config
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/Caddyfile.tls /etc/caddy/Caddyfile.tls
COPY deploy/security-headers.caddy /etc/caddy/security-headers.caddy
COPY --chmod=0755 deploy/entrypoint.sh /entrypoint.sh
COPY --from=build /app/dist /srv
USER web
ENTRYPOINT ["/entrypoint.sh"]
