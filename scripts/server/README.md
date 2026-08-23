# Server-side deploy (ziglings.xihale.top)

Deploy without a GitHub Actions runner: GitHub sends a **push webhook** to
`https://ziglings.xihale.top/hooks/ziglings-deploy`; Caddy proxies that path to
a systemd **socket-activated** receiver (`webhook.mjs`) that verifies the
GitHub HMAC-SHA256 signature and runs `deploy.sh`. Nothing runs while idle — a
receiver process exists only for the seconds a request (or deploy) takes.

ziglings-web is a pure consumer (compilers load from zp.xihale.top via
zp-loader.js), so deploys are fetch → checks → vite build → rsync; no compiler
builds and no submodules needed.

## Pieces (all on zzy_hk)

| what | where |
| --- | --- |
| persistent clone | `/home/ziglings-ci/ziglings-web` |
| webhook secret | `/home/ziglings-ci/.webhook-secret` (0600, ziglings-ci; same value as the GitHub hook) |
| deploy log | `/home/ziglings-ci/deploy.log` |
| receiver | `scripts/server/webhook.mjs` (from the clone) |
| deploy job | `scripts/server/deploy.sh` (from the clone) |
| socket | `/run/ziglings-deploy.sock` (ziglings-ci:caddy 0660) |
| published site | `/srv/ziglings-web` (Caddy serves it) |

The account (`ziglings-ci`, uid 1501) is password-locked, has no sudo, and can
write only its home and `/srv/ziglings-web`.

## Units

`/etc/systemd/system/ziglings-deploy.socket`:

```ini
[Unit]
Description=ziglings-web deploy webhook (socket-activated)

[Socket]
# Accept=yes → template service (ziglings-deploy@.service), one instance per
# connection with the accepted socket as fd 0/1 (inetd-style).
Accept=yes
ListenStream=/run/ziglings-deploy.sock
SocketUser=ziglings-ci
SocketGroup=caddy
SocketMode=0660
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

`/etc/systemd/system/ziglings-deploy@.service` (template: one instance per
connection, `Accept=yes` passes the connection as fd 0/1):

```ini
[Unit]
Description=ziglings-web webhook %i
Requires=ziglings-deploy.socket

[Service]
User=ziglings-ci
Group=ziglings-ci
Type=oneshot
StandardInput=socket
StandardOutput=socket
StandardError=journal
ExecStart=/usr/local/bin/node /home/ziglings-ci/ziglings-web/scripts/server/webhook.mjs
Environment=HOME=/home/ziglings-ci
TimeoutStartSec=15min
# Be a good neighbor on a shared box
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/ziglings-ci /srv/ziglings-web
```

Enable once (root): `systemctl daemon-reload && systemctl enable --now ziglings-deploy.socket`

## Caddy

The `ziglings.xihale.top` site block (security headers used to live in
`public/_headers`, which GitHub Pages ignored anyway — Caddy actually applies
them):

```caddyfile
ziglings.xihale.top {
	encode zstd gzip
	root * /srv/ziglings-web
	@deployhook {
		path /hooks/ziglings-deploy
		method POST
	}
	@nocache {
		path */ *.html /versions.json *meta.json */catalog.json
	}
	route {
		reverse_proxy @deployhook unix//run/ziglings-deploy.sock
		header {
			Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://zp.xihale.top blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self' https://zp.xihale.top; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
			X-Content-Type-Options "nosniff"
			Referrer-Policy "no-referrer"
			Cross-Origin-Opener-Policy "same-origin"
			Permissions-Policy "camera=(), microphone=(), geolocation=()"
		}
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		header /vendor/* Cache-Control "public, max-age=86400"
		header @nocache Cache-Control "no-cache"
		try_files {path} /index.html
		file_server {
			precompressed gzip
		}
	}
}
```

Cache policy: Vite `/assets/*` are content-hashed → immutable; `catalog.json`
gates exercise freshness at boot → no-cache; the rest of `/vendor/*` (exercise
sources/patches, un-hashed) → 1d.

## GitHub webhook (one-time)

The API needs `url` inside a `config` object (`gh api -f url=…` flattens it to
the top level and gets a 422):

```sh
SECRET=$(ssh zzy_hk 'cat /home/ziglings-ci/.webhook-secret')
printf '{"name":"web","active":true,"events":["push"],"config":{"url":"https://ziglings.xihale.top/hooks/ziglings-deploy","content_type":"json","secret":"%s"}}' "$SECRET" \
  | gh api -X POST repos/xihale/ziglings-web/hooks --input -
```

## Ops

```sh
ssh zzy_hk
tail -f /home/ziglings-ci/deploy.log                  # deploy output
journalctl -t ziglings-deploy@ -e                     # receiver lifecycle (start/exit)
curl -s https://ziglings.xihale.top/deploy-meta.json  # what sha is live
# manual deploy:
sudo -u ziglings-ci bash /home/ziglings-ci/ziglings-web/scripts/server/deploy.sh
```

Rollback = `git` any old sha in the clone and re-run deploy.sh.
