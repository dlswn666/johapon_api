/**
 * LDAREG 분기 p_items 조립 (DESIGN §12·§13.4).
 *
 * 순수 함수: 외부 scan 결과(ldareg/expos rows)와 주입된 후보(building_unit/property_unit)를 받아
 * dedup·비율 parse·매칭·component 조립까지 하고 apply RPC p_items(LDAREG) 를 만든다.
 * DB·네트워크 호출은 하지 않는다(호출측 service 가 주입).
 *
 * 매칭·정규화·identity·ratio 는 Task 9 순수 모듈을 재사용한다. 이 모듈의 책임은:
 *  - ldareg raw row → LdaregObservationInput 정규화(clsSeCode→sourceState, floor 표기 정렬).
 *  - matcher 후보 조립(floor 표기 정규화 일치) + per-unit 결정.
 *  - property별 component 묶음 + expectedTargetPnus coverage 요건.
 *  - §7.3 source record allowlist 12필드 추출.
 */

import type {
    LdaregRow,
    BrExposRow,
    BrBasisOulnRow,
    LandAreaSyncIssueCode,
} from '../../types/land-area-sync.types';
import { createHash } from 'node:crypto';
import type {
    LandAreaSyncApplyLdaregItem,
    LandAreaSyncApplyLdaregComponent,
    LandAreaSyncIssue,
} from '../../types/land-area-sync-job.types';
import {
    dedupLdaregObservations,
    type LdaregObservationInput,
    type LdaregSourceRecord,
} from './identity';
import { parseLdaQotaRate, checkDenominatorAgainstArea } from './ratio';
import {
    matchLdaregUnit,
    type ExposUnitCandidate,
    type BuildingUnitCandidate,
    type PropertyUnitCandidate,
    type MatchSource,
} from './matcher';
import { mapClsSeCodeToSourceState, normalizeFloorLabel } from './preview';
import type { ScopeLadfrlArea } from './ladfrl-scope';
import { normalizeUnitTuple, unitTupleKey } from './normalizer';
import {
    buildBasisRootIndex,
    resolveExposRootIdentity,
    type BasisRootIndex,
    type ExposRootIdentitySource,
} from './expos-root';
import {
    providerUnitShapeWitness,
    providerUnitShapeWitnessKey,
} from './provider-unit-shape-bridge';

/** 한 대상 PNU 의 LDAREG·전유부 raw scan 묶음. */
export interface LdaregPnuScan {
    pnu: string;
    ldaregRows: LdaregRow[];
    exposRows: BrExposRow[];
    /**
     * LDAREG 분기 전용 same-run basis scan. service 런타임은 모든 scanned PNU에
     * 반드시 주입한다. optional은 기존 순수 fixture의 title-root self 호환만 위한 것이다.
     */
    basisRows?: BrBasisOulnRow[];
}

export interface LdaregBranchInput {
    unionId: string;
    /** scope 내 정렬 대상 PNU 전체(각 property 의 expected coverage 이자 apply scanned scope). */
    scannedPnus: string[];
    /** 단일 root 관리번호(전유부 root identity 비교 기준). */
    rootIdentity: string;
    perPnu: LdaregPnuScan[];
    /** 정렬된 distinct scope PNU별 same-run LADFRL 양수면적. */
    scopeLadfrlAreas: ScopeLadfrlArea[];
    /** 위 면적의 정확한 decimal 합계. 모든 CURRENT component 분모의 유일한 비교 기준. */
    scopeLadfrlTotal: string;
    /** scanned set에 포함된 base PNU 중 정렬 첫 값. */
    canonicalSourcePnu: string;
    buildingUnits: BuildingUnitCandidate[];
    propertyUnits: PropertyUnitCandidate[];
}

const LDAREG_REPEAT_FIELDS = [
    'agbldgSn',
    'buldNm',
    'buldDongNm',
    'buldFloorNm',
    'buldHoNm',
    'buldRoomNm',
    'ldaQotaRate',
    'clsSeCode',
    'clsSeCodeNm',
    'relateLdEmdLiCode',
    'lastUpdtDt',
] as const;

export interface LdaregReplicationEvidence {
    canonicalSourcePnu: string;
    comparedPnus: string[];
    exactReplica: true;
    /** canonical logical row multiset 수(중복 포함). */
    rowCount: number;
    rowMultisetDigest: string;
    /**
     * provider bridge witness가 scope에 실제 존재할 때만 생성되는 all-PNU
     * building identity 증거. 일반 2280 v2 replica digest/shape에는 추가하지 않는다.
     */
    providerBuildingIdentity?: {
        aggregateBuildingSerialHash: string;
        buildingNameHash: string;
        observedRowCount: number;
    };
}

export type LdaregReplicationResult =
    | {
          ok: true;
          evidence: LdaregReplicationEvidence;
      }
    | { ok: false };

function canonicalLdaregScalar(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') return value.normalize('NFKC').trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function canonicalDecimalToken(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
}

/**
 * query-dependent pnu를 제외한 LDAREG logical row. 고정 allowlist의 상태·기준일을
 * 보존하되 ratio와 unit tuple은 비교 의미에 맞게 canonicalize한다.
 *
 * 일반 행은 기존 v2 JSON을 byte-for-byte 유지한다(기존 2280 replica digest 호환).
 * provider bridge가 인정하는 exact 원문 shape만 v3 witness로 별도 고정한다.
 * 따라서 base/attached PNU의 논리 tuple이 같더라도 `지상2`와 `지상02`처럼
 * recognized/non-recognized 상태가 달라지면 replica로 인정하지 않는다.
 */
function canonicalLdaregRowKey(row: LdaregRow): string | null {
    const record = row as Record<string, unknown>;
    const raw: Record<string, string | null> = {};
    for (const field of LDAREG_REPEAT_FIELDS.filter((field) => field !== 'ldaQotaRate')) {
        const value = canonicalLdaregScalar(record[field]);
        if (value === undefined) return null;
        raw[field] = value;
    }
    const ratio = parseLdaQotaRate(record.ldaQotaRate);
    const state = mapClsSeCodeToSourceState(raw.clsSeCode ?? '', raw.clsSeCodeNm ?? '');
    const normalized = normalizeUnitTuple({
        dong: raw.buldDongNm,
        floor: raw.buldFloorNm,
        ho: raw.buldHoNm,
        room: raw.buldRoomNm,
    });
    const providerShapeWitness = providerUnitShapeWitness(
        'LDAREG_UNIT',
        record
    );
    const v2Key = {
        v: 2,
        agbldgSn: raw.agbldgSn,
        buildingName: raw.buldNm,
        normalized,
        ratio: ratio.ok
            ? {
                  numerator: canonicalDecimalToken(ratio.numeratorText),
                  denominator: canonicalDecimalToken(ratio.denominatorText),
              }
            : { invalid: canonicalLdaregScalar(record.ldaQotaRate) ?? null },
        sourceState: state.state,
        sourceStateAmbiguous: state.ambiguous,
        clsSeCode: raw.clsSeCode,
        clsSeCodeNm: raw.clsSeCodeNm,
        relateLdEmdLiCode: raw.relateLdEmdLiCode,
        lastUpdtDt: raw.lastUpdtDt,
    };
    if (providerShapeWitness === null) {
        return JSON.stringify(v2Key);
    }
    return JSON.stringify({
        ...v2Key,
        v: 3,
        providerShape: {
            recognized: true,
            key: providerUnitShapeWitnessKey(
                providerShapeWitness
            ),
        },
    });
}

