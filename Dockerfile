# owner 승인 요청을 컨테이너 밖으로 내보내기 전에 암호화하는 고정 도구
FROM alpine:3.22 AS age-tool

ARG AGE_VERSION=1.3.1
ARG TARGETARCH
ARG AGE_LINUX_AMD64_SHA256=bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377
ARG AGE_LINUX_ARM64_SHA256=c6878a324421b69e3e20b00ba17c04bc5c6dab0030cfe55bf8f68fa8d9e9093a

RUN case "${TARGETARCH}" in \
      amd64) age_sha256="${AGE_LINUX_AMD64_SHA256}" ;; \
      arm64) age_sha256="${AGE_LINUX_ARM64_SHA256}" ;; \
      *) exit 64 ;; \
    esac \
  && wget -q \
      "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-${TARGETARCH}.tar.gz" \
      -O /tmp/age.tar.gz \
  && printf '%s  %s\n' "${age_sha256}" /tmp/age.tar.gz \
      | sha256sum -c - \
  && tar -xzf /tmp/age.tar.gz -C /tmp \
  && install -m 755 /tmp/age/age /age

# Node.js 22 Alpine 기반 경량 이미지
FROM node:22-alpine AS builder

# 작업 디렉토리 설정
WORKDIR /app

# package.json과 package-lock.json 복사
COPY package*.json ./

# 모든 의존성 설치 (devDependencies 포함 - TypeScript 빌드 필요)
RUN npm ci

# 소스 코드 복사
COPY . .

# TypeScript 빌드
RUN npm run build

# 불필요한 devDependencies 제거 (이미지 크기 최적화)
RUN npm prune --omit=dev

# 프로덕션 이미지
FROM node:22-alpine AS production

ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG IMAGE_TAG=local

LABEL org.opencontainers.image.revision="${GIT_SHA}"

# 작업 디렉토리 설정
WORKDIR /app

# 필요한 파일만 복사
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/data ./data
COPY --from=age-tool /age /usr/local/bin/age

# 비특권 사용자로 실행
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001 -G nodejs
RUN test "$(id -u nodejs):$(id -g nodejs)" = "1001:1001"
RUN test "$(age --version)" = "v1.3.1"
RUN mkdir -p logs .phase0-land-area .development-land-area-sync \
      .development-land-area-evidence-capture \
      .development-building-registry-relation-adoption \
    && chown -R nodejs:nodejs logs .phase0-land-area .development-land-area-sync \
      .development-land-area-evidence-capture \
      .development-building-registry-relation-adoption \
    && chmod 700 .phase0-land-area .development-land-area-sync \
      .development-land-area-evidence-capture \
      .development-building-registry-relation-adoption
USER nodejs

# 환경 변수 설정
ENV NODE_ENV=production
ENV PORT=3100
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV IMAGE_TAG=${IMAGE_TAG}

# 포트 노출
EXPOSE 3100

# 헬스체크
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1

# 애플리케이션 시작
CMD ["node", "dist/index.js"]
