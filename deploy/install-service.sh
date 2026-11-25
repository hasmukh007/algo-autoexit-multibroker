#!/bin/sh
set -eu

SERVICE_NAME="algo-autoexit"
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "$RUN_USER")"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node binary not found in PATH." >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Installing ${UNIT_PATH} for ${APP_DIR} (user=${RUN_USER}, node=${NODE_BIN})..."

sudo tee "$UNIT_PATH" > /dev/null <<EOF
[Unit]
Description=Multi-Broker Algo Auto-Exit Terminal (Kotak Neo, Angel One, Dhan)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=TZ=Asia/Kolkata
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"
sudo systemctl status "${SERVICE_NAME}" --no-pager
