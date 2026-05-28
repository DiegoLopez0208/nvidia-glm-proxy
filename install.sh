#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_SRC="$SCRIPT_DIR/nvidia-glm-proxy.service"
SERVICE_DEST="$HOME/.config/systemd/user/nvidia-glm-proxy.service"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "=== nvidia-glm-proxy installer ==="

echo "[1/4] Installing systemd user service..."
mkdir -p "$SYSTEMD_DIR"
sed "s|__INSTALL_DIR__|$SCRIPT_DIR|g" "$SERVICE_SRC" > "$SERVICE_DEST"

echo "[2/4] Reloading systemd daemon..."
systemctl --user daemon-reload

echo "[3/4] Enabling and starting nvidia-glm-proxy..."
systemctl --user enable nvidia-glm-proxy.service
systemctl --user restart nvidia-glm-proxy.service

echo "[4/4] Verifying proxy is running..."
sleep 2
if curl -sf http://127.0.0.1:9999/health > /dev/null 2>&1; then
  echo ""
  echo "SUCCESS: nvidia-glm-proxy is running at http://127.0.0.1:9999"
  echo ""
  echo "Next step: update your client config (e.g. opencode, claude):"
  echo '  Change: "baseURL": "https://integrate.api.nvidia.com/v1"'
  echo '  To:     "baseURL": "http://127.0.0.1:9999/v1"'
else
  echo ""
  echo "FAILED: nvidia-glm-proxy did not start successfully" >&2
  echo "Check logs with: journalctl --user -u nvidia-glm-proxy --no-pager -n 30" >&2
  systemctl --user status nvidia-glm-proxy.service >&2 || true
  exit 1
fi
