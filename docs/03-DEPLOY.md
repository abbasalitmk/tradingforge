# Deployment

Two halves, deployed separately. This split is forced by Upstox, not a preference —
see `00-PLAN.md` §12.

| | Control plane | Engine |
|---|---|---|
| Where | Vercel | static-IP host |
| Holds credentials | **no** | yes |
| Places orders | never | yes |
| Deploy | git push → Vercel CI/CD | pm2 / launchd / Docker |

---

## 1. Control plane → Vercel (git CI/CD)

The repo is already configured: root `vercel.json` builds `apps/web`, and
`.npmrc` pins `legacy-peer-deps` so Vercel's install does not hit the npm
arborist bug. Nothing needs the Vercel CLI.

1. Go to <https://vercel.com/new>
2. Import **abbasalitmk/tradingforge**
3. Leave Root Directory as the repo root — `vercel.json` handles the monorepo
4. Add these Environment Variables (Production):

| Key | Value |
|---|---|
| `TF_MODE` | `PAPER` |
| `UPSTOX_API_KEY` | your API key |
| `UPSTOX_REDIRECT_URI` | `https://<assigned-host>/api/auth/callback` |
| `TF_WEBHOOK_SECRET` | the 64-hex secret from `.secrets.local` |
| `TF_ENGINE_URL` | your Cloudflare Tunnel hostname |
| `TF_ENGINE_TOKEN` | the engine token from `.secrets.local` |

5. Deploy. Every push to `main` redeploys from then on.

`UPSTOX_REDIRECT_URI` is circular — you need the hostname to set it. Deploy once,
read the assigned host, set the variable, redeploy. Vercel assigns
`tradingforge.vercel.app` if free, otherwise a suffixed variant.

---

## 2. Engine → static-IP host

**Not Vercel.** Functions are request-scoped (the market feed needs a socket held
open for 6.5 hours), there is no background process, and Vercel's egress IPs rotate
so every trading call returns `401 UDAPI1221`.

```bash
git clone git@github.com:abbasalitmk/tradingforge.git && cd tradingforge
npm install --legacy-peer-deps
createdb tradeforger
DATABASE_URL=postgresql://$USER@localhost:5432/tradeforger npm run migrate
cp .env.example apps/engine/.env.local   # fill in, then:
npm start -w @tradeforger/engine
```

Then allowlist that host's IP at <https://account.upstox.com/developer/apps>, or the
trading plane stays dead. Verify:

```bash
curl -s https://api.upstox.com/v2/user/profile -H "Authorization: Bearer $TOKEN"
```

`UDAPI1221` means the IP is not allowlisted.

Expose the engine to Vercel over a tunnel — never a public port:

```bash
cloudflared tunnel --url http://127.0.0.1:4000
```

---

## 3. URLs to register with Upstox

Paste into <https://account.upstox.com/developer/apps>, replacing
`<assigned-host>` with your Vercel hostname.

**Redirect URI**
```
https://<assigned-host>/api/auth/callback
```

**Webhook URL** — enable **both** "Order updates" and "GTT order updates";
GTT updates default to off and without them bracket legs report nothing.
```
https://<assigned-host>/api/webhooks/upstox/order/9ed50257864e86e587ce90ddd87d615966f81e553120d79b8e19657a7fd89457
```

**Notifier URL** — postback for the semi-automated daily token flow.
```
https://<assigned-host>/api/webhooks/upstox/token/9ed50257864e86e587ce90ddd87d615966f81e553120d79b8e19657a7fd89457
```

> The path secret is the only thing guarding these — Upstox sends webhooks with no
> signature, HMAC or IP allowlist. Treat the full URLs as credentials.

---

## 4. WebSocket URLs

These are Upstox's, not ours, and are **not** configured anywhere — the engine
fetches an authorized URL at runtime and connects outbound.

| Purpose | Endpoint |
|---|---|
| Market data authorize | `GET https://api.upstox.com/v3/feed/market-data-feed/authorize` |
| Market data socket | `wss://wsfeeder-api.upstox.com/market-data-feeder/v3/upstox-developer-api/feeds?requestId=…` |
| Portfolio (orders/fills) | `wss://api.upstox.com/v2/feed/portfolio-stream-feed?update_types=order,gtt_order,position,holding` |

The market socket URL is single-use and issued per authorize call — it cannot be
hardcoded. Market data is protobuf; the portfolio stream is JSON.

**Standard tier allows 2 WebSocket connections total.** The engine uses both. The
browser must never open one; it receives ticks relayed from the engine.

---

## 5. CI

`.github/workflows/ci.yml` runs typecheck, 203 tests, and a production build of the
control plane on every push and PR.
