# Hostinger Deployment Guide (Direct VPS)

Deploy TradeForger directly to your **Hostinger VPS** using Docker Compose. All secrets and `.env` settings remain strictly on your Hostinger server and your local machine — **no secrets on GitHub, no GitHub Actions CI/CD needed**.

---

## 1. How to Add and Edit `.env` Directly on Hostinger

You can add/edit your `.env` directly on your Hostinger server without using GitHub at all:

### Option A: Using Hostinger hPanel
1. Log in to [Hostinger hPanel](https://hpanel.hostinger.com).
2. Go to **VPS** $\to$ Select your VPS.
3. Open **File Manager** (or **Browser Terminal**).
4. Navigate to `/opt/tradeforger/.env`.
5. Edit your values directly and save.

### Option B: Via SSH from your terminal
Run this one command from your local machine to open and edit `.env` directly on your VPS:
```bash
ssh root@<YOUR_HOSTINGER_VPS_IP> "nano /opt/tradeforger/.env"
```

### Option C: Automatic 1-Time Upload via Deploy Script
If you already have a local `.env` file on your computer, the deploy script can copy it directly to your VPS over secure SSH on the first deploy.

---

## 2. Deploying with the Deploy Script

Run the deployment script from your project root:

```bash
./scripts/deploy-hostinger.sh <YOUR_HOSTINGER_VPS_IP>
```
*(Or set `export HOSTINGER_VPS_HOST=<YOUR_HOSTINGER_VPS_IP>` and run `npm run deploy:hostinger`)*

### What the deploy script does:
0. **Refuses during NSE market hours** (Mon–Fri 09:00–15:35 IST): a deploy restarts the engine, which comes back with LIVE disarmed. Override with `FORCE_DEPLOY=1` only if it cannot wait.
1. **Tests locally**: Runs `npm run typecheck` and `npm test` (all 435 tests).
2. **Syncs code**: Copies project files to `/opt/tradeforger` on your VPS, strictly ignoring secrets (`.env*`, `.secrets.local`, `.git`).
3. **Preserves `.env`**: If `/opt/tradeforger/.env` already exists on Hostinger, the script leaves it untouched so your server settings are never overwritten.
4. **Starts Docker**: Runs `docker compose up -d --build` on Hostinger VPS.
5. **Prints URLs**: Displays the exact Redirect URI and Webhook URLs to paste into Upstox.

---

## 3. Managing the App on Hostinger

Once deployed, you can manage the application on your VPS anytime:

```bash
# View live application logs
ssh root@<HOSTINGER_VPS_IP> "cd /opt/tradeforger && docker compose logs -f"

# Restart application
ssh root@<HOSTINGER_VPS_IP> "cd /opt/tradeforger && docker compose restart"

# Check container status
ssh root@<HOSTINGER_VPS_IP> "docker ps"
```

---

## 4. Upstox Developer App Configuration

Paste these into <https://account.upstox.com/developer/apps>:

- **Redirect URI**:
  ```
  http://<HOSTINGER_VPS_IP>:3000/api/auth/callback
  ```
- **Webhook URL** (Enable "Order updates" AND "GTT order updates"):
  ```
  http://<HOSTINGER_VPS_IP>:3000/api/webhooks/upstox/order/<TF_WEBHOOK_SECRET>
  ```
- **Notifier URL**:
  ```
  http://<HOSTINGER_VPS_IP>:3000/api/webhooks/upstox/token/<TF_WEBHOOK_SECRET>
  ```
- **Static IP Allowlist**:
  Add your Hostinger VPS IP address so that Upstox authorizes live order execution without `UDAPI1221`.
