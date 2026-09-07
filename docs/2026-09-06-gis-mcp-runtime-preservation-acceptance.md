# GIS MCP 인증 파일 연결 보존과 복구

## 요구사항과 역할

- 사용자 요청: 인스펙터 14개 항목 전체를 MCP로 조회한다. 건물호수조회는 사용자가 별도 이용허락 확보를 확인했다.
- 기획/분석: 전체 조회 기능 `22c8bf6`의 운영 배포를 막는 기존 GIS 파일 연결 누락을 복구한다. 기준은 GIS MCP runbook의 기존 활성화 완료 marker, 파일 인증, 읽기 전용 mount 계약이다.
- 구현: 토지면적 runtime workflow가 현재 이미지로 컨테이너를 다시 만들 때 기존 GIS registry mount를 보존한다.
- 리뷰: 별도 에이전트가 활성화/복구 경계와 실패 시 원상복구를 검토한다.
- 검증: 별도 에이전트의 Bash mock 회귀 테스트, 기존 workflow 테스트, 전체 테스트/빌드, 운영 health 및 MCP 실호출로 확인한다.

## 실행 순서와 완료 기준

1. [x] 기존 GIS 활성화 marker, 고정 FILE 환경변수, UID/GID 1001 디렉터리와 registry validate를 확인한다. 인증 정보/등록 내역은 변경하지 않는다.
2. [x] candidate/final 컨테이너에 검증된 GIS 디렉터리를 읽기 전용으로 연결하고 env/mount/health를 모두 검증한다. 미활성 설치는 비활성 상태를 보존한다.
3. [x] 이미 mount가 빠진 상태의 복구는 disable 요청, 기존 gate false/allowlist empty, idle queue, 정확한 FILE 환경변수와 검증된 registry가 모두 맞을 때만 허용한다. 잘못된 경로나 writable mount, 혼합 인증은 거부한다.
4. [x] 기존 production/operation lock, 동일 immutable image, atomic env 변경, rollback, watermark, 보호 환경 승인을 유지한다. 복구 실패 시 기존 컨테이너의 원래 GIS 상태까지 확인한다.
5. [ ] 관련 테스트와 전체 테스트/빌드 통과 후 최신 main을 반영해 merge/push한다.
6. [ ] 보호된 runtime disable 실행으로 mount 복구 후 최신 이미지 배포와 실제 14항목 MCP 호출을 검증한다. 코드 반영과 운영 완료를 구분해 보고한다.

## 범위

법률 MCP 및 토지면적 런타임 설정의 기존 검증을 유지한다. DB·명부 쓰기, 토큰 발급·추가·폐기, 최초 GIS 활성화, 외부 네트워크 공개 범위 변경은 포함하지 않는다.

## 검증 결과

- 전체 직렬 테스트: 1,581개 중 1,577 통과, 실패 0, 기존 skip 4.
- 최종 리뷰 반영 후 영향 범위 재검증: runtime workflow 28/28 통과(새 GIS 회귀 12개 포함).
- TypeScript 빌드, property-building writer guard, REMOTE_RUNTIME 전체 Bash 구문 검사, diff 공백 검사 통과.
- 독립 리뷰의 rollback idle 오인, 잘못된 mount 목적지 오인, registry 파일 권한 계약 보강을 반영했고 재검토에서 차단 사항이 없었다.
- 운영 복구와 신규 14항목 도구의 운영 실호출은 보호 환경 실행 이후 별도 확인한다.
