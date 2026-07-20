# --- Build frontend ---
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Backend runtime ---
FROM node:20-slim AS runtime
WORKDIR /app
# better-sqlite3 needs build tools to compile its native binding
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist ./public

ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
