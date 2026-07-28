import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../src/types/land-area-sync.types';
import {
    LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH,
    LAND_AREA_PHASE0_MANIFEST_VERSION,
    LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
    buildLandAreaPhase0CapturePlan,
    captureLandAreaPhase0,
    parseLandAreaPhase0Manifest,
    resolveLandAreaPhase0OutputPath,
    type LandAreaPhase0CaptureAdapter,
    type LandAreaPhase0CaptureManifest,
} from '../src/verification/land-area-phase0-capture';
import { validateLandAreaPhase0CaptureArtifact } from '../src/verification/land-area-phase0-artifact-validator';
import {
    runLandAreaPhase0CaptureCli,
    writeLandAreaPhase0Artifact,
} from '../src/cli/phase0-land-area-capture';
import {
    LAND_AREA_PHASE0_VALIDATION_SENTINEL,
    runLandAreaPhase0ValidationCli,
} from '../src/cli/phase0-land-area-validate';

const ZERO_PNU = '1168010100107000000';
const POSITIVE_PNU = '1168010100107360024';
const ATTACHED_PNU = '1168010100107360025';
const SINGLE_PARCEL_MULTIPLEX_PNU = '1168010100107360030';
const MIA7_2172_PNU = '1130510100107912172';
const MIA7_2173_PNU = '1130510100107912173';
const MIA7_2188_PNU = '1130510100107912188';
const MIA7_2191_PNU = '1130510100107912191';
const ZERO_PK = '1001001001001';
const ZERO_UP_PK = '1001001001002';
const POSITIVE_PK = '2002002002001';
const POSITIVE_UP_PK = '2002002002002';
const SINGLE_PARCEL_MULTIPLEX_PK = '3003003003001';
const SECRET = 'SECRET-CANARY-DO-NOT-EMIT';
const DOMAIN = 'secret-domain.example';
const OWNER = 'OWNER-CANARY-DO-NOT-EMIT';
const CONTACT = '010-9999-9999';
const UNIT_DONG = 'UNIT-DONG-CANARY';
const UNIT_FLOOR = '지하1층';
const UNIT_HO = 'UNIT-HO-CANARY';
const UNKNOWN_KEY = 'unknownSecretFieldCanary';

const HUB_AUTH = { serviceKey: SECRET };
const VWORLD_AUTH = { key: `${SECRET}-VWORLD`, domain: DOMAIN };

function manifest(samples?: LandAreaPhase0CaptureManifest['samples']): LandAreaPhase0CaptureManifest {
    return {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION,
        samples:
            samples ?? [
                { alias: 'zero-sample', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                { alias: 'positive-sample', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
            ],
    };
}

function canonicalTestValue(candidate: unknown): unknown {
    if (Array.isArray(candidate)) {
        return candidate.map(canonicalTestValue);
    }
    if (candidate !== null && typeof candidate === 'object') {
        return Object.fromEntries(
            Object.entries(candidate as Record<string, unknown>)
                .filter(([, nested]) => nested !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [
                    key,
                    canonicalTestValue(nested),
                ])
        );
    }
    return candidate;
}

function canonicalTestString(value: unknown): string {
    return JSON.stringify(canonicalTestValue(value));
}

function sortCanonicalTestRecords<T>(records: T[]): T[] {
    return records.sort((left, right) =>
        canonicalTestString(left).localeCompare(
            canonicalTestString(right)
        )
    );
}

function sanitizedTestDigest(value: unknown): string {
    return createHash('sha256')
        .update(canonicalTestString(value), 'utf8')
        .digest('hex');
}

function complete<T>(rows: T[]): StrictScan<T> {
    return {
        state: rows.length === 0 ? 'COMPLETE_ZERO' : 'COMPLETE',
        rows: rows as T[] & [],
        totalCount: rows.length,
        pagesFetched: 1,
    } as StrictScan<T>;
}

function titleRows(pnu: string): BrTitleRow[] {
    if (pnu === ZERO_PNU) {
        return [
            {
                pnu,
                mgmBldrgstPk: ZERO_PK,
                bylotCnt: '0',
                regstrGbCd: '1',
                regstrGbCdNm: '일반건축물대장',
                mainPurpsCd: '01000',
                mainPurpsCdNm: '단독주택',
                etcPurps: '주거시설',
                ownerNm: OWNER,
                [UNKNOWN_KEY]: SECRET,
            },
        ];
    }
    return [
        {
            pnu,
            mgmBldrgstPk: POSITIVE_PK,
            bylotCnt: '1',
            regstrGbCd: '2',
            regstrGbCdNm: '집합건축물대장',
            mainPurpsCd: '02003',
            mainPurpsCdNm: '다세대주택',
            etcPurps: `공동주택(다세대주택) ${OWNER}`,
            ownerTelno: CONTACT,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function basisRows(pnu: string): BrBasisOulnRow[] {
    return [
        {
            pnu,
            mgmBldrgstPk: pnu === ZERO_PNU ? ZERO_PK : POSITIVE_PK,
            mgmUpBldrgstPk:
                pnu === ZERO_PNU ? ZERO_UP_PK : POSITIVE_UP_PK,
            bylotCnt: pnu === ZERO_PNU ? '0' : '1',
            ownerNm: OWNER,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function attachedRows(pnu: string): BrAtchJibunRow[] {
    if (pnu === ZERO_PNU) return [];
    return [
        {
            mgmBldrgstPk: POSITIVE_PK,
            sigunguCd: '11680',
            bjdongCd: '10100',
            platGbCd: '0',
            bun: '0736',
            ji: '0024',
            atchSigunguCd: '11680',
            atchBjdongCd: '10100',
            atchPlatGbCd: '0',
            atchBun: '0736',
            atchJi: '0025',
            ownerNm: OWNER,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function exposRows(pnu: string): BrExposRow[] {
    if (pnu === ATTACHED_PNU) return [];
    return [
        {
            pnu,
            mgmBldrgstPk: pnu === ZERO_PNU ? ZERO_PK : POSITIVE_PK,
            dongNm: UNIT_DONG,
            flrNoNm: UNIT_FLOOR,
            hoNm: UNIT_HO,
            mainAtchGbCd: DOMAIN,
            ownerNm: OWNER,
            ownerTelno: CONTACT,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function ladfrlRows(pnu: string): LadfrlRow[] {
    return [
        {
            pnu,
            lndpclAr:
                pnu === ZERO_PNU
                    ? '100.5'
                    : pnu === ATTACHED_PNU
                      ? '187'
                      : '177.6',
            lndcgrCode: '08',
            ownerNm: OWNER,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function ldaregRows(pnu: string): LdaregRow[] {
    if (pnu === ZERO_PNU) return [];
    return [
        {
            pnu,
            agbldgSn: 'RAW-AGBLDG-SN',
            ldaQotaRate: '24.6/364.6',
            clsSeCode: '0',
            clsSeCodeNm: '유효',
            buldNm: UNIT_DONG,
            buldDongNm: UNIT_DONG,
            buldFloorNm: UNIT_FLOOR,
            buldHoNm: UNIT_HO,
            ownerNm: OWNER,
            contact: CONTACT,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function adapter(overrides: Partial<LandAreaPhase0CaptureAdapter> = {}) {
    const calls: Array<{ endpoint: string; pnu: string }> = [];
    const implementation: LandAreaPhase0CaptureAdapter = {
        async scanTitle(pnu) {
            calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(titleRows(pnu));
        },
        async scanBasis(pnu) {
            calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(basisRows(pnu));
        },
        async scanAttached(pnu) {
            calls.push({ endpoint: 'getBrAtchJibunInfo', pnu });
            return complete(attachedRows(pnu));
        },
        async scanExpos(pnu) {
            calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(exposRows(pnu));
        },
        async scanLadfrl(pnu) {
            calls.push({ endpoint: 'ladfrlList', pnu });
            return complete(ladfrlRows(pnu));
        },
        async scanLdareg(pnu) {
            calls.push({ endpoint: 'ldaregList', pnu });
            return complete(ldaregRows(pnu));
        },
        ...overrides,
    };
    return { implementation, calls };
}

function v2TargetManifest(
    alias: string,
    pnu: string
): LandAreaPhase0CaptureManifest {
    return {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
        samples: [
            {
                alias: 'zero-control',
                expectedBylot: 'ZERO',
                expectedFamily: 'LADFRL',
                pnu: ZERO_PNU,
            },
            {
                alias: 'positive-control',
                expectedBylot: 'POSITIVE',
                expectedFamily: 'LDAREG',
                pnu: POSITIVE_PNU,
            },
            {
                alias,
                expectedBylot: 'ZERO',
                expectedFamily: 'LDAREG',
                pnu,
            },
        ],
    };
}

function singleParcelTargetAdapter(input: {
    pnu: string;
    rootPk: string;
    etcPurps?: string;
    expos: BrExposRow[];
    ldareg: LdaregRow[];
    landArea: string;
    duplicateTitle?: boolean;
    registryTypeLabel?: string;
}) {
    const target = adapter({
        async scanTitle(pnu) {
            target.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            if (pnu !== input.pnu) return complete(titleRows(pnu));
            const row: BrTitleRow = {
                pnu,
                mgmBldrgstPk: input.rootPk,
                bylotCnt: '0',
                regstrGbCd: '2',
                regstrGbCdNm:
                    input.registryTypeLabel ?? '집합',
                mainPurpsCd: '02000',
                mainPurpsCdNm: '공동주택',
                ...(input.etcPurps !== undefined
                    ? { etcPurps: input.etcPurps }
                    : {}),
            };
            return complete(
                input.duplicateTitle ? [row, { ...row }] : [row]
            );
        },
        async scanBasis(pnu) {
            target.calls.push({
                endpoint: 'getBrBasisOulnInfo',
                pnu,
            });
            return pnu === input.pnu
                ? complete([
                      {
                          pnu,
                          mgmBldrgstPk: input.rootPk,
                          bylotCnt: '0',
                      },
                  ])
                : complete(basisRows(pnu));
        },
        async scanAttached(pnu) {
            target.calls.push({
                endpoint: 'getBrAtchJibunInfo',
                pnu,
            });
            return pnu === input.pnu
                ? complete([])
                : complete(attachedRows(pnu));
        },
        async scanExpos(pnu) {
            target.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return pnu === input.pnu
                ? complete(
                      input.expos.map((row) => ({
                          pnu,
                          mgmBldrgstPk: input.rootPk,
                          ...row,
                      }))
                  )
                : complete(exposRows(pnu));
        },
        async scanLadfrl(pnu) {
            target.calls.push({ endpoint: 'ladfrlList', pnu });
            return pnu === input.pnu
                ? complete([{ pnu, lndpclAr: input.landArea }])
                : complete(ladfrlRows(pnu));
        },
        async scanLdareg(pnu) {
            target.calls.push({ endpoint: 'ldaregList', pnu });
            return pnu === input.pnu
                ? complete(
                      input.ldareg.map((row) => ({
                          pnu,
                          ...row,
                      }))
                  )
                : complete(ldaregRows(pnu));
        },
    });
    return target;
}

test('manifest: version+samples와 ZERO/POSITIVE 최소 1개만 허용한다', () => {
    assert.deepEqual(parseLandAreaPhase0Manifest(manifest()), manifest());

    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                ...manifest(),
                serviceKey: SECRET,
            }),
        /허용되지 않은 키/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [{ alias: 'zero-only', expectedBylot: 'ZERO', pnu: ZERO_PNU }],
            }),
        /ZERO와 POSITIVE/
    );
});

test('manifest v2는 expectedBylot과 expectedFamily를 독립적으로 exact 검증한다', () => {
    const v2 = {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
        samples: [
            {
                alias: 'zero-ldareg',
                expectedBylot: 'ZERO',
                expectedFamily: 'LDAREG',
                pnu: ZERO_PNU,
            },
            {
                alias: 'positive-ladfrl',
                expectedBylot: 'POSITIVE',
                expectedFamily: 'LADFRL',
                pnu: POSITIVE_PNU,
            },
        ],
    } as const;
    assert.deepEqual(parseLandAreaPhase0Manifest(v2), v2);
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                ...v2,
                samples: v2.samples.map(
                    ({ expectedFamily: _omitted, ...sample }) => sample
                ),
            }),
        /expectedFamily/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                ...v2,
                samples: [
                    { ...v2.samples[0], expectedFamily: 'MANUAL' },
                    v2.samples[1],
                ],
            }),
        /expectedFamily/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: v2.samples,
            }),
        /허용되지 않은 키/
    );
});

test('manifest: 중복 alias는 대소문자와 무관하게 fail-closed', () => {
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'Case-A', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                    { alias: 'case-a', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /alias가 중복/
    );
});

test('manifest: 중복 PNU, unknown sample key, 잘못된 alias/PNU를 거부한다', () => {
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'zero', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: ZERO_PNU },
                ],
            }),
        /PNU가 중복/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'zero', expectedBylot: 'ZERO', pnu: ZERO_PNU, owner: OWNER },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /허용되지 않은 키/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: '../zero', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /alias 형식/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'zero', expectedBylot: 'ZERO', pnu: '123' },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /PNU 형식/
    );
});

test('dry plan: 비식별 계획만 만들고 HTTP 호출은 0회다', () => {
    const { calls } = adapter();
    const plan = buildLandAreaPhase0CapturePlan(manifest());
    assert.equal(calls.length, 0);
    assert.equal(plan.sampleCount, 2);
    assert.equal(plan.requestCount, 12);
    assert.equal(JSON.stringify(plan).includes(ZERO_PNU), false);
    assert.equal(JSON.stringify(plan).includes('zero-sample'), false);
    assert.match(plan.samples[0].pnuHash, /^[a-f0-9]{64}$/);
    assert.match(plan.samples[0].aliasHash, /^[a-f0-9]{64}$/);
});

test('live capture: sample 6 endpoint 뒤 linked scope BASIS/LADFRL/LDAREG/EXPOS를 PNU별 1회 호출한다', async () => {
    const { implementation, calls } = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    const baseEndpointOrder = [
        'getBrTitleInfo',
        'getBrBasisOulnInfo',
        'getBrAtchJibunInfo',
        'getBrExposInfo',
        'ladfrlList',
        'ldaregList',
    ];
    for (const pnu of [ZERO_PNU, POSITIVE_PNU]) {
        assert.deepEqual(
            calls
                .filter((call) => call.pnu === pnu)
                .map((call) => call.endpoint),
            baseEndpointOrder
        );
    }
    assert.deepEqual(
        calls.filter((call) => call.pnu === ATTACHED_PNU).map((call) => call.endpoint),
        [
            'getBrBasisOulnInfo',
            'ladfrlList',
            'ldaregList',
            'getBrExposInfo',
        ]
    );
    assert.equal(
        calls.filter(
            (call) =>
                call.pnu === ATTACHED_PNU &&
                call.endpoint === 'getBrBasisOulnInfo'
        ).length,
        1
    );
    assert.deepEqual(
        artifact.samples.map((sample) => sample.aliasHash),
        artifact.samples.map((sample) => sample.aliasHash).sort()
    );
    for (const sample of artifact.samples) {
        assert.match(sample.aliasHash, /^[a-f0-9]{64}$/);
        assert.equal(sample.endpoints.length, 6);
        assert.ok(sample.endpoints.some((endpoint) => endpoint.endpoint === 'getBrBasisOulnInfo'));
    }
    assert.equal(JSON.stringify(artifact).includes('zero-sample'), false);
    assert.equal(JSON.stringify(artifact).includes('positive-sample'), false);
});

test('ZERO/POSITIVE: exact 관리 PK의 bylotCnt와 부속지번 수를 교차검증한다', async () => {
    const { implementation } = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    const zero = artifact.samples.find((sample) => sample.expectedBylot === 'ZERO')!;
    const positive = artifact.samples.find((sample) => sample.expectedBylot === 'POSITIVE')!;
    assert.equal(zero.checks.bylotAttached.status, 'PASS');
    assert.equal(positive.checks.bylotAttached.status, 'PASS');
    assert.equal(zero.policyCandidate, 'TITLE_ONLY');
    assert.equal(positive.policyCandidate, 'TITLE_ONLY');
    assert.equal(zero.checks.titleBasis.status, 'PASS');
    assert.equal(positive.checks.titleBasis.status, 'PASS');
    assert.equal(zero.evidence.bylotByManagementPk.records[0].titleCount, 0);
    assert.equal(zero.evidence.bylotByManagementPk.records[0].attachedPairCount, 0);
    assert.equal(positive.evidence.bylotByManagementPk.records[0].titleCount, 1);
    assert.equal(positive.evidence.bylotByManagementPk.records[0].basisCount, 1);
    assert.equal(positive.evidence.bylotByManagementPk.records[0].attachedPairCount, 1);
    assert.match(
        positive.evidence.bylotByManagementPk.records[0].managementPkHash,
        /^[a-f0-9]{64}$/
    );
    assert.equal(positive.evidence.scopeLadfrl.status, 'PASS');
    assert.deepEqual(
        positive.evidence.scopeLadfrl.records.map((record) => record.area),
        ['177.6', '187']
    );
    assert.equal(positive.evidence.scopeLadfrl.totalArea, '364.6');
    assert.equal(positive.evidence.ldaregReplication.status, 'PASS');
    assert.equal(positive.evidence.ldaregReplication.rowCount, 1);
    assert.equal(positive.evidence.ldaregReplication.comparedPnuHashes.length, 2);
    assert.match(
        positive.evidence.ldaregReplication.rowMultisetDigest ?? '',
        /^[a-f0-9]{64}$/
    );
});

test('부속지번 0개 다세대는 expectedBylot과 무관하게 공식 분류 LDAREG를 검증한다', async () => {
    const singleParcel = adapter({
        async scanTitle(pnu) {
            singleParcel.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            if (pnu !== SINGLE_PARCEL_MULTIPLEX_PNU) {
                return complete(titleRows(pnu));
            }
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: SINGLE_PARCEL_MULTIPLEX_PK,
                    bylotCnt: '0',
                    regstrGbCd: '2',
                    regstrGbCdNm: '집합',
                    mainPurpsCd: '02000',
                    mainPurpsCdNm: '공동주택',
                    etcPurps: '다세대주택',
                },
            ]);
        },
        async scanBasis(pnu) {
            singleParcel.calls.push({
                endpoint: 'getBrBasisOulnInfo',
                pnu,
            });
            if (pnu !== SINGLE_PARCEL_MULTIPLEX_PNU) {
                return complete(basisRows(pnu));
            }
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: SINGLE_PARCEL_MULTIPLEX_PK,
                    bylotCnt: '0',
                },
            ]);
        },
        async scanAttached(pnu) {
            singleParcel.calls.push({
                endpoint: 'getBrAtchJibunInfo',
                pnu,
            });
            return pnu === SINGLE_PARCEL_MULTIPLEX_PNU
                ? complete([])
                : complete(attachedRows(pnu));
        },
        async scanExpos(pnu) {
            singleParcel.calls.push({ endpoint: 'getBrExposInfo', pnu });
            if (pnu !== SINGLE_PARCEL_MULTIPLEX_PNU) {
                return complete(exposRows(pnu));
            }
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: SINGLE_PARCEL_MULTIPLEX_PK,
                    flrNo: 1,
                    hoNm: '101',
                },
            ]);
        },
        async scanLadfrl(pnu) {
            singleParcel.calls.push({ endpoint: 'ladfrlList', pnu });
            if (pnu !== SINGLE_PARCEL_MULTIPLEX_PNU) {
                return complete(ladfrlRows(pnu));
            }
            return complete([{ pnu, lndpclAr: '221' }]);
        },
        async scanLdareg(pnu) {
            singleParcel.calls.push({ endpoint: 'ldaregList', pnu });
            if (pnu !== SINGLE_PARCEL_MULTIPLEX_PNU) {
                return complete(ldaregRows(pnu));
            }
            return complete([
                {
                    pnu,
                    agbldgSn: 'SINGLE-PARCEL',
                    ldaQotaRate: '39.08/221',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldDongNm: '0000',
                    buldFloorNm: '1',
                    buldHoNm: '101',
                },
            ]);
        },
    });
    const approvedManifest: LandAreaPhase0CaptureManifest = {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
        samples: [
            {
                alias: 'zero-control',
                expectedBylot: 'ZERO',
                expectedFamily: 'LADFRL',
                pnu: ZERO_PNU,
            },
            {
                alias: 'positive-control',
                expectedBylot: 'POSITIVE',
                expectedFamily: 'LDAREG',
                pnu: POSITIVE_PNU,
            },
            {
                alias: 'single-parcel-multiplex',
                expectedBylot: 'ZERO',
                expectedFamily: 'LDAREG',
                pnu: SINGLE_PARCEL_MULTIPLEX_PNU,
            },
        ],
    };

    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: singleParcel.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    const target = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${SINGLE_PARCEL_MULTIPLEX_PNU}`)
                .digest('hex')
    )!;
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(target.expectedBylot, 'ZERO');
    assert.equal(target.checks.bylotAttached.status, 'PASS');
    assert.equal(target.evidence.ldaregReplication.status, 'PASS');
    assert.deepEqual(target.failureCodes, []);
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
    const wrongFamilyManifest: LandAreaPhase0CaptureManifest = {
        ...approvedManifest,
        samples: approvedManifest.samples.map((sample) =>
            sample.pnu === SINGLE_PARCEL_MULTIPLEX_PNU
                ? { ...sample, expectedFamily: 'LADFRL' }
                : sample
        ),
    };
    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                wrongFamilyManifest,
                artifact
            ),
        /manifest housing family/
    );
});

for (const target of [
    {
        label: '791-2173',
        pnu: MIA7_2173_PNU,
        rootPk: '3010101010101',
        etcPurps: '공동주택',
    },
    {
        label: '791-2188',
        pnu: MIA7_2188_PNU,
        rootPk: '3010101010102',
        etcPurps: undefined,
    },
] as const) {
    test(`${target.label}: input@2 expectedFamily=LDAREG는 exact 집합/02000/공동주택 + 무신호 title을 Phase 0에서만 인정한다`, async () => {
        const floors = ['1', '2', '3', '4'];
        const targetAdapter = singleParcelTargetAdapter({
            pnu: target.pnu,
            rootPk: target.rootPk,
            etcPurps: target.etcPurps,
            landArea: '96',
            expos: floors.map((floor) => ({
                flrGbCd: '20',
                flrNo: Number(floor),
                hoNm: `${floor}01`,
            })),
            ldareg: floors.map((floor) => ({
                agbldgSn: `GENERIC-${target.label}`,
                buldNm: `GENERIC-${target.label}`,
                ldaQotaRate: '24/96',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: floor,
                buldHoNm: `${floor}01`,
            })),
        });
        const approvedManifest = v2TargetManifest(
            `mia7-${target.label.replace('-', '')}`,
            target.pnu
        );
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: targetAdapter.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });

        const sample = artifact.samples.find(
            (candidate) =>
                candidate.pnuHash ===
                createHash('sha256')
                    .update(`PNU\u0000${target.pnu}`)
                    .digest('hex')
        )!;
        assert.equal(artifact.gate.status, 'PASS');
        assert.deepEqual(sample.failureCodes, []);
        assert.equal(sample.evidence.ldaregReplication.status, 'PASS');
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                sample.evidence.ldaregReplication,
                'providerBuildingIdentity'
            ),
            false,
            'provider witness가 없는 standard-only scope에는 proof를 추가하지 않는다'
        );
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    });
}

for (const contradictoryPurpose of [
    '단독주택',
    '다가구주택',
    '연립주택',
    '아파트',
    '근린생활시설',
] as const) {
    test(`generic 공동주택 fallback은 모순 기타용도 신호(${contradictoryPurpose})를 fail-closed한다`, async () => {
        const targetAdapter = singleParcelTargetAdapter({
            pnu: MIA7_2173_PNU,
            rootPk: '3010101010110',
            etcPurps: contradictoryPurpose,
            landArea: '96',
            expos: [
                {
                    flrGbCd: '20',
                    flrNo: 1,
                    hoNm: '101',
                },
            ],
            ldareg: [
                {
                    agbldgSn: 'CONTRADICTORY',
                    buldNm: 'CONTRADICTORY',
                    ldaQotaRate: '24/96',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldFloorNm: '1',
                    buldHoNm: '101',
                },
            ],
        });
        const approvedManifest = v2TargetManifest(
            'generic-conflict',
            MIA7_2173_PNU
        );
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: targetAdapter.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const targetSample = artifact.samples.find(
            (sample) =>
                sample.pnuHash ===
                createHash('sha256')
                    .update(`PNU\u0000${MIA7_2173_PNU}`)
                    .digest('hex')
        )!;

        assert.equal(artifact.gate.status, 'FAIL');
        assert.ok(
            targetSample.failureCodes.includes(
                'HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH'
            )
        );
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    });
}

test('generic 공동주택 fallback은 동일 title 중복 2건도 자동 인정하지 않는다', async () => {
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2188_PNU,
        rootPk: '3010101010120',
        landArea: '96',
        duplicateTitle: true,
        expos: [
            {
                flrGbCd: '20',
                flrNo: 1,
                hoNm: '101',
            },
        ],
        ldareg: [
            {
                agbldgSn: 'DUPLICATE-TITLE',
                buldNm: 'DUPLICATE-TITLE',
                ldaQotaRate: '24/96',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: '1',
                buldHoNm: '101',
            },
        ],
    });
    const approvedManifest = v2TargetManifest(
        'generic-duplicate-title',
        MIA7_2188_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2188_PNU}`)
                .digest('hex')
    )!;

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        targetSample.failureCodes.includes(
            'HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('generic 공동주택 fallback은 집합 코드의 label 불일치를 fail-closed한다', async () => {
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2188_PNU,
        rootPk: '3010101010121',
        registryTypeLabel: '일반',
        landArea: '96',
        expos: [
            {
                flrGbCd: '20',
                flrNo: 1,
                hoNm: '101',
            },
        ],
        ldareg: [
            {
                agbldgSn: 'REGISTRY-LABEL-MISMATCH',
                buldNm: 'REGISTRY-LABEL-MISMATCH',
                ldaQotaRate: '24/96',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: '1',
                buldHoNm: '101',
            },
        ],
    });
    const approvedManifest = v2TargetManifest(
        'generic-registry-label',
        MIA7_2188_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2188_PNU}`)
                .digest('hex')
    )!;

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        targetSample.failureCodes.includes(
            'HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('791-2172: Phase 0 v2는 LDAREG exact 지상#(접미사 없음)과 EXPOS 숫자 층·호를 raw unit로 결속한다', async () => {
    const units = [
        { floor: '3', ho: '301', numerator: '27.5' },
        { floor: '5', ho: '501', numerator: '17.26' },
        { floor: '4', ho: '401', numerator: '19.9' },
        { floor: '2', ho: '201', numerator: '19.97' },
        { floor: '2', ho: '202', numerator: '16.87' },
    ] as const;
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2172_PNU,
        rootPk: '3010101010200',
        etcPurps: '다세대주택',
        landArea: '121',
        expos: units.map((unit) => ({
            dongNm: '월드빌라',
            flrGbCd: '20',
            flrNo: Number(unit.floor),
            hoNm: unit.ho,
        })),
        // provider row 순서와 ratio 크기는 identity가 아니다.
        ldareg: [...units].reverse().map((unit) => ({
            agbldgSn: 'MIA7-2172',
            buldNm: '월드빌라',
            // producer/validator 동 parity: A↔A + A↔missing 혼합 허용.
            buldDongNm:
                unit.ho === '301' ? '월드빌라' : undefined,
            ldaQotaRate: `${unit.numerator}/121`,
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            buldFloorNm: `지상${unit.floor}`,
            buldHoNm: unit.ho,
        })),
    });
    const approvedManifest = v2TargetManifest(
        'mia7-2172-above-floor',
        MIA7_2172_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2172_PNU}`)
                .digest('hex')
    )!;
    const expos = targetSample.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrExposInfo'
    )!.inventory;
    const ldareg = targetSample.endpoints.find(
        (endpoint) => endpoint.endpoint === 'ldaregList'
    )!.inventory;
    assert.equal(expos.kind, 'EXPOS');
    assert.equal(ldareg.kind, 'LDAREG');
    if (expos.kind !== 'EXPOS' || ldareg.kind !== 'LDAREG') {
        assert.fail('unexpected inventory kind');
    }

    assert.equal(artifact.gate.status, 'PASS');
    assert.deepEqual(targetSample.failureCodes, []);
    assert.deepEqual(
        new Set(
            expos.records.map(
                (record) => record.providerUnitBridgeHash
            )
        ),
        new Set(
            ldareg.records.map(
                (record) => record.providerUnitBridgeHash
            )
        )
    );
    assert.ok(
        ldareg.records.every(
            (record) =>
                record.providerUnitBridgeKind ===
                'PROVIDER_ABOVE_NO_SUFFIX'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('791-2172: live와 다른 LDAREG 지상#층 접미사 표기는 fail-closed한다', async () => {
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2172_PNU,
        rootPk: '3010101010201',
        etcPurps: '다세대주택',
        landArea: '121',
        expos: [
            {
                dongNm: '월드빌라',
                flrGbCd: '20',
                flrNo: 2,
                hoNm: '201',
            },
        ],
        ldareg: [
            {
                agbldgSn: 'MIA7-2172-NO-FLOOR-SUFFIX',
                buldNm: '월드빌라',
                ldaQotaRate: '27.5/121',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: '지상2층',
                buldHoNm: '201',
            },
        ],
    });
    const approvedManifest = v2TargetManifest(
        'mia7-2172-floor-suffix-near-miss',
        MIA7_2172_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2172_PNU}`)
                .digest('hex')
    )!;

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        targetSample.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('791-2172: EXPOS 지상#층과 LDAREG 숫자 층의 역방향 표기는 접지 않는다', async () => {
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2172_PNU,
        rootPk: '3010101010202',
        etcPurps: '다세대주택',
        landArea: '121',
        expos: [
            {
                dongNm: '월드빌라',
                flrGbCd: '20',
                flrNoNm: '지상2층',
                hoNm: '201',
            },
        ],
        ldareg: [
            {
                agbldgSn: 'MIA7-2172-REVERSED-FLOOR-SHAPE',
                buldNm: '월드빌라',
                ldaQotaRate: '27.5/121',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: '2',
                buldHoNm: '201',
            },
        ],
    });
    const approvedManifest = v2TargetManifest(
        'mia7-2172-shape-direction',
        MIA7_2172_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2172_PNU}`)
                .digest('hex')
    )!;

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        targetSample.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