/**
 * Phase 0 실측 계약: 동일 building의 LDAREG 전체 호/비율 집합이 scope의 각 PNU에서 반복된다.
 * 각 query 응답의 row.pnu만 query target에 맞게 달라진다. pnu를 제외한 canonical source
 * multiset(중복 개수 포함)이 모든 PNU에서 exact equal일 때만 replica로 인정한다.
 */
export function validateLdaregReplication(
    scannedPnus: string[],
    perPnu: LdaregPnuScan[],
    canonicalSourcePnu: string
): LdaregReplicationResult {
    const expected = [...new Set(scannedPnus)].sort();
    const actual = [...new Set(perPnu.map((scan) => scan.pnu))].sort();
    if (
        expected.length !== scannedPnus.length ||
        actual.length !== perPnu.length ||
        expected.length !== actual.length ||
        expected.some((pnu, index) => pnu !== actual[index]) ||
        !expected.includes(canonicalSourcePnu)
    ) {
        return { ok: false };
    }

    const replicatedRows = perPnu.flatMap(
        (scan) => scan.ldaregRows
    );
    const providerIdentityRequired = replicatedRows.some(
        (row) =>
            providerUnitShapeWitness(
                'LDAREG_UNIT',
                row as Record<string, unknown>
            ) !== null
    );
    let providerBuildingIdentity:
        | NonNullable<
              LdaregReplicationEvidence['providerBuildingIdentity']
          >
        | undefined;
    if (providerIdentityRequired) {
        const identities = replicatedRows.map((row) => {
            const raw = row as Record<string, unknown>;
            return {
                aggregateSerial:
                    typeof raw.agbldgSn === 'string'
                        ? raw.agbldgSn.trim()
                        : null,
                buildingName:
                    typeof raw.buldNm === 'string'
                        ? raw.buldNm.trim()
                        : null,
            };
        });
        const aggregateSerials = new Set(
            identities.map(
                (identity) => identity.aggregateSerial
            )
        );
        const buildingNames = new Set(
            identities.map(
                (identity) => identity.buildingName
            )
        );
        if (
            identities.length === 0 ||
            identities.some(
                (identity) =>
                    identity.aggregateSerial === null ||
                    identity.aggregateSerial === '' ||
                    identity.buildingName === null ||
                    identity.buildingName === ''
            ) ||
            aggregateSerials.size !== 1 ||
            buildingNames.size !== 1
        ) {
            return { ok: false };
        }
        const aggregateSerial = identities[0]
            .aggregateSerial!;
        const buildingName = identities[0].buildingName!;
        providerBuildingIdentity = {
            aggregateBuildingSerialHash: createHash('sha256')
                .update(
                    `AGBLDG_SN\u0000${aggregateSerial}`,
                    'utf8'
                )
                .digest('hex'),
            buildingNameHash: createHash('sha256')
                .update(
                    `BUILDING_NAME\u0000${buildingName}`,
                    'utf8'
                )
                .digest('hex'),
            observedRowCount: replicatedRows.length,
        };
    }

    const keysByPnu = new Map<string, string[]>();
    for (const scan of perPnu) {
        const keys: string[] = [];
        for (const row of scan.ldaregRows) {
            if (typeof row.pnu !== 'string' || row.pnu.trim() !== scan.pnu) {
                return { ok: false };
            }
            const key = canonicalLdaregRowKey(row);
            if (key === null) return { ok: false };
            keys.push(key);
        }
        keysByPnu.set(scan.pnu, keys.sort());
    }

    const canonical = keysByPnu.get(canonicalSourcePnu);
    if (!canonical) return { ok: false };
    for (const pnu of expected) {
        const candidate = keysByPnu.get(pnu);
        if (
            !candidate ||
            candidate.length !== canonical.length ||
            candidate.some((key, index) => key !== canonical[index])
        ) {
            return { ok: false };
        }
    }

    const rowMultisetDigest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    return {
        ok: true,
        evidence: {
            canonicalSourcePnu,
            comparedPnus: expected,
            exactReplica: true,
            rowCount: canonical.length,
            rowMultisetDigest,
            ...(providerBuildingIdentity
                ? { providerBuildingIdentity }
                : {}),
        },
    };
}

export interface LdaregBranchResult {
    items: LandAreaSyncApplyLdaregItem[];
    issues: LandAreaSyncIssue[];
    matchedPropertyUnitIds: string[];
    counts: {
        landRegistryRows: number;
        exposureRows: number;
        parsedRows: number;
    };
    /** scopeHash 의 정렬 component/match digest 입력. */
    componentMatchDigest: unknown[];
    /** immutable scope snapshot에 고정할 replica 근거. validation 실패면 null. */
    replicationEvidence: LdaregReplicationEvidence | null;
    /** 분모/ratio/replica/match 불일치로 apply RPC가 0회여야 하는 전역 gate. */
    blocking: boolean;
}

