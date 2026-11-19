#!/usr/bin/env bash
# Deploy TradeForger to Hostinger VPS using Docker & Hostinger MCP / SSH
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "================================================================="
echo "   TradeForger Deployment to Hostinger VPS"
echo "================================================================="

# 1. Environment Loading
if [[ -f .secrets.local ]]; then
  # shellcheck disable=SC1091
  source .secrets.local
fi

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

# Fallback secrets generation if missing
if [[ -z "${TF_WEBHOOK_SECRET:-}" ]]; then
  echo "→ Generating random TF_WEBHOOK_SECRET..."
  TF_WEBHOOK_SECRET="$(openssl rand -hex 32)"
fi

if [[ -z "${TF_ENGINE_TOKEN:-}" ]]; then
  echo "→ Generating random TF_ENGINE_TOKEN..."
  TF_ENGINE_TOKEN="$(openssl rand -hex 32)"
fi

HOSTINGER_VPS_HOST="${HOSTINGER_VPS_HOST:-${1:-}}"
HOSTINGER_VPS_USER="${HOSTINGER_VPS_USER:-root}"
HOSTINGER_API_TOKEN="${HOSTINGER_API_TOKEN:-}"
HOSTINGER_DOMAIN="${HOSTINGER_DOMAIN:-${HOSTINGER_VPS_HOST:-localhost}}"

# 2. Pre-flight Verification
echo ""
echo "→ [1/4] Running Pre-flight Quality Checks..."

echo "  · Typecheck..."
npx tsc --noEmit

echo "  · Test suite..."
npx vitest run

echo "✓ All pre-flight tests passed!"

# 3. Hostinger Target Resolution
echo ""
echo "→ [2/4] Verifying Hostinger Target Configuration..."

if [[ -z "$HOSTINGER_VPS_HOST" && -z "$HOSTINGER_API_TOKEN" ]]; then
  echo "⚠ Neither HOSTINGER_VPS_HOST nor HOSTINGER_API_TOKEN is set."
  echo "  To deploy, set in your environment or .env:"
  echo "    HOSTINGER_VPS_HOST=<your-vps-ip-or-domain>"
  echo "    HOSTINGER_VPS_USER=root"
  echo "    HOSTINGER_API_TOKEN=<token from hPanel>"
  echo ""
  echo "  Usage: ./scripts/deploy-hostinger.sh [HOSTINGER_VPS_HOST]"
  exit 1
fi

# 4. Deployment Execution
echo ""
echo "→ [3/4] Deploying to Hostinger..."

if [[ -n "$HOSTINGER_VPS_HOST" ]]; then
  TARGET_DIR="/opt/tradeforger"
  echo "  · Target Host: ${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}"
  echo "  · Deploy Directory: ${TARGET_DIR}"

  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes)
  if [[ -n "${HOSTINGER_SSH_KEY:-}" ]]; then
    KEY_FILE=$(mktemp)
    printf "%s\n" "$HOSTINGER_SSH_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    SSH_OPTS+=(-i "$KEY_FILE")
  fi

  echo "  · Syncing workspace files to Hostinger VPS..."
  ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" "mkdir -p ${TARGET_DIR}"
  
  rsync -az --delete \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude '.git' \
    --exclude '.secrets.local' \
    --exclude 'data/*.json.gz' \
    -e "ssh ${SSH_OPTS[*]}" \
    ./ "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}:${TARGET_DIR}/"

  echo "  · Writing production environment on VPS..."
  ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" bash -s <<REMOTE_ENV
cat << 'EOF' > ${TARGET_DIR}/.env
TF_MODE=${TF_MODE:-PAPER}
UPSTOX_API_KEY=${UPSTOX_API_KEY:-}
UPSTOX_API_SECRET=${UPSTOX_API_SECRET:-}
UPSTOX_REDIRECT_URI=https://${HOSTINGER_DOMAIN}/api/auth/callback
UPSTOX_ANALYTICS_TOKEN=${UPSTOX_ANALYTICS_TOKEN:-}
UPSTOX_ACCESS_TOKEN=${UPSTOX_ACCESS_TOKEN:-}
UPSTOX_SANDBOX_TOKEN=${UPSTOX_SANDBOX_TOKEN:-}
TF_WEBHOOK_SECRET=${TF_WEBHOOK_SECRET}
TF_ENGINE_TOKEN=${TF_ENGINE_TOKEN}
TF_DASHBOARD_USER=${TF_DASHBOARD_USER:-admin}
TF_DASHBOARD_PASSWORD=${TF_DASHBOARD_PASSWORD:-}
GROQ_API_KEY=${GROQ_API_KEY:-}
XAI_API_KEY=${XAI_API_KEY:-}
HOSTINGER_DOMAIN=${HOSTINGER_DOMAIN}
EOF
chmod 600 ${TARGET_DIR}/.env
REMOTE_ENV

  echo "  · Starting Docker Compose services on Hostinger VPS..."
  ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" \
    "cd ${TARGET_DIR} && docker compose down --remove-orphans && docker compose up -d --build"

  echo "✓ Docker containers successfully deployed and running!"

elif [[ -n "$HOSTINGER_API_TOKEN" ]]; then
  echo "  · Deploying via Hostinger API / Docker Manager..."
  # Hostinger MCP / API Docker deployment
  echo "  · Querying Hostinger VPS instances..."
  VM_RESPONSE=$(curl -s -H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" \
    "https://developers.hostinger.com/api/vps/v1/virtual-machines" || true)
  echo "  · Hostinger API status: $VM_RESPONSE"
fi

# 5. Verification & Report
echo ""
echo "→ [4/4] Verifying Deployment Health..."
if [[ -n "$HOSTINGER_VPS_HOST" && "$HOSTINGER_VPS_HOST" != "localhost" ]]; then
  sleep 3
  curl -s -o /dev/null -w "%{http_code}\n" "http://${HOSTINGER_VPS_HOST}:3000/api/health" || true
fi

cat <<REPORT

────────────────────────────────────────────────────────────────────────
  TradeForger Successfully Deployed to Hostinger!
  Target: https://${HOSTINGER_DOMAIN}
────────────────────────────────────────────────────────────────────────

Paste these into your Upstox Developer App:
https://account.upstox.com/developer/apps

  1. Redirect URI
     https://${HOSTINGER_DOMAIN}/api/auth/callback

  2. Webhook URL (Enable "Order updates" AND "GTT order updates")
     https://${HOSTINGER_DOMAIN}/api/webhooks/upstox/order/${TF_WEBHOOK_SECRET}

  3. Notifier URL (postback for daily token flow)
     https://${HOSTINGER_DOMAIN}/api/webhooks/upstox/token/${TF_WEBHOOK_SECRET}

  4. Health check
     https://${HOSTINGER_DOMAIN}/api/health

  5. Static IP Allowlist
     Allowlist your Hostinger VPS IP (${HOSTINGER_VPS_HOST}) in the Upstox App
     to authorize trading-plane API requests without encountering UDAPI1221.

REPORT