function mia72188ProviderShapeRows(): {
    expos: BrExposRow[];
    ldareg: LdaregRow[];
} {
    const regular = [
        { floor: 1, ho: '101', numerator: '40' },
        { floor: 2, ho: '201', numerator: '35' },
        { floor: 3, ho: '301', numerator: '45' },
        { floor: 4, ho: '401', numerator: '51.27' },
    ] as const;
    return {
        expos: [
            ...regular.map((unit) => ({
                dongNm: 'A',
                flrGbCd: '20',
                flrNo: unit.floor,
                hoNm: unit.ho,
            })),
            {
                dongNm: 'A',
                flrGbCd: '10',
                flrNo: 1,
                hoNm: 'B1',
            },
            {
                dongNm: 'A',
                flrGbCd: '10',
                flrNo: 1,
                hoNm: 'B2',
            },
        ],
        ldareg: [
            ...regular.map((unit) => ({
                agbldgSn: 'MIA7-2188',
                buldNm: 'MIA7-2188',
                ldaQotaRate: `${unit.numerator}/221`,
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldDongNm:
                    unit.ho === '201' ? undefined : 'A',
                buldFloorNm: String(unit.floor),
                buldHoNm: unit.ho,
            })),
            {
                agbldgSn: 'MIA7-2188',
                buldNm: 'MIA7-2188',
                ldaQotaRate: '20.18/221',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldDongNm: 'A',
                buldFloorNm: '지하',
                buldHoNm: '비1',
            },
            {
                agbldgSn: 'MIA7-2188',
                buldNm: 'MIA7-2188',
                ldaQotaRate: '29.55/221',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldDongNm: 'A',
                buldFloorNm: '지하',
                buldHoNm: '비2',
            },
            {
                agbldgSn: 'MIA7-2188',
                buldNm: 'MIA7-2188',
                ldaQotaRate: '',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldDongNm: '0000',
                buldFloorNm: '0000',
                buldHoNm: '0000',
                buldRoomNm: '0000',
            },
        ],
    };
}

