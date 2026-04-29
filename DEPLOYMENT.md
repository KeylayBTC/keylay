# Deploying Keylay

Keylay is a single Node.js WebSocket relay (`server.js`) plus a single static HTML app (`index.html`). There is no build step. This guide covers self-hosting the relay on your own server with TLS and a reverse proxy in front of it.

If you only want to *use* Keylay, you don't need to deploy anything — open `index.html` in your browser (downloaded from this repo or from `app.keylay.org`) and the app will connect to the public relay.

---

## Prerequisites

- A Linux server (Ubuntu/Debian assumed below; adapt package commands for other distros)
- A domain name pointing at the server's IP (for TLS)
- Node.js 18 or later
- `git` and `npm`

```bash
sudo apt update
sudo apt install -y git nodejs npm
node --version   # confirm >= 18
```

---

## Install the relay

```bash
sudo mkdir -p /var/keylay
sudo chown $USER /var/keylay
cd /var/keylay
git clone https://github.com/keylaybtc/keylay.git .
npm install --omit=dev
```

Confirm it starts:

```bash
node server.js
# Should print: QR Relay WebSocket server started on port 8080
```

`Ctrl+C` to stop. You'll run it as a service in a moment.

---

## Run as a systemd service

Create `/etc/systemd/system/keylay.service`:

```ini
[Unit]
Description=Keylay WebSocket Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/keylay
ExecStart=/usr/bin/node /var/keylay/server.js
Restart=on-failure
RestartSec=5
User=keylay
StandardOutput=append:/var/log/keylay/server.log
StandardError=append:/var/log/keylay/server.log

[Install]
WantedBy=multi-user.target
```

Replace `keylay` with whatever local user account you want the relay to run as. Then:

```bash
sudo mkdir -p /var/log/keylay
sudo chown keylay /var/log/keylay
sudo systemctl daemon-reload
sudo systemctl enable --now keylay
sudo systemctl status keylay
```

`server.js` writes ISO-8601 timestamped log lines to stdout. The `StandardOutput=append:` line above sends them to `/var/log/keylay/server.log` directly — no shell redirect needed.

---

## Reverse proxy with TLS

The relay listens on `ws://localhost:8080`. Browsers loaded over HTTPS require `wss://`, so you need a reverse proxy that terminates TLS and proxies WebSocket upgrades.

### Caddy (recommended — TLS is automatic)

`/etc/caddy/Caddyfile`:

```
app.keylay.org {
    root * /var/keylay
    file_server

    handle /ws {
        reverse_proxy localhost:8080
    }
}
```

Caddy serves `index.html` at the domain root and proxies `wss://app.keylay.org/ws` to the relay. It provisions a Let's Encrypt certificate automatically on first start.

```bash
sudo systemctl reload caddy
```

### Nginx

`/etc/nginx/sites-available/keylay`:

```nginx
server {
    listen 443 ssl http2;
    server_name app.keylay.org;

    ssl_certificate     /etc/letsencrypt/live/app.keylay.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.keylay.org/privkey.pem;

    root /var/keylay;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

Use `certbot --nginx -d app.keylay.org` to provision the certificate, then enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/keylay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Optional security headers

The HTTP layer can add headers the meta-tag CSP can't:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(self), geolocation=(), microphone=()`
- `frame-ancestors` directive (set via header, not meta tag) — `Content-Security-Policy: frame-ancestors 'none'`

Caddy:

```
app.keylay.org {
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Permissions-Policy "camera=(self), geolocation=(), microphone=()"
        Content-Security-Policy "frame-ancestors 'none'"
    }
    # ... rest as above
}
```

Nginx:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(self), geolocation=(), microphone=()" always;
add_header Content-Security-Policy "frame-ancestors 'none'" always;
```

---

## Pointing the app at your relay

`index.html` ships with two URLs in `getServerConfig()`:

- `WS_LOCAL_URL = ws://localhost:8080` — used when the page is opened over `file://` or from `localhost`
- `WS_CLOUD_URL = wss://app.keylay.org/ws` — used otherwise

If you're hosting your own public relay, edit `index.html` to set `WS_CLOUD_URL` to your domain and update the `connect-src` entry in the `Content-Security-Policy` meta tag at the top of the file to allow your origin.

---

## Logs and rotation

The relay logs ISO-timestamped lines for connection lifecycle, message types, and rate-limit decisions. IP addresses are truncated to a /16 prefix (IPv4) or /32 hextet prefix (IPv6) before being written. No channel codes, channel hashes, message contents, or counters are logged.

Log rotation is the operator's responsibility. The simplest options:

**systemd journal (no file at all):** Drop the `StandardOutput=append:...` lines from the service unit. journald captures the output and rotates it automatically. View with `journalctl -u keylay`.

**logrotate (file-based):** Create `/etc/logrotate.d/keylay`:

```
/var/log/keylay/server.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` is important — it lets you keep the `StandardOutput=append:` setup without restarting the relay on rotation.

---

## Updating

```bash
cd /var/keylay
git pull
npm install --omit=dev   # only if package.json changed
sudo systemctl restart keylay
sudo systemctl status keylay
```

Watch logs after restart:

```bash
journalctl -u keylay -f
# or, if logging to a file:
tail -f /var/log/keylay/server.log
```

---

## Verifying the deployment

From any machine:

```bash
curl -I https://app.keylay.org/         # 200, valid TLS
```

In a browser, open `https://app.keylay.org/`. The app should load and the connection indicator should report "Cloud" once you enter a channel code. Open the same URL in a second browser/window with the same code; both sides should connect and exchange a test message.

If the WebSocket fails, check:

- `sudo systemctl status keylay` — is the relay running?
- `journalctl -u keylay -n 50` — any errors at startup?
- `ss -ltnp | grep 8080` — is anything listening on port 8080?
- The reverse proxy's access/error log — is it reaching the upstream?

---

## Limits and tunables

`server.js` enforces several limits as named constants at the top of the file. Adjust there if needed and restart:

- `MAX_PAYLOAD_BYTES` — WebSocket frame size cap (default 256 KB)
- `RATE_BUCKET_CAPACITY` / `RATE_REFILL_PER_SEC` — per-connection rate limit
- `MAX_CONNECTIONS_PER_IP` / `MAX_GLOBAL_CONNECTIONS` — concurrency caps
- `SESSION_IDLE_MS` / `SESSION_MAX_MS` — session lifetime
- `PING_INTERVAL_MS` / `PONG_TIMEOUT_MS` — liveness keepalives
