#!/usr/bin/env bash
# Deploy TradeForger directly to Hostinger VPS using Docker & Hostinger MCP / SSH.
# Completely bypasses GitHub: secrets stay strictly on your Hostinger VPS and your local machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "================================================================="
echo "   TradeForger Direct Deploy to Hostinger VPS"
echo "================================================================="

# 1. Environment Loading (Local fallback only)
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

HOSTINGER_VPS_HOST="${HOSTINGER_VPS_HOST:-${1:-}}"
HOSTINGER_VPS_USER="${HOSTINGER_VPS_USER:-root}"
HOSTINGER_DOMAIN="${HOSTINGER_DOMAIN:-${HOSTINGER_VPS_HOST:-localhost}}"

# 1b. Never restart the engine mid-session. A deploy recreates the engine:
# LIVE comes back disarmed, open positions are re-adopted, and on 26 Nov five
# market-hours deploys left the engine re-arming instead of trading.
IST_DOW=$(TZ=Asia/Kolkata date +%u)
IST_HHMM=$(TZ=Asia/Kolkata date +%H%M)
if [[ "$IST_DOW" -le 5 && "$IST_HHMM" -ge 0900 && "$IST_HHMM" -le 1535 && "${FORCE_DEPLOY:-}" != "1" ]]; then
  echo ""
  echo "✗ NSE market hours (IST $(TZ=Asia/Kolkata date +%H:%M)) — a deploy would restart the trading engine mid-session."
  echo "  Deploy after 15:35 IST, or set FORCE_DEPLOY=1 if it cannot wait."
  exit 1
fi

# 2. Pre-flight Verification
echo ""
echo "→ [1/4] Running Local Quality Checks..."

echo "  · Typecheck..."
npx tsc --noEmit

echo "  · Test suite..."
npx vitest run

echo "✓ All local pre-flight tests passed!"

# 3. Hostinger Target Resolution
echo ""
echo "→ [2/4] Verifying Hostinger VPS Configuration..."

if [[ -z "$HOSTINGER_VPS_HOST" ]]; then
  echo "⚠ HOSTINGER_VPS_HOST is not set."
  echo ""
  echo "  Provide your Hostinger VPS IP address or domain:"
  echo "    Usage: ./scripts/deploy-hostinger.sh <your-hostinger-vps-ip>"
  echo "    Or set: export HOSTINGER_VPS_HOST=<your-hostinger-vps-ip>"
  echo ""
  exit 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "${HOSTINGER_SSH_KEY:-}" ]]; then
  KEY_FILE=$(mktemp)
  printf "%s\n" "$HOSTINGER_SSH_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  SSH_OPTS+=(-i "$KEY_FILE")
fi

TARGET_DIR="/opt/tradeforger"
echo "  · Target Host: ${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}"
echo "  · Deploy Directory: ${TARGET_DIR}"

# 4. Sync Code & Preserve Hostinger .env
echo ""
echo "→ [3/4] Deploying to Hostinger VPS..."

# Ensure target directory exists on VPS
ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" "mkdir -p ${TARGET_DIR}"

echo "  · Synchronizing project code (excluding secrets, node_modules, .git)..."
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude '.env*' \
  --exclude '.secrets.local' \
  --exclude 'data/*.json.gz' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}:${TARGET_DIR}/"