test('791-2188: EXPOS 지하 1/Bn과 LDAREG exact 지하/비n을 suffix equality로 결속한다', async () => {
    const rows = mia72188ProviderShapeRows();
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2188_PNU,
        rootPk: '3010101010208',
        etcPurps: '다세대주택',
        landArea: '221',
        ...rows,
    });
    const approvedManifest = v2TargetManifest(
        'mia7-2188-basement',
        MIA7_2188_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2188_PNU}`)
                .digest('hex')
    )!;
    const ldareg = targetSample.endpoints.find(
        (endpoint) => endpoint.endpoint === 'ldaregList'
    )!.inventory;
    assert.equal(ldareg.kind, 'LDAREG');
    if (ldareg.kind !== 'LDAREG') assert.fail('unexpected inventory');

    assert.equal(
        artifact.gate.status,
        'PASS',
        JSON.stringify(targetSample.failureCodes)
    );
    assert.deepEqual(targetSample.failureCodes, []);
    assert.equal(
        ldareg.records.filter(
            (record) =>
                record.providerUnitBridgeKind ===
                'PROVIDER_BASEMENT_B_HO'
        ).length,
        2
    );
    assert.deepEqual(
        ldareg.records
            .filter(
                (record) =>
                    record.providerUnitBridgeKind ===
                    'PROVIDER_BASEMENT_B_HO'
            )
            .map((record) => record.quotaRatio)
            .sort(),
        ['20.18/221', '29.55/221']
    );
    assert.deepEqual(
        targetSample.evidence.ldaregReplication
            .providerBuildingIdentity,
        {
            aggregateBuildingSerialHash:
                ldareg.records[0]
                    .aggregateBuildingSerialHash,
            buildingNameHash:
                ldareg.records[0].buildingNameHash,
            observedRowCount: rows.ldareg.length,
        }
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('provider bridge artifact validator는 witness·unique set·canonical order 변조를 fail-closed한다', async () => {
    const rows = mia72188ProviderShapeRows();
    const approvedManifest = v2TargetManifest(
        'mia7-2188-artifact-tamper',
        MIA7_2188_PNU
    );
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2188_PNU,
        rootPk: '3010101010210',
        etcPurps: '다세대주택',
        landArea: '221',
        ...rows,
    });
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetPnuHash = createHash('sha256')
        .update(`PNU\u0000${MIA7_2188_PNU}`)
        .digest('hex');
    const targetSample = (candidate: any) =>
        candidate.samples.find(
            (sample: any) => sample.pnuHash === targetPnuHash
        );
    const endpoint = (sample: any, endpointName: string) =>
        sample.endpoints.find(
            (candidate: any) =>
                candidate.endpoint === endpointName
        );
    const rejected = (
        mutate: (candidate: any) => void,
        pattern: RegExp
    ) => {
        const candidate = structuredClone(artifact) as any;
        mutate(candidate);
        assert.throws(
            () =>
                validateLandAreaPhase0CaptureArtifact(
                    approvedManifest,
                    candidate
                ),
            pattern
        );
    };

    rejected((candidate) => {
        candidate.schemaHash =
            '99d06939e77afcf8220fc1b6cef55ea22315f11b38a24a13aeecb45a47c49e16';
    }, /legacy artifact schema/);

    rejected((candidate) => {
        delete targetSample(candidate).evidence
            .ldaregReplication.providerBuildingIdentity;
    }, /provider building identity applicability/);

    rejected((candidate) => {
        targetSample(
            candidate
        ).evidence.ldaregReplication.providerBuildingIdentity.buildingNameHash =
            '0'.repeat(64);
    }, /provider building identity proof/);

    rejected((candidate) => {
        targetSample(
            candidate
        ).evidence.ldaregReplication.providerBuildingIdentity.observedRowCount +=
            1;
    }, /provider building identity proof/);

    rejected((candidate) => {
        const inventory = endpoint(
            targetSample(candidate),
            'getBrExposInfo'
        ).inventory;
        const record = inventory.records.find(
            (entry: any) =>
                entry.providerUnitBridgeKind ===
                'PROVIDER_BASEMENT_B_HO'
        );
        delete record.providerUnitBridgeKind;
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /provider unit bridge witness is inconsistent/);

    rejected((candidate) => {
        const scopeExpos =
            targetSample(candidate).evidence.scopeExpos;
        const record = scopeExpos.records.find(
            (entry: any) =>
                entry.providerUnitBridgeKind ===
                'PROVIDER_BASEMENT_B_HO'
        );
        delete record.providerUnitBridgeHash;
        scopeExpos.sanitizedDigest = sanitizedTestDigest(
            scopeExpos.records
        );
    }, /provider unit bridge witness is inconsistent/);

    rejected((candidate) => {
        const inventory = endpoint(
            targetSample(candidate),
            'ldaregList'
        ).inventory;
        const record = inventory.records.find(
            (entry: any) =>
                entry.providerUnitBridgeKind ===
                'PROVIDER_BASEMENT_B_HO'
        );
        record.providerUnitBridgeKind =
            'FLOOR_AS_UNIT_ABOVE';
        sortCanonicalTestRecords(inventory.records);
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /semantic failure|unit correlation|failureCodes omits|provider building identity proof/);

    rejected((candidate) => {
        const inventory = endpoint(
            targetSample(candidate),
            'ldaregList'
        ).inventory;
        inventory.records.reverse();
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /canonical producer ordering/);

    rejected((candidate) => {
        const sample = targetSample(candidate);
        const scopeExpos = sample.evidence.scopeExpos;
        const exposEndpoint = endpoint(
            sample,
            'getBrExposInfo'
        );
        const exposInventory = exposEndpoint.inventory;
        const ldaregEndpoint = endpoint(sample, 'ldaregList');
        const ldaregInventory = ldaregEndpoint.inventory;
        const exposRecord = exposInventory.records.find(
            (entry: any) =>
                entry.providerUnitBridgeKind ===
                'PROVIDER_BASEMENT_B_HO'
        );
        const scopeRecord = scopeExpos.records.find(
            (entry: any) =>
                entry.providerUnitBridgeHash ===
                exposRecord.providerUnitBridgeHash
        );
        const ldaregRecord = ldaregInventory.records.find(
            (entry: any) =>
                entry.providerUnitBridgeHash ===
                    exposRecord.providerUnitBridgeHash &&
                entry.quotaRatio === '20.18/221'
        );

        exposInventory.records.push(
            structuredClone(exposRecord)
        );
        sortCanonicalTestRecords(exposInventory.records);
        exposInventory.totalRecords += 1;
        exposInventory.sanitizedDigest = sanitizedTestDigest(
            exposInventory.records
        );
        exposEndpoint.totalCount += 1;

        scopeExpos.records.push(structuredClone(scopeRecord));
        sortCanonicalTestRecords(scopeExpos.records);
        scopeExpos.totalRecords += 1;
        scopeExpos.queries[0].totalCount += 1;
        scopeExpos.sanitizedDigest = sanitizedTestDigest(
            scopeExpos.records
        );

        ldaregRecord.quotaRatio = '10.09/221';
        const duplicateLdaregRecord =
            structuredClone(ldaregRecord);
        ldaregInventory.records.push(
            duplicateLdaregRecord
        );
        sortCanonicalTestRecords(ldaregInventory.records);
        ldaregInventory.totalRecords += 1;
        ldaregInventory.sanitizedDigest = sanitizedTestDigest(
            ldaregInventory.records
        );
        ldaregEndpoint.totalCount += 1;
        sample.evidence.ldaregReplication.rowCount += 1;
        sample.evidence.ldaregReplication.rowMultisetDigest =
            sanitizedTestDigest(ldaregInventory.records);
    }, /semantic failure|unit correlation|failureCodes omits|provider building identity proof/);
});

for (const invalidCase of [
    {
        name: 'Bn과 비n suffix가 다름',
        mutate: (rows: ReturnType<typeof mia72188ProviderShapeRows>) => {
            rows.ldareg[5] = {
                ...rows.ldareg[5],
                buldHoNm: '비3',
            };
        },
    },
    {
        name: 'EXPOS basement floor type이 10이 아님',
        mutate: (rows: ReturnType<typeof mia72188ProviderShapeRows>) => {
            rows.expos[4] = {
                ...rows.expos[4],
                flrGbCd: '20',
            };
        },
    },
    {
        name: 'EXPOS B2의 실측 floor가 exact 1이 아님',
        mutate: (rows: ReturnType<typeof mia72188ProviderShapeRows>) => {
            rows.expos[5] = {
                ...rows.expos[5],
                flrNo: 2,
            };
        },
    },
    {
        name: 'LDAREG floor가 exact 지하가 아님',
        mutate: (rows: ReturnType<typeof mia72188ProviderShapeRows>) => {
            rows.ldareg[4] = {
                ...rows.ldareg[4],
                buldFloorNm: '지하1',
            };
        },
    },
    {
        name: 'mixed exact 소진 뒤 residual bridge가 같은 unit을 다시 가리킴',
        mutate: (rows: ReturnType<typeof mia72188ProviderShapeRows>) => {
            rows.ldareg[1] = {
                ...rows.ldareg[1],
                buldFloorNm: '지상1',
                buldHoNm: '101',
            };
        },
    },
] as const) {
    test(`791-2188 provider bridge는 ${invalidCase.name}이면 fail-closed한다`, async () => {
        const rows = mia72188ProviderShapeRows();
        invalidCase.mutate(rows);
        const targetAdapter = singleParcelTargetAdapter({
            pnu: MIA7_2188_PNU,
            rootPk: '3010101010209',
            etcPurps: '다세대주택',
            landArea: '221',
            ...rows,
        });
        const approvedManifest = v2TargetManifest(
            'mia7-2188-provider-near-miss',
            MIA7_2188_PNU
        );
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: targetAdapter.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const targetSample = artifact.samples.find(
            (sample) =>
                sample.pnuHash ===
                createHash('sha256')
                    .update(`PNU\u0000${MIA7_2188_PNU}`)
                    .digest('hex')
        )!;

        assert.equal(artifact.gate.status, 'FAIL');
        assert.ok(
            targetSample.failureCodes.includes(
                'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
            )
        );
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    });
}

test('v1 및 input@2 expectedFamily=LADFRL은 generic/floor-as-unit 보강을 사용하지 않는다', async () => {
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2191_PNU,
        rootPk: '3010101010210',
        landArea: '101',
        expos: [
            {
                flrGbCd: '20',
                flrNo: 1,
                hoNm: '1층',
            },
        ],
        ldareg: [
            {
                agbldgSn: 'LEGACY-UNCHANGED',
                buldNm: 'LEGACY-UNCHANGED',
                ldaQotaRate: '33.67/101',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: '1',
                buldHoNm: '0000',
            },
        ],
    });
    const manifests: LandAreaPhase0CaptureManifest[] = [
        manifest([
            {
                alias: 'zero-control',
                expectedBylot: 'ZERO',
                pnu: ZERO_PNU,
            },
            {
                alias: 'positive-control',
                expectedBylot: 'POSITIVE',
                pnu: POSITIVE_PNU,
            },
            {
                alias: 'legacy-target',
                expectedBylot: 'ZERO',
                pnu: MIA7_2191_PNU,
            },
        ]),
        {
            version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
            samples: [
                {
                    alias: 'zero-control',
                    expectedBylot: 'ZERO',
                    expectedFamily: 'LADFRL',
                    pnu: ZERO_PNU,
                },
                {
                    alias: 'positive-control',
                    expectedBylot: 'POSITIVE',
                    expectedFamily: 'LDAREG',
                    pnu: POSITIVE_PNU,
                },
                {
                    alias: 'ladfrl-target',
                    expectedBylot: 'ZERO',
                    expectedFamily: 'LADFRL',
                    pnu: MIA7_2191_PNU,
                },
            ],
        },
    ];
    const rawLdaregHash = createHash('sha256')
        .update(
            `FLOOR_HO_TUPLE_JSON\u0000${JSON.stringify(['1', '0'])}`
        )
        .digest('hex');

    for (const approvedManifest of manifests) {
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: targetAdapter.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const targetSample = artifact.samples.find(
            (sample) =>
                sample.pnuHash ===
                createHash('sha256')
                    .update(`PNU\u0000${MIA7_2191_PNU}`)
                    .digest('hex')
        )!;
        const ldareg = targetSample.endpoints.find(
            (endpoint) => endpoint.endpoint === 'ldaregList'
        )!.inventory;
        assert.equal(ldareg.kind, 'LDAREG');
        if (ldareg.kind !== 'LDAREG') assert.fail('unexpected inventory');

        assert.equal(artifact.gate.status, 'FAIL');
        assert.ok(
            targetSample.failureCodes.includes(
                'HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH'
            )
        );
        assert.equal(
            ldareg.records[0].floorHoIdentityHash,
            rawLdaregHash
        );
        assert.equal(ldareg.records[0].floorShape, '#');
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    }
});

function mia72191FloorAsUnitRows(): {
    expos: BrExposRow[];
    ldareg: LdaregRow[];
} {
    return {
        expos: [
            {
                flrGbCd: '10',
                flrNo: 1,
                hoNm: '지층',
            },
            {
                flrGbCd: '20',
                flrNo: 1,
                hoNm: '1층',
            },
            {
                flrGbCd: '20',
                flrNo: 2,
                hoNm: '2층',
            },
        ],
        ldareg: [
            {
                agbldgSn: 'MIA7-2191',
                buldNm: 'MIA7-2191',
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: '0',
                buldHoNm: '0000',
            },
            ...[
                { floor: '지', numerator: '33.67' },
                { floor: '1', numerator: '33.67' },
                { floor: '2', numerator: '33.67' },
            ].map((entry) => ({
                agbldgSn: 'MIA7-2191',
                buldNm: 'MIA7-2191',
                ldaQotaRate: `${entry.numerator}/101`,
                clsSeCode: '0',
                clsSeCodeNm: '현재',
                buldFloorNm: entry.floor,
                buldHoNm: '0000',
            })),
        ],
    };
}

test('791-2191: LDAREG 지/0000 및 숫자층/0000을 EXPOS exact 지층·N층과 unique one-per-floor로 상관한다', async () => {
    const rows = mia72191FloorAsUnitRows();
    const targetAdapter = singleParcelTargetAdapter({
        pnu: MIA7_2191_PNU,
        rootPk: '3010101010220',
        etcPurps: '다세대주택',
        landArea: '101',
        ...rows,
    });
    const approvedManifest = v2TargetManifest(
        'mia7-2191-floor-unit',
        MIA7_2191_PNU
    );
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: targetAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const targetSample = artifact.samples.find(
        (sample) =>
            sample.pnuHash ===
            createHash('sha256')
                .update(`PNU\u0000${MIA7_2191_PNU}`)
                .digest('hex')
    )!;
    const expos = targetSample.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrExposInfo'
    )!.inventory;
    const ldareg = targetSample.endpoints.find(
        (endpoint) => endpoint.endpoint === 'ldaregList'
    )!.inventory;
    assert.equal(expos.kind, 'EXPOS');
    assert.equal(ldareg.kind, 'LDAREG');
    if (expos.kind !== 'EXPOS' || ldareg.kind !== 'LDAREG') {
        assert.fail('unexpected inventory kind');
    }
    const validLdareg = ldareg.records.filter(
        (record) => record.quotaRatioState === 'VALID'
    );

    assert.equal(artifact.gate.status, 'PASS');
    assert.deepEqual(targetSample.failureCodes, []);
    assert.deepEqual(
        new Set(
            expos.records.map(
                (record) => record.providerUnitBridgeHash
            )
        ),
        new Set(
            validLdareg.map(
                (record) => record.providerUnitBridgeHash
            )
        )
    );
    assert.deepEqual(
        new Set(
            expos.records.map(
                (record) => record.providerUnitBridgeKind
            )
        ),
        new Set([
            'FLOOR_AS_UNIT_ABOVE',
            'FLOOR_AS_UNIT_BASEMENT',
        ])
    );
    assert.equal(
        ldareg.records.find(
            (record) => record.quotaRatioState === 'MISSING'
        )?.floorShape,
        '#'
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

for (const invalidCase of [
    {
        name: '동일 floor LDAREG가 중복',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.ldareg.push({ ...rows.ldareg[2] });
        },
    },
    {
        name: 'EXPOS ho가 exact 층 라벨이 아님',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.expos[1] = { ...rows.expos[1], hoNm: '1호' };
        },
    },
    {
        name: 'EXPOS 실제 층과 ho 층 라벨이 불일치',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.expos[1] = { ...rows.expos[1], hoNm: '2층' };
        },
    },
    {
        name: 'EXPOS 지상 floor alias가 서로 충돌함',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.expos[1] = {
                ...rows.expos[1],
                flrNoNm: '2',
            };
        },
    },
    {
        name: 'EXPOS 지층의 실제 층이 지하 1층이 아님',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.expos[0] = { ...rows.expos[0], flrNo: 2 };
        },
    },
    {
        name: 'LDAREG ho가 exact 0000이 아님',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.ldareg[2] = { ...rows.ldareg[2], buldHoNm: '0' };
        },
    },
    {
        name: 'LDAREG 지상 floor에 층 접미사가 붙음',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.ldareg[2] = {
                ...rows.ldareg[2],
                buldFloorNm: '1층',
            };
        },
    },
    {
        name: 'LDAREG 지층 floor가 live exact 지가 아님',
        mutate: (rows: ReturnType<typeof mia72191FloorAsUnitRows>) => {
            rows.ldareg[1] = {
                ...rows.ldareg[1],
                buldFloorNm: '지층',
            };
        },
    },
] as const) {
    test(`floor-as-unit은 ${invalidCase.name}이면 fail-closed한다`, async () => {
        const rows = mia72191FloorAsUnitRows();
        invalidCase.mutate(rows);
        const targetAdapter = singleParcelTargetAdapter({
            pnu: MIA7_2191_PNU,
            rootPk: '3010101010230',
            etcPurps: '다세대주택',
            landArea: '101',
            ...rows,
        });
        const approvedManifest = v2TargetManifest(
            'mia7-2191-floor-unit-negative',
            MIA7_2191_PNU
        );
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: targetAdapter.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const targetSample = artifact.samples.find(
            (sample) =>
                sample.pnuHash ===
                createHash('sha256')
                    .update(`PNU\u0000${MIA7_2191_PNU}`)
                    .digest('hex')
        )!;

        assert.equal(artifact.gate.status, 'FAIL');
        assert.ok(
            targetSample.failureCodes.includes(
                'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
            )
        );
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    });
}

test('실측형 집합건축물: title root 1 + basis/expos child 7 + ratio 7 + 미적용 관찰 1을 구분한다', async () => {
    const childPks = Array.from(
        { length: 7 },
        (_, index) => `40040040040${index + 10}`
    );
    const liveShape = adapter({
        async scanTitle(pnu) {
            liveShape.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            if (pnu === ZERO_PNU) return complete(titleRows(pnu));
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                    regstrGbCd: '2',
                    regstrGbCdNm: '집합',
                    mainPurpsCd: '02000',
                    mainPurpsCdNm: '공동주택',
                    etcPurps: '다세대주택',
                },
            ]);
        },
        async scanBasis(pnu) {
            liveShape.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            if (pnu === ZERO_PNU) return complete(basisRows(pnu));
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                },
                ...childPks.map((pk) => ({
                    pnu,
                    mgmBldrgstPk: pk,
                    mgmUpBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                })),
            ]);
        },
        async scanExpos(pnu) {
            liveShape.calls.push({ endpoint: 'getBrExposInfo', pnu });
            if (pnu === ZERO_PNU || pnu === ATTACHED_PNU) {
                return complete([]);
            }
            return complete(
                childPks.map((pk, index) => ({
                    pnu,
                    mgmBldrgstPk: pk,
                    mgmUpBldrgstPk: POSITIVE_PK,
                    dongNm: '1동',
                    flrNoNm: `${index + 1}층`,
                    hoNm: `${index + 1}01호`,
                }))
            );
        },
        async scanLdareg(pnu) {
            liveShape.calls.push({ endpoint: 'ldaregList', pnu });
            if (pnu === ZERO_PNU) return complete([]);
            return complete([
                ...childPks.map((_, index) => ({
                    pnu,
                    agbldgSn: 'LIVE-SHAPE',
                    ldaQotaRate: `${index + 10}/364.6`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldDongNm: '1동',
                    buldFloorNm: `${index + 1}층`,
                    buldHoNm: `${index + 1}01호`,
                })),
                {
                    pnu,
                    agbldgSn: 'LIVE-SHAPE',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldDongNm: '관리',
                    buldFloorNm: '0층',
                    buldHoNm: '0호',
                },
            ]);
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: liveShape.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(positive.policyCandidate, 'TITLE_ONLY');
    assert.equal(positive.checks.titleBasis.status, 'PASS');
    assert.equal(positive.checks.bylotAttached.status, 'PASS');
    assert.deepEqual(positive.failureCodes, []);
    assert.ok(
        positive.reviewCodes.includes(
            'LDAREG_RATIO_MISSING_OBSERVED'
        )
    );
    const basis = positive.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrBasisOulnInfo'
    )!;
    assert.equal(basis.inventory.kind, 'BASIS');
    if (basis.inventory.kind === 'BASIS') {
        assert.equal(
            basis.inventory.records.filter(
                (record) => record.upManagementPkHash !== undefined
            ).length,
            7
        );
    }
});

test('동/층/호가 완전하지 않은 EXPOS·LDAREG unit은 상호 일치처럼 보여도 fail-closed한다', async () => {
    const partial = adapter({
        async scanExpos(pnu) {
            partial.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    dongNm: undefined,
                    flrNoNm: undefined,
                }))
            );
        },
        async scanLdareg(pnu) {
            partial.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    buldDongNm: undefined,
                    buldFloorNm: undefined,
                }))
            );
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: partial.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('실응답형 단일 동은 EXPOS 숫자 층+호와 LDAREG 0000 동+층+호를 정확히 상관한다', async () => {
    const liveShape = adapter({
        async scanExpos(pnu) {
            liveShape.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => {
                    const { flrNoNm: _omittedFloorName, ...rest } =
                        row;
                    return {
                        ...rest,
                        dongNm: ' ',
                        flrNo: 5,
                        hoNm: '501',
                    };
                })
            );
        },
        async scanLdareg(pnu) {
            liveShape.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    buldNm: '건물명은 동명이 아님',
                    buldDongNm: '0000',
                    buldFloorNm: '5',
                    buldHoNm: '501',
                }))
            );
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: liveShape.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    for (const endpointName of ['getBrExposInfo', 'ldaregList']) {
        const endpoint = positive.endpoints.find(
            (entry) => entry.endpoint === endpointName
        )!;
        const inventory = endpoint.inventory;
        if (inventory.kind !== 'EXPOS' && inventory.kind !== 'LDAREG') {
            assert.fail(`unexpected inventory kind: ${inventory.kind}`);
        }
        assert.equal(inventory.records[0].unitIdentityShape, 'FLOOR_HO');
    }
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('resolved scope EXPOS 합집합은 base/attached에 분산된 호실을 canonical LDAREG와 정확히 상관한다', async () => {
    const units = [
        { floor: 4, ho: '401', numerator: '33.88' },
        { floor: 3, ho: '301', numerator: '51.02' },
        { floor: 2, ho: '201', numerator: '51.02' },
        { floor: 1, ho: '101', numerator: '39.08' },
    ] as const;
    const splitScope = adapter({
        async scanExpos(pnu) {
            splitScope.calls.push({ endpoint: 'getBrExposInfo', pnu });
            if (pnu === ZERO_PNU) return complete(exposRows(pnu));
            const selected =
                pnu === POSITIVE_PNU
                    ? units.slice(0, 2)
                    : units.slice(2);
            return complete(
                selected.map((unit) => ({
                    pnu,
                    mgmBldrgstPk: POSITIVE_PK,
                    dongNm: ' ',
                    flrNo: unit.floor,
                    hoNm: unit.ho,
                }))
            );
        },
        async scanLdareg(pnu) {
            splitScope.calls.push({ endpoint: 'ldaregList', pnu });
            if (pnu === ZERO_PNU) return complete([]);
            return complete(
                units.map((unit) => ({
                    pnu,
                    agbldgSn: 'SPLIT-SCOPE',
                    ldaQotaRate: `${unit.numerator}/364.6`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldDongNm: '0000',
                    buldFloorNm: String(unit.floor),
                    buldHoNm: unit.ho,
                }))
            );
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: splitScope.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(
        positive.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        ),
        false
    );
    const expos = positive.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrExposInfo'
    )!;
    assert.equal(expos.state, 'COMPLETE');
    assert.equal(expos.totalCount, 2);
    assert.equal(expos.pagesFetched, 1);
    assert.equal(expos.inventory.kind, 'EXPOS');
    if (expos.inventory.kind === 'EXPOS') {
        assert.equal(expos.inventory.totalRecords, 2);
        assert.equal(expos.inventory.records.length, 2);
    }
    assert.equal(positive.evidence.scopeExpos.status, 'PASS');
    assert.equal(positive.evidence.scopeExpos.queries.length, 2);
    assert.equal(positive.evidence.scopeExpos.totalRecords, 4);
    assert.equal(positive.evidence.scopeExpos.records.length, 4);
    assert.ok(
        splitScope.calls.some(
            (call) =>
                call.endpoint === 'getBrExposInfo' &&
                call.pnu === ATTACHED_PNU
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('resolved scope EXPOS 합집합은 같은 호실의 서로 다른 self 관리번호 충돌을 fail-closed한다', async () => {
    const identityConflict = adapter({
        async scanExpos(pnu) {
            identityConflict.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            if (pnu === ZERO_PNU) return complete(exposRows(pnu));
            return complete([
                {
                    pnu,
                    mgmBldrgstPk:
                        pnu === POSITIVE_PNU
                            ? POSITIVE_PK
                            : '3003003003003',
                    mgmUpBldrgstPk: POSITIVE_PK,
                    dongNm: ' ',
                    flrNo: 1,
                    hoNm: '101',
                },
            ]);
        },
        async scanLdareg(pnu) {
            identityConflict.calls.push({ endpoint: 'ldaregList', pnu });
            if (pnu === ZERO_PNU) return complete([]);
            return complete([
                {
                    pnu,
                    agbldgSn: 'SELF-IDENTITY-CONFLICT',
                    ldaQotaRate: '39.08/364.6',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldDongNm: '0000',
                    buldFloorNm: '1',
                    buldHoNm: '101',
                },
            ]);
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: identityConflict.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    const expos = positive.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrExposInfo'
    )!;
    assert.equal(expos.totalCount, 1);
    assert.equal(positive.evidence.scopeExpos.totalRecords, 2);
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('scope EXPOS는 cross-PNU exact replica만 1건으로 접고 같은 PNU 중복은 ambiguity로 남긴다', async () => {
    const replica = adapter({
        async scanExpos(pnu) {
            replica.calls.push({ endpoint: 'getBrExposInfo', pnu });
            if (pnu === ZERO_PNU) return complete(exposRows(pnu));
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: POSITIVE_PK,
                    dongNm: UNIT_DONG,
                    flrNoNm: UNIT_FLOOR,
                    hoNm: UNIT_HO,
                },
            ]);
        },
    });
    const approvedManifest = manifest();
    const replicaArtifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: replica.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(replicaArtifact.gate.status, 'PASS');
    const replicaPositive = replicaArtifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(replicaPositive.evidence.scopeExpos.totalRecords, 2);
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            replicaArtifact
        ),
        replicaArtifact
    );

    const duplicate = adapter({
        async scanExpos(pnu) {
            duplicate.calls.push({ endpoint: 'getBrExposInfo', pnu });
            if (pnu === ZERO_PNU) return complete(exposRows(pnu));
            if (pnu === ATTACHED_PNU) return complete([]);
            const row = {
                pnu,
                mgmBldrgstPk: POSITIVE_PK,
                dongNm: UNIT_DONG,
                flrNoNm: UNIT_FLOOR,
                hoNm: UNIT_HO,
            };
            return complete([row, { ...row }]);
        },
    });
    const duplicateArtifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: duplicate.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(duplicateArtifact.gate.status, 'FAIL');
    assert.ok(
        duplicateArtifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            duplicateArtifact
        ),
        duplicateArtifact
    );
});

function providerReplicaV2Manifest(): LandAreaPhase0CaptureManifest {
    return {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
        samples: [
            {
                alias: 'zero-control',
                expectedBylot: 'ZERO',
                expectedFamily: 'LADFRL',
                pnu: ZERO_PNU,
            },
            {
                alias: 'provider-expos-replica',
                expectedBylot: 'POSITIVE',
                expectedFamily: 'LDAREG',
                pnu: POSITIVE_PNU,
            },
        ],
    };
}

function providerExposReplicaAdapter(input: {
    baseFloor: number | string;
    attachedFloor: number | string;
}) {
    const target = adapter({
        async scanExpos(pnu) {
            target.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            if (pnu === ZERO_PNU) {
                return complete(exposRows(pnu));
            }
            if (
                pnu !== POSITIVE_PNU &&
                pnu !== ATTACHED_PNU
            ) {
                return complete([]);
            }
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: POSITIVE_PK,
                    dongNm: 'A',
                    flrGbCd: '20',
                    flrNo:
                        pnu === POSITIVE_PNU
                            ? input.baseFloor
                            : input.attachedFloor,
                    hoNm: '201',
                },
            ]);
        },
        async scanLdareg(pnu) {
            target.calls.push({
                endpoint: 'ldaregList',
                pnu,
            });
            if (
                pnu !== POSITIVE_PNU &&
                pnu !== ATTACHED_PNU
            ) {
                return complete(ldaregRows(pnu));
            }
            return complete([
                {
                    pnu,
                    agbldgSn: 'MIA7-EXPOS-REPLICA',
                    buldNm: 'A',
                    buldDongNm: 'A',
                    buldFloorNm: '지상2',
                    buldHoNm: '201',
                    buldRoomNm: '201',
                    ldaQotaRate: '24.6/364.6',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
            ]);
        },
    });
    return target;
}

for (const variant of [
    {
        name: 'base valid/attached near-miss',
        baseFloor: 2,
        attachedFloor: '02',
    },
    {
        name: 'base near-miss/attached valid',
        baseFloor: '02',
        attachedFloor: 2,
    },
] as const) {
    test(`scope EXPOS provider witness variant는 PNU 방향과 무관하게 replica로 접지 않는다 (${variant.name})`, async () => {
        const target = providerExposReplicaAdapter(variant);
        const approvedManifest =
            providerReplicaV2Manifest();
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: target.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const positive = artifact.samples.find(
            (sample) =>
                sample.expectedBylot === 'POSITIVE'
        )!;
        assert.equal(
            positive.evidence.scopeExpos.totalRecords,
            2
        );
        assert.ok(
            positive.failureCodes.includes(
                'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
            )
        );
        assert.equal(artifact.gate.status, 'FAIL');
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    });
}

test('artifact validator는 attached EXPOS의 provider witness만 제거한 cross-PNU tamper를 replica로 접지 않는다', async () => {
    const target = providerExposReplicaAdapter({
        baseFloor: 2,
        attachedFloor: 2,
    });
    const approvedManifest = providerReplicaV2Manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: target.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'PASS');

    const candidate = structuredClone(artifact) as any;
    const positive = candidate.samples.find(
        (sample: any) =>
            sample.expectedBylot === 'POSITIVE'
    );
    const attachedPnuHash = createHash('sha256')
        .update(`PNU\u0000${ATTACHED_PNU}`)
        .digest('hex');
    const attachedRecord =
        positive.evidence.scopeExpos.records.find(
            (record: any) =>
                record.queryPnuHash === attachedPnuHash
        );
    assert.ok(attachedRecord);
    delete attachedRecord.providerUnitBridgeHash;
    delete attachedRecord.providerUnitBridgeKind;
    sortCanonicalTestRecords(
        positive.evidence.scopeExpos.records
    );
    positive.evidence.scopeExpos.sanitizedDigest =
        sanitizedTestDigest(
            positive.evidence.scopeExpos.records
        );

    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                candidate
            ),
        /semantic failure|unit correlation|failureCodes omits/
    );
});

test('attached PNU EXPOS가 다른 PNU row를 반환하면 scope evidence와 gate가 fail-closed한다', async () => {
    const foreignPnu = adapter({
        async scanExpos(pnu) {
            foreignPnu.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            if (pnu === ATTACHED_PNU) {
                return complete(exposRows(POSITIVE_PNU));
            }
            return complete(exposRows(pnu));
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: foreignPnu.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'EXPOS_PNU_EXACT_MISMATCH'
        )
    );
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(positive.evidence.scopeExpos.status, 'FAIL');
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('attached PNU의 다른 건물 EXPOS가 unit만 일치해도 title/basis PK closure에서 fail-closed한다', async () => {
    const foreignBuilding = adapter({
        async scanExpos(pnu) {
            foreignBuilding.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            if (pnu === ZERO_PNU) return complete(exposRows(pnu));
            if (pnu === POSITIVE_PNU) return complete([]);
            return complete([
                {
                    pnu,
                    mgmBldrgstPk: '3003003003003',
                    dongNm: UNIT_DONG,
                    flrNoNm: UNIT_FLOOR,
                    hoNm: UNIT_HO,
                },
            ]);
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: foreignBuilding.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'TITLE_BASIS_PK_CLOSURE_MISMATCH'
        )
    );
    assert.ok(
        artifact.gate.failureCodes.includes('BYLOT_POLICY_UNRESOLVED')
    );
    assert.equal(
        artifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        ),
        true
    );
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(positive.evidence.scopeExpos.status, 'FAIL');
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('791형 4호실은 basis unique root와 DONG_FLOOR_HO↔FLOOR_HO 1:1 증거로 PASS한다', async () => {
    const units = [
        {
            childPk: '3003003003003',
            floor: '1층',
            ho: '101호',
            numerator: '39.08',
        },
        {
            childPk: '3003003003004',
            floor: '2층',
            ho: '201호',
            numerator: '51.02',
        },
        {
            childPk: '3003003003005',
            floor: '3층',
            ho: '301호',
            numerator: '51.02',
        },
        {
            childPk: '3003003003006',
            floor: '4층',
            ho: '401호',
            numerator: '33.88',
        },
    ] as const;
    const missingParent = adapter({
        async scanBasis(pnu) {
            missingParent.calls.push({
                endpoint: 'getBrBasisOulnInfo',
                pnu,
            });
            if (pnu === ZERO_PNU) return complete(basisRows(pnu));
            if (pnu === POSITIVE_PNU) {
                return complete([
                    {
                        pnu,
                        mgmBldrgstPk: POSITIVE_PK,
                        bylotCnt: '1',
                    },
                ]);
            }
            return complete([
                ...units.map((unit) => ({
                    pnu,
                    mgmBldrgstPk: unit.childPk,
                    mgmUpBldrgstPk: POSITIVE_PK,
                    // linked scope basis의 bylot은 base 정책 근거가 아니다.
                    bylotCnt: '999',
                })),
            ]);
        },
        async scanExpos(pnu) {
            missingParent.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            if (pnu === ZERO_PNU) return complete(exposRows(pnu));
            const scopedUnits =
                pnu === POSITIVE_PNU
                    ? units.slice(0, 2)
                    : units.slice(2);
            return complete(
                scopedUnits.map((unit) => ({
                    pnu,
                    mgmBldrgstPk: unit.childPk,
                    dongNm: '청성주택6차',
                    flrNoNm: unit.floor,
                    hoNm: unit.ho,
                }))
            );
        },
        async scanLdareg(pnu) {
            missingParent.calls.push({
                endpoint: 'ldaregList',
                pnu,
            });
            if (pnu === ZERO_PNU) return complete([]);
            return complete([
                ...units.map((unit) => ({
                    pnu,
                    agbldgSn: '791-SINGLE-SERIAL',
                    ldaQotaRate: `${unit.numerator}/364.6`,
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldNm: '청성주택6차',
                    buldDongNm: undefined,
                    buldFloorNm: unit.floor,
                    buldHoNm: unit.ho,
                })),
                {
                    pnu,
                    agbldgSn: '791-SINGLE-SERIAL',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                    buldNm: '청성주택6차',
                    buldDongNm: undefined,
                    buldFloorNm: '0층',
                    buldHoNm: '관리호',
                },
            ]);
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: missingParent.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(
        artifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        ),
        false
    );
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    const childRecords = positive.evidence.scopeExpos.records.filter(
        (record) =>
            record.rootIdentitySource === 'BASIS_UNIQUE'
    );
    assert.equal(childRecords.length, 4);
    assert.ok(
        childRecords.every(
            (record) =>
                record.rawUpManagementPkHash === undefined
        )
    );
    const attachedPair = positive.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrAtchJibunInfo'
    )!;
    assert.equal(attachedPair.inventory.kind, 'ATTACHED');
    if (attachedPair.inventory.kind === 'ATTACHED') {
        const attachedPnuHash =
            attachedPair.inventory.pairs[0].attachedPnuHash;
        assert.deepEqual(
            positive.evidence.scopeBasis.queries.map(
                (query) => query.pnuHash
            ),
            [
                positive.pnuHash,
                attachedPnuHash,
            ].sort()
        );
        assert.equal(
            positive.evidence.scopeBasis.records.filter(
                (record) =>
                    record.queryPnuHash === attachedPnuHash &&
                    record.rowPnuHash === attachedPnuHash &&
                    record.selfManagementPkHash !== undefined
            ).length,
            4
        );
        assert.equal(
            positive.evidence.scopeExpos.records.filter(
                (record) => record.queryPnuHash === positive.pnuHash
            ).length,
            2
        );
        assert.equal(
            positive.evidence.scopeExpos.records.filter(
                (record) => record.queryPnuHash === attachedPnuHash
            ).length,
            2
        );
    }
    const title = positive.endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrTitleInfo'
    )!;
    assert.equal(title.inventory.kind, 'TITLE');
    if (title.inventory.kind === 'TITLE') {
        assert.deepEqual(
            new Set(
                childRecords.map(
                    (record) => record.rootManagementPkHash
                )
            ),
            new Set([title.inventory.records[0].managementPkHash])
        );
    }
    const ldareg = positive.endpoints.find(
        (endpoint) => endpoint.endpoint === 'ldaregList'
    )!;
    assert.equal(ldareg.inventory.kind, 'LDAREG');
    if (ldareg.inventory.kind === 'LDAREG') {
        assert.match(
            ldareg.inventory.records[0].floorHoIdentityHash ?? '',
            /^[a-f0-9]{64}$/
        );
        assert.match(
            ldareg.inventory.records[0].buildingNameHash ?? '',
            /^[a-f0-9]{64}$/
        );
        assert.equal(
            ldareg.inventory.records.filter(
                (record) => record.quotaRatioState === 'VALID'
            ).length,
            4
        );
        assert.equal(
            ldareg.inventory.records.filter(
                (record) => record.quotaRatioState === 'MISSING'
            ).length,
            1
        );
    }
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('basis child의 복수 title root와 명시 raw up 충돌은 root 보강 없이 fail-closed한다', async () => {
    const childPk = '3003003003003';
    const secondRootPk = '2002002002003';
    const conflictCases = [
        {
            name: 'MULTIPLE_BASIS_ROOTS',
            title: [
                ...titleRows(POSITIVE_PNU),
                {
                    ...titleRows(POSITIVE_PNU)[0],
                    mgmBldrgstPk: secondRootPk,
                    bylotCnt: '0',
                },
            ],
            baseBasis: [
                {
                    pnu: POSITIVE_PNU,
                    mgmBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                },
                {
                    pnu: POSITIVE_PNU,
                    mgmBldrgstPk: secondRootPk,
                    bylotCnt: '0',
                },
                {
                    pnu: POSITIVE_PNU,
                    mgmBldrgstPk: childPk,
                    mgmUpBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                },
            ],
            attachedBasis: [
                {
                    pnu: ATTACHED_PNU,
                    mgmBldrgstPk: childPk,
                    mgmUpBldrgstPk: secondRootPk,
                    bylotCnt: '999',
                },
            ],
            rawUp: undefined,
        },
        {
            name: 'RAW_UP_CONFLICT',
            title: titleRows(POSITIVE_PNU),
            baseBasis: [
                {
                    pnu: POSITIVE_PNU,
                    mgmBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                },
                {
                    pnu: POSITIVE_PNU,
                    mgmBldrgstPk: childPk,
                    mgmUpBldrgstPk: POSITIVE_PK,
                    bylotCnt: '1',
                },
            ],
            attachedBasis: [],
            rawUp: '9999999999999',
        },
    ] as const;

    for (const conflictCase of conflictCases) {
        const conflicting = adapter({
            async scanTitle(pnu) {
                conflicting.calls.push({
                    endpoint: 'getBrTitleInfo',
                    pnu,
                });
                return complete(
                    pnu === ZERO_PNU
                        ? titleRows(pnu)
                        : [...conflictCase.title]
                );
            },
            async scanBasis(pnu) {
                conflicting.calls.push({
                    endpoint: 'getBrBasisOulnInfo',
                    pnu,
                });
                return complete(
                    pnu === ZERO_PNU
                        ? basisRows(pnu)
                        : pnu === POSITIVE_PNU
                          ? [...conflictCase.baseBasis]
                          : [...conflictCase.attachedBasis]
                );
            },
            async scanExpos(pnu) {
                conflicting.calls.push({
                    endpoint: 'getBrExposInfo',
                    pnu,
                });
                if (pnu === ZERO_PNU) return complete(exposRows(pnu));
                if (pnu === POSITIVE_PNU) return complete([]);
                return complete([
                    {
                        pnu,
                        mgmBldrgstPk: childPk,
                        ...(conflictCase.rawUp
                            ? {
                                  mgmUpBldrgstPk:
                                      conflictCase.rawUp,
                              }
                            : {}),
                        dongNm: UNIT_DONG,
                        flrNoNm: UNIT_FLOOR,
                        hoNm: UNIT_HO,
                    },
                ]);
            },
        });
        const approvedManifest = manifest();
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: conflicting.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        assert.equal(
            artifact.gate.status,
            'FAIL',
            conflictCase.name
        );
        assert.ok(
            artifact.gate.failureCodes.includes('EXPOS_PK_INVALID'),
            conflictCase.name
        );
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
    }
});

test('층/호 fallback은 multi-dong·중복·건물 serial/name 충돌·missing ratio 겹침을 모두 차단한다', async () => {
    const unit = (
        dong: string,
        floor: string,
        ho: string
    ): BrExposRow => ({
        pnu: POSITIVE_PNU,
        mgmBldrgstPk: POSITIVE_PK,
        dongNm: dong,
        flrNoNm: floor,
        hoNm: ho,
    });
    const ratio = (
        floor: string,
        ho: string,
        options: {
            numerator?: string;
            serial?: string;
            buildingName?: string;
        } = {}
    ): LdaregRow => ({
        pnu: POSITIVE_PNU,
        agbldgSn: options.serial ?? 'SINGLE-SERIAL',
        ...(options.numerator === undefined
            ? {}
            : {
                  ldaQotaRate: `${options.numerator}/364.6`,
              }),
        clsSeCode: '0',
        clsSeCodeNm: '현재',
        buldNm: options.buildingName ?? 'SINGLE-BUILDING',
        buldDongNm: undefined,
        buldFloorNm: floor,
        buldHoNm: ho,
    });
    const cases = [
        {
            name: 'MULTI_DONG',
            expos: [
                unit('1동', '1층', '101호'),
                unit('2동', '2층', '201호'),
            ],
            ldareg: [
                ratio('1층', '101호', { numerator: '10' }),
                ratio('2층', '201호', { numerator: '20' }),
            ],
        },
        {
            name: 'DUPLICATE_FLOOR_HO',
            expos: [
                unit('1동', '1층', '101호'),
                unit('1동', '1층', '101호'),
            ],
            ldareg: [
                ratio('1층', '101호', { numerator: '10' }),
                ratio('1층', '101호', { numerator: '11' }),
            ],
        },
        {
            name: 'BUILDING_NAME_COLLISION',
            expos: [
                unit('1동', '1층', '101호'),
                unit('1동', '2층', '201호'),
            ],
            ldareg: [
                ratio('1층', '101호', {
                    numerator: '10',
                    buildingName: 'A동',
                }),
                ratio('2층', '201호', {
                    numerator: '20',
                    buildingName: 'B동',
                }),
            ],
        },
        {
            name: 'AGGREGATE_SERIAL_COLLISION',
            expos: [
                unit('1동', '1층', '101호'),
                unit('1동', '2층', '201호'),
            ],
            ldareg: [
                ratio('1층', '101호', {
                    numerator: '10',
                    serial: 'SERIAL-A',
                }),
                ratio('2층', '201호', {
                    numerator: '20',
                    serial: 'SERIAL-B',
                }),
            ],
        },
        {
            name: 'MISSING_RATIO_FLOOR_HO_OVERLAP',
            expos: [unit('1동', '1층', '101호')],
            ldareg: [
                ratio('1층', '101호', { numerator: '10' }),
                ratio('1층', '101호'),
            ],
        },
    ] as const;

    let failArtifactForTamper: Awaited<
        ReturnType<typeof captureLandAreaPhase0>
    > | null = null;
    for (const collisionCase of cases) {
        const collision = adapter({
            async scanExpos(pnu) {
                collision.calls.push({
                    endpoint: 'getBrExposInfo',
                    pnu,
                });
                if (pnu === ZERO_PNU) return complete(exposRows(pnu));
                if (pnu === ATTACHED_PNU) return complete([]);
                return complete(
                    collisionCase.expos.map((row) => ({
                        ...row,
                        pnu,
                    }))
                );
            },
            async scanLdareg(pnu) {
                collision.calls.push({
                    endpoint: 'ldaregList',
                    pnu,
                });
                if (pnu === ZERO_PNU) return complete([]);
                return complete(
                    collisionCase.ldareg.map((row) => ({
                        ...row,
                        pnu,
                    }))
                );
            },
        });
        const approvedManifest = manifest();
        const artifact = await captureLandAreaPhase0({
            manifest: approvedManifest,
            adapter: collision.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        assert.equal(
            artifact.gate.status,
            'FAIL',
            collisionCase.name
        );
        assert.ok(
            artifact.gate.failureCodes.includes(
                'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
            ),
            collisionCase.name
        );
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                artifact
            ),
            artifact
        );
        failArtifactForTamper ??= artifact;
    }

    const forged = structuredClone(failArtifactForTamper) as any;
    const positive = forged.samples.find(
        (sample: any) => sample.expectedBylot === 'POSITIVE'
    );
    const scopeRecord = positive.evidence.scopeExpos.records.find(
        (record: any) =>
            record.queryPnuHash === positive.pnuHash
    );
    scopeRecord.rootIdentitySource = 'RAW_UP';
    scopeRecord.rawUpManagementPkHash =
        scopeRecord.rootManagementPkHash;
    positive.evidence.scopeExpos.sanitizedDigest =
        sanitizedTestDigest(positive.evidence.scopeExpos.records);
    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                manifest(),
                forged
            ),
        /base EXPOS inventory/
    );

    const forgedRoot = structuredClone(
        failArtifactForTamper
    ) as any;
    const forgedRootPositive = forgedRoot.samples.find(
        (sample: any) => sample.expectedBylot === 'POSITIVE'
    );
    const forgedRootRecord =
        forgedRootPositive.evidence.scopeExpos.records.find(
            (record: any) =>
                record.queryPnuHash === forgedRootPositive.pnuHash
        );
    forgedRootRecord.rootManagementPkHash = '0'.repeat(64);
    forgedRootPositive.evidence.scopeExpos.sanitizedDigest =
        sanitizedTestDigest(
            forgedRootPositive.evidence.scopeExpos.records
        );
    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                manifest(),
                forgedRoot
            ),
        /root identity provenance|root provenance/
    );
});

test('unit component의 비문자열 값과 충돌 alias는 같은 모양이어도 fail-closed한다', async () => {
    const malformed = adapter({
        async scanExpos(pnu) {
            malformed.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    dongNm: { malformed: true },
                    flrNoNm: true,
                    hoNm: ['101'],
                }))
            );
        },
        async scanLdareg(pnu) {
            malformed.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    buldDongNm: { malformed: true },
                    buldFloorNm: true,
                    buldHoNm: ['101'],
                }))
            );
        },
    });
    const malformedArtifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: malformed.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(malformedArtifact.gate.status, 'FAIL');
    assert.ok(
        malformedArtifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );

    const conflictingAliases = adapter({
        async scanExpos(pnu) {
            conflictingAliases.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    buldDongNm: '다른동',
                    buldFloorNm: '99층',
                    buldHoNm: '999호',
                }))
            );
        },
        async scanLdareg(pnu) {
            conflictingAliases.calls.push({
                endpoint: 'ldaregList',
                pnu,
            });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    buldDongNm: '다른동',
                    flrNoNm: '99층',
                    hoNm: '999호',
                }))
            );
        },
    });
    const aliasArtifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: conflictingAliases.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(aliasArtifact.gate.status, 'FAIL');
    assert.ok(
        aliasArtifact.gate.failureCodes.includes(
            'LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH'
        )
    );
});

test('basis title root의 별도 상위 PK는 허용하고 EXPOS의 모순된 상위 PK는 거부한다', async () => {
    const contradictoryBasis = adapter({
        async scanBasis(pnu) {
            contradictoryBasis.calls.push({
                endpoint: 'getBrBasisOulnInfo',
                pnu,
            });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    mgmUpBldrgstPk: '9999999999999',
                }))
            );
        },
    });
    const basisArtifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: contradictoryBasis.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(basisArtifact.gate.status, 'PASS');

    const contradictoryExpos = adapter({
        async scanExpos(pnu) {
            contradictoryExpos.calls.push({
                endpoint: 'getBrExposInfo',
                pnu,
            });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    mgmUpBldrgstPk: '9999999999999',
                }))
            );
        },
    });
    const exposArtifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: contradictoryExpos.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(exposArtifact.gate.status, 'FAIL');
    assert.ok(
        exposArtifact.gate.failureCodes.includes(
            'TITLE_BASIS_PK_CLOSURE_MISMATCH'
        )
    );
});

test('scope BASIS의 invalid raw up은 비식별 상태로 보존한 valid FAIL artifact다', async () => {
    const invalidRawUp = adapter({
        async scanBasis(pnu) {
            invalidRawUp.calls.push({
                endpoint: 'getBrBasisOulnInfo',
                pnu,
            });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    mgmUpBldrgstPk: 'INVALID-UP-PK',
                }))
            );
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: invalidRawUp.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('BASIS_PK_INVALID'));
    assert.ok(
        artifact.samples.every(
            (sample) =>
                sample.evidence.scopeBasis.status === 'FAIL' &&
                sample.evidence.scopeBasis.records.every(
                    (record) =>
                        record.upIdentityState === 'INVALID' &&
                        record.upManagementPkHash === undefined
                )
        )
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );
});

test('관리 PK numeric 응답은 digit string과 같은 canonical identity로 처리한다', async () => {
    const numeric = adapter({
        async scanTitle(pnu) {
            numeric.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                    ...(row.mgmUpBldrgstPk === undefined
                        ? {}
                        : { mgmUpBldrgstPk: Number(row.mgmUpBldrgstPk) }),
                    bylotCnt: Number(row.bylotCnt),
                }))
            );
        },
        async scanBasis(pnu) {
            numeric.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                    bylotCnt: Number(row.bylotCnt),
                }))
            );
        },
        async scanAttached(pnu) {
            numeric.calls.push({ endpoint: 'getBrAtchJibunInfo', pnu });
            return complete(
                attachedRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                }))
            );
        },
        async scanExpos(pnu) {
            numeric.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                    ...(row.mgmUpBldrgstPk === undefined
                        ? {}
                        : {
                              mgmUpBldrgstPk: Number(
                                  row.mgmUpBldrgstPk
                              ),
                          }),
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: numeric.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'PASS');
});

test('unsafe number·음수·소수·invalid string 관리 PK는 endpoint별로 fail-closed한다', async () => {
    const unsafe = adapter({
        async scanTitle(pnu) {
            unsafe.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number.MAX_SAFE_INTEGER + 1,
                }))
            );
        },
        async scanBasis(pnu) {
            unsafe.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: 'PK-INVALID',
                }))
            );
        },
        async scanAttached(pnu) {
            unsafe.calls.push({ endpoint: 'getBrAtchJibunInfo', pnu });
            return complete(
                attachedRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: -1,
                }))
            );
        },
        async scanExpos(pnu) {
            unsafe.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: 1.5,
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: unsafe.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    for (const code of [
        'TITLE_PK_INVALID',
        'BASIS_PK_INVALID',
        'ATTACHED_PK_INVALID',
        'EXPOS_PK_INVALID',
    ]) {
        assert.ok(artifact.gate.failureCodes.includes(code), code);
    }
});

test('exact-PK gate는 일부 PK만 맞거나 title에 없는 attached PK가 있어도 false-green하지 않는다', async () => {
    const partial = adapter({
        async scanTitle(pnu) {
            partial.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            if (pnu === ZERO_PNU) return complete(titleRows(pnu));
            return complete([
                ...titleRows(pnu),
                {
                    mgmBldrgstPk: '3003003003003',
                    bylotCnt: '1',
                    regstrGbCd: '2',
                    mainPurpsCd: '02003',
                },
            ]);
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: partial.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const positive = artifact.samples.find((sample) => sample.expectedBylot === 'POSITIVE')!;
    assert.equal(positive.checks.bylotAttached.status, 'FAIL');
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('BYLOT_ATTACHED_EXPECTATION_MISMATCH'));
});

test('title bylot이 ABSENT/NULL일 때만 같은 PK의 basis fallback 후보를 명시한다', async () => {
    const missingTitleBylot = adapter({
        async scanTitle(pnu) {
            missingTitleBylot.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map(({ bylotCnt: _bylotCnt, ...row }) => row)
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: missingTitleBylot.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    for (const sample of artifact.samples) {
        assert.equal(sample.policyCandidate, 'TITLE_WITH_BASIS_FALLBACK');
        assert.equal(sample.checks.titleBasis.status, 'PASS');
        assert.ok(
            sample.reviewCodes.includes('TITLE_WITH_BASIS_FALLBACK_CANDIDATE')
        );
        assert.equal(
            sample.evidence.bylotByManagementPk.records[0].titleBasisRelation,
            'FALLBACK_AVAILABLE'
        );
        const title = sample.endpoints.find(
            (endpoint) => endpoint.endpoint === 'getBrTitleInfo'
        )!;
        assert.equal(title.inventory.kind, 'TITLE');
        if (title.inventory.kind === 'TITLE') {
            assert.equal(title.inventory.records[0].bylot.presence, 'ABSENT');
            assert.equal(title.inventory.records[0].bylot.jsonType, 'undefined');
            assert.equal(title.inventory.records[0].bylot.parseState, 'INVALID');
        }
    }
});

test('title와 basis의 같은 관리 PK bylotCnt가 다르면 정책 후보를 만들지 않는다', async () => {
    const mismatch = adapter({
        async scanBasis(pnu) {
            mismatch.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    bylotCnt: pnu === ZERO_PNU ? '1' : '2',
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: mismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'TITLE_BASIS_PK_CLOSURE_MISMATCH'
        )
    );
    assert.ok(
        artifact.samples.every((sample) => sample.policyCandidate === null)
    );
});

test('Building HUB title/basis/expos 응답은 manifest의 exact PNU와 일치해야 한다', async () => {
    const mismatch = adapter({
        async scanTitle(pnu) {
            mismatch.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map((row) => ({ ...row, pnu: ZERO_PNU }))
            );
        },
        async scanBasis(pnu) {
            mismatch.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({ ...row, pnu: ZERO_PNU }))
            );
        },
        async scanExpos(pnu) {
            mismatch.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({ ...row, pnu: ZERO_PNU }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: mismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('TITLE_PNU_EXACT_MISMATCH'));
    assert.ok(artifact.gate.failureCodes.includes('BASIS_PNU_EXACT_MISMATCH'));
    assert.ok(artifact.gate.failureCodes.includes('EXPOS_PNU_EXACT_MISMATCH'));
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    );
    assert.equal(positive?.policyCandidate, null);
});

test('scan FAILED/INCOMPLETE를 그대로 보존하고 나머지 endpoint도 호출한 뒤 최종 gate를 실패시킨다', async () => {
    const { implementation, calls } = adapter({
        async scanTitle() {
            calls.push({ endpoint: 'getBrTitleInfo', pnu: ZERO_PNU });
            return {
                state: 'FAILED',
                issue: {
                    kind: 'HTTP_ERROR',
                    endpoint: 'getBrTitleInfo',
                    message: SECRET,
                    httpStatus: 403,
                },
            };
        },
        async scanBasis() {
            calls.push({ endpoint: 'getBrBasisOulnInfo', pnu: ZERO_PNU });
            return {
                state: 'INCOMPLETE',
                issue: {
                    kind: 'PAGINATION_MISMATCH',
                    endpoint: 'getBrBasisOulnInfo',
                    message: SECRET,
                    pagesFetched: 1,
                    expectedTotalCount: 2,
                    receivedRows: 1,
                },
            };
        },
    });

    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const zero = artifact.samples.find((sample) => sample.expectedBylot === 'ZERO')!;
    assert.equal(zero.endpoints[0].state, 'FAILED');
    assert.equal(zero.endpoints[1].state, 'INCOMPLETE');
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('SCAN_FAILED'));
    assert.ok(artifact.gate.failureCodes.includes('SCAN_INCOMPLETE'));
    assert.equal(zero.policyCandidate, null);
    assert.equal(zero.checks.titleBasis.status, 'FAIL');
    assert.equal(calls.length, 16);
    assert.equal(JSON.stringify(artifact).includes(SECRET), false);
});

test('artifact는 결정론적으로 정렬되고 row 순서와 무관한 schema hash를 만든다', async () => {
    const firstAdapter = adapter();
    const secondAdapter = adapter({
        async scanTitle(pnu) {
            secondAdapter.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete([...titleRows(pnu)].reverse());
        },
    });

    const first = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: firstAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const second = await captureLandAreaPhase0({
        manifest: manifest([...manifest().samples].reverse()),
        adapter: secondAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.deepEqual(first, second);
    assert.match(first.schemaHash, /^[a-f0-9]{64}$/);
    for (const sample of first.samples) {
        for (const endpoint of sample.endpoints) {
            assert.match(endpoint.schemaHash, /^[a-f0-9]{64}$/);
        }
    }
});

test('artifact는 raw PNU·관리 PK·agbldgSn·unit identity·PII·secret·domain·unknown field를 내보내지 않는다', async () => {
    const { implementation } = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const serialized = JSON.stringify(artifact);

    for (const canary of [
        ZERO_PNU,
        POSITIVE_PNU,
        ATTACHED_PNU,
        ZERO_PK,
        ZERO_UP_PK,
        POSITIVE_PK,
        POSITIVE_UP_PK,
        'RAW-AGBLDG-SN',
        SECRET,
        DOMAIN,
        OWNER,
        CONTACT,
        UNIT_DONG,
        UNIT_FLOOR,
        UNIT_HO,
        UNKNOWN_KEY,
        'zero-sample',
        'positive-sample',
    ]) {
        assert.equal(serialized.includes(canary), false, `artifact leaked: ${canary}`);
    }
    for (const publicLabel of [
        '일반건축물대장',
        '집합건축물대장',
        '단독주택',
        '다세대주택',
        '유효',
        'MULTIPLEX_HOUSE',
        'otherPurposeHash',
    ]) {
        assert.equal(serialized.includes(publicLabel), true, `artifact omitted: ${publicLabel}`);
    }
    assert.match(serialized, /24\.6\/364\.6/);
    assert.match(serialized, /177\.6/);
    assert.match(serialized, /187/);
    assert.match(serialized, /364\.6/);
    assert.match(serialized, /02003/);
    assert.match(serialized, /지하#층/);
});

test('LADFRL/LDAREG positive evidence가 하나라도 없으면 gate는 fail-closed', async () => {
    const noLadfrl = adapter({
        async scanLadfrl(pnu) {
            noLadfrl.calls.push({ endpoint: 'ladfrlList', pnu });
            return complete([]);
        },
    });
    const first = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: noLadfrl.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(first.gate.status, 'FAIL');
    assert.ok(first.gate.failureCodes.includes('LADFRL_POSITIVE_EVIDENCE_MISSING'));

    const noLdareg = adapter({
        async scanLdareg(pnu) {
            noLdareg.calls.push({ endpoint: 'ldaregList', pnu });
            return complete([]);
        },
    });
    const second = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: noLdareg.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(second.gate.status, 'FAIL');
    assert.ok(second.gate.failureCodes.includes('LDAREG_POSITIVE_EVIDENCE_MISSING'));
});

test('LDAREG는 같은 PNU의 LADFRL 면적과 분모가 허용 오차 안에서 일치해야 한다', async () => {
    const denominatorMismatch = adapter({
        async scanLdareg(pnu) {
            denominatorMismatch.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    ldaQotaRate: '24.6/9999.9',
                }))
            );
        },
    });
    const first = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: denominatorMismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(first.gate.status, 'FAIL');
    assert.ok(first.gate.failureCodes.includes('LDAREG_DENOMINATOR_MISMATCH'));
    assert.ok(first.gate.failureCodes.includes('LDAREG_POSITIVE_EVIDENCE_MISSING'));

    const pnuMismatch = adapter({
        async scanLdareg(pnu) {
            pnuMismatch.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    pnu: ZERO_PNU,
                }))
            );
        },
    });
    const second = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: pnuMismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(second.gate.status, 'FAIL');
    assert.ok(second.gate.failureCodes.includes('LDAREG_PNU_EXACT_MISMATCH'));
    assert.ok(second.gate.failureCodes.includes('LDAREG_POSITIVE_EVIDENCE_MISSING'));

    const conflictingLadfrl = adapter({
        async scanLadfrl(pnu) {
            conflictingLadfrl.calls.push({ endpoint: 'ladfrlList', pnu });
            return complete([
                ...ladfrlRows(pnu),
                {
                    ...ladfrlRows(pnu)[0],
                    lndpclAr: pnu === ZERO_PNU ? '101.5' : '178.6',
                },
            ]);
        },
    });
    const third = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: conflictingLadfrl.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(third.gate.status, 'FAIL');
    assert.ok(third.gate.failureCodes.includes('LADFRL_AREA_CONFLICT'));
    assert.ok(third.gate.failureCodes.includes('LADFRL_SCOPE_AREA_INVALID'));
    assert.ok(third.gate.failureCodes.includes('LDAREG_DENOMINATOR_MISMATCH'));
    assert.ok(third.gate.failureCodes.includes('LADFRL_POSITIVE_EVIDENCE_MISSING'));
});

test('linked PNU의 LDAREG ratio가 base canonical multiset과 다르면 Phase 0 gate가 차단한다', async () => {
    const mutated = adapter({
        async scanLdareg(pnu) {
            mutated.calls.push({ endpoint: 'ldaregList', pnu });
            const rows = ldaregRows(pnu).map((row) =>
                pnu === ATTACHED_PNU
                    ? { ...row, ldaQotaRate: '25/364.6' }
                    : row
            );
            return complete(rows);
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: mutated.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(positive.evidence.ldaregReplication.status, 'FAIL');
    assert.ok(positive.failureCodes.includes('LDAREG_SCOPE_REPLICA_INVALID'));
    assert.equal(artifact.gate.status, 'FAIL');
});

for (const replicaVariant of [
    {
        name: 'base valid/attached near-miss',
        baseFloor: '지상2',
        attachedFloor: '지상02',
        baseBuildingName: 'A',
        attachedBuildingName: 'A',
    },
    {
        name: 'base near-miss/attached valid',
        baseFloor: '지상02',
        attachedFloor: '지상2',
        baseBuildingName: 'A',
        attachedBuildingName: 'A',
    },
    {
        name: 'attached building identity NFKC variant',
        baseFloor: '지상2',
        attachedFloor: '지상2',
        baseBuildingName: 'A',
        attachedBuildingName: 'Ａ',
    },
] as const) {
    test(`Phase 0 shared replica helper는 provider raw variant를 fail-closed한다 (${replicaVariant.name})`, async () => {
        const mutated = adapter({
            async scanExpos(pnu) {
                mutated.calls.push({
                    endpoint: 'getBrExposInfo',
                    pnu,
                });
                if (pnu === POSITIVE_PNU) {
                    return complete([
                        {
                            pnu,
                            mgmBldrgstPk: POSITIVE_PK,
                            dongNm: 'A',
                            flrGbCd: '20',
                            flrNo: 2,
                            hoNm: '201',
                        },
                    ]);
                }
                return complete(exposRows(pnu));
            },
            async scanLdareg(pnu) {
                mutated.calls.push({
                    endpoint: 'ldaregList',
                    pnu,
                });
                if (
                    pnu !== POSITIVE_PNU &&
                    pnu !== ATTACHED_PNU
                ) {
                    return complete(ldaregRows(pnu));
                }
                const base = pnu === POSITIVE_PNU;
                return complete([
                    {
                        pnu,
                        agbldgSn: 'MIA7-REPLICA-V3',
                        buldNm: base
                            ? replicaVariant.baseBuildingName
                            : replicaVariant.attachedBuildingName,
                        buldDongNm: 'A',
                        buldFloorNm: base
                            ? replicaVariant.baseFloor
                            : replicaVariant.attachedFloor,
                        buldHoNm: '201',
                        buldRoomNm: '201',
                        ldaQotaRate: '24.6/364.6',
                        clsSeCode: '0',
                        clsSeCodeNm: '현재',
                    },
                ]);
            },
        });
        const v2Manifest: LandAreaPhase0CaptureManifest = {
            version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
            samples: [
                {
                    alias: 'zero-control',
                    expectedBylot: 'ZERO',
                    expectedFamily: 'LADFRL',
                    pnu: ZERO_PNU,
                },
                {
                    alias: 'provider-replica-variant',
                    expectedBylot: 'POSITIVE',
                    expectedFamily: 'LDAREG',
                    pnu: POSITIVE_PNU,
                },
            ],
        };
        const artifact = await captureLandAreaPhase0({
            manifest: v2Manifest,
            adapter: mutated.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const positive = artifact.samples.find(
            (sample) =>
                sample.expectedBylot === 'POSITIVE'
        )!;
        assert.equal(
            positive.evidence.ldaregReplication.status,
            'FAIL'
        );
        assert.ok(
            positive.failureCodes.includes(
                'LDAREG_SCOPE_REPLICA_INVALID'
            )
        );
        assert.equal(artifact.gate.status, 'FAIL');
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                v2Manifest,
                artifact
            ),
            artifact
        );
    });
}

for (const mixedVariant of [
    {
        name: 'attached standard row NFKC building name',
        mutate: (rows: Array<Record<string, unknown>>) => {
            rows[0].buldNm = 'Ａ';
        },
    },
    {
        name: 'attached placeholder numeric aggregate serial',
        mutate: (rows: Array<Record<string, unknown>>) => {
            rows[2].agbldgSn = 1;
        },
    },
] as const) {
    test(`Phase 0 mixed standard+bridge replica는 ${mixedVariant.name}도 all-row proof에서 차단한다`, async () => {
        const mixedRows = (pnu: string) =>
            [
                {
                    pnu,
                    agbldgSn: '1',
                    buldNm: 'A',
                    buldFloorNm: '1',
                    buldHoNm: '101',
                    buldRoomNm: '101',
                    ldaQotaRate: '200/364.6',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
                {
                    pnu,
                    agbldgSn: '1',
                    buldNm: 'A',
                    buldFloorNm: '지하',
                    buldHoNm: '비1',
                    buldRoomNm: '비1',
                    ldaQotaRate: '164.6/364.6',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
                {
                    pnu,
                    agbldgSn: '1',
                    buldNm: 'A',
                    buldDongNm: '0000',
                    buldFloorNm: '0000',
                    buldHoNm: '0000',
                    buldRoomNm: '0000',
                    ldaQotaRate: '',
                    clsSeCode: '0',
                    clsSeCodeNm: '현재',
                },
            ] as Array<Record<string, unknown>>;
        const attachedRows = mixedRows(ATTACHED_PNU);
        mixedVariant.mutate(attachedRows);
        const mutated = adapter({
            async scanExpos(pnu) {
                mutated.calls.push({
                    endpoint: 'getBrExposInfo',
                    pnu,
                });
                if (pnu === POSITIVE_PNU) {
                    return complete([
                        {
                            pnu,
                            mgmBldrgstPk: POSITIVE_PK,
                            flrGbCd: '20',
                            flrNo: 1,
                            hoNm: '101',
                        },
                        {
                            pnu,
                            mgmBldrgstPk: POSITIVE_PK,
                            flrGbCd: '10',
                            flrNo: 1,
                            hoNm: 'B1',
                        },
                    ]);
                }
                return complete(exposRows(pnu));
            },
            async scanLdareg(pnu) {
                mutated.calls.push({
                    endpoint: 'ldaregList',
                    pnu,
                });
                if (pnu === POSITIVE_PNU) {
                    return complete(
                        mixedRows(
                            pnu
                        ) as unknown as LdaregRow[]
                    );
                }
                if (pnu === ATTACHED_PNU) {
                    return complete(
                        attachedRows as unknown as LdaregRow[]
                    );
                }
                return complete(ldaregRows(pnu));
            },
        });
        const v2Manifest: LandAreaPhase0CaptureManifest = {
            version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
            samples: [
                {
                    alias: 'zero-control',
                    expectedBylot: 'ZERO',
                    expectedFamily: 'LADFRL',
                    pnu: ZERO_PNU,
                },
                {
                    alias: 'mixed-provider-identity-variant',
                    expectedBylot: 'POSITIVE',
                    expectedFamily: 'LDAREG',
                    pnu: POSITIVE_PNU,
                },
            ],
        };
        const artifact = await captureLandAreaPhase0({
            manifest: v2Manifest,
            adapter: mutated.implementation,
            buildingHubAuth: HUB_AUTH,
            vworldAuth: VWORLD_AUTH,
        });
        const positive = artifact.samples.find(
            (sample) =>
                sample.expectedBylot === 'POSITIVE'
        )!;
        assert.equal(
            positive.evidence.ldaregReplication.status,
            'FAIL'
        );
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                positive.evidence.ldaregReplication,
                'providerBuildingIdentity'
            ),
            false
        );
        assert.ok(
            positive.failureCodes.includes(
                'LDAREG_SCOPE_REPLICA_INVALID'
            )
        );
        assert.equal(artifact.gate.status, 'FAIL');
        assert.equal(
            validateLandAreaPhase0CaptureArtifact(
                v2Manifest,
                artifact
            ),
            artifact
        );
    });
}

test('sanitized inventory는 200건으로 제한하고 전체 수·digest·truncated를 남긴다', async () => {
    const oversized = adapter({
        async scanExpos(pnu) {
            oversized.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                Array.from({ length: 201 }, (_, index) => ({
                    ...exposRows(pnu)[0],
                    hoNm: `${UNIT_HO}-${index}`,
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: oversized.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const expos = artifact.samples[0].endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrExposInfo'
    )!;
    assert.equal(expos.inventory.kind, 'EXPOS');
    if (expos.inventory.kind === 'EXPOS') {
        assert.equal(expos.inventory.records.length, 200);
        assert.equal(expos.inventory.totalRecords, 201);
        assert.equal(expos.inventory.truncated, true);
        assert.match(expos.inventory.sanitizedDigest, /^[a-f0-9]{64}$/);
    }
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('CAPTURE_INVENTORY_TRUNCATED'));
});

test('output path는 cwd/.phase0-land-area 바로 아래 JSON 파일만 허용한다', () => {
    const cwd = '/workspace/tonghari-api';
    assert.equal(
        resolveLandAreaPhase0OutputPath(cwd, 'capture.json'),
        '/workspace/tonghari-api/.phase0-land-area/capture.json'
    );
    assert.equal(
        resolveLandAreaPhase0OutputPath(cwd, '.phase0-land-area/capture-01.json'),
        '/workspace/tonghari-api/.phase0-land-area/capture-01.json'
    );
    for (const invalid of [
        '../capture.json',
        '.phase0-land-area/nested/capture.json',
        '/tmp/capture.json',
        '.phase0-land-area/../capture.json',
        'capture.txt',
        'owner name.json',
    ]) {
        assert.throws(() => resolveLandAreaPhase0OutputPath(cwd, invalid), /출력 경로/);
    }
});

test('secure writer는 디렉터리 0700·파일 0600으로 생성하고 기존 파일을 덮어쓰지 않는다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-'));
    const outputPath = resolveLandAreaPhase0OutputPath(cwd, 'capture.json');
    const artifact = {
        version: 'test',
        schemaHash: 'a'.repeat(64),
        gate: { status: 'FAIL', failureCodes: ['TEST'] },
        samples: [],
    };

    await writeLandAreaPhase0Artifact(cwd, outputPath, artifact);
    assert.equal((await stat(path.join(cwd, '.phase0-land-area'))).mode & 0o777, 0o700);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), artifact);
    await assert.rejects(() => writeLandAreaPhase0Artifact(cwd, outputPath, artifact), /이미 존재/);

    const oversizedPath = resolveLandAreaPhase0OutputPath(cwd, 'oversized.json');
    await assert.rejects(
        () =>
            writeLandAreaPhase0Artifact(cwd, oversizedPath, {
                payload: 'x'.repeat(3 * 1024 * 1024),
            }),
        /artifact 크기/
    );
    await assert.rejects(() => access(oversizedPath));
});

test('CLI는 --input/--out만 받고 환경변수 키를 사용하며 stdout에 민감값을 출력하지 않는다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-cli-'));
    const privateDir = path.join(cwd, '.phase0-land-area');
    const manifestPath = path.join(privateDir, 'manifest.json');
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const output: string[] = [];
    const errors: string[] = [];
    const { implementation } = adapter();

    const exitCode = await runLandAreaPhase0CaptureCli(
        ['--input', manifestPath, '--out', 'capture.json'],
        {
            cwd,
            env: {
                DATA_PORTAL_API_KEY: SECRET,
                VWORLD_API_KEY: `${SECRET}-VWORLD`,
            },
            adapter: implementation,
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
        }
    );

    assert.equal(exitCode, 0);
    assert.equal(errors.length, 0);
    const stdout = output.join('\n');
    assert.ok(stdout.length <= 256);
    for (const canary of [SECRET, DOMAIN, ZERO_PNU, POSITIVE_PNU, OWNER, CONTACT]) {
        assert.equal(stdout.includes(canary), false);
    }
    const artifactText = await readFile(path.join(cwd, '.phase0-land-area/capture.json'), 'utf8');
    assert.equal(artifactText.includes(SECRET), false);
    assert.equal(artifactText.includes('www.tonghari.kr'), false);
});

test('CLI는 추가 flag, 공개 권한 manifest, 누락 credential을 fail-closed로 거부한다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-cli-invalid-'));
    const privateDir = path.join(cwd, '.phase0-land-area');
    const manifestPath = path.join(privateDir, 'manifest.json');
    const outsideManifestPath = path.join(cwd, 'outside-manifest.json');
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`, { mode: 0o644 });
    await writeFile(outsideManifestPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o644);
    await chmod(outsideManifestPath, 0o600);
    const { implementation } = adapter();

    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', manifestPath, '--out', 'capture.json', '--verbose'],
            { cwd, env: {}, adapter: implementation, stdout: () => undefined, stderr: () => undefined }
        ),
        2
    );
    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', manifestPath, '--out', 'capture.json'],
            {
                cwd,
                env: {
                    DATA_PORTAL_API_KEY: SECRET,
                    VWORLD_API_KEY: `${SECRET}-VWORLD`,
                    VWORLD_API_DOMAIN: DOMAIN,
                },
                adapter: implementation,
                stdout: () => undefined,
                stderr: () => undefined,
            }
        ),
        2
    );
    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', outsideManifestPath, '--out', 'capture.json'],
            {
                cwd,
                env: {
                    DATA_PORTAL_API_KEY: SECRET,
                    VWORLD_API_KEY: `${SECRET}-VWORLD`,
                    VWORLD_API_DOMAIN: DOMAIN,
                },
                adapter: implementation,
                stdout: () => undefined,
                stderr: () => undefined,
            }
        ),
        2
    );

    await chmod(manifestPath, 0o600);
    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', manifestPath, '--out', 'capture.json'],
            { cwd, env: {}, adapter: implementation, stdout: () => undefined, stderr: () => undefined }
        ),
        2
    );
});

