# 개발 LDAREG 비공개 target bundle 생성·승인 설치

이 문서는 운영 DB/API 호출 없이 준비하는 오프라인 절차만 설명한다. Bundle
builder와 owner approval installer는 개발 Supabase project만 허용하고 운영 URL은
네트워크 호출 전에 거부한다.

## 비공개 루트

- 호출자가 미리 만든 `0700` 디렉터리여야 한다.
- 입력은 모두 루트 바로 아래의 `0600`, link count 1인 regular file이어야 한다.
- symlink와 하위 경로는 허용하지 않는다.
- 출력 파일은 존재하지 않아야 하며 `O_CREAT | O_EXCL | O_NOFOLLOW`로 `0600`
  생성한다.
- 읽기 전후 root/inode/size/mtime/ctime을 고정하고, 출력도 inode/size/mode/link
  count를 재검증한다. 실패 중 생성한 출력은 같은 inode일 때만 정리한다.

## DEV read-only snapshot

Version은 `development-api-authoritative-ldareg-db-snapshot@1`이다.
`MANUAL`, `land_area`, `source` 계열 키는 어느 깊이에서도 허용하지 않는다.

```json
{
  "version": "development-api-authoritative-ldareg-db-snapshot@1",
  "databaseTarget": "development",
  "projectRef": "yxypndgipnxrdfyctmvh",
  "groups": [
    {
      "key": "ldareg-target-01",
      "unionId": "<uuid>",
      "basePnu": "<19-digit-pnu>",
      "managementPk": "<normalized-management-pk>",
      "canonicalBuildingId": "<uuid>",
      "scopePnus": ["<sorted-pnu>"],
      "scopeDigest": "<db-computed-sha256>",
      "propertyUnitDigest": "<db-computed-sha256>",
      "units": [
        {
          "buildingUnitId": "<uuid>",
          "buildingUnitPnu": "<scope-pnu>",
          "rawDong": null,
          "rawFloor": null,
          "rawHo": "101",
          "activePropertyUnit": {
            "propertyUnitId": "<uuid>",
            "pnu": "<scope-pnu>"
          }
        }
      ],
      "landParcels": [
        {
          "pnu": "<scope-pnu>",
          "area": "100"
        }
      ]
    }
  ]
}
```

`rawDong`, `rawFloor`, `rawHo`는 DEV DB의 원문 문자열 또는 `null`이다.
Builder는 `rawDong`/`rawHo`를 정규화하고, `rawFloor`가 비어 있으면 EXPOS 공식
unit hash를 대상으로 1–999층의 유일한 preimage를 찾아 floor를 복원한다.
`rawFloor`가 있으면 복원된 floor와 exact 일치해야 한다.

`activePropertyUnit`은 active property가 없는 building unit 후보일 때 `null`이다.
같은 공식 tuple에 active 1개와 inactive alias가 함께 있으면 active를 선택하고
inactive alias는 제외한다. Active가 없고 공식 tuple에 대응하는 inactive가 정확히
1개일 때만 ignored 공식 unit으로 분류한다. Active 중복, inactive ambiguity,
active의 불완전·미매칭 tuple은 fail-closed하고, 불완전하거나 매칭되지 않는 inactive
shadow/placeholder는 제외한다.

공식 EXPOS가 dong을 가지지만 active DB row의 dong이 비어 있는 경우에는 다음
경계를 모두 만족해야만 보조 결합한다.

- EXPOS `floorHoIdentityHash`가 해당 group에서 유일하고 empty-dong active 후보도
  정확히 1개여야 한다.
- Group의 모든 DB row에서 얻은 nonempty normalized dong token만 bounded candidate
  dictionary로 사용한다(최대 32개, token당 최대 32자).
- 후보 token을 공식 floor/ho와 결합한 `UNIT_TUPLE_JSON` hash가 EXPOS
  `unitIdentityHash`와 exact 일치하는 후보가 공식 unit마다 정확히 1개여야 한다.
- 같은 group의 DONG 공식 unit들이 서로 다른 dong으로 복원되면 거부한다.
- Inactive row의 ID, FK, activity 상태는 dong resolver가 아니다. Inactive row에서
  나온 dong도 다른 token과 똑같이 bounded preimage 후보일 뿐이며 property 선택은
  끝까지 unique active floor/ho 후보가 우선한다.
- Nonempty-dong active mismatch, 후보 0개/복수, floor/ho 중복은 완화하지 않는다.

`expectedIgnoredOfficialUnitCount`는 DB snapshot 생성자가 명시적으로 봉인할 때만
group에 추가하며, 생략 시에도 builder gate는 `0`을 요구한다. Target 출력에는
입력에 제공된 경우에만 이 필드를 보존한다.