export interface ExposRootResolutionEvidence {
    queryPnu: string;
    selfIdentity: string;
    rootIdentity: string;
    rawUpIdentity: string | null;
    source: ExposRootIdentitySource;
    normalized: {
        dong: string;
        floor: string;
        ho: string;
    };
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeLdaregDong(value: unknown): string | null {
    const normalized = str(value).normalize('NFKC').trim();
    if (normalized === '' || /^0+$/.test(normalized)) return null;
    return normalized;
}

function isObservedNonApplicablePlaceholder(row: LdaregRow): boolean {
    const raw = row as Record<string, unknown>;
    const ratioMissing = str(raw.ldaQotaRate).trim() === '';
    const allUnitSegmentsAreZero = [
        raw.buldDongNm,
        raw.buldFloorNm,
        raw.buldHoNm,
        raw.buldRoomNm,
    ].every((value) => /^0+$/.test(str(value).normalize('NFKC').trim()));
    const state = mapClsSeCodeToSourceState(
        str(raw.clsSeCode),
        str(raw.clsSeCodeNm)
    );
    return (
        ratioMissing &&
        allUnitSegmentsAreZero &&
        state.state === 'CURRENT' &&
        !state.ambiguous
    );
}

/** §7.3 v1 allowlist 12필드만 typed string 으로 뽑는다(임의 필드 금지). */
function extractSourceRecord(row: LdaregRow): Record<string, string | null> {
    const pick = (k: string): string | null => {
        const v = (row as Record<string, unknown>)[k];
        if (v == null) return null;
        const s = String(v);
        return s.length === 0 ? null : s;
    };
    return {
        pnu: pick('pnu'),
        agbldgSn: pick('agbldgSn'),
        buldNm: pick('buldNm'),
        buldDongNm: pick('buldDongNm'),
        buldFloorNm: pick('buldFloorNm'),
        buldHoNm: pick('buldHoNm'),
        buldRoomNm: pick('buldRoomNm'),
        ldaQotaRate: pick('ldaQotaRate'),
        clsSeCode: pick('clsSeCode'),
        clsSeCodeNm: pick('clsSeCodeNm'),
        relateLdEmdLiCode: pick('relateLdEmdLiCode'),
        lastUpdtDt: pick('lastUpdtDt'),
    };
}

/** getBrExposInfo row에서 basis-closed root와 동·층·호 후보를 뽑는다. */
function toExposCandidate(
    row: BrExposRow,
    basisRootIndex: BasisRootIndex
): ExposUnitCandidate | null {
    const r = row as Record<string, unknown>;
    const resolved = resolveExposRootIdentity(row, basisRootIndex);
    if (!resolved.ok) return null;
    return {
        dong: str(r.dongNm ?? r.buldDongNm ?? r.dong) || null,
        floor: normalizeFloorLabel(str(r.flrNoNm ?? r.buldFloorNm ?? r.floor ?? r.flrNo)) || null,
        ho: str(r.hoNm ?? r.buldHoNm ?? r.ho) || null,
        rootIdentity: resolved.evidence.rootIdentity,
        selfIdentity: resolved.evidence.selfIdentity,
        rawUpIdentity: resolved.evidence.rawUpIdentity,
        rootIdentitySource: resolved.evidence.source,
        providerShapeWitness: providerUnitShapeWitness(
            'EXPOS_UNIT',
            r
        ),
    };
}

function buildScopeBasisRootIndex(
    perPnu: LdaregPnuScan[],
    acceptedRootIdentities: readonly string[]
): BasisRootIndex | null {
    const result = buildBasisRootIndex(
        perPnu.flatMap((scan) => scan.basisRows ?? []),
        acceptedRootIdentities
    );
    return result.ok ? result.index : null;
}

/**
 * resolved scope 전체의 EXPOS 후보를 합친다.
 *
 * Building HUB는 같은 호실을 기준·부속 PNU 양쪽에서 반복할 수 있고, 반대로 일부 호실을
 * 한쪽 PNU에서만 반환할 수도 있다. 서로 다른 PNU 사이의 동일 normalized 후보는 query
 * replica로 1건만 사용한다. 다만 한 PNU 안의 중복은 provider ambiguity이므로 숨기지
 * 않도록 PNU별 최대 multiplicity를 보존한다.
 */
function collectScopeExposUnits(
    perPnu: LdaregPnuScan[],
    basisRootIndex: BasisRootIndex
):
    | {
          ok: true;
          units: ExposUnitCandidate[];
          rootEvidence: ExposRootResolutionEvidence[];
      }
    | { ok: false } {
    const representativeByKey = new Map<string, ExposUnitCandidate>();
    const maxMultiplicityByKey = new Map<string, number>();
    const rootEvidence: ExposRootResolutionEvidence[] = [];

    for (const scan of perPnu) {
        const localMultiplicity = new Map<string, number>();
        for (const row of scan.exposRows) {
            const candidate = toExposCandidate(row, basisRootIndex);
            if (!candidate || !candidate.selfIdentity || !candidate.rootIdentitySource) {
                return { ok: false };
            }
            const normalized = normalizeUnitTuple(candidate);
            const key = JSON.stringify({
                rootIdentity: candidate.rootIdentity,
                selfIdentity: candidate.selfIdentity,
                dong: normalized.dong,
                floor: normalized.floor,
                ho: normalized.ho,
                providerShapeWitness: candidate.providerShapeWitness
                    ? providerUnitShapeWitnessKey(
                          candidate.providerShapeWitness
                      )
                    : null,
            });
            rootEvidence.push({
                queryPnu: scan.pnu,
                selfIdentity: candidate.selfIdentity,
                rootIdentity: candidate.rootIdentity,
                rawUpIdentity: candidate.rawUpIdentity ?? null,
                source: candidate.rootIdentitySource,
                normalized: {
                    dong: normalized.dong,
                    floor: normalized.floor,
                    ho: normalized.ho,
                },
            });
            representativeByKey.set(
                key,
                representativeByKey.get(key) ?? candidate
            );
            localMultiplicity.set(
                key,
                (localMultiplicity.get(key) ?? 0) + 1
            );
        }
        for (const [key, count] of localMultiplicity) {
            maxMultiplicityByKey.set(
                key,
                Math.max(maxMultiplicityByKey.get(key) ?? 0, count)
            );
        }
    }

    const units = [...representativeByKey.keys()]
        .sort()
        .flatMap((key) =>
            Array.from(
                { length: maxMultiplicityByKey.get(key) ?? 0 },
                () => representativeByKey.get(key)!
            )
        );
    return {
        ok: true,
        units,
        rootEvidence: rootEvidence.sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b))
        ),
    };
}

/**
 * match에 사용할 canonical Building HUB 전유부 dataset을 고른다. scanned base 중 strict
 * COMPLETE nonzero expos를 가진 PNU만 후보이며, 후보가 여러 개면 match에 쓰이는 canonical
 * expos multiset이 exact 같아야 한다.
 */