test('capture 경로는 DB/queue/동기화 service/config env에 정적으로 연결되지 않는다', async () => {
    const verification = await readFile(
        path.join(process.cwd(), 'src/verification/land-area-phase0-capture.ts'),
        'utf8'
    );
    const cli = await readFile(path.join(process.cwd(), 'src/cli/phase0-land-area-capture.ts'), 'utf8');
    const requestIntervalPolicy = await readFile(
        path.join(
            process.cwd(),
            'src/utils/vworld-request-interval.ts'
        ),
        'utf8'
    );
    const combined = `${verification}\n${cli}\n${requestIntervalPolicy}`;

    assert.doesNotMatch(combined, /from ['"][^'"]*\/(?:repository|service|queue)['"]/);
    assert.doesNotMatch(combined, /from ['"][^'"]*config\/env['"]/);
    assert.doesNotMatch(combined, /supabase/i);
    assert.doesNotMatch(combined, /runLandAreaSyncJob|GisInspectService/);
});

test('production image는 compiled CLI와 node 사용자 전용 0700 artifact 디렉터리를 포함한다', async () => {
    const dockerfile = await readFile(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    const dockerignore = await readFile(path.join(process.cwd(), '.dockerignore'), 'utf8');
    assert.match(dockerfile, /COPY --from=builder \/app\/dist \.\/dist/);
    assert.match(dockerfile, /mkdir -p logs \.phase0-land-area/);
    assert.match(dockerfile, /chown -R nodejs:nodejs logs \.phase0-land-area/);
    assert.match(dockerfile, /chmod 700 \.phase0-land-area/);
    assert.match(dockerfile, /USER nodejs/);
    assert.match(dockerignore, /^\.phase0-land-area$/m);
});

test('strict artifact validator는 exact manifest/sample/endpoint/schema 계약의 PASS와 FAIL을 모두 보존한다', async () => {
    const { implementation } = adapter();
    const passManifest = manifest();
    const passArtifact = await captureLandAreaPhase0({
        manifest: passManifest,
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(
        passArtifact.schemaHash,
        LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH
    );
    assert.equal(
        LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH,
        '0909518650db9d6330549bf67998a75b1c17378ece1dd14473be5f3c3cb3a05a'
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(passManifest, passArtifact),
        passArtifact
    );
    const legacySchemaArtifact =
        structuredClone(passArtifact) as any;
    legacySchemaArtifact.schemaHash =
        '99d06939e77afcf8220fc1b6cef55ea22315f11b38a24a13aeecb45a47c49e16';
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            passManifest,
            legacySchemaArtifact
        ),
        legacySchemaArtifact
    );

    // 최초 관찰의 expectedBylot은 아직 입증값이 아니다. 관찰 결과가 가설과
    // 다르면 strict-valid FAIL artifact로 보존되어야 한다.
    const firstObservationManifest = manifest([
        {
            alias: 'first-observation-a',
            expectedBylot: 'POSITIVE',
            pnu: ZERO_PNU,
        },
        {
            alias: 'first-observation-b',
            expectedBylot: 'ZERO',
            pnu: POSITIVE_PNU,
        },
    ]);
    const failing = adapter();
    const failArtifact = await captureLandAreaPhase0({
        manifest: firstObservationManifest,
        adapter: failing.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(failArtifact.gate.status, 'FAIL');
    assert.ok(failArtifact.gate.failureCodes.length > 0);
    assert.deepEqual(
        failArtifact.gate.failureCodes,
        [...new Set(failArtifact.samples.flatMap((sample) => sample.failureCodes))].sort()
    );
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            firstObservationManifest,
            failArtifact
        ),
        failArtifact
    );
});

test('strict artifact validator는 extra key, hash/set/code/gate union 변조와 3MiB 초과를 fail-closed한다', async () => {
    const { implementation } = adapter();
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const rejected = (mutate: (candidate: any) => void, pattern: RegExp) => {
        const candidate = structuredClone(artifact) as any;
        mutate(candidate);
        assert.throws(
            () =>
                validateLandAreaPhase0CaptureArtifact(
                    approvedManifest,
                    candidate
                ),
            pattern
        );
    };

    rejected((candidate) => {
        candidate.extra = true;
    }, /unknown key/);
    rejected((candidate) => {
        candidate.samples[0].checks.titleBasis.extra = true;
    }, /unknown key/);
    rejected((candidate) => {
        candidate.schemaHash = '0'.repeat(64);
    }, /schema hash/);
    rejected((candidate) => {
        candidate.samples[0].pnuHash = '0'.repeat(64);
    }, /approved manifest|base BASIS inventory|base EXPOS inventory|exact base\/attached parcel scope/);
    rejected((candidate) => {
        candidate.samples[0].endpoints[1] =
            candidate.samples[0].endpoints[0];
    }, /exact approved endpoint set/);
    rejected((candidate) => {
        candidate.samples[0].failureCodes = ['Z_CODE', 'A_CODE'];
    }, /sorted and unique/);
    rejected((candidate) => {
        candidate.gate.status = 'FAIL';
    }, /PASS is allowed iff/);
    rejected((candidate) => {
        candidate.gate.status = 'FAIL';
        candidate.gate.failureCodes = ['GATE_ONLY'];
    }, /sample failure union/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const inventory = sample.endpoints.find(
            (entry: any) => entry.endpoint === 'getBrExposInfo'
        ).inventory;
        delete inventory.records[0].unitIdentityHash;
        inventory.records[0].unitIdentityShape = 'INCOMPLETE';
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /semantic failure|unit identity|not bound|conflicts with hash/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const titleHash = sample.endpoints
            .find((entry: any) => entry.endpoint === 'getBrTitleInfo')
            .inventory.records[0].managementPkHash;
        const inventory = sample.endpoints.find(
            (entry: any) => entry.endpoint === 'getBrBasisOulnInfo'
        ).inventory;
        const root = inventory.records.find(
            (record: any) => record.managementPkHash === titleHash
        );
        root.managementPkHash = '0'.repeat(64);
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /outside title PK closure|base BASIS inventory/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const inventory = sample.endpoints.find(
            (entry: any) => entry.endpoint === 'ldaregList'
        ).inventory;
        inventory.records[0].quotaRatioInput.parseState = 'MISSING';
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /quotaRatioInput is inconsistent/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const inventory = sample.endpoints.find(
            (entry: any) => entry.endpoint === 'ldaregList'
        ).inventory;
        inventory.records[0].quotaRatioInput = {
            presence: 'ABSENT',
            jsonType: 'undefined',
            parseState: 'VALID',
            stringShape: 'NOT_APPLICABLE',
        };
        inventory.sanitizedDigest = sanitizedTestDigest(
            inventory.records
        );
    }, /quotaRatioInput is inconsistent/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const basisInventory = sample.endpoints.find(
            (entry: any) =>
                entry.endpoint === 'getBrBasisOulnInfo'
        ).inventory;
        const baseScopeRecord =
            sample.evidence.scopeBasis.records.find(
                (record: any) =>
                    record.queryPnuHash === sample.pnuHash
            );
        basisInventory.records[0].managementPkHash =
            '1'.repeat(64);
        baseScopeRecord.selfManagementPkHash =
            '2'.repeat(64);
        basisInventory.sanitizedDigest = sanitizedTestDigest(
            basisInventory.records
        );
        sample.evidence.scopeBasis.sanitizedDigest =
            sanitizedTestDigest(
                sample.evidence.scopeBasis.records
            );
    }, /base BASIS inventory/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const attachedPnuHash = sample.endpoints.find(
            (entry: any) =>
                entry.endpoint === 'getBrAtchJibunInfo'
        ).inventory.pairs[0].attachedPnuHash;
        const scopeBasis = sample.evidence.scopeBasis;
        const attachedRecord = scopeBasis.records.find(
            (record: any) =>
                record.queryPnuHash === attachedPnuHash
        );
        attachedRecord.rowPnuHash = '0'.repeat(64);
        scopeBasis.sanitizedDigest = sanitizedTestDigest(
            scopeBasis.records
        );
    }, /scopeBasis\.status is inconsistent|semantic failure/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        sample.evidence.scopeExpos.queries[0].pnuHash =
            '0'.repeat(64);
    }, /scopeExpos|canonical/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const scopeExpos = sample.evidence.scopeExpos;
        scopeExpos.records[0].selfManagementPkHash =
            '0'.repeat(64);
        scopeExpos.records[0].rootManagementPkHash =
            '0'.repeat(64);
        scopeExpos.sanitizedDigest = sanitizedTestDigest(
            scopeExpos.records
        );
    }, /root provenance|title\/basis PK closure/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const scopeExpos = sample.evidence.scopeExpos;
        scopeExpos.records[0].rowPnuHash = '0'.repeat(64);
        scopeExpos.sanitizedDigest = sanitizedTestDigest(
            scopeExpos.records
        );
    }, /scopeExpos\.status is inconsistent|semantic failure/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const attached = sample.endpoints.find(
            (entry: any) =>
                entry.endpoint === 'getBrAtchJibunInfo'
        ).inventory;
        attached.pairs[0].basePnuHash = '0'.repeat(64);
        attached.pairsDigest = sanitizedTestDigest(attached.pairs);
    }, /not bound to the sample base PNU|exact base\/attached parcel scope/);
    rejected((candidate) => {
        const sample = candidate.samples.find(
            (entry: any) => entry.expectedBylot === 'POSITIVE'
        );
        const attached = sample.endpoints.find(
            (entry: any) =>
                entry.endpoint === 'getBrAtchJibunInfo'
        ).inventory;
        attached.pairs[0].attachedPnuHash = '0'.repeat(64);
        attached.pairsDigest = sanitizedTestDigest(attached.pairs);
    }, /captured parcel scope|exact base\/attached parcel scope/);

    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(approvedManifest, {
                ...artifact,
                padding: 'x'.repeat(3 * 1024 * 1024),
            }),
        /artifact size/
    );
});

