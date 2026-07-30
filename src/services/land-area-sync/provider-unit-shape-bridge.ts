/**
 * Building HUB EXPOS와 V-World LDAREG의 실측 provider 표기 차이를 연결하는
 * 방향성 있는 exact witness.
 *
 * 이 모듈은 일반 정규화기가 아니다. 아래에서 열거한 원문 shape만 증명하고,
 * 행 순서·건수·근사 문자열·비율 값으로 호실을 추론하지 않는다. 호출측은 이 witness
 * 외에도 single-root/building, unique 1:1 set, replica, ratio, denominator gate를
 * 별도로 통과해야 한다.
 */

export const PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX =
    'PROVIDER_ABOVE_NO_SUFFIX' as const;
export const PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO =
    'PROVIDER_BASEMENT_B_HO' as const;
export const PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE =
    'FLOOR_AS_UNIT_ABOVE' as const;
export const PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT =
    'FLOOR_AS_UNIT_BASEMENT' as const;

export type ProviderUnitShapeBridgeKind =
    | typeof PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX
    | typeof PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO
    | typeof PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE
    | typeof PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT;

export interface ProviderUnitShapeWitness {
    kind: ProviderUnitShapeBridgeKind;
    /**
     * provider 양쪽에서 같은 호실일 때만 같아지는 내부 exact token.
     * artifact에는 원문/token을 노출하지 않고 domain-separated hash만 기록한다.
     */
    token: string;
    /** EXPOS/건축물대장 쪽 canonical tuple. runtime DB exact 매칭에만 사용한다. */
    canonicalFloor: string;
    canonicalHo: string;
}

export type ProviderUnitKind = 'EXPOS_UNIT' | 'LDAREG_UNIT';

function exactAliasScalar(
    row: Record<string, unknown>,
    aliases: readonly string[]
): string | null {
    const present = aliases
        .filter((alias) =>
            Object.prototype.hasOwnProperty.call(row, alias)
        )
        .map((alias) => row[alias]);
    if (
        present.length === 0 ||
        present.some(
            (value) =>
                typeof value !== 'string' &&
                !(
                    typeof value === 'number' &&
                    Number.isSafeInteger(value)
                )
        )
    ) {
        return null;
    }
    const normalized = [
        ...new Set(
            present.map((value) =>
                String(value).normalize('NFKC').trim()
            )
        ),
    ];
    return normalized.length === 1 && normalized[0] !== ''
        ? normalized[0]
        : null;
}

/**
 * 791-2188 지하 provider bridge 전용 원문 scalar.
 * 공백 제거·NFKC·대소문자 변환 없이 alias의 exact byte-level 문자열 표현만
 * 허용한다. safe integer는 provider의 JSON scalar 표현 그대로 10진 문자열화한다.
 */
function strictAliasScalar(
    row: Record<string, unknown>,
    aliases: readonly string[]
): string | null {
    const present = aliases
        .filter((alias) =>
            Object.prototype.hasOwnProperty.call(row, alias)
        )
        .map((alias) => row[alias]);
    if (
        present.length === 0 ||
        present.some(
            (value) =>
                typeof value !== 'string' &&
                !(
                    typeof value === 'number' &&
                    Number.isSafeInteger(value)
                )
        )
    ) {
        return null;
    }
    const exact = [...new Set(present.map((value) => String(value)))];
    return exact.length === 1 && exact[0] !== '' ? exact[0] : null;
}

function positiveFloor(value: string | null): string | null {
    return value !== null && /^[1-9]\d{0,2}$/u.test(value)
        ? value
        : null;
}

function positiveUnitNumber(value: string | null): string | null {
    return value !== null && /^[1-9]\d{0,3}$/u.test(value)
        ? value
        : null;
}

/**
 * provider가 지하 호 suffix를 고정폭 0-padding으로 보내는 실측 shape를
 * positive canonical 숫자로 접는다. 최대 3자리 숫자 run만 허용하고 000은
 * 거부하므로 일반 문자열·근사 매칭으로 넓어지지 않는다.
 */
