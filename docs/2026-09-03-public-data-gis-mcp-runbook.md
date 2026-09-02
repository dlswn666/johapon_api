# 통하리 공공 GIS MCP 운영 런북

## 운영 표면

- endpoint: `POST /gis-mcp` (modern Streamable HTTP, legacy reject)
- read-only tools: acceptance 문서의 versioned 5개 도구
- prompt: 공개 데이터 검토 prompt 1개
- resource: `tonghari-gis://policy/public-data/v1`
- health: `GET /health`, `GET /health/detailed`의 `gisMcp*` 필드

필수 설정이 없거나 형식이 잘못되면 `/gis-mcp`만 503
`GIS_MCP_NOT_CONFIGURED`로 닫힌다. 기존 API와 법률 `/mcp`는 계속 동작한다.

## 필수 환경변수

| 변수 | 의미 |
|---|---|
| `VWORLD_API_KEY` | VWorld 운영키. 원문은 서버 secret에만 둔다. |
| `VWORLD_API_DOMAIN` | VWorld에 등록한 서비스 URL의 hostname과 동일해야 한다. |
| `DATA_PORTAL_API_KEY` | 건축HUB serviceKey. Encoding/Decoding 키를 1회 정규화한다. |
| `GIS_MCP_TOKEN_REGISTRY_JSON` | 권장 client별 bearer SHA-256 digest registry |
| `GIS_MCP_TOKEN_SHA256` | legacy 단일 client digest, registry와 동시 금지 |
| `GIS_MCP_PROXY_TOKEN_SHA256` | Caddy 전용 raw proxy secret의 서버측 digest |
| `GIS_MCP_ALLOWED_HOSTS` | scheme/port/path 없는 hostname allowlist |
| `GIS_MCP_ALLOWED_ORIGINS` | Origin을 보내는 서버 client allowlist, 선택 |
| `GIS_MCP_REQUESTS_PER_MINUTE` | bearer별 upstream 도구 분당 제한, 기본 20 |
| `GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE` | 프로세스 전체 분당 제한, 기본 40 |
| `GIS_MCP_REQUEST_DEADLINE_MS` | admission 포함 전체 deadline, 기본 45000ms |
| `GIS_MCP_MAX_CONCURRENCY` | 동시 upstream 도구 상한, 기본 2 |
| `GIS_MCP_MAX_QUEUE` | 대기 요청 상한, 기본 4 |

```bash
npm run gis:mcp:token -- client-generate --client-id codex-mac-202609
npm run gis:mcp:token -- client-digest --client-id codex-mac-202609
npm run gis:mcp:token -- proxy-generate
```

raw bearer는 client secret store에만, raw proxy token은 Caddy owner-only secret에만
둔다. API와 배포 secret에는 digest만 저장한다.

## Caddy exact route

법률 MCP와 GIS MCP proxy token은 서로 재사용하지 않는다.

```caddyfile
api.tonghari.kr {
    @legal_mcp path /mcp
    handle @legal_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}
        }
    }

    @gis_mcp path /gis-mcp
    handle @gis_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-GIS-MCP-Proxy-Token {$GIS_MCP_PROXY_TOKEN}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }
}
```

3100은 loopback 또는 host firewall/security group에서 공개 ingress를 차단한다.

## Codex client 예시

```toml
[mcp_servers.tonghari_gis]
url = "https://api.tonghari.kr/gis-mcp"
bearer_token_env_var = "TONGHARI_GIS_MCP_TOKEN"
enabled = true
required = true
enabled_tools = [
  "resolve_address_to_pnu_v1",
  "lookup_parcel_public_data_v1",
  "lookup_building_register_v1",
  "lookup_housing_official_price_v1",
  "lookup_land_right_registration_v1"
]
```

## 운영 활성화 gate

1. VWorld 운영키 신청/변경 내역에 통하리 상용 MCP 조회 용도가 포함됐는지 확인한다.
2. 건축HUB 운영계정과 호출량을 확인하고 필요하면 활용사례 등록 후 증설한다.
3. geocoder 결과를 영구 저장하지 않고 모든 응답에 VWorld 출처를 유지한다.
4. Caddy/API의 proxy raw/digest가 같은 발급 쌍인지 값을 출력하지 않고 확인한다.
5. `GET /health`의 설정 상태는 형식 확인으로만 사용한다.
6. HTTPS에서 hidden-input smoke를 실행한다.

```bash
npm run gis:mcp:smoke -- --endpoint https://api.tonghari.kr/gis-mcp
```

7. 정확한 테스트 PNU로 5개 도구를 각각 live 호출해 provider 성공/무자료/일시 장애
   상태와 출처표시를 확인한다. 이 live smoke 전에는 외부 MCP가 완료됐다고 보고하지 않는다.

## 공식 근거

- [VWorld Open API 목록](https://www.vworld.kr/dev/v4apiRefer.do)
- [연속지적도 2D Data API](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral)
- [VWorld 국가중점데이터 API](https://www.vworld.kr/dtna/dtna_apiSvcList_s001.do)
- [VWorld 대지권등록 API](https://www.vworld.kr/dtna/dtna_apiSvcFc_s001.do?apiNum=78)
- [VWorld 주소→좌표 제한](https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do)
- [VWorld 이용약관](https://www.vworld.kr/v4po_prcint_a001.do)
- [VWorld 저작권 정책](https://www.vworld.kr/v4po_prcint_a006.do)
- [공공데이터포털 건축HUB](https://www.data.go.kr/data/15134735/openapi.do)
