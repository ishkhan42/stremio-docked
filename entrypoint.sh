#!/bin/bash
set -e

CONFIG_DIR="${APP_PATH:-/root/.stremio-server}"

echo "=== stremio-docked starting ==="
echo "Config dir: $CONFIG_DIR"

# ── Validate / prepare stremio-server config ─────────────────────────────
mkdir -p "$CONFIG_DIR"

# On first run, populate the server localStorage with our pre-baked config
if [ ! -f "$CONFIG_DIR/server.js.localStorage" ]; then
  echo "First run: installing default stremio-server settings..."
  cp /srv/stremio-server/server-localStorage.json "$CONFIG_DIR/server.js.localStorage"
fi

# Print GPU availability info (for debugging)
if [ -e /dev/dri/renderD128 ]; then
  echo "GPU device found at /dev/dri/renderD128 - hardware transcode may be available"
else
  echo "No /dev/dri/renderD128 found - stremio-server will use software transcode"
fi

# ── Start stremio-server ────────────────────────────────────────────────────
cd /srv/stremio-server
echo "Starting stremio-server on :11470..."
node server.js &
STREMIO_PID=$!

# Wait for stremio-server to be ready (up to 30s)
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:11470/local-addon/manifest.json >/dev/null 2>&1; then
    echo "stremio-server is ready."
    break
  fi
  echo "Waiting for stremio-server... ($i/30)"
  sleep 1
done

# ── Start Express backend ────────────────────────────────────────────────────
cd /srv/backend
echo "Starting backend API on :3001..."
STREMIO_SERVER_URL="http://127.0.0.1:11470" node index.js &
BACKEND_PID=$!

# ── Start nginx ──────────────────────────────────────────────────────────────
echo "Starting nginx on :8080..."
nginx -g "daemon off;" &
NGINX_PID=$!

echo "=== All services started ==="
echo "UI:           http://[HOST]:8080/"
echo "API backend:  http://127.0.0.1:3001"
echo "Stremio server: http://127.0.0.1:11470"

# Monitor child processes; exit if any die unexpectedly
wait -n $STREMIO_PID $BACKEND_PID $NGINX_PID
EXIT_CODE=$?
echo "A process exited with code $EXIT_CODE – shutting down."
kill $STREMIO_PID $BACKEND_PID $NGINX_PID 2>/dev/null || true
exit $EXIT_CODE
