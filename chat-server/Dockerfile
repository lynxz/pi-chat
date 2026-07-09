# chat-server/Dockerfile.
#
# Zero-runtime-dep Node 20 image. The `chat-server/` ships with no
# third-party packages, so we don't need an `npm install` step (and so the
# image stays tiny, ~50 MB). We do COPY package.json explicitly so
# downstream tooling (dependabot, runtime introspection) can pick it up.

FROM node:20-alpine

# OCI labels — match the conventions in the project README so the image is
# discoverable from `docker inspect`.
LABEL org.opencontainers.image.title="pi-chat-server" \
      org.opencontainers.image.description="Minimal HTTP+SSE chat server for the pi-chat multi-agent extension." \
      org.opencontainers.image.licenses="(see project LICENSE)" \
      org.opencontainers.image.source="https://github.com/example/pi-chat" \
      org.opencontainers.image.documentation="https://github.com/example/pi-chat/blob/main/chat-server/README.md"

WORKDIR /app

# Copy package metadata first (cache-friendly) and then sources.
COPY package.json ./
COPY server.js ./
COPY lib ./lib

# There's nothing to install (`package.json` declares no dependencies).
# The dev-time test framework is `node:test` — already shipped with Node.

# Default port; overridable via CHAT_PORT at runtime. `EXPOSE` is documentation
# only; publish the actual mapping via docker-compose or `docker run -p`.
EXPOSE 8080

# Healthcheck uses Node's built-in `fetch` (Node 18+) — no curl/wget needed.
# Reads CHAT_PORT from the environment so the URL matches the actual bind
# port when the operator overrides it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CHAT_PORT||8080)+'/health').then(r=>{process.exit(r.status===200?0:1)}).catch(()=>process.exit(1))"

# Drop root — the upstream `node:20-alpine` ships a `node` user (UID 1000).
USER node

# `server.js` auto-listens when invoked directly (see the `_isMain` guard
# in the server entry point). Use the array form so it survives signals.
CMD ["node", "server.js"]