function positiveBasementSuffix(value: string): string | null {
    if (!/^\d{1,3}$/u.test(value) || /^0+$/u.test(value)) {
        return null;
    }
    return value.replace(/^0+(?=\d)/u, '');
}

function exposWitness(
    row: Record<string, unknown>
): ProviderUnitShapeWitness | null {
    const floorType = exactAliasScalar(row, ['flrGbCd']);
    const rawFloor = exactAliasScalar(row, [
        'flrNoNm',
        'buldFloorNm',
        'flrNo',
    ]);
    const rawHo = exactAliasScalar(row, ['hoNm', 'buldHoNm']);
    const floor = positiveFloor(rawFloor);

    // 791-2172 실측: EXPOS 지상(20) 숫자 층 + 숫자 호.
    const numericHo = positiveUnitNumber(rawHo);
    if (floorType === '20' && floor !== null && numericHo !== null) {
        return {
            kind: PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
            token: `ABOVE_NO_SUFFIX:${floor}:${numericHo}`,
            canonicalFloor: floor,
            canonicalHo: numericHo,
        };
    }

    // 791-2188 실측: EXPOS 지하(10) floor=1 + ho=B0N. provider는
    // B01/B02처럼 0-padding할 수 있고, 대응 identity는 LDAREG 비0N과의
    // positive suffix equality다.
    const strictFloorType = strictAliasScalar(row, ['flrGbCd']);
    const strictRawFloor = strictAliasScalar(row, [
        'flrNoNm',
        'buldFloorNm',
        'flrNo',
    ]);
    const strictRawHo = strictAliasScalar(row, [
        'hoNm',
        'buldHoNm',
    ]);
    const latinBasement = strictRawHo === null
        ? null
        : /^B(\d{1,3})$/u.exec(strictRawHo);
    const latinBasementSuffix =
        latinBasement === null
            ? null
            : positiveBasementSuffix(latinBasement[1]);
    if (
        strictFloorType === '10' &&
        strictRawFloor === '1' &&
        latinBasementSuffix !== null
    ) {
        const suffix = latinBasementSuffix;
        return {
            kind: PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
            token: `BASEMENT_B_HO:${suffix}`,
            canonicalFloor: '1',
            canonicalHo: `B${suffix}`,
        };
    }

    // 791-2191 실측 지상: EXPOS 지상(20) floor=N + ho=N층.
    const floorAsUnit = rawHo === null
        ? null
        : /^([1-9]\d{0,2})층$/u.exec(rawHo);
    if (
        floorType === '20' &&
        floor !== null &&
        floorAsUnit !== null &&
        floorAsUnit[1] === floor
    ) {
        return {
            kind: PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
            token: `FLOOR_AS_UNIT_ABOVE:${floor}`,
            canonicalFloor: floor,
            canonicalHo: `${floor}층`,
        };
    }

    // 791-2191 실측 지층: EXPOS 지하(10) floor=1 + exact ho=지층.
    if (
        floorType === '10' &&
        rawFloor === '1' &&
        rawHo === '지층'
    ) {
        return {
            kind: PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
            token: 'FLOOR_AS_UNIT_BASEMENT:1',
            canonicalFloor: '1',
            canonicalHo: '지층',
        };
    }

    return null;
}

/**
 * LDAREG가 지하 1층을 표기하는 실측 원문 집합.
 *
 * EXPOS는 지하 호를 flrGbCd=10 + flrNo=1 한 가지로만 보내지만, LDAREG는 같은
 * 호를 지번마다 다른 원문으로 보낸다. 2026-07-30 GIS 인스펙터로 원문을 직접
 * 확인한 결과는 다음과 같다.
 *
 *   791-2155 · 2267  →  buldFloorNm '지',    buldHoNm '비01'
 *   791-2282         →  buldFloorNm '지',    buldHoNm 'B01'
 *   791-2320         →  buldFloorNm '지1',   buldHoNm '지하01' / '지하02'
 *   791-2343         →  buldFloorNm '지하1', buldHoNm '비01'
 *
 * `지층`은 `지`와 함께 정규화 역상에 있어 같이 인정한다. 그 밖에 정규화가 B1로
 * 접히는 표기(`지하01`/`지01`/`B1`/`B01` 등)는 실측되지 않았으므로 넣지 않는다 —
 * exact witness만 인정한다는 이 모듈의 계약을 추측으로 무르지 않기 위해서다.
 *
 * 지하 2층 이하 표기는 EXPOS 쪽 witness가 flrNo=1만 인정하므로 넣지 않는다.
 */