export function selectCanonicalExposSourcePnu(
    basePnus: string[],
    perPnu: LdaregPnuScan[],
    acceptedRootIdentities: readonly string[]
): string | null {
    const basisRootIndex = buildScopeBasisRootIndex(
        perPnu,
        acceptedRootIdentities
    );
    if (!basisRootIndex) return null;
    const scansByPnu = new Map(perPnu.map((scan) => [scan.pnu, scan]));
    const candidates = [...new Set(basePnus)].sort();
    if (
        candidates.length === 0 ||
        candidates.some((pnu) => (scansByPnu.get(pnu)?.exposRows.length ?? 0) === 0)
    ) {
        return null;
    }

    const digestFor = (pnu: string): string | null => {
        const candidates: Array<Record<string, unknown>> = [];
        for (const rawRow of scansByPnu.get(pnu)?.exposRows ?? []) {
            const candidate = toExposCandidate(rawRow, basisRootIndex);
            if (!candidate) return null;
            candidates.push({
                rootIdentity: candidate.rootIdentity,
                selfIdentity: candidate.selfIdentity,
                rawUpIdentity: candidate.rawUpIdentity ?? null,
                rootIdentitySource: candidate.rootIdentitySource,
                normalized: normalizeUnitTuple(candidate),
                providerShapeWitness: candidate.providerShapeWitness
                    ? providerUnitShapeWitnessKey(
                          candidate.providerShapeWitness
                      )
                    : null,
            });
        }
        return JSON.stringify(
            candidates.sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b))
            )
        );
    };
    const reference = digestFor(candidates[0]);
    if (
        reference === null ||
        candidates.slice(1).some((pnu) => digestFor(pnu) !== reference)
    ) {
        return null;
    }
    return candidates[0];
}

/** building_unit 후보 floor 표기를 matcher 주입 전 정규화한다(integer ↔ '3층'). */
function normalizeBuildingUnitFloor(candidate: BuildingUnitCandidate): BuildingUnitCandidate {
    return { ...candidate, floor: candidate.floor == null ? null : normalizeFloorLabel(candidate.floor) || null };
}

interface ExposFloorHoFallbackEvidence {
    kind: 'EXPOS_FLOOR_HO_FALLBACK_GATE';
    allowed: boolean;
    fallbackRequiredCount: number;
    singleRoot: boolean;
    exposDongUnique: boolean;
    ldaregDongUnique: boolean;
    exposFloorHoUnique: boolean;
    ldaregFloorHoUnique: boolean;
    ldaregBuildingNameUnique: boolean;
    ldaregAgbldgSnUnique: boolean;
    ldaregMetadataCollision: boolean;
    oneSideDongOnly: boolean;
}

function floorHoKey(unit: {
    floor?: string | null;
    ho?: string | null;
}): string {
    return unitTupleKey(normalizeUnitTuple(unit), ['floor', 'ho']);
}

function dongFloorHoKey(unit: {
    dong?: string | null;
    floor?: string | null;
    ho?: string | null;
}): string {
    return unitTupleKey(normalizeUnitTuple(unit), ['dong', 'floor', 'ho']);
}

/**
 * dong 누락 호환은 matcher 개별 row 판단 전에 scope 전체에서 먼저 닫는다.
 * floor+ho와 양쪽의 dong token이 각각 scope 전체에서 유일하고,
 * 동일 FH의 LDAREG metadata 충돌이 없으며,
 * 실제 fallback pair마다 정확히 한쪽 dong만 비어 있을 때만 허용한다.
 */
function evaluateExposFloorHoFallback(
    records: readonly LdaregSourceRecord[],
    exposUnits: readonly ExposUnitCandidate[],
    scopeRootIdentity: string
): ExposFloorHoFallbackEvidence {
    const rootSet = new Set(
        exposUnits.map((unit) => unit.rootIdentity.trim()).filter(Boolean)
    );
    const singleRoot =
        scopeRootIdentity.trim() !== '' &&
        rootSet.size === 1 &&
        rootSet.has(scopeRootIdentity.trim()) &&
        exposUnits.every((unit) => unit.rootIdentity.trim() !== '');
    const exposDongTokens = new Set(
        exposUnits.map((unit) => normalizeUnitTuple(unit).dong)
    );
    const exposDongUnique = exposDongTokens.size === 1;
    const ldaregDongTokens = new Set(
        records.map((record) => record.normalized.dong)
    );
    const ldaregDongUnique = ldaregDongTokens.size === 1;

    const exposFloorHoKeys = exposUnits.map(floorHoKey);
    const exposFloorHoUnique =
        exposUnits.every((unit) => {
            const normalized = normalizeUnitTuple(unit);
            return normalized.floor !== '' && normalized.ho !== '';
        }) &&
        new Set(exposFloorHoKeys).size === exposFloorHoKeys.length;
    const ldaregFloorHoKeys = records.map((record) =>
        floorHoKey(record.normalized)
    );
    const ldaregFloorHoUnique =
        records.every(
            (record) =>
                record.normalized.floor !== '' &&
                record.normalized.ho !== ''
        ) &&
        new Set(ldaregFloorHoKeys).size === ldaregFloorHoKeys.length;
    const ldaregBuildingNames = new Set(
        records.map((record) => record.buildingName).filter(Boolean)
    );
    const ldaregAgbldgSns = new Set(
        records.map((record) => record.agbldgSn ?? '').filter(Boolean)
    );
    const ldaregBuildingNameUnique =
        records.length > 0 &&
        records.every((record) => record.buildingName !== '') &&
        ldaregBuildingNames.size === 1;
    const ldaregAgbldgSnUnique =
        records.length > 0 &&
        records.every(
            (record) =>
                record.agbldgSn !== null &&
                record.agbldgSn !== ''
        ) &&
        ldaregAgbldgSns.size === 1;

    const metadataByFloorHo = new Map<string, Set<string>>();
    for (const record of records) {
        const key = floorHoKey(record.normalized);
        const signatures = metadataByFloorHo.get(key) ?? new Set<string>();
        signatures.add(
            JSON.stringify({
                buildingName: record.buildingName,
                agbldgSn: record.agbldgSn,
                room: record.normalized.room,
            })
        );
        metadataByFloorHo.set(key, signatures);
    }
    const ldaregMetadataCollision = [...metadataByFloorHo.values()].some(
        (signatures) => signatures.size > 1
    );

    let fallbackRequiredCount = 0;
    let oneSideDongOnly = true;
    for (const record of records) {
        const exactMatches = exposUnits.filter(
            (candidate) =>
                dongFloorHoKey(candidate) ===
                dongFloorHoKey(record.normalized)
        );
        if (exactMatches.length > 0) continue; // matcher에서 exact ambiguity를 별도 차단
        fallbackRequiredCount += 1;
        const candidates = exposUnits.filter(
            (candidate) =>
                floorHoKey(candidate) === floorHoKey(record.normalized)
        );
        if (candidates.length !== 1) {
            oneSideDongOnly = false;
            continue;
        }
        const sourceDong = record.normalized.dong;
        const candidateDong = normalizeUnitTuple(candidates[0]).dong;
        if ((sourceDong === '') === (candidateDong === '')) {
            oneSideDongOnly = false;
        }
    }

    const allowed =
        fallbackRequiredCount > 0 &&
        singleRoot &&
        exposDongUnique &&
        ldaregDongUnique &&
        exposFloorHoUnique &&
        ldaregFloorHoUnique &&
        ldaregBuildingNameUnique &&
        ldaregAgbldgSnUnique &&
        !ldaregMetadataCollision &&
        oneSideDongOnly;
    return {
        kind: 'EXPOS_FLOOR_HO_FALLBACK_GATE',
        allowed,
        fallbackRequiredCount,
        singleRoot,
        exposDongUnique,
        ldaregDongUnique,
        exposFloorHoUnique,
        ldaregFloorHoUnique,
        ldaregBuildingNameUnique,
        ldaregAgbldgSnUnique,
        ldaregMetadataCollision,
        oneSideDongOnly,
    };
}

