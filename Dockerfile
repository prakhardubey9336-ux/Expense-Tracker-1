# SmartSpend — container image
# ---------------------------------------------------------------------------
# Why this file exists: platforms like Render, Railway, Fly.io and Koyeb run a
# *program*, not a folder of files. GitHub Pages only serves static files, so it
# can never run this app (no /api, no SQLite). See docs/DEPLOY.md.
#
# Build and run locally:
#   docker build -t smartspend .
#   docker run -p 3000:3000 -v smartspend-data:/data smartspend
#
# better-sqlite3 is a native module, so the build stage needs a compiler.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

# Tools needed to compile better-sqlite3 if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first: this layer is cached while only source files change.
COPY package*.json ./
RUN npm install --omit=dev

# The rest of the project.
COPY . .

# Keep the database on a mounted volume so it survives a redeploy
# (mount /data; SQLite writes <dir>/<name>.db plus -wal/-shm files).
ENV SMARTSPEND_DB=/data/expense-tracker.db
ENV NODE_ENV=production
RUN mkdir -p /data

EXPOSE 3000

# A tiny health check so the host knows when the app is really up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