test('SCHEMA_ERROR artifact는 고정 schemaErrorCode가 없으면 검증되지 않는다', async () => {
    const schemaFailure = adapter({
        async scanLdareg(pnu) {
            schemaFailure.calls.push({ endpoint: 'ldaregList', pnu });
            return {
                state: 'FAILED',
                issue: {
                    kind: 'SCHEMA_ERROR',
                    endpoint: 'ldaregList',
                    message: '응답 구조가 계약과 다릅니다.',
                    schemaErrorCode:
                        'ENDPOINT_CONTAINER_MISSING_EMPTY_OBJECT',
                    attempts: 1,
                },
            };
        },
    });
    const approvedManifest = manifest();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: schemaFailure.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(
        validateLandAreaPhase0CaptureArtifact(
            approvedManifest,
            artifact
        ),
        artifact
    );

    const candidate = structuredClone(artifact) as any;
    const endpoint = candidate.samples[0].endpoints.find(
        (entry: any) => entry.endpoint === 'ldaregList'
    );
    delete endpoint.issue.schemaErrorCode;
    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                candidate
            ),
        /SCHEMA_ERROR requires schemaErrorCode/
    );
});

test('reviewer all-zero fixture는 nested FAIL을 숨긴 PASS/failureCodes=[]로 승인될 수 없다', async () => {
    const approvedManifest = manifest();
    const captured = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: captured.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const zeroAttachedInventory = structuredClone(
        artifact.samples
            .find((sample) => sample.expectedBylot === 'ZERO')!
            .endpoints.find(
                (endpoint) => endpoint.inventory.kind === 'ATTACHED'
            )!.inventory
    );
    const allZero = structuredClone(artifact) as any;
    for (const sample of allZero.samples) {
        for (const endpoint of sample.endpoints) {
            endpoint.state = 'COMPLETE_ZERO';
            endpoint.totalCount = 0;
            endpoint.pagesFetched = 1;
            delete endpoint.issue;
            if (endpoint.inventory.kind === 'ATTACHED') {
                endpoint.inventory = structuredClone(zeroAttachedInventory);
            } else {
                endpoint.inventory.records = [];
                endpoint.inventory.totalRecords = 0;
                endpoint.inventory.truncated = false;
                endpoint.inventory.sanitizedDigest =
                    sanitizedTestDigest([]);
            }
        }
        sample.evidence.bylotByManagementPk = {
            records: [],
            totalRecords: 0,
            truncated: false,
            sanitizedDigest: sanitizedTestDigest([]),
        };
        sample.evidence.scopeLadfrl = {
            status: 'FAIL',
            records: [],
            totalArea: null,
        };
        sample.evidence.ldaregReplication.status =
            'NOT_APPLICABLE';
        sample.evidence.ldaregReplication.rowCount = null;
        sample.evidence.ldaregReplication.rowMultisetDigest = null;
        sample.policyCandidate = null;
        sample.checks.titleBasis.status = 'FAIL';
        sample.checks.bylotAttached = {
            status: 'FAIL',
            matchedManagementPkHashes: {
                records: [],
                totalRecords: 0,
                truncated: false,
                sanitizedDigest: sanitizedTestDigest([]),
            },
        };
        sample.failureCodes = [];
        sample.reviewCodes = [];
    }
    allZero.gate = {
        status: 'PASS',
        failureCodes: [],
        reviewCodes: [],
    };

    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                allZero
            ),
        /required semantic failure|root provenance|base BASIS inventory/
    );
});