# Check if .env exists on Hostinger VPS
echo "  · Checking .env file on Hostinger VPS..."
ENV_EXISTS=$(ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" \
  "test -f ${TARGET_DIR}/.env && echo 'yes' || echo 'no'")

if [[ "$ENV_EXISTS" == "yes" ]]; then
  echo "  ✓ Existing ${TARGET_DIR}/.env found on Hostinger VPS. Preserving it untouched."
else
  echo "  ⚠ No .env found at ${TARGET_DIR}/.env on Hostinger VPS."
  if [[ -f .env ]]; then
    echo "  → Uploading your local .env directly to Hostinger VPS..."
    scp "${SSH_OPTS[@]}" .env "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}:${TARGET_DIR}/.env"
    ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" "chmod 600 ${TARGET_DIR}/.env"
    echo "  ✓ Local .env securely uploaded to ${TARGET_DIR}/.env on Hostinger!"
  else
    echo "  → Creating initial .env template on Hostinger VPS from .env.example..."
    ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" bash -s <<REMOTE_INIT
cp ${TARGET_DIR}/.env.example ${TARGET_DIR}/.env
TF_SECRET=\$(openssl rand -hex 32)
TF_TOKEN=\$(openssl rand -hex 32)
sed -i.bak "s/^TF_WEBHOOK_SECRET=.*/TF_WEBHOOK_SECRET=\$TF_SECRET/" ${TARGET_DIR}/.env
sed -i.bak "s/^TF_ENGINE_TOKEN=.*/TF_ENGINE_TOKEN=\$TF_TOKEN/" ${TARGET_DIR}/.env
sed -i.bak "s/^TF_MODE=.*/TF_MODE=PAPER/" ${TARGET_DIR}/.env
chmod 600 ${TARGET_DIR}/.env
rm -f ${TARGET_DIR}/.env.bak
REMOTE_INIT
    echo "  ✓ Initial template created at ${TARGET_DIR}/.env. You can edit it directly on Hostinger VPS."
  fi
fi

# Postgres holds the position journal; compose refuses to start without a password.
ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" \
  "grep -q '^POSTGRES_PASSWORD=.\\+' ${TARGET_DIR}/.env || { sed -i '/^POSTGRES_PASSWORD=/d' ${TARGET_DIR}/.env; echo \"POSTGRES_PASSWORD=\$(openssl rand -hex 24)\" >> ${TARGET_DIR}/.env; echo '  ✓ Generated POSTGRES_PASSWORD on the VPS'; }"

# 5. Build and Run Containers on Hostinger
echo "  · Rebuilding and launching Docker containers on Hostinger VPS..."
ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" \
  "cd ${TARGET_DIR} && docker compose down --remove-orphans && docker compose up -d --build"

echo "✓ Containers are up and running on Hostinger!"

# 6. Verification & Upstox Callback URLs
echo ""
echo "→ [4/4] Verifying Deployment..."
sleep 3
WEBHOOK_SECRET=$(ssh "${SSH_OPTS[@]}" "${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST}" \
  "grep '^TF_WEBHOOK_SECRET=' ${TARGET_DIR}/.env | cut -d= -f2" || echo "YOUR_SECRET")

cat <<REPORT

────────────────────────────────────────────────────────────────────────
  TradeForger Deployed to Hostinger VPS!
  Server IP / Domain: ${HOSTINGER_VPS_HOST}
────────────────────────────────────────────────────────────────────────

Direct VPS Management:
  • Edit .env directly on Hostinger:
      ssh ${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST} "nano ${TARGET_DIR}/.env"
      (or edit in Hostinger hPanel File Manager at ${TARGET_DIR}/.env)

  • View live logs:
      ssh ${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST} "cd ${TARGET_DIR} && docker compose logs -f"

  • Restart services:
      ssh ${HOSTINGER_VPS_USER}@${HOSTINGER_VPS_HOST} "cd ${TARGET_DIR} && docker compose restart"

────────────────────────────────────────────────────────────────────────
Upstox Developer App Settings (https://account.upstox.com/developer/apps):

  1. Redirect URI:
     http://${HOSTINGER_VPS_HOST}:3000/api/auth/callback
     (or https://${HOSTINGER_DOMAIN}/api/auth/callback if using a domain)

  2. Webhook URL (Order updates + GTT updates):
     http://${HOSTINGER_VPS_HOST}:3000/api/webhooks/upstox/order/${WEBHOOK_SECRET}

  3. Notifier URL (daily token flow):
     http://${HOSTINGER_VPS_HOST}:3000/api/webhooks/upstox/token/${WEBHOOK_SECRET}

  4. Allowlist IP in Upstox Developer App:
     Add your Hostinger VPS IP: ${HOSTINGER_VPS_HOST}

REPORT
