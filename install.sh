#!/usr/bin/env bash
# BD Automation Suite — Local Runner Installer
# Usage: BRAINS_TOKEN=<token> CC_BOARD_ID=<id> bash install.sh
set -euo pipefail

BRAINS_TOKEN="${BRAINS_TOKEN:?BRAINS_TOKEN env var is required}"
CC_BOARD_ID="${CC_BOARD_ID:?CC_BOARD_ID env var is required}"

INSTALL_DIR="$HOME/.bd-suite"
REPO_RAW="https://raw.githubusercontent.com/matty1335/bd-suite/main"
ENV_FILE="$INSTALL_DIR/.linkedin-runner.env"

echo ""
echo "BD Automation Suite — Local Runner Setup"
echo "========================================"
echo ""
echo "This installs two background processes on your machine:"
echo "  linkedin-runner  — executes LinkedIn outreach via a local Playwright browser"
echo "  agent4-bd        — detects completed meetings, queues notes for your CRM"
echo ""
echo "Both processes run only on this machine. They communicate with your Brains"
echo "workspace via API. Your LinkedIn session and Google credentials never leave"
echo "this computer — only your Brains token is sent over the network."
echo ""

# [1] Check Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Install Node 18+ from https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required. Found: $(node --version)"
  exit 1
fi
echo "[1/6] Node.js $(node --version) — OK"

# [2] Install PM2 if missing
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[2/6] Installing PM2 (process manager)..."
  npm install -g pm2 --quiet
else
  echo "[2/6] PM2 $(pm2 --version) — OK"
fi

# [3] Create install directory
mkdir -p "$INSTALL_DIR"
echo "[3/6] Install directory: $INSTALL_DIR"

# [4] Download runners and login helper
echo "[4/6] Downloading runners..."
curl -fsSL "$REPO_RAW/linkedin-runner.mjs" -o "$INSTALL_DIR/linkedin-runner.mjs"
curl -fsSL "$REPO_RAW/agent4-local.mjs"    -o "$INSTALL_DIR/agent4-local.mjs"
curl -fsSL "$REPO_RAW/login.mjs"           -o "$INSTALL_DIR/login.mjs"
echo "      Runners downloaded OK"

# Install Node dependencies (Playwright must be local to the runner directory)
echo "      Installing dependencies (Playwright — this may take a few minutes)..."
cd "$INSTALL_DIR"
if [ ! -f "package.json" ]; then
  echo '{"name":"bd-suite","version":"1.0.0","type":"module"}' > package.json
fi
if [ ! -d "node_modules/playwright" ]; then
  npm install playwright --quiet >/dev/null 2>&1
fi
npx playwright install chromium >/dev/null 2>&1
echo "      Playwright ready"

# [5] Write .env config file
echo "[5/6] Writing config to $ENV_FILE"
cat > "$ENV_FILE" <<EOF
BRAINS_TOKEN=${BRAINS_TOKEN}
CC_BOARD_ID=${CC_BOARD_ID}
BOT_TOKEN=
EOF

echo ""
echo "  NOTE: BOT_TOKEN is empty. Telegram approval notifications require a bot token."
echo "  To add one:"
echo "    1. Open Telegram -> message @BotFather -> /newbot -> copy the token"
echo "    2. Edit: $ENV_FILE"
echo "    3. Run:  pm2 restart linkedin-runner"
echo ""

# [6] Start runners with PM2 (idempotent — delete any existing first)
echo "[6/6] Starting runners..."
pm2 delete linkedin-runner >/dev/null 2>&1 || true
pm2 delete agent4-bd       >/dev/null 2>&1 || true

pm2 start "$INSTALL_DIR/linkedin-runner.mjs" \
  --name linkedin-runner \
  --cwd  "$INSTALL_DIR" \
  --interpreter node

pm2 start "$INSTALL_DIR/agent4-local.mjs" \
  --name agent4-bd \
  --cwd  "$INSTALL_DIR" \
  --interpreter node \
  --cron "*/5 * * * *" \
  --no-autorestart

pm2 save --force >/dev/null 2>&1
echo ""
echo "Runners started."
pm2 list --no-color 2>/dev/null | grep -E "linkedin-runner|agent4-bd" || true

echo ""
echo "====================================================="
echo "Setup complete!"
echo "====================================================="
echo ""
echo "Required next step — connect your LinkedIn account:"
echo "  cd $INSTALL_DIR && node login.mjs"
echo ""
echo "Monitor logs:"
echo "  pm2 logs linkedin-runner    # LinkedIn runner"
echo "  pm2 logs agent4-bd          # Meeting intel"
echo ""
echo "Your CC dashboard will show both runners as ONLINE"
echo "within a few minutes once the heartbeat fires."
echo ""
