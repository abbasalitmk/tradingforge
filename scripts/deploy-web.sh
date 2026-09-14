#!/usr/bin/env bash
# Deploy the TradeForger control plane to Vercel and print the webhook URLs.
#
# The control plane is stateless and holds NO Upstox credentials. It is safe to
# put on Vercel. The trading engine is NOT deployed here and cannot be — see
# docs/00-PLAN.md §12.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${TF_VERCEL_PROJECT:-tradeforger}"

if ! vercel whoami >/dev/null 2>&1; then
  echo "✗ Vercel CLI is not authenticated."
  echo "  Run:  vercel login        (or export VERCEL_TOKEN=…)"
  exit 1
fi
echo "✓ Vercel account: $(vercel whoami 2>/dev/null)"

if [[ ! -f .secrets.local ]]; then
  echo "✗ .secrets.local missing. Regenerate with:"
  echo "    printf 'TF_WEBHOOK_SECRET=%s\\nTF_ENGINE_TOKEN=%s\\n' \\"
  echo "      \"\$(openssl rand -hex 32)\" \"\$(openssl rand -hex 32)\" > .secrets.local"
  exit 1
fi
# shellcheck disable=SC1091
source .secrets.local

: "${UPSTOX_API_KEY:=c13dd61d-ac65-4a3c-bdc5-15cd648a15aa}"
: "${TF_ENGINE_URL:=https://engine.invalid}"   # replace with your Cloudflare Tunnel hostname

echo "→ Linking project '$PROJECT'…"
vercel link --yes --project "$PROJECT" >/dev/null

# Idempotent env push: remove then add, so re-runs don't error on existing keys.
push_env() {
  local key="$1" val="$2"
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$val" | vercel env add "$key" production >/dev/null
  echo "  · $key"
}

echo "→ Pushing production environment…"
push_env TF_MODE               "PAPER"
push_env UPSTOX_API_KEY        "$UPSTOX_API_KEY"
push_env TF_WEBHOOK_SECRET     "$TF_WEBHOOK_SECRET"
push_env TF_ENGINE_TOKEN       "$TF_ENGINE_TOKEN"
push_env TF_ENGINE_URL         "$TF_ENGINE_URL"

echo "→ Deploying…"
DEPLOY_URL="$(vercel deploy --prod --yes 2>&1 | tail -1)"
HOST="${DEPLOY_URL#https://}"

# The redirect URI must match what Upstox has registered, so set it last,
# once the hostname is known, then redeploy to pick it up.
push_env UPSTOX_REDIRECT_URI "https://${HOST}/api/auth/callback"
vercel deploy --prod --yes >/dev/null 2>&1

cat <<REPORT

────────────────────────────────────────────────────────────────────────
  Deployed: https://${HOST}
────────────────────────────────────────────────────────────────────────

Paste these into https://account.upstox.com/developer/apps

  Redirect URI
    https://${HOST}/api/auth/callback

  Webhook URL  (enable "Order updates" AND "GTT order updates")
    https://${HOST}/api/webhooks/upstox/order/${TF_WEBHOOK_SECRET}

  Notifier URL (postback for the semi-automated daily token flow)
    https://${HOST}/api/webhooks/upstox/token/${TF_WEBHOOK_SECRET}

  Health check
    https://${HOST}/api/health

⚠  Upstox sends webhooks UNAUTHENTICATED — no HMAC, no signature, no IP
   allowlist. The path secret above is the only thing guarding these
   endpoints. Treat the full URLs as credentials: never commit, never share,
   never paste into a chat or an issue tracker.

REPORT