test('FORGED_ALL_ZERO_PASS_ACCEPTED: all-zero endpoint와 fake nested PASS 조합을 fail-closed한다', async () => {
    const approvedManifest = manifest();
    const captured = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: captured.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const zeroAttachedInventory = structuredClone(
        artifact.samples
            .find((sample) => sample.expectedBylot === 'ZERO')!
            .endpoints.find(
                (endpoint) => endpoint.inventory.kind === 'ATTACHED'
            )!.inventory
    );
    const forged = structuredClone(artifact) as any;
    for (const sample of forged.samples) {
        for (const endpoint of sample.endpoints) {
            endpoint.state = 'COMPLETE_ZERO';
            endpoint.totalCount = 0;
            endpoint.pagesFetched = 1;
            delete endpoint.issue;
            if (endpoint.inventory.kind === 'ATTACHED') {
                endpoint.inventory = structuredClone(zeroAttachedInventory);
            } else {
                endpoint.inventory.records = [];
                endpoint.inventory.totalRecords = 0;
                endpoint.inventory.truncated = false;
                endpoint.inventory.sanitizedDigest =
                    sanitizedTestDigest([]);
            }
        }
        // producer가 만든 양성 evidence/check를 그대로 남겨도 endpoint 관찰값과
        // 결속되지 않으면 PASS witness로 인정하면 안 된다.
        sample.failureCodes = [];
    }
    forged.gate.status = 'PASS';
    forged.gate.failureCodes = [];

    assert.throws(
        () =>
            validateLandAreaPhase0CaptureArtifact(
                approvedManifest,
                forged
            ),
        /required semantic failure|every endpoint COMPLETE_ZERO|root provenance|base BASIS inventory/
    );
});