공식 EXPOS 집합은 대표 PNU 단일 endpoint inventory가 아니라 검증된
`sample.evidence.scopeExpos`의 logical union이다. 대표·부속 PNU 양쪽을 조회한
evidence에서 서로 다른 query PNU의 exact replica는 1건으로 접고, 같은 PNU 내부
중복은 최대 multiplicity를 보존해 ambiguity를 숨기지 않는다. 따라서 호실이
부속 PNU에만 존재해도 유효하지만, scope query/record count, canonical order,
sanitized digest, root 관리번호, 대표 PNU endpoint inventory binding 중 하나라도
맞지 않으면 `OFFICIAL_SCOPE_EXPOS_INVALID`로 거부한다.

## Phase0 capture index

Version은
`development-api-authoritative-ldareg-phase0-capture-index@1`이다. 한 artifact를
여러 target binding이 공유할 수 있다. `manifestFile`은 해당 artifact를 만든 원본
Phase0 capture input manifest다. Artifact가 alias/PNU 원문을 노출하지 않으므로
manifest와 그 SHA-256은 sample commitment 전체 검증에 필수다.

```json
{
  "version": "development-api-authoritative-ldareg-phase0-capture-index@1",
  "artifacts": [
    {
      "key": "shared-capture",
      "artifactFile": "phase0-artifact.json",
      "artifactSha256": "<sha256>",
      "manifestFile": "phase0-manifest.json",
      "manifestSha256": "<sha256>",
      "runId": "<positive-run-id>"
    }
  ],
  "bindings": [
    {
      "targetKey": "ldareg-target-01",
      "artifactKey": "shared-capture",
      "alias": "<phase0-alias>"
    }
  ]
}
```

## Bundle 생성

```bash
node dist/cli/development-api-authoritative-ldareg-target-bundle-build.js \
  --private-root /dev/shm/<private-root> \
  --db-snapshot db-snapshot.json \
  --capture-index capture-index.json \
  --out target-bundle.json
```

기존 target07 target@1이 새 v2 target과 canonical dong까지 exact 호환되는지
확인할 때만 다음 인자를 추가한다.

```text
--legacy-target-07 legacy-target07.json
```

Legacy v1은 `canonicalDong`, provider bridge, ignored official unit을 담지 않는다.
이 v2 확장 필드들을 제외한 legacy-representable projection이 새 target과 exact
같고 확장 필드만 달라질 때에만
`LEGACY_TARGET_07_CANONICAL_DONG_UPGRADE_REQUIRED`로 거부한다. DB digest, PNU,
property/building ID, 층·호, 분자 등 v1 필드가 하나라도 달라지면
`LEGACY_TARGET_07_PIN_MISMATCH`다. 확장 전환이 필요한 경우 legacy 입력을 빼고 새
v2 candidate bundle을 생성·검증한 뒤, 별도의 승인된 변경에서 candidate digest로
pin을 전환해야 한다. Builder는 pin이나 provision flag를 자동으로 변경하지 않는다.

Builder는 DB raw unit을 canonicalize하여 EXPOS hash와 exact join하고,
EXPOS/LDAREG는 standard full unit hash를 우선한다. 잔여 집합에서는 unique
`floorHoIdentityHash`를 먼저 소진하고, 다시 남은 집합에만 exact provider bridge
hash/kind의 unique 1:1 join을 허용한다. LDAREG 분자를 target 값으로 사용하고
분모는 snapshot의 `landParcels[].area` 합계와 exact 비교한다.

실패 stderr는 원문 JSON·식별자·경로를 반사하지 않고 사전 허용된 rejection code만
출력한다. 성공 stdout도 sentinel, key/active/ignored count, 출력 digest만 포함한다.

## Owner approval RPC 설치

승인 요청, prepare artifact, selected target을 같은 `0700` private root 아래
`0600` 파일로 둔다. 자격증명은 argv에 넣지 않는다. 전용 환경변수
`LDAREG_OWNER_SUPABASE_SERVICE_ROLE_KEY` 또는 stdin으로만 전달한다.

```bash
node dist/cli/development-api-authoritative-ldareg-approval-rpc-install.js \
  --private-root /dev/shm/<private-root> \
  --target target.json \
  --artifact prepare-artifact.json \
  --request owner-approval-request.json \
  --source-release-sha <40-hex-release-sha> \
  --project-url https://yxypndgipnxrdfyctmvh.supabase.co
```

Installer는
`replace_development_api_authoritative_ldareg_backfill_approval_v1`만 호출한다.
요청/응답 body와 자격증명은 stdout/stderr에 출력하지 않는다.