const LDAREG_BASEMENT_FIRST_FLOOR_LABELS: ReadonlySet<string> = new Set([
    '지하',
    '지',
    '지층',
    '지1',
    '지하1',
]);

function ldaregWitness(
    row: Record<string, unknown>
): ProviderUnitShapeWitness | null {
    const rawFloor = exactAliasScalar(row, [
        'buldFloorNm',
        'flrNoNm',
    ]);
    const rawHo = exactAliasScalar(row, ['buldHoNm', 'hoNm']);

    // 791-2172 실측: LDAREG exact 지상N(층 접미사 없음) + 숫자 호.
    const aboveNoSuffix = rawFloor === null
        ? null
        : /^지상([1-9]\d{0,2})$/u.exec(rawFloor);
    const numericHo = positiveUnitNumber(rawHo);
    if (aboveNoSuffix !== null && numericHo !== null) {
        const floor = aboveNoSuffix[1];
        return {
            kind: PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
            token: `ABOVE_NO_SUFFIX:${floor}:${numericHo}`,
            canonicalFloor: floor,
            canonicalHo: numericHo,
        };
    }

    // 791-2188 실측: LDAREG exact floor=지하 + ho=비0N. EXPOS와 동일하게
    // 최대 3자리 positive suffix의 leading zero만 canonicalize한다.
    // 미아7 실측에서 층은 LDAREG_BASEMENT_FIRST_FLOOR_LABELS의 원문으로,
    // 호는 비0N 외에 B0N·지하0N으로도 오는 것이 확인돼 세 접두사를 함께 인정한다.
    const strictRawFloor = strictAliasScalar(row, [
        'buldFloorNm',
        'flrNoNm',
    ]);
    const strictRawHo = strictAliasScalar(row, [
        'buldHoNm',
        'hoNm',
    ]);
    const koreanBasement = strictRawHo === null
        ? null
        : /^(?:비|B|지하)(\d{1,3})$/u.exec(strictRawHo);
    const koreanBasementSuffix =
        koreanBasement === null
            ? null
            : positiveBasementSuffix(koreanBasement[1]);
    if (
        strictRawFloor !== null &&
        LDAREG_BASEMENT_FIRST_FLOOR_LABELS.has(strictRawFloor) &&
        koreanBasementSuffix !== null
    ) {
        const suffix = koreanBasementSuffix;
        return {
            kind: PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
            token: `BASEMENT_B_HO:${suffix}`,
            canonicalFloor: '1',
            canonicalHo: `B${suffix}`,
        };
    }

    // 791-2191 실측 지상: LDAREG floor=N + exact ho=0000.
    const floor = positiveFloor(rawFloor);
    if (floor !== null && rawHo === '0000') {
        return {
            kind: PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
            token: `FLOOR_AS_UNIT_ABOVE:${floor}`,
            canonicalFloor: floor,
            canonicalHo: `${floor}층`,
        };
    }

    // 791-2191 실측 지층: LDAREG exact floor=지 + exact ho=0000.
    if (rawFloor === '지' && rawHo === '0000') {
        return {
            kind: PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
            token: 'FLOOR_AS_UNIT_BASEMENT:1',
            canonicalFloor: '1',
            canonicalHo: '지층',
        };
    }

    return null;
}

export function providerUnitShapeWitness(
    kind: ProviderUnitKind,
    row: Record<string, unknown>
): ProviderUnitShapeWitness | null {
    return kind === 'EXPOS_UNIT'
        ? exposWitness(row)
        : ldaregWitness(row);
}

export function providerUnitShapeWitnessKey(
    witness: ProviderUnitShapeWitness
): string {
    return `${witness.kind}\u0001${witness.token}`;
}
