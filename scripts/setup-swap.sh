#!/bin/bash
# ============================================================
# Swap 메모리 설정 스크립트 (2GB)
# EC2 인스턴스 초기 설정 시 실행
# ============================================================

set -e

echo "=========================================="
echo "Swap 메모리 설정 시작"
echo "=========================================="

# 기존 Swap 확인
echo "현재 Swap 상태:"
free -h
echo ""

# 기존 Swap 파일이 있는지 확인
if [ -f /swapfile ]; then
    echo "기존 Swap 파일이 존재합니다."
    echo "기존 Swap을 유지하려면 Ctrl+C를 눌러 종료하세요."
    echo "5초 후 기존 Swap을 삭제하고 새로 생성합니다..."
    sleep 5
    
    sudo swapoff /swapfile 2>/dev/null || true
    sudo rm /swapfile
    echo "기존 Swap 파일 삭제 완료"
fi

# 2GB Swap 파일 생성
echo "2GB Swap 파일 생성 중..."
sudo fallocate -l 2G /swapfile

# 권한 설정 (root만 읽기/쓰기)
sudo chmod 600 /swapfile

# Swap 파일 포맷
sudo mkswap /swapfile

# Swap 활성화
sudo swapon /swapfile

# 영구적으로 설정 (재부팅 후에도 유지)
# 이미 설정되어 있는지 확인
if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "/etc/fstab에 Swap 설정 추가 완료"
else
    echo "/etc/fstab에 Swap 설정이 이미 존재합니다."
fi

echo ""
echo "=========================================="
echo "Swap 설정 완료!"
echo "=========================================="

# 설정 확인
echo ""
echo "메모리 상태:"
free -h

echo ""
echo "Swap 상태:"
swapon --show

echo ""
echo "/etc/fstab 내용:"
cat /etc/fstab

echo ""
echo "=========================================="
echo "완료! 이제 서버 재부팅 후에도 Swap이 유지됩니다."
echo "=========================================="

