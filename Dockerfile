# ── TACO API (NestJS) — 멀티스테이지 빌드 ──
# 로컬: docker compose up --build  (→ http://localhost:3001/api, 문서 /docs)
# AWS: 동일 이미지를 ECR push 후 ECS/EC2에서 실행. BASE_URL은 프론트 env로 전환.

# 1) build — devDependencies 포함, dist 생성
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# 2) runtime — 프로덕션 의존성만, dist 실행
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3001
# 헬스체크: /api/health
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:${PORT}/api/health || exit 1
CMD ["node", "dist/main.js"]
