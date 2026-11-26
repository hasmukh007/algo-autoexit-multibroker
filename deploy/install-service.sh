#!/bin/sh
set -eu

SERVICE_NAME="algo-autoexit"
RESTART_UNIT="${SERVICE_NAME}-restart"
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
RUN_USER="root"
RUN_GROUP="root"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node binary not found in PATH." >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
RESTART_SERVICE_PATH="/etc/systemd/system/${RESTART_UNIT}.service"
RESTART_TIMER_PATH="/etc/systemd/system/${RESTART_UNIT}.timer"

echo "Installing ${UNIT_PATH} for ${APP_DIR} (user=${RUN_USER}, node=${NODE_BIN})..."

sudo tee "$UNIT_PATH" > /dev/null <<EOF
[Unit]
Description=Multi-Broker Algo Auto-Exit Terminal (Kotak Neo, Angel One, Dhan)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
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

echo "Installing daily 8:55 AM IST restart timer (${RESTART_TIMER_PATH})..."

sudo tee "$RESTART_SERVICE_PATH" > /dev/null <<EOF
[Unit]
Description=Daily 8:55 AM IST Restart of Algo Auto-Exit Terminal

[Service]
Type=oneshot
ExecStart=/bin/systemctl restart ${SERVICE_NAME}.service
EOF

sudo tee "$RESTART_TIMER_PATH" > /dev/null <<EOF
[Unit]
Description=Restart Algo Auto-Exit Terminal Daily at 8:55 AM IST

[Timer]
OnCalendar=*-*-* 08:55:00 Asia/Kolkata
Persistent=false

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"
sudo systemctl enable --now "${RESTART_UNIT}.timer"
sudo systemctl status "${SERVICE_NAME}.service" --no-pager
sudo systemctl list-timers "${RESTART_UNIT}.timer" --no-pager
