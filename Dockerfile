# ─── Stage 1: Build Svelte UI ───────────────────────────────────────────────
FROM node:20-alpine AS ui-builder

WORKDIR /build/ui
COPY ui/package*.json ./
RUN npm install

COPY ui/ ./
RUN npm run build

# ─── Stage 2: Final image ────────────────────────────────────────────────────
FROM node:20-alpine AS final

# Install nginx, curl, ffmpeg (apk), va-api for Intel/AMD GPU
RUN apk add --no-cache \
    nginx \
    curl \
    bash \
    ffmpeg \
    libva \
    libva-utils \
    && rm -rf /var/cache/apk/*

# Optionally add Intel media driver for VAAPI (x86_64 only)
RUN if [ "$(uname -m)" = "x86_64" ]; then \
      apk add --no-cache intel-media-driver mesa-va-gallium 2>/dev/null || true; \
    fi

# ── stremio-server ──────────────────────────────────────────────────────────
WORKDIR /srv/stremio-server

# Download the official stremio server binary
RUN SERVER_URL=$(curl -sf https://raw.githubusercontent.com/Stremio/stremio-shell/master/server-url.txt) \
    && echo "Downloading stremio-server from: $SERVER_URL" \
    && curl -fL "$SERVER_URL" -o server.js \
    && echo "Server downloaded."

# Fix Alpine df command compatibility
RUN sed -i 's/df -k/df -Pk/g' server.js

COPY server-localStorage.json /srv/stremio-server/

# ── Express backend ──────────────────────────────────────────────────────────
WORKDIR /srv/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./

# ── Static UI ────────────────────────────────────────────────────────────────
COPY --from=ui-builder /build/ui/dist /srv/ui/dist

# ── nginx config ─────────────────────────────────────────────────────────────
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/default.conf /etc/nginx/http.d/default.conf

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/root/.stremio-server"]

EXPOSE 8080

CMD ["/entrypoint.sh"]
