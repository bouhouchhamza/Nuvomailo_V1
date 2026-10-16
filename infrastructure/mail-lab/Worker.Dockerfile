FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build
COPY backend/migrations ./migrations
COPY infrastructure/mail-lab/seed.sql /lab/seed.sql
# COPY already creates world-readable code; do not duplicate all dependency layers with chmod.
RUN chmod a+rX /lab /lab/seed.sql
USER 1000:3000
