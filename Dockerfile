# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
RUN npm ci

# Copy source and build
COPY packages/shared ./packages/shared
COPY apps/frontend ./apps/frontend
RUN npm run build --workspace=apps/frontend

# Stage 2: Runtime — backend serves both API and built frontend
FROM node:22-alpine AS runtime
WORKDIR /app

# tzdata: Alpine's musl libc has no built-in zoneinfo database, so without this
# package a named TZ (e.g. America/Phoenix) silently fails to resolve and Date's
# local-time getters fall back to UTC — the exact bug this image's TZ env var
# (see docker-compose.yml) exists to fix. See routes/helpers.ts's todayLocal().
RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/backend/package.json ./apps/backend/
# frontend package.json needed for workspace resolution
COPY apps/frontend/package.json ./apps/frontend/
RUN npm ci

COPY packages/shared/src ./packages/shared/src
COPY apps/backend ./apps/backend
COPY --from=frontend-builder /app/apps/frontend/dist ./apps/frontend/dist

EXPOSE 3000
WORKDIR /app/apps/backend
CMD ["npm", "run", "start"]
