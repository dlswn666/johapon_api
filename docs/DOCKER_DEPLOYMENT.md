# Docker 배포 가이드 (Build Local, Run Remote)

## 개요

이 문서는 알림톡 프록시 서버의 Docker 배포 전략을 설명합니다.

**핵심 전략**: "Build Local, Run Remote"

1GB RAM EC2 서버에서 직접 `docker build`를 실행하면 `npm install` 과정에서 메모리 부족으로 100% 실패합니다. 따라서 로컬 또는 CI/CD에서 이미지를 빌드하고, EC2에서는 Pull과 Run만 수행합니다.

## 배포 흐름

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────┐
│  로컬/CI에서     │────▶│   Docker Hub     │────▶│    EC2       │
│  docker build   │     │   또는 ECR       │     │  docker run  │
└─────────────────┘     └──────────────────┘     └──────────────┘
        │                       │                       │
   이미지 빌드              이미지 저장            이미지 실행
   npm install              (레지스트리)          (메모리 절약)
```

## 방법 1: 로컬 빌드 및 배포

### 1. 사전 준비

```bash
# Docker Hub 계정 생성 (무료)
# https://hub.docker.com/

# Docker 로그인
docker login
```

### 2. 환경 변수 설정

```bash
# Windows (PowerShell)
$env:DOCKER_USERNAME="your-dockerhub-username"

# Linux/Mac
export DOCKER_USERNAME="your-dockerhub-username"
```

### 3. 이미지 빌드 및 Push

```bash
# 스크립트 사용
./scripts/build-and-push.sh latest

# 또는 수동 실행
docker build -t alimtalk-proxy .
docker tag alimtalk-proxy $DOCKER_USERNAME/alimtalk-proxy:latest
docker push $DOCKER_USERNAME/alimtalk-proxy:latest
```

### 4. EC2에서 배포

```bash
# EC2 서버에 SSH 접속
ssh ec2-user@your-ec2-ip

# 환경 변수 설정
export DOCKER_USERNAME="your-dockerhub-username"

# 배포 스크립트 실행
./scripts/deploy-to-ec2.sh latest

# 또는 수동 실행
docker pull $DOCKER_USERNAME/alimtalk-proxy:latest
docker stop alimtalk-proxy 2>/dev/null || true
docker rm alimtalk-proxy 2>/dev/null || true
docker run -d \
  --name alimtalk-proxy \
  --restart unless-stopped \
  -p 3100:3100 \
  --env-file .env \
  -v $(pwd)/logs:/app/logs \
  $DOCKER_USERNAME/alimtalk-proxy:latest
```

## 방법 2: GitHub Actions 자동 배포

### 1. GitHub Secrets 설정

Repository Settings > Secrets and variables > Actions에서 다음 설정:

- `DOCKER_USERNAME`: Docker Hub 사용자명
- `DOCKER_PASSWORD`: Docker Hub 비밀번호 또는 Access Token
- `EC2_HOST`: EC2 퍼블릭 IP
- `EC2_SSH_KEY`: EC2 SSH 프라이빗 키 (PEM 파일 내용)

### 2. GitHub Actions 워크플로우

`.github/workflows/docker-build.yml`:

```yaml
name: Docker Build and Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Build and Push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ secrets.DOCKER_USERNAME }}/alimtalk-proxy:latest
            ${{ secrets.DOCKER_USERNAME }}/alimtalk-proxy:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to EC2
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ec2-user
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd ~/alimtalk-proxy
            docker pull ${{ secrets.DOCKER_USERNAME }}/alimtalk-proxy:latest
            docker stop alimtalk-proxy || true
            docker rm alimtalk-proxy || true
            docker run -d \
              --name alimtalk-proxy \
              --restart unless-stopped \
              -p 3100:3100 \
              --env-file .env \
              -v $(pwd)/logs:/app/logs \
              --memory=800m \
              ${{ secrets.DOCKER_USERNAME }}/alimtalk-proxy:latest
```

## 방법 3: AWS ECR 사용

### 1. ECR 리포지토리 생성

```bash
# AWS CLI로 생성
aws ecr create-repository --repository-name alimtalk-proxy --region ap-northeast-2
```

### 2. ECR 로그인 및 Push

```bash
# ECR 로그인
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin 123456789.dkr.ecr.ap-northeast-2.amazonaws.com

# 이미지 빌드 및 Push
docker build -t alimtalk-proxy .
docker tag alimtalk-proxy:latest 123456789.dkr.ecr.ap-northeast-2.amazonaws.com/alimtalk-proxy:latest
docker push 123456789.dkr.ecr.ap-northeast-2.amazonaws.com/alimtalk-proxy:latest
```

### 3. EC2에서 Pull

```bash
# EC2에서 ECR 로그인
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin 123456789.dkr.ecr.ap-northeast-2.amazonaws.com

# 이미지 Pull
docker pull 123456789.dkr.ecr.ap-northeast-2.amazonaws.com/alimtalk-proxy:latest
```

## Docker 이미지 최적화

### .dockerignore 확인

이미지 크기를 줄이기 위해 `.dockerignore`에 다음 항목이 포함되어야 합니다:

```
node_modules
.git
.env
dist
logs
*.log
```

### 멀티 스테이지 빌드

Dockerfile은 멀티 스테이지 빌드를 사용합니다:

1. **builder 스테이지**: npm install, TypeScript 빌드
2. **production 스테이지**: 빌드 결과물만 복사, 최소 런타임

이를 통해 최종 이미지 크기를 최소화합니다.

## 트러블슈팅

### 이미지 빌드 실패 (로컬)

```bash
# Docker 캐시 정리
docker system prune -a

# 캐시 없이 빌드
docker build --no-cache -t alimtalk-proxy .
```

### Push 실패

```bash
# Docker 재로그인
docker logout
docker login
```

### EC2에서 Pull 실패

```bash
# 디스크 공간 확인
df -h

# 오래된 이미지 정리
docker image prune -a

# Docker 재시작
sudo systemctl restart docker
```

### 컨테이너 메모리 부족

```bash
# Swap 확인
free -h

# Swap이 없으면 설정
sudo ./scripts/setup-swap.sh

# 컨테이너 메모리 제한 조정
docker run -d \
  --memory=800m \
  --memory-swap=1600m \
  ...
```

## 버전 관리

### 태그 전략

- `latest`: 최신 안정 버전
- `v1.0.0`: 시맨틱 버전
- `sha-abc123`: Git 커밋 해시

### 롤백

```bash
# 이전 버전으로 롤백
docker pull $DOCKER_USERNAME/alimtalk-proxy:v1.0.0
docker stop alimtalk-proxy
docker rm alimtalk-proxy
docker run -d \
  --name alimtalk-proxy \
  --restart unless-stopped \
  -p 3100:3100 \
  --env-file .env \
  $DOCKER_USERNAME/alimtalk-proxy:v1.0.0
```

