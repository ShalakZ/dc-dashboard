FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM caddy:2-alpine
RUN apk add --no-cache libcap \
 && addgroup -g 10002 web && adduser -D -u 10002 -G web web \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && mkdir -p /data /config && chown -R web:web /data /config
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/Caddyfile.tls /etc/caddy/Caddyfile.tls
COPY --chmod=0755 deploy/entrypoint.sh /entrypoint.sh
COPY --from=build /app/dist /srv
USER web
ENTRYPOINT ["/entrypoint.sh"]
