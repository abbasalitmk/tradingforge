# Hostinger Deployment Guide

TradeForger is architected to run in production on **Hostinger VPS** using Docker Compose. Hostinger VPS provides a persistent static IP (required by Upstox API for order routing and session validation `401 UDAPI1221`), and keeps the 6.5-hour market data WebSocket connection alive continuously.

| Component | Port | Description |
|---|---|---|
| **Web Dashboard** (`@tradeforger/web`) | `3000` | Next.js frontend, OAuth callback, Upstox webhook gateway, mode toggle |
| **Trading Engine** (`@tradeforger/engine`) | `4000` | Automated trading execution, risk guards, Upstox WebSocket feed, AI analysis |
| **Reverse Proxy** (Caddy / Nginx) | `80`, `443` | Automated SSL (Let's Encrypt), exposes Web Dashboard & protects Engine internally |

---

## 1. Quick Deploy (`scripts/deploy-hostinger.sh`)

TradeForger includes an automated deploy script supporting both Hostinger MCP / API and SSH Docker Compose:

```bash
# Set your Hostinger credentials in .env or environment
export HOSTINGER_API_TOKEN="your_hostinger_api_token"
export HOSTINGER_VPS_HOST="your.vps.ip.or.domain"

./scripts/deploy-hostinger.sh
```

The script performs:
1. **Pre-flight verification**: runs typechecks (`npm run typecheck`) and all test suites (`npm test`).
2. **Environment validation**: verifies required Upstox & AI keys.
3. **Container build & deploy**: builds multi-stage standalone Next.js & Engine containers.
4. **Health check**: verifies `/api/health` responds with HTTP 200.
5. **Prints Upstox configuration**: prints redirect and webhook URLs ready to paste into your Upstox Developer App.

---

## 2. GitHub Actions CI/CD (Auto-Deploy on Git Push)

Whenever you push to the `main` branch, `.github/workflows/deploy-hostinger.yml` runs automated verification and deploys directly to your Hostinger VPS.

### Configure GitHub Repository Secrets
In your GitHub Repository (`Settings` → `Secrets and variables` → `Actions`):

| Secret Name | Description | Example |
|---|---|---|
| `HOSTINGER_HOST` | Hostinger VPS IP or domain | `194.163.x.x` |
| `HOSTINGER_USER` | SSH user (typically root) | `root` |
| `HOSTINGER_SSH_KEY` | Private SSH key matching Hostinger VPS authorized keys | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `HOSTINGER_API_TOKEN` | (Optional) Hostinger API token from hPanel | `8Fyu3zkD...` |
| `UPSTOX_API_KEY` | Upstox API Key | `...` |
| `UPSTOX_API_SECRET` | Upstox API Secret | `...` |
| `TF_WEBHOOK_SECRET` | 64-hex webhook secret | `$(openssl rand -hex 32)` |
| `TF_ENGINE_TOKEN` | 64-hex engine auth token | `$(openssl rand -hex 32)` |

---

## 3. URLs to Register with Upstox

Paste these into <https://account.upstox.com/developer/apps>, replacing `<your-domain>` with your Hostinger VPS domain or IP:

**Redirect URI**
```
https://<your-domain>/api/auth/callback
```

**Webhook URL** — enable **both** "Order updates" and "GTT order updates";
GTT updates default to off and without them bracket legs report nothing:
```
https://<your-domain>/api/webhooks/upstox/order/<TF_WEBHOOK_SECRET>
```

**Notifier URL** — postback for the semi-automated daily token flow:
```
https://<your-domain>/api/webhooks/upstox/token/<TF_WEBHOOK_SECRET>
```

> ⚠️ The path secret is the only thing guarding these — Upstox sends webhooks with no
> signature, HMAC or IP allowlist. Treat the full URLs as credentials.

---

## 4. WebSocket Connections

| Purpose | Endpoint |
|---|---|
| Market data authorize | `GET https://api.upstox.com/v3/feed/market-data-feed/authorize` |
| Market data socket | `wss://wsfeeder-api.upstox.com/market-data-feeder/v3/upstox-developer-api/feeds?requestId=…` |
| Portfolio (orders/fills) | `wss://api.upstox.com/v2/feed/portfolio-stream-feed?update_types=order,gtt_order,position,holding` |

The engine opens and maintains both connections from the Hostinger VPS static IP.