test('attached rejected inventory는 exact reason enum·count sum·producer digest·failure code를 강제한다', async () => {
    const approvedManifest = manifest();
    const captured = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: approvedManifest,
        adapter: captured.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const mutateAttached = (
        mutate: (inventory: any, endpoint: any) => void,
        pattern: RegExp
    ) => {
        const candidate = structuredClone(artifact) as any;
        const endpoint = candidate.samples[0].endpoints.find(
            (item: any) => item.inventory.kind === 'ATTACHED'
        );
        mutate(endpoint.inventory, endpoint);
        assert.throws(
            () =>
                validateLandAreaPhase0CaptureArtifact(
                    approvedManifest,
                    candidate
                ),
            pattern
        );
    };
    const validRejected = [
        { side: 'PAIR', reason: 'SELF_RELATION', count: 1 },
    ];

    mutateAttached((inventory) => {
        inventory.rejected = [
            { side: 'PAIR', reason: 'MISSING_FIELD', count: 1 },
        ];
    }, /unsupported value/);
    mutateAttached((inventory) => {
        inventory.rejected = validRejected;
        inventory.totalRejected = 2;
    }, /rejected count sum/);
    mutateAttached((inventory) => {
        inventory.rejected = validRejected;
        inventory.totalRejected = 1;
        inventory.rejectedDigest = '0'.repeat(64);
    }, /rejectedDigest/);
    mutateAttached((inventory) => {
        inventory.pairsDigest = '0'.repeat(64);
    }, /pairsDigest/);
    mutateAttached((inventory, endpoint) => {
        inventory.rejected = validRejected;
        inventory.totalRejected = 1;
        inventory.rejectedDigest = sanitizedTestDigest(validRejected);
        endpoint.state = 'COMPLETE';
        endpoint.totalCount += 1;
    }, /required semantic failure/);
});

