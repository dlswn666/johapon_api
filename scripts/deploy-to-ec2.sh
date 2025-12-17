#!/bin/bash
# ============================================================
# EC2 서버 배포 스크립트
# EC2 서버에서 실행 (Pull & Run)
# ============================================================

set -e

# 변수 설정 (필요에 따라 수정)
IMAGE_NAME="alimtalk-proxy"
DOCKER_USERNAME="${DOCKER_USERNAME:-}"
TAG="${1:-latest}"
CONTAINER_NAME="alimtalk-proxy"
PORT="${PORT:-3100}"

# 전체 이미지 이름 구성
if [ -n "$DOCKER_USERNAME" ]; then
    FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}:${TAG}"
else
    FULL_IMAGE_NAME="${IMAGE_NAME}:${TAG}"
fi

echo "=========================================="
echo "EC2 Docker 배포"
echo "=========================================="
echo "이미지: ${FULL_IMAGE_NAME}"
echo "컨테이너: ${CONTAINER_NAME}"
echo "포트: ${PORT}"
echo ""

# 새 이미지 Pull
echo "=========================================="
echo "1. Docker 이미지 Pull..."
echo "=========================================="
docker pull ${FULL_IMAGE_NAME}

# 기존 컨테이너 중지 및 삭제
echo ""
echo "=========================================="
echo "2. 기존 컨테이너 정리..."
echo "=========================================="
if docker ps -a | grep -q ${CONTAINER_NAME}; then
    echo "기존 컨테이너 중지 중..."
    docker stop ${CONTAINER_NAME} 2>/dev/null || true
    echo "기존 컨테이너 삭제 중..."
    docker rm ${CONTAINER_NAME} 2>/dev/null || true
    echo "완료"
else
    echo "기존 컨테이너 없음"
fi

# 새 컨테이너 실행
echo ""
echo "=========================================="
echo "3. 새 컨테이너 실행..."
echo "=========================================="

# .env 파일이 있는지 확인
if [ -f .env ]; then
    echo ".env 파일 발견, 환경 변수 로드..."
    docker run -d \
        --name ${CONTAINER_NAME} \
        --restart unless-stopped \
        -p ${PORT}:3100 \
        --env-file .env \
        -v $(pwd)/logs:/app/logs \
        --memory=800m \
        --memory-swap=1600m \
        ${FULL_IMAGE_NAME}
else
    echo "⚠️  .env 파일이 없습니다. 환경 변수를 직접 전달해야 합니다."
    echo ""
    echo "다음 명령어로 .env 파일을 생성하세요:"
    echo "  vim .env"
    echo ""
    echo "또는 환경 변수를 직접 전달하여 실행:"
    echo "  docker run -d \\"
    echo "    --name ${CONTAINER_NAME} \\"
    echo "    -p ${PORT}:3100 \\"
    echo "    -e JWT_SECRET=your-secret \\"
    echo "    -e ALIGO_API_KEY=your-key \\"
    echo "    ... \\"
    echo "    ${FULL_IMAGE_NAME}"
    exit 1
fi

# 실행 확인
echo ""
echo "=========================================="
echo "4. 배포 상태 확인..."
echo "=========================================="
sleep 3

if docker ps | grep -q ${CONTAINER_NAME}; then
    echo "✅ 컨테이너 실행 중!"
    echo ""
    docker ps | grep ${CONTAINER_NAME}
    echo ""
    
    # 헬스체크
    echo "헬스체크 수행 중..."
    sleep 2
    curl -s http://localhost:${PORT}/health | python3 -m json.tool 2>/dev/null || echo "헬스체크 응답: $(curl -s http://localhost:${PORT}/health)"
else
    echo "❌ 컨테이너 실행 실패!"
    echo ""
    echo "로그 확인:"
    docker logs ${CONTAINER_NAME}
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ 배포 완료!"
echo "=========================================="
echo ""
echo "유용한 명령어:"
echo "  로그 확인: docker logs -f ${CONTAINER_NAME}"
echo "  컨테이너 중지: docker stop ${CONTAINER_NAME}"
echo "  컨테이너 재시작: docker restart ${CONTAINER_NAME}"
echo "  헬스체크: curl http://localhost:${PORT}/health"

