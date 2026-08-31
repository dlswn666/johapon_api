import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * 재건축 P2 — building_land_lots 쓰기의 PNU 단수 의존 제거
 *
 * 배경: P2 는 `building_land_lots` 의 `UNIQUE (pnu)` 를 `UNIQUE (pnu, building_id)`
 * 로 교체해 한 필지에 여러 동을 허용한다. 그런데 현행 쓰기가
 * `.upsert(..., { onConflict: 'pnu' })` 를 쓰고 있어, 제약이 바뀌는 순간
 * Postgres 가 42P10("there is no unique or exclusion constraint matching the
 * ON CONFLICT specification")으로 **하드 실패**한다 → 운영 GIS 수집이 멈춘다.
 *
 * 따라서 이 수정은 DDL 마이그레이션보다 **먼저 배포**돼야 한다.
 * 이 테스트가 그 순서를 코드로 강제한다.
 */
const source = readFileSync('src/services/supabase.service.ts', 'utf8');

test("building_land_lots 쓰기가 onConflict: 'pnu' 에 의존하지 않는다", () => {
    const offending = /from\('building_land_lots'\)[\s\S]{0,400}?onConflict:\s*'pnu'/.exec(source);
    assert.equal(
        offending,
        null,
        `building_land_lots upsert 가 여전히 onConflict: 'pnu' 를 쓴다 — ` +
            `UNIQUE(pnu) 제거 후 42P10 으로 하드 실패한다:\n${offending?.[0] ?? ''}`,
    );
});

test('매핑 쓰기는 (pnu, building_id) 를 확인한 뒤 쓰는 단일 진입점을 가진다', () => {
    assert.match(
        source,
        /async upsertBuildingLandLotMapping\(/,
        'upsertBuildingLandLotMapping 진입점이 없다',
    );
    assert.match(
        source,
        /\.eq\('pnu', pnu\)[\s\S]{0,200}?\.eq\('building_id', buildingId\)/,
        '매핑 조회가 (pnu, building_id) 두 컬럼을 함께 보지 않는다',
    );
});

test('매핑 진입점은 onConflict 를 아예 쓰지 않는다', () => {
    // 조회 → 분기 → 쓰기로 구현해야 제약 형태 변화에 영향받지 않는다.
    const entry = /async upsertBuildingLandLotMapping\([\s\S]*?\n    }/.exec(source);
    assert.ok(entry, 'upsertBuildingLandLotMapping 본문을 찾지 못했다');
    assert.equal(
        /onConflict/.test(entry[0]),
        false,
        '매핑 진입점이 onConflict 에 의존한다',
    );
});
