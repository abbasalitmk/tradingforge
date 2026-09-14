# Webhook & Callback Endpoints

The control plane (Vercel) terminates all **inbound** Upstox traffic. The engine
(static-IP host) makes all **outbound** calls. This split matters:

- **Inbound is fine on Vercel.** Webhook receivers are request-scoped, which is exactly
  what serverless does well. No static IP is involved in receiving a POST.
- **Outbound is not.** Every order/funds/position call must originate from the account's
  allowlisted IP or it returns `401 UDAPI1221`. Vercel's egress IPs rotate, so the engine
  cannot live there. See `00-PLAN.md` §12.

---

## Endpoints

| Purpose | Method | Path |
|---|---|---|
| OAuth redirect | `GET` | `/api/auth/callback` |
| Order + GTT updates | `POST` | `/api/webhooks/upstox/order/{secret}` |
| Daily-token notifier | `POST` | `/api/webhooks/upstox/token/{secret}` |
| Health | `GET` | `/api/health` |

`{secret}` is `TF_WEBHOOK_SECRET` — 64 hex chars from `openssl rand -hex 32`.

---

## The security problem, and what we do about it

Upstox's webhook documentation states webhooks **"should not require authentication"**.
There is no HMAC, no signature header, no shared secret, no IP allowlist. Verified against
the docs on 2026-09-14.

That means: **anyone who learns your webhook URL can POST a forged order-fill event.**

Three mitigations, in order of how much they actually matter:

### 1. The payload is a hint, never a fact — *this is the real defence*

The engine never mutates position state from a webhook body. A webhook arrival only
*triggers* an authenticated re-poll of the authoritative endpoints:

```
webhook arrives  →  engine calls GET /v2/order/retrieve-all   (its own bearer token)
                 →  engine calls GET /v3/order/gtt
                 →  state updated from THAT response only
```

A forged `{"update_type":"order","status":"complete"}` therefore costs one wasted API call.
It cannot create a phantom position, arm a bracket against nothing, or trigger an exit.

The **portfolio WebSocket feed** (`wss://api.upstox.com/v2/feed/portfolio-stream-feed`) is
the primary fill source — it is authenticated with our bearer token on an outbound
connection, so it is trustworthy in a way the webhook is not. Webhooks are redundancy.

### 2. Unguessable path

The 64-hex secret in the path is the only auth primitive Upstox's design leaves available.
A wrong secret returns **404, not 401** — an unauthenticated endpoint should not confirm to a
prober that the path shape means anything.

### 3. Operational hygiene

- Treat the full webhook URLs as credentials. They are not committed; `.secrets.local` and
  `.env.local` are gitignored.
- `X-Robots-Tag: noindex` and `Cache-Control: no-store` on all `/api/*` responses.
- Rotate by regenerating `TF_WEBHOOK_SECRET`, redeploying, and updating the Upstox app config.

### The token notifier is the sharpest edge

`/api/webhooks/upstox/token/{secret}` can receive a **live access token**. Handling rules,
enforced in `apps/web/src/app/api/webhooks/upstox/token/[secret]/route.ts`:

- Never logged, never persisted by the web app, never returned in a response body.
- Forwarded to the engine over the tunnel and immediately dropped from memory.
- The engine treats an inbound token as a **candidate**: it validates against
  `/v2/user/profile` before replacing the active token. Someone who guesses the path can
  submit a token — but not a working one.

Verified locally: a POST containing a token string produces zero occurrences of that string
in the server log.

---

## Deploying

```bash
vercel login                 # one-time, interactive
./scripts/deploy-web.sh      # links, pushes env, deploys, prints the URLs
```

The script prints the three URLs to paste into
<https://account.upstox.com/developer/apps>. On the app config page, enable **both**
"Order updates" and "GTT order updates" — GTT updates are off by default, and without them
the bracket legs (§0.1) report nothing.

---

## Verifying a deployment

```bash
HOST=your-app.vercel.app
SEC=$(grep TF_WEBHOOK_SECRET .secrets.local | cut -d= -f2)

curl -s https://$HOST/api/health

# wrong secret must 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://$HOST/api/webhooks/upstox/order/$(openssl rand -hex 32) \
  -H 'content-type: application/json' -d '{"update_type":"order","order_id":"x","status":"complete"}'

# correct secret must 200
curl -s -X POST https://$HOST/api/webhooks/upstox/order/$SEC \
  -H 'content-type: application/json' \
  -d '{"update_type":"order","order_id":"test","status":"complete"}'
```

`relayed: false` is expected until the engine is running and `TF_ENGINE_URL` points at a live
Cloudflare Tunnel. The webhook still returns `200` — acknowledging without a relay is
deliberate, since Upstox's retry semantics are undocumented and the engine reconciles on its
own timer regardless.
