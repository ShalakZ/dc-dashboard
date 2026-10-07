#!/bin/sh
set -eu
if [ -n "${DCDASH_TLS_CERT:-}" ] || [ -n "${DCDASH_TLS_KEY:-}" ]; then
	if [ -z "${DCDASH_TLS_CERT:-}" ] || [ -z "${DCDASH_TLS_KEY:-}" ]; then
		echo "web: both DCDASH_TLS_CERT and DCDASH_TLS_KEY must be set (or neither)" >&2
		exit 2
	fi
	for f in "$DCDASH_TLS_CERT" "$DCDASH_TLS_KEY"; do
		if [ ! -r "$f" ]; then
			echo "web: TLS file not readable inside the container: $f (mount it under ./certs and check permissions, uid 10002)" >&2
			exit 2
		fi
	done
	echo "web: serving HTTPS on 443 with $DCDASH_TLS_CERT"
	exec caddy run --config /etc/caddy/Caddyfile.tls --adapter caddyfile
fi
echo "web: serving plain HTTP on 80 (set DCDASH_TLS_CERT and DCDASH_TLS_KEY to enable TLS)"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