interface ExposProviderShapeBridgeEvidence {
    kind: 'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE';
    allowed: boolean;
    bridgeRequiredCount: number;
    singleRoot: boolean;
    singleLdaregBuildingIdentity: boolean;
    standardExactOneToOne: boolean;
    sourceRawWitnessConsistent: boolean;
    sourceWitnessUnique: boolean;
    exposWitnessOneToOne: boolean;
    dongCompatible: boolean;
}

/**
 * 공용 exact witness를 runtime matcher에 열기 전 scope 전체 gate.
 *
 * 일반 DFH exact 행은 먼저 unique하게 소진하되 matcher에서는 기존 경로를
 * 그대로 사용한다. 남은 양쪽 witness set이 extra 없이 unique 1:1일 때만 bridge를
 * 연다. count/order/ratio를 호실 identity로 쓰지 않는다.
 */
function evaluateExposProviderShapeBridge(
    records: readonly LdaregSourceRecord[],
    canonicalRows: readonly LdaregRow[],
    replicatedRows: readonly LdaregRow[],
    exposUnits: readonly ExposUnitCandidate[],
    scopeRootIdentity: string
): ExposProviderShapeBridgeEvidence {
    const rootSet = new Set(
        exposUnits
            .map((unit) => unit.rootIdentity.trim())
            .filter(Boolean)
    );
    const singleRoot =
        scopeRootIdentity.trim() !== '' &&
        rootSet.size === 1 &&
        rootSet.has(scopeRootIdentity.trim()) &&
        exposUnits.every(
            (unit) => unit.rootIdentity.trim() !== ''
        );
    const replicatedBuildingIdentities = replicatedRows.map(
        (row) => {
            const raw = row as Record<string, unknown>;
            const exactIdentityScalar = (
                value: unknown
            ): string | null =>
                typeof value === 'string' &&
                value.trim() !== ''
                    ? value.trim()
                    : null;
            return {
                buildingName: exactIdentityScalar(raw.buldNm),
                aggregateSerial: exactIdentityScalar(
                    raw.agbldgSn
                ),
            };
        }
    );
    const buildingNames = new Set(
        replicatedBuildingIdentities.map(
            (identity) => identity.buildingName
        )
    );
    const aggregateSerials = new Set(
        replicatedBuildingIdentities.map(
            (identity) => identity.aggregateSerial
        )
    );
    const singleLdaregBuildingIdentity =
        replicatedBuildingIdentities.length > 0 &&
        replicatedBuildingIdentities.every(
            (identity) =>
                typeof identity.buildingName === 'string' &&
                identity.buildingName !== '' &&
                typeof identity.aggregateSerial === 'string' &&
                identity.aggregateSerial !== ''
        ) &&
        buildingNames.size === 1 &&
        aggregateSerials.size === 1;

    const standardMatchedExposIndexes: number[] = [];
    const residualSources: Array<{
        record: LdaregSourceRecord;
        witness: NonNullable<
            ReturnType<typeof providerUnitShapeWitness>
        >;
        witnessKey: string;
    }> = [];
    const dongPairs: Array<{
        sourceDong: string;
        exposDong: string;
    }> = [];
    let standardExactOneToOne = true;
    let sourceRawWitnessConsistent = true;
    let dongCompatible = true;

    for (const record of records) {
        const standardMatches = exposUnits
            .map((candidate, index) => ({ candidate, index }))
            .filter(
                ({ candidate }) =>
                    floorHoKey(candidate) ===
                    floorHoKey(record.normalized)
            );
        if (standardMatches.length === 1) {
            standardMatchedExposIndexes.push(
                standardMatches[0].index
            );
            dongPairs.push({
                sourceDong: record.normalized.dong,
                exposDong: normalizeUnitTuple(
                    standardMatches[0].candidate
                ).dong,
            });
            continue;
        }
        if (standardMatches.length > 1) {
            standardExactOneToOne = false;
            continue;
        }

        const memberIndexes = record.sourceRowIndexes;
        const memberWitnesses = memberIndexes.map((index) => {
            const raw =
                Number.isInteger(index) && index >= 0
                    ? canonicalRows[index]
                    : undefined;
            return raw
                ? providerUnitShapeWitness(
                      'LDAREG_UNIT',
                      raw as Record<string, unknown>
                  )
                : null;
        });
        const witnessKeys = memberWitnesses.map((witness) =>
            witness
                ? providerUnitShapeWitnessKey(witness)
                : null
        );
        const canonicalWitnesses = memberWitnesses.map(
            (witness) =>
                witness === null
                    ? null
                    : JSON.stringify([
                          witness.canonicalFloor,
                          witness.canonicalHo,
                      ])
        );
        if (
            memberIndexes.length === 0 ||
            !memberIndexes.includes(record.sourceRowIndex) ||
            memberWitnesses.some((witness) => witness === null) ||
            new Set(witnessKeys).size !== 1 ||
            new Set(canonicalWitnesses).size !== 1
        ) {
            sourceRawWitnessConsistent = false;
            continue;
        }
        const sourceWitness = memberWitnesses[0]!;
        const witnessKey =
            providerUnitShapeWitnessKey(sourceWitness);
        residualSources.push({
            record,
            witness: sourceWitness,
            witnessKey,
        });
    }

    standardExactOneToOne =
        standardExactOneToOne &&
        new Set(standardMatchedExposIndexes).size ===
            standardMatchedExposIndexes.length;
    const standardMatchedIndexSet = new Set(
        standardMatchedExposIndexes
    );
    const residualExpos = exposUnits
        .map((candidate, index) => ({
            candidate,
            index,
            witness: candidate.providerShapeWitness,
        }))
        .filter(
            (entry) => !standardMatchedIndexSet.has(entry.index)
        );
    const sourceWitnessKeys = residualSources.map(
        (source) => source.witnessKey
    );
    const residualExposWitnessKeys = residualExpos.map(
        (entry) =>
            entry.witness
                ? providerUnitShapeWitnessKey(entry.witness)
                : null
    );
    const sourceWitnessUnique =
        sourceRawWitnessConsistent &&
        sourceWitnessKeys.length > 0 &&
        new Set(sourceWitnessKeys).size ===
            sourceWitnessKeys.length;
    const residualExposWitnessUnique =
        residualExposWitnessKeys.every(
            (key): key is string => key !== null
        ) &&
        new Set(residualExposWitnessKeys).size ===
            residualExposWitnessKeys.length;
    const residualExposWitnessSet = new Set(
        residualExposWitnessKeys.filter(
            (key): key is string => key !== null
        )
    );
    const exposWitnessOneToOne =
        standardExactOneToOne &&
        residualExposWitnessUnique &&
        residualExpos.length === residualSources.length &&
        residualSources.every((source) =>
            residualExposWitnessSet.has(source.witnessKey)
        );

    if (exposWitnessOneToOne) {
        for (const source of residualSources) {
            const matched = residualExpos.find(
                (entry) =>
                    entry.witness !== null &&
                    entry.witness !== undefined &&
                    providerUnitShapeWitnessKey(
                        entry.witness
                    ) === source.witnessKey &&
                    entry.witness.canonicalFloor ===
                        source.witness.canonicalFloor &&
                    entry.witness.canonicalHo ===
                        source.witness.canonicalHo
            );
            if (!matched) {
                dongCompatible = false;
                continue;
            }
            const sourceDong = source.record.normalized.dong;
            const exposDong = normalizeUnitTuple(
                matched.candidate
            ).dong;
            dongPairs.push({
                sourceDong,
                exposDong,
            });
            if (
                sourceDong !== '' &&
                exposDong !== '' &&
                sourceDong !== exposDong
            ) {
                dongCompatible = false;
            }
        }
    } else {
        dongCompatible = false;
    }
    const bridgeRequiredCount = residualSources.length;

    const oneSidedDirections = new Set<string>();
    const oneSidedDongTokens = new Set<string>();
    const allDongTokens = new Set<string>();
    for (const { sourceDong, exposDong } of dongPairs) {
        if (sourceDong !== '' && exposDong !== '') {
            if (sourceDong !== exposDong) {
                dongCompatible = false;
            }
            allDongTokens.add(sourceDong);
            continue;
        }
        if (sourceDong === '' && exposDong === '') continue;
        oneSidedDirections.add(
            exposDong !== '' ? 'EXPOS_ONLY' : 'LDAREG_ONLY'
        );
        const presentDong = exposDong || sourceDong;
        oneSidedDongTokens.add(presentDong);
        allDongTokens.add(presentDong);
    }
    if (
        oneSidedDirections.size > 1 ||
        oneSidedDongTokens.size > 1 ||
        (oneSidedDongTokens.size > 0 &&
            allDongTokens.size > 1)
    ) {
        dongCompatible = false;
    }

    const allowed =
        bridgeRequiredCount > 0 &&
        singleRoot &&
        singleLdaregBuildingIdentity &&
        standardExactOneToOne &&
        sourceRawWitnessConsistent &&
        sourceWitnessUnique &&
        exposWitnessOneToOne &&
        dongCompatible;
    return {
        kind: 'EXPOS_PROVIDER_SHAPE_BRIDGE_GATE',
        allowed,
        bridgeRequiredCount,
        singleRoot,
        singleLdaregBuildingIdentity,
        standardExactOneToOne,
        sourceRawWitnessConsistent,
        sourceWitnessUnique,
        exposWitnessOneToOne,
        dongCompatible,
    };
}