test('compiled validator CLI는 valid FAIL에도 sentinel만 출력하고 raw PNU·오류 내용을 노출하지 않는다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-validator-'));
    const privateDir = path.join(cwd, '.phase0-land-area');
    await mkdir(privateDir, { mode: 0o700 });
    const firstObservationManifest = manifest([
        {
            alias: 'first-observation-a',
            expectedBylot: 'POSITIVE',
            pnu: ZERO_PNU,
        },
        {
            alias: 'first-observation-b',
            expectedBylot: 'ZERO',
            pnu: POSITIVE_PNU,
        },
    ]);
    const failing = adapter();
    const failArtifact = await captureLandAreaPhase0({
        manifest: firstObservationManifest,
        adapter: failing.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const manifestPath = path.join(privateDir, 'manifest.json');
    const artifactPath = path.join(privateDir, 'artifact.json');
    await writeFile(manifestPath, `${JSON.stringify(firstObservationManifest)}\n`, {
        mode: 0o600,
    });
    await writeFile(artifactPath, `${JSON.stringify(failArtifact)}\n`, {
        mode: 0o600,
    });
    await chmod(manifestPath, 0o600);
    await chmod(artifactPath, 0o600);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runLandAreaPhase0ValidationCli(
        [
            '--manifest',
            '.phase0-land-area/manifest.json',
            '--artifact',
            '.phase0-land-area/artifact.json',
        ],
        {
            cwd,
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
        }
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(stdout, [LAND_AREA_PHASE0_VALIDATION_SENTINEL]);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.join('\n').includes(ZERO_PNU), false);
    assert.equal(stdout.join('\n').includes(POSITIVE_PNU), false);

    const tampered = structuredClone(failArtifact) as any;
    tampered.samples[0].pnuHash = '0'.repeat(64);
    await writeFile(artifactPath, `${JSON.stringify(tampered)}\n`, {
        mode: 0o600,
    });
    await chmod(artifactPath, 0o600);
    const rejectedOutput: string[] = [];
    const rejectedErrors: string[] = [];
    assert.equal(
        await runLandAreaPhase0ValidationCli(
            [
                '--manifest',
                '.phase0-land-area/manifest.json',
                '--artifact',
                '.phase0-land-area/artifact.json',
            ],
            {
                cwd,
                stdout: (message) => rejectedOutput.push(message),
                stderr: (message) => rejectedErrors.push(message),
            }
        ),
        2
    );
    assert.deepEqual(rejectedOutput, []);
    assert.deepEqual(rejectedErrors, ['Phase 0 artifact validation rejected.']);
    assert.equal(rejectedErrors.join('\n').includes(ZERO_PNU), false);
});

test('Phase 0 workflow는 승인 environment·pinned SSH/container·exclusive remote dir·validator sentinel을 강제한다', async () => {
    const workflow = await readFile(
        path.join(process.cwd(), '.github/workflows/phase0-land-area-capture.yml'),
        'utf8'
    );
    const deployWorkflow = await readFile(
        path.join(process.cwd(), '.github/workflows/docker-build.yml'),
        'utf8'
    );
    const dockerfile = await readFile(
        path.join(process.cwd(), 'Dockerfile'),
        'utf8'
    );
    assert.match(
        workflow,
        /^name: Phase 0 Land Area First-Observation Read-Only Capture$/m
    );
    assert.match(workflow, /^\s+environment: phase0-production-readonly$/m);
    assert.match(workflow, /^concurrency:\n\s+group: tonghari-api-production$/m);
    assert.match(
        deployWorkflow,
        /^concurrency:\n\s+group: tonghari-api-production$/m
    );
    assert.match(
        workflow,
        /First-observation manifest; expectedBylot values are unproven hypotheses/
    );
    assert.match(
        workflow,
        /\^\[A-Za-z0-9\]\(\[A-Za-z0-9\.\-\]\*\[A-Za-z0-9\]\)\?\$/
    );
    for (const option of [
        'BatchMode=yes',
        'IdentitiesOnly=yes',
        'StrictHostKeyChecking=yes',
        'UserKnownHostsFile=${HOME}/.ssh/known_hosts',
    ]) {
        assert.ok(workflow.includes(option), option);
    }
    const remoteCommands = workflow
        .split('\n')
        .filter((line) => /^\s+(?:ssh|scp) /.test(line));
    assert.ok(remoteCommands.length >= 7);
    assert.ok(
        remoteCommands.every((line) => line.includes('"${ssh_options[@]}"'))
    );
    assert.match(workflow, /test ! -L "\$\{application_root\}"/);
    assert.match(workflow, /test ! -L "\$\{parent\}"/);
    assert.match(workflow, /\(umask 077; mkdir -m 700 -- "\$\{run_root\}"\)/);
    assert.match(
        workflow,
        /timeout --foreground --kill-after=15s 10m[\s\S]*phase0-land-area-capture\.js/
    );
    assert.match(
        workflow,
        /health\?[\s\S]*health\?\.gitSha !== process\.env\.EXPECTED_GIT_SHA[\s\S]*health\?\.imageTag !== process\.env\.EXPECTED_IMAGE_TAG/
    );
    assert.match(
        workflow,
        /health\?\.features\?\.landAreaSyncEnabled !== false/
    );
    assert.match(
        workflow,
        /health\?\.features\?\.landAreaSyncAllowedTargetCount !== 0/
    );
    assert.match(
        workflow,
        /health\?\.features\?\.landAreaSyncAllowedTargetsDigest !== ""/
    );
    assert.match(workflow, /docker inspect --format '\{\{\.Id\}\}'/);
    assert.match(workflow, /docker inspect --format '\{\{\.Image\}\}'/);
    assert.match(
        dockerfile,
        /LABEL org\.opencontainers\.image\.revision="\$\{GIT_SHA\}"/
    );
    assert.match(
        workflow,
        /docker image inspect[\s\S]*org\.opencontainers\.image\.revision/
    );
    assert.match(
        workflow,
        /container_image_revision_before}" != "\$\{EXPECTED_GIT_SHA\}"/
    );
    assert.match(
        workflow,
        /PHASE0_MANIFEST_PATH[\s\S]*flag: "wx"[\s\S]*mode: 0o600/
    );
    assert.doesNotMatch(
        workflow,
        /docker cp "\$\{host_manifest\}"[\s\S]*"\$\{target_container\}:\$\{container_manifest\}"/
    );
    assert.match(
        workflow,
        /container_id_after[\s\S]*container_id_before[\s\S]*container_image_id_after[\s\S]*container_image_id_before[\s\S]*container_image_revision_after[\s\S]*container_image_revision_before/
    );
    assert.match(
        workflow,
        /verify_target_health\(\)[\s\S]*docker exec[\s\S]*http:\/\/127\.0\.0\.1:3100\/health/
    );
    assert.match(workflow, /phase0-land-area-validate\.js/);
    assert.match(workflow, /LAND_AREA_PHASE0_ARTIFACT_VALIDATED/);
    assert.match(workflow, /sha256sum phase0-output\/artifact\.json/);
    assert.match(
        workflow,
        /node "\$\{GITHUB_WORKSPACE\}\/dist\/cli\/phase0-land-area-validate\.js"/
    );
    assert.match(workflow, /phase0-output\/validated-runner/);
    assert.match(workflow, /artifact_size}" -gt 3145728/);
    assert.match(
        workflow,
        /steps\.validate\.outcome == 'success'/
    );
    assert.ok(
        workflow.indexOf('- name: Upload sanitized evidence artifact') <
            workflow.indexOf('- name: Enforce capture gate')
    );
    assert.doesNotMatch(
        workflow.slice(
            workflow.indexOf('- name: Upload sanitized evidence artifact'),
            workflow.indexOf('- name: Enforce capture gate')
        ),
        /gate_status.*PASS/
    );
});

test('repository manifest는 미아7 최초 관찰 이름을 쓰고 expectedBylot을 입증 완료로 표현하지 않는다', async () => {
    const manifestPath = path.join(
        process.cwd(),
        'phase0-manifests/mia-seven-first-observation-20260724.json'
    );
    const repositoryManifest = parseLandAreaPhase0Manifest(
        JSON.parse(await readFile(manifestPath, 'utf8'))
    );
    assert.equal(repositoryManifest.samples.length, 2);
    assert.ok(
        repositoryManifest.samples.every((sample) =>
            sample.alias.startsWith('mia7-first-observation-')
        )
    );
    await assert.rejects(() =>
        access(
            path.join(
                process.cwd(),
                'phase0-manifests/mia-seven-dev-20260724.json'
            )
        )
    );
});

test('서울특별시 강북구 미아동 791-2315 전용 manifest는 기존 대표 표본과 exact PNU shape/digest를 고정한다', async () => {
    const manifestName =
        'mia-seven-791-2315-first-observation-20260725';
    const manifestPath = path.join(
        process.cwd(),
        `phase0-manifests/${manifestName}.json`
    );
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const expectedManifest = {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION,
        samples: [
            {
                alias: 'mia7-first-observation-a',
                expectedBylot: 'ZERO',
                pnu: '1130510100107912166',
            },
            {
                alias: 'mia7-first-observation-b',
                expectedBylot: 'POSITIVE',
                pnu: '1130510100107450049',
            },
            {
                alias: 'mia7-791-2315-first-observation',
                expectedBylot: 'ZERO',
                pnu: '1130510100107912315',
            },
        ],
    } as const;

    assert.deepEqual(JSON.parse(manifestRaw), expectedManifest);
    assert.deepEqual(
        parseLandAreaPhase0Manifest(JSON.parse(manifestRaw)),
        expectedManifest
    );
    assert.equal(
        createHash('sha256').update(manifestRaw).digest('hex'),
        '8b66ae291d5b9b0d3b75ebd723ad513cd93efe8578ab3056bca3ccc18250c8fa'
    );
    assert.equal(
        expectedManifest.samples.some(
            (sample) => sample.expectedBylot === 'ZERO'
        ),
        true
    );
    assert.equal(
        expectedManifest.samples.some(
            (sample) => sample.expectedBylot === 'POSITIVE'
        ),
        true
    );

    const workflow = await readFile(
        path.join(
            process.cwd(),
            '.github/workflows/phase0-land-area-capture.yml'
        ),
        'utf8'
    );
    assert.match(workflow, new RegExp(`^          - ${manifestName}$`, 'm'));
    assert.match(
        workflow,
        new RegExp(
            `${manifestName.replaceAll('-', '\\-')}\\)\\n` +
                `              manifest_path="phase0-manifests/${manifestName}\\.json"`
        )
    );
});

test('서울특별시 강북구 미아동 791-2280 base/attached manifest와 승인 workflow mapping을 exact 고정한다', async () => {
    const manifestName =
        'mia-seven-791-2280-base-attached-first-observation-20260725';
    const manifestPath = path.join(
        process.cwd(),
        `phase0-manifests/${manifestName}.json`
    );
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const expectedManifest = {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION,
        samples: [
            {
                alias: 'mia7-791-2166-zero-control',
                expectedBylot: 'ZERO',
                pnu: '1130510100107912166',
            },
            {
                alias: 'mia7-791-2280-base-attached',
                expectedBylot: 'POSITIVE',
                pnu: '1130510100107912280',
            },
        ],
    } as const;

    assert.deepEqual(JSON.parse(manifestRaw), expectedManifest);
    assert.deepEqual(
        parseLandAreaPhase0Manifest(JSON.parse(manifestRaw)),
        expectedManifest
    );
    assert.equal(
        createHash('sha256').update(manifestRaw).digest('hex'),
        '3e18837d97bcaa1d6677a43a9043d43ce80a00599074d36e3c36650b490271c6'
    );

    const workflow = await readFile(
        path.join(
            process.cwd(),
            '.github/workflows/phase0-land-area-capture.yml'
        ),
        'utf8'
    );
    assert.match(workflow, new RegExp(`^          - ${manifestName}$`, 'm'));
    assert.match(
        workflow,
        new RegExp(
            `${manifestName.replaceAll('-', '\\-')}\\)\\n` +
                `              manifest_path="phase0-manifests/${manifestName}\\.json"`
        )
    );
});

test('미아7 중복 없는 다세대 6개 Phase 0 manifest는 단일필지 가설과 양쪽 대조군을 exact 고정한다', async () => {
    const manifestName =
        'mia-seven-clean-multifamily-remaining-six-first-observation-20260725';
    const manifestPath = path.join(
        process.cwd(),
        `phase0-manifests/${manifestName}.json`
    );
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const expectedManifest = {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION_V2,
        samples: [
            {
                alias: 'mia7-zero-control',
                expectedBylot: 'ZERO',
                expectedFamily: 'LADFRL',
                pnu: '1130510100107912166',
            },
            {
                alias: 'mia7-positive-control',
                expectedBylot: 'POSITIVE',
                expectedFamily: 'LDAREG',
                pnu: '1130510100107450049',
            },
            ...[
                '1130510100107912172',
                '1130510100107912173',
                '1130510100107912188',
                '1130510100107912191',
                '1130510100107912315',
                '1130510100107912340',
            ].map((pnu) => ({
                alias: `mia7-mf-791-${pnu.slice(-4)}`,
                expectedBylot: 'ZERO' as const,
                expectedFamily: 'LDAREG' as const,
                pnu,
            })),
        ],
    } as const;

    assert.deepEqual(JSON.parse(manifestRaw), expectedManifest);
    assert.deepEqual(
        parseLandAreaPhase0Manifest(JSON.parse(manifestRaw)),
        expectedManifest
    );
    assert.equal(
        createHash('sha256').update(manifestRaw).digest('hex'),
        'a70c4c226cbcf9145c77647c55fab255a9764725a44336af15180a2beb088589'
    );

    const workflow = await readFile(
        path.join(
            process.cwd(),
            '.github/workflows/phase0-land-area-capture.yml'
        ),
        'utf8'
    );
    assert.match(workflow, new RegExp(`^          - ${manifestName}$`, 'm'));
    assert.match(
        workflow,
        new RegExp(
            `${manifestName.replaceAll('-', '\\-')}\\)\\n` +
                `              manifest_path="phase0-manifests/${manifestName}\\.json"`
        )
    );
});
