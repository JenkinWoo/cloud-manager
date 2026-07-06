FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

COPY package.json ../package.json
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM node:22-bookworm-slim AS backend-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY backend ./backend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

EXPOSE 3001

CMD ["node", "backend/server.mjs"]