/**
 * LDAREG 분기 p_items 를 조립한다.
 */
export function assembleLdaregApply(input: LdaregBranchInput): LdaregBranchResult {
    const { unionId, scannedPnus, rootIdentity, perPnu, propertyUnits } = input;
    const expectedTargetPnus = [...new Set(scannedPnus)].sort();
    const scopeLadfrlAreas = [...input.scopeLadfrlAreas].sort((a, b) => a.pnu.localeCompare(b.pnu));
    const scopeLadfrlTotal = Number(input.scopeLadfrlTotal);
    const buildingUnits = input.buildingUnits.map(normalizeBuildingUnitFloor);
    const rawLandRegistryRows = perPnu.reduce((sum, scan) => sum + scan.ldaregRows.length, 0);
    const rawExposureRows = perPnu.reduce((sum, scan) => sum + scan.exposRows.length, 0);
    const replication = validateLdaregReplication(
        scannedPnus,
        perPnu,
        input.canonicalSourcePnu
    );
    const canonicalScan = perPnu.find((scan) => scan.pnu === input.canonicalSourcePnu);
    const basisRootIndex = buildScopeBasisRootIndex(perPnu, [rootIdentity]);
    const scopeExpos =
        basisRootIndex === null
            ? { ok: false as const }
            : collectScopeExposUnits(perPnu, basisRootIndex);
    if (
        !replication.ok ||
        !canonicalScan ||
        !scopeExpos.ok ||
        scopeExpos.units.length === 0
    ) {
        return {
            items: [],
            issues: [{ code: 'LDAREG_IDENTITY_CONFLICT' }],
            matchedPropertyUnitIds: [],
            counts: {
                landRegistryRows: rawLandRegistryRows,
                exposureRows: rawExposureRows,
                parsedRows: 0,
            },
            componentMatchDigest: [
                {
                    kind: 'SCOPE_LADFRL',
                    areas: scopeLadfrlAreas,
                    totalArea: input.scopeLadfrlTotal,
                },
            ],
            replicationEvidence: null,
            blocking: true,
        };
    }

    const issues: LandAreaSyncIssue[] = [];
    let parsedRows = 0;
    let denominatorMismatch = false;
    let ratioParseFailed = false;
    let unitMatchIncomplete = false;
    let sourceStateAmbiguous = false;

    // property_unit_id → component 목록.
    const byProperty = new Map<string, LandAreaSyncApplyLdaregComponent[]>();
    const componentMatchDigest: Array<Record<string, unknown>> = [
        {
            kind: 'SCOPE_LADFRL',
            areas: scopeLadfrlAreas,
            totalArea: input.scopeLadfrlTotal,
        },
        {
            kind: 'LDAREG_REPLICATION',
            ...replication.evidence,
        },
    ];

    // canonical base LDAREG를 한 번만 dedup/match한다. EXPOS는 scope 전체에서 합친
    // normalized 후보를 사용하므로 호실이 기준 또는 부속 PNU 한쪽에만 있어도 매칭한다.
    // attached PNU의 expos COMPLETE_ZERO도 정상이다.
    const exposUnits = scopeExpos.units;
    const placeholderIndexes = new Set(
        canonicalScan.ldaregRows
            .map((row, index) =>
                isObservedNonApplicablePlaceholder(row) ? index : -1
            )
            .filter((index) => index >= 0)
    );
    if (placeholderIndexes.size > 0) {
        componentMatchDigest.push({
            kind: 'LDAREG_NON_APPLICABLE_PLACEHOLDER',
            ignoredCount: placeholderIndexes.size,
        });
    }
    if (placeholderIndexes.size > 1) {
        issues.push({
            code: 'RATIO_PARSE_FAILED',
            targetPnu: canonicalScan.pnu,
        });
        ratioParseFailed = true;
    }

    const observations: LdaregObservationInput[] =
        canonicalScan.ldaregRows.flatMap((row, idx) => {
            if (placeholderIndexes.has(idx)) return [];
            const r = row as Record<string, unknown>;
            const decision = mapClsSeCodeToSourceState(
                str(r.clsSeCode),
                str(r.clsSeCodeNm)
            );
            return [
                {
                    targetPnu: canonicalScan.pnu,
                    identityRoot: rootIdentity,
                    agbldgSn: str(r.agbldgSn) || null,
                    buildingName: str(r.buldNm) || null,
                    dong: normalizeLdaregDong(r.buldDongNm),
                    floor:
                        normalizeFloorLabel(str(r.buldFloorNm)) ||
                        null,
                    ho: str(r.buldHoNm) || null,
                    room: str(r.buldRoomNm) || null,
                    ldaQotaRate: str(r.ldaQotaRate) || null,
                    clsSeCode: str(r.clsSeCode) || null,
                    sourceState: decision.state,
                    sourceStateAmbiguous: decision.ambiguous,
                    sourceIndex: idx,
                },
            ];
        });
    const dedup = dedupLdaregObservations(observations);
    const floorHoFallback = evaluateExposFloorHoFallback(
        dedup.records,
        exposUnits,
        rootIdentity
    );
    const providerShapeBridge =
        evaluateExposProviderShapeBridge(
            dedup.records,
            canonicalScan.ldaregRows,
            perPnu.flatMap((scan) => scan.ldaregRows),
            exposUnits,
            rootIdentity
        );
    componentMatchDigest.push(
        {
            kind: 'EXPOS_ROOT_RESOLUTION',
            rows: scopeExpos.rootEvidence,
        },
        { ...floorHoFallback },
        { ...providerShapeBridge }
    );
    const dedupConflict = dedup.issues.some(
        (issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'
    );
    for (const issue of dedup.issues) {
        issues.push({ code: issue.code, targetPnu: canonicalScan.pnu });
    }

    // exact multiset 검증을 통과했으므로 canonical logical key별 raw row가 모든 PNU에 존재한다.
    // sourceRecord.pnu provenance를 보존하기 위해 target별 대응 raw row를 별도로 꺼낸다.
    const rowsByPnuAndKey = new Map<string, Map<string, LdaregRow[]>>();
    for (const scan of perPnu) {
        const byKey = new Map<string, LdaregRow[]>();
        for (const row of scan.ldaregRows) {
            const key = canonicalLdaregRowKey(row);
            if (key === null) continue; // replication validation에서 이미 차단됨
            const list = byKey.get(key) ?? [];
            list.push(row);
            byKey.set(key, list);
        }
        rowsByPnuAndKey.set(scan.pnu, byKey);
    }

    for (const record of dedup.records) {
        const canonicalRaw =
            record.sourceRowIndex >= 0
                ? canonicalScan.ldaregRows[record.sourceRowIndex]
                : undefined;
        const canonicalKey = canonicalRaw ? canonicalLdaregRowKey(canonicalRaw) : null;
        if (canonicalKey === null) {
            issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', targetPnu: canonicalScan.pnu });
            ratioParseFailed = true;
            continue;
        }

        const source: MatchSource = {
            targetPnu: canonicalScan.pnu,
            dong: record.normalized.dong || null,
            floor: record.normalized.floor || null,
            ho: record.normalized.ho || null,
            room: record.normalized.room || null,
            registryExternalId: null,
            providerShapeWitness: canonicalRaw
                ? providerUnitShapeWitness(
                      'LDAREG_UNIT',
                      canonicalRaw as Record<string, unknown>
                  )
                : null,
            expectedPnuScope: expectedTargetPnus,
        };
        const decision = matchLdaregUnit({
            source,
            scopeRootIdentity: rootIdentity,
            exposUnits,
            buildingUnits,
            propertyUnits,
            unionId,
            allowExposFloorHoFallback: floorHoFallback.allowed,
            allowProviderShapeBridge:
                providerShapeBridge.allowed,
        });
        if (decision.kind === 'NO_CHANGE') {
            unitMatchIncomplete = true;
            issues.push({ code: decision.issue, targetPnu: canonicalScan.pnu });
            continue;
        }

        if (record.sourceStateAmbiguous) {
            sourceStateAmbiguous = true;
            issues.push({
                code: 'LDAREG_IDENTITY_CONFLICT',
                propertyUnitId: decision.propertyUnitId,
                targetPnu: canonicalScan.pnu,
            });
        }

        let ratio:
            | {
                  raw: string;
                  numeratorText: string;
                  denominatorText: string;
              }
            | null = null;
        if (record.state === 'CURRENT') {
            const parsed = parseLdaQotaRate(record.ldaQotaRateRaw);
            if (!parsed.ok) {
                ratioParseFailed = true;
                issues.push({
                    code: parsed.issue,
                    propertyUnitId: decision.propertyUnitId,
                    targetPnu: canonicalScan.pnu,
                });
                continue;
            }
            const denomCheck = checkDenominatorAgainstArea(parsed.denominator, scopeLadfrlTotal);
            if (!denomCheck.ok) {
                denominatorMismatch = true;
                issues.push({
                    code: denomCheck.issue,
                    propertyUnitId: decision.propertyUnitId,
                    targetPnu: canonicalScan.pnu,
                });
                continue;
            }
            ratio = parsed;
            parsedRows += expectedTargetPnus.length;
        }

        for (const targetPnu of expectedTargetPnus) {
            const targetRaw = rowsByPnuAndKey.get(targetPnu)?.get(canonicalKey)?.[0];
            if (!targetRaw) {
                ratioParseFailed = true;
                issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', targetPnu });
                continue;
            }
            const component: LandAreaSyncApplyLdaregComponent =
                record.state === 'CLOSED'
                    ? {
                          targetPnu,
                          sourceState: 'CLOSED',
                          matchMethod: decision.buildingUnitRef
                              ? 'BUILDING_UNIT_ID'
                              : 'PNU_DONG_HO',
                          matchedBuildingUnitId: decision.buildingUnitRef,
                          sourceIdentity: record.identity.value,
                          sourceAgbldgSn:
                              record.identity.kind === 'PRIMARY' ? record.agbldgSn : null,
                          ratioRaw: str(record.ldaQotaRateRaw) || '0/1',
                          ratioNumerator: '0',
                          ratioDenominator: '1',
                          retiredReason: 'CLS_SE_CODE_CLOSED',
                          sourceRecord: extractSourceRecord(targetRaw),
                      }
                    : {
                          targetPnu,
                          sourceState: 'CURRENT',
                          matchMethod: decision.buildingUnitRef
                              ? 'BUILDING_UNIT_ID'
                              : 'PNU_DONG_HO',
                          matchedBuildingUnitId: decision.buildingUnitRef,
                          sourceIdentity: record.identity.value,
                          sourceAgbldgSn: record.agbldgSn,
                          ratioRaw: ratio!.raw,
                          ratioNumerator: ratio!.numeratorText,
                          ratioDenominator: ratio!.denominatorText,
                          retiredReason: null,
                          sourceRecord: extractSourceRecord(targetRaw),
                      };
            pushComponent(byProperty, decision.propertyUnitId, component);
            componentMatchDigest.push(
                digestOf(decision.propertyUnitId, component, input.scopeLadfrlTotal)
            );
        }
    }

    // 모든 PNU가 strict COMPLETE_ZERO인 경우에만 scope property를 empty component item으로
    // 전달한다. 기존 rights의 STALE lifecycle 평가는 가능하지만 신규 0 면적을 만들지는 않는다.
    if (replication.evidence.rowCount === 0) {
        for (const property of propertyUnits) {
            if (property.unionId !== unionId || property.isDeleted) continue;
            if (!byProperty.has(property.id)) byProperty.set(property.id, []);
        }
    }

    const items: LandAreaSyncApplyLdaregItem[] = [...byProperty.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([propertyUnitId, components]) => ({
            propertyUnitId,
            expectedTargetPnus,
            components: components.sort((x, y) => {
                const pnuOrder = x.targetPnu.localeCompare(y.targetPnu);
                if (pnuOrder !== 0) return pnuOrder;
                const identityOrder = x.sourceIdentity.localeCompare(y.sourceIdentity);
                if (identityOrder !== 0) return identityOrder;
                return x.sourceState.localeCompare(y.sourceState);
            }),
        }));

    let ambiguousPropertyIdentity = false;
    for (const item of items) {
        const identities = new Set(
            item.components.map((component) => component.sourceIdentity)
        );
        const countByTarget = new Map<string, number>();
        for (const component of item.components) {
            countByTarget.set(
                component.targetPnu,
                (countByTarget.get(component.targetPnu) ?? 0) + 1
            );
        }
        if (
            identities.size < 2 &&
            ![...countByTarget.values()].some((count) => count > 1)
        ) {
            continue;
        }
        ambiguousPropertyIdentity = true;
        issues.push({
            code: 'LDAREG_IDENTITY_CONFLICT',
            propertyUnitId: item.propertyUnitId,
        });
    }

    // exact replica의 각 logical identity는 property별 모든 target PNU에 정확히 1개씩
    // 존재하고, query-specific targetPnu/sourceRecord.pnu를 제외한 payload가 같아야 한다.
    let componentReplicaMismatch = false;
    for (const item of items) {
        const byIdentity = new Map<string, LandAreaSyncApplyLdaregComponent[]>();
        for (const component of item.components) {
            const list = byIdentity.get(component.sourceIdentity) ?? [];
            list.push(component);
            byIdentity.set(component.sourceIdentity, list);
        }
        for (const components of byIdentity.values()) {
            const targets = components.map((component) => component.targetPnu).sort();
            const payloads = components.map(componentReplicaPayload);
            if (
                components.length !== expectedTargetPnus.length ||
                targets.some((pnu, index) => pnu !== expectedTargetPnus[index]) ||
                new Set(payloads).size !== 1
            ) {
                componentReplicaMismatch = true;
                break;
            }
        }
        if (componentReplicaMismatch) break;
    }

    if (componentReplicaMismatch) {
        issues.push({
            code: 'LDAREG_IDENTITY_CONFLICT',
        });
    }
    const nonzeroWithoutMatchedItem =
        replication.evidence.rowCount > 0 && items.length === 0;
    if (nonzeroWithoutMatchedItem && issues.length === 0) {
        issues.push({ code: 'PROPERTY_UNIT_NOT_FOUND' });
    }

    return {
        items,
        issues,
        matchedPropertyUnitIds: items.map((i) => i.propertyUnitId),
        counts: {
            landRegistryRows: rawLandRegistryRows,
            exposureRows: rawExposureRows,
            parsedRows,
        },
        componentMatchDigest: componentMatchDigest.sort((a, b) =>
            JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0
        ),
        replicationEvidence: replication.evidence,
        blocking:
            denominatorMismatch ||
            ratioParseFailed ||
            sourceStateAmbiguous ||
            componentReplicaMismatch ||
            ambiguousPropertyIdentity ||
            nonzeroWithoutMatchedItem ||
            unitMatchIncomplete ||
            dedupConflict,
    };
}

function componentReplicaPayload(component: LandAreaSyncApplyLdaregComponent): string {
    const sourceRecord = { ...component.sourceRecord };
    delete sourceRecord.pnu;
    return JSON.stringify({
        sourceState: component.sourceState,
        matchMethod: component.matchMethod,
        matchedBuildingUnitId: component.matchedBuildingUnitId,
        sourceIdentity: component.sourceIdentity,
        sourceAgbldgSn: component.sourceAgbldgSn,
        ratioRaw: component.ratioRaw,
        ratioNumerator: component.ratioNumerator,
        ratioDenominator: component.ratioDenominator,
        retiredReason: component.retiredReason,
        sourceRecord,
    });
}

function pushComponent(
    map: Map<string, LandAreaSyncApplyLdaregComponent[]>,
    propertyUnitId: string,
    component: LandAreaSyncApplyLdaregComponent
): void {
    const list = map.get(propertyUnitId) ?? [];
    list.push(component);
    map.set(propertyUnitId, list);
}

function digestOf(
    propertyUnitId: string,
    c: LandAreaSyncApplyLdaregComponent,
    scopeLadfrlTotal: string
): Record<string, unknown> {
    return {
        propertyUnitId,
        targetPnu: c.targetPnu,
        sourceState: c.sourceState,
        sourceIdentity: c.sourceIdentity,
        ratioNumerator: c.ratioNumerator,
        ratioDenominator: c.ratioDenominator,
        scopeLadfrlTotal,
    };
}

export type { LandAreaSyncIssueCode };
