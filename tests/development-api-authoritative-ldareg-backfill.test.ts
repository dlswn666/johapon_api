import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST,
    DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH,
    DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH,
    DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST,
    DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION,
    DEVELOPMENT_API_LDAREG_TARGET_KEYS,
    DEVELOPMENT_API_LDAREG_TARGET_VERSION,
    computeDevelopmentApiLdaregExecutionTargetDigest,
    computeDevelopmentApiLdaregManifestDigest,
    parseDevelopmentApiLdaregTarget,
    parseDevelopmentApiLdaregTargetBundle,
    prepareDevelopmentApiLdaregBackfill,
    runDevelopmentApiLdaregBackfill,
    scanDevelopmentApiLdaregOfficialSource,
    selectDevelopmentApiLdaregTargetFromBundle,
    validateDevelopmentApiLdaregApprovalItems,
    validateDevelopmentApiLdaregApprovalRequest,
    validateDevelopmentApiLdaregArtifact,
    validateDevelopmentApiLdaregPrepareArtifact,
    type DevelopmentApiLdaregApplyReceipt,
    type DevelopmentApiLdaregDatabase,
    type DevelopmentApiLdaregInspectorTarget,
    type DevelopmentApiLdaregInvariantDigests,
    type DevelopmentApiLdaregScanAdapter,
    type DevelopmentApiLdaregSnapshot,
    type DevelopmentApiLdaregTarget,
    type DevelopmentApiLdaregTargetBundle,
    type DevelopmentApiLdaregTargetPins,
} from '../src/operations/development-api-authoritative-ldareg-backfill';
import {
    runDevelopmentApiLdaregCli,
    SupabaseDevelopmentApiLdaregDatabase,
    validateDevelopmentApiLdaregEnvironment,
} from '../src/cli/development-api-authoritative-ldareg-backfill';
import {
    runDevelopmentApiLdaregApprovalValidatorCli,
} from '../src/cli/development-api-authoritative-ldareg-backfill-approval-request-validate';
import {
    runDevelopmentApiLdaregValidatorCli,
} from '../src/cli/development-api-authoritative-ldareg-backfill-validate';
import {
    runDevelopmentApiLdaregTargetBundleSelector,
} from '../src/cli/development-api-authoritative-ldareg-target-bundle-select';
import {
    validateLdaregReplication,
} from '../src/services/land-area-sync/ldareg-branch';
import {
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
} from '../src/services/land-area-sync/provider-unit-shape-bridge';
import type {
    LandAreaSyncApplyLdaregItem,
} from '../src/types/land-area-sync-job.types';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../src/types/land-area-sync.types';

const UNION_ID = '11111111-1111-4111-8111-111111111111';
const BUILDING_ID = '22222222-2222-4222-8222-222222222222';
const BASE_PNU = '1111010100100000001';
const ATTACHED_PNU = '1111010100100000002';
const MANAGEMENT_PK = '10000000000001';
const RELEASE_SHA = 'a'.repeat(40);
const SYNC_JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT_PARENT_PK = '10000000000000';
const PROPERTIES = [
    {
        propertyUnitId: '30000000-0000-4000-8000-000000000001',
        expectedBuildingUnitId:
            '40000000-0000-4000-8000-000000000001',
        floor: '3',
        ho: '301',
        numerator: '30',
        childPk: '10000000000004',
        agbldgSn: '9003',
    },
    {
        propertyUnitId: '30000000-0000-4000-8000-000000000002',
        expectedBuildingUnitId:
            '40000000-0000-4000-8000-000000000002',
        floor: '4',
        ho: '401',
        numerator: '40',
        childPk: '10000000000005',
        agbldgSn: '9004',
    },
    {
        propertyUnitId: '30000000-0000-4000-8000-000000000003',
        expectedBuildingUnitId:
            '40000000-0000-4000-8000-000000000003',
        floor: '1',
        ho: '101',
        numerator: '10',
        childPk: '10000000000002',
        agbldgSn: '9001',
    },
    {
        propertyUnitId: '30000000-0000-4000-8000-000000000004',
        expectedBuildingUnitId:
            '40000000-0000-4000-8000-000000000004',
        floor: '2',
        ho: '201',
        numerator: '20',
        childPk: '10000000000003',
        agbldgSn: '9002',
    },
] as const;

const BRIDGE_PROPERTIES = [
    {
        ...PROPERTIES[0],
        floor: '3',
        ho: '301',
        exposFloor: '3',
        exposHo: '301',
        exposFloorType: '20',
        ldaregFloor: '지상3',
        ldaregHo: '301',
        bridgeKind: PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    },
    {
        ...PROPERTIES[1],
        floor: '1',
        ho: 'B1',
        exposFloor: '1',
        exposHo: 'B1',
        exposFloorType: '10',
        ldaregFloor: '지하',
        ldaregHo: '비1',
        bridgeKind: PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    },
    {
        ...PROPERTIES[2],
        floor: '2',
        ho: '2층',
        exposFloor: '2',
        exposHo: '2층',
        exposFloorType: '20',
        ldaregFloor: '2',
        ldaregHo: '0000',
        bridgeKind:
            PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    },
    {
        ...PROPERTIES[3],
        floor: '1',
        ho: '지층',
        exposFloor: '1',
        exposHo: '지층',
        exposFloorType: '10',
        ldaregFloor: '지',
        ldaregHo: '0000',
        bridgeKind:
            PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
    },
] as const;

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(
            value as Record<string, unknown>
        ).sort()) {
            if ((value as Record<string, unknown>)[key] !== undefined) {
                result[key] = canonicalize(
                    (value as Record<string, unknown>)[key]
                );
            }
        }
        return result;
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function schemaHash(rows: unknown[]): string {
    const tokens = new Set<string>();
    const visit = (value: unknown, path: string, depth: number): void => {
        if (depth > 12) {
            tokens.add(`${path}:DEPTH_LIMIT`);
            return;
        }
        if (value === null) {
            tokens.add(`${path}:null`);
            return;
        }
        if (Array.isArray(value)) {
            tokens.add(`${path}:array`);
            for (const item of value) {
                visit(item, `${path}[]`, depth + 1);
            }
            return;
        }
        if (typeof value === 'object') {
            tokens.add(`${path}:object`);
            for (const key of Object.keys(
                value as Record<string, unknown>
            ).sort()) {
                visit(
                    (value as Record<string, unknown>)[key],
                    `${path}.${key}`,
                    depth + 1
                );
            }
            return;
        }
        tokens.add(`${path}:${typeof value}`);
    };
    for (const row of rows) visit(row, '$', 0);
    return sha256([...tokens].sort().join('\n'));
}

function pnuFields(pnu: string) {
    return {
        sigunguCd: pnu.slice(0, 5),
        bjdongCd: pnu.slice(5, 10),
        platGbCd: pnu.slice(10, 11) === '2' ? '1' : '0',
        bun: pnu.slice(11, 15),
        ji: pnu.slice(15, 19),
    };
}

function titleRows(bylotCount = 1): BrTitleRow[] {
    return [
        {
            ...pnuFields(BASE_PNU),
            mgmBldrgstPk: MANAGEMENT_PK,
            mgmUpBldrgstPk: '',
            bylotCnt: bylotCount,
            regstrGbCd: '2',
            regstrGbCdNm: '집합',
            mainPurpsCd: '02000',
            mainPurpsCdNm: '공동주택',
            etcPurps: '다세대주택',
        },
    ];
}

function basisRows(bylotCount = 1): BrBasisOulnRow[] {
    return [
        {
            ...pnuFields(BASE_PNU),
            mgmBldrgstPk: MANAGEMENT_PK,
            mgmUpBldrgstPk: ROOT_PARENT_PK,
            bylotCnt: bylotCount,
        },
        ...PROPERTIES.map((property) => ({
            ...pnuFields(BASE_PNU),
            mgmBldrgstPk: property.childPk,
            mgmUpBldrgstPk: MANAGEMENT_PK,
            bylotCnt: bylotCount,
        })),
    ];
}

function attachedRows(): BrAtchJibunRow[] {
    return [
        {
            ...pnuFields(BASE_PNU),
            mgmBldrgstPk: MANAGEMENT_PK,
            atchSigunguCd: ATTACHED_PNU.slice(0, 5),
            atchBjdongCd: ATTACHED_PNU.slice(5, 10),
            atchPlatGbCd: '0',
            atchBun: ATTACHED_PNU.slice(11, 15),
            atchJi: ATTACHED_PNU.slice(15, 19),
        },
    ];
}

function exposRows(): BrExposRow[] {
    return PROPERTIES.map((property) => ({
        ...pnuFields(BASE_PNU),
        mgmBldrgstPk: property.childPk,
        mgmUpBldrgstPk: MANAGEMENT_PK,
        dongNm: '0000',
        flrNoNm: `${property.floor}층`,
        hoNm: property.ho,
        flrGbCd: '20',
    }));
}

function ladfrlRows(pnu: string): LadfrlRow[] {
    return [
        {
            pnu,
            lndpclAr: pnu === BASE_PNU ? '100' : '200',
            lndcgrCode: '08',
        },
    ];
}

function ldaregRows(
    pnu: string,
    denominator = '300'
): LdaregRow[] {
    return [
        ...PROPERTIES.map((property) => ({
            pnu,
            agbldgSn: property.agbldgSn,
            buldNm: '다세대주택',
            buldDongNm: '0000',
            buldFloorNm: property.floor,
            buldHoNm: property.ho,
            buldRoomNm: '0000',
            ldaQotaRate: `${property.numerator}/${denominator}`,
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            relateLdEmdLiCode: BASE_PNU.slice(0, 10),
            lastUpdtDt: '2099-01-01',
        })),
        {
            pnu,
            agbldgSn: '9999',
            buldNm: '다세대주택',
            buldDongNm: '0000',
            buldFloorNm: '0000',
            buldHoNm: '0000',
            buldRoomNm: '0000',
            ldaQotaRate: '',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            relateLdEmdLiCode: BASE_PNU.slice(0, 10),
            lastUpdtDt: '2099-01-01',
        },
    ];
}

function bridgeExposRows(): BrExposRow[] {
    return BRIDGE_PROPERTIES.map((property) => ({
        ...pnuFields(BASE_PNU),
        mgmBldrgstPk: property.childPk,
        mgmUpBldrgstPk: MANAGEMENT_PK,
        dongNm: '0000',
        flrNoNm: property.exposFloor,
        hoNm: property.exposHo,
        flrGbCd: property.exposFloorType,
    }));
}

function bridgeLdaregRows(
    pnu: string,
    denominator = '100'
): LdaregRow[] {
    return [
        ...BRIDGE_PROPERTIES.map((property) => ({
            pnu,
            // 실증된 building-wide serial fallback 조건을 synthetic 값으로 재현한다.
            agbldgSn: '9900',
            buldNm: '합성공동주택',
            buldDongNm: '0000',
            buldFloorNm: property.ldaregFloor,
            buldHoNm: property.ldaregHo,
            buldRoomNm: '0000',
            ldaQotaRate: `${property.numerator}/${denominator}`,
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            relateLdEmdLiCode: BASE_PNU.slice(0, 10),
            lastUpdtDt: '2099-01-01',
        })),
        {
            pnu,
            agbldgSn: '9900',
            buldNm: '합성공동주택',
            buldDongNm: '0000',
            buldFloorNm: '0000',
            buldHoNm: '0000',
            buldRoomNm: '0000',
            ldaQotaRate: '',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            relateLdEmdLiCode: BASE_PNU.slice(0, 10),
            lastUpdtDt: '2099-01-01',
        },
    ];
}

const PARTITION_UNITS = Array.from(
    { length: 11 },
    (_, index) => {
        const sequence = index + 1;
        return {
            propertyUnitId: `50000000-0000-4000-8000-${String(
                sequence
            ).padStart(12, '0')}`,
            expectedBuildingUnitId: `60000000-0000-4000-8000-${String(
                sequence
            ).padStart(12, '0')}`,
            floor: String(sequence),
            ho: `${sequence}01`,
            numerator: String(sequence),
            childPk: `100000000001${String(sequence).padStart(
                2,
                '0'
            )}`,
            providerShapeBridgeKind:
                sequence === 11
                    ? PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX
                    : null,
        };
    }
);

function partitionBasisRows(): BrBasisOulnRow[] {
    return [
        {
            ...pnuFields(BASE_PNU),
            mgmBldrgstPk: MANAGEMENT_PK,
            mgmUpBldrgstPk: ROOT_PARENT_PK,
            bylotCnt: 1,
        },
        ...PARTITION_UNITS.map((unit) => ({
            ...pnuFields(BASE_PNU),
            mgmBldrgstPk: unit.childPk,
            mgmUpBldrgstPk: MANAGEMENT_PK,
            bylotCnt: 1,
        })),
    ];
}

function partitionExposRows(): BrExposRow[] {
    return PARTITION_UNITS.map((unit, index) => ({
        ...pnuFields(BASE_PNU),
        mgmBldrgstPk: unit.childPk,
        mgmUpBldrgstPk: MANAGEMENT_PK,
        dongNm: index === 0 ? '000000' : '0000',
        flrNoNm: unit.floor,
        hoNm: unit.ho,
        flrGbCd: '20',
    }));
}

function partitionLdaregRows(pnu: string): LdaregRow[] {
    return [
        ...PARTITION_UNITS.map((unit, index) => ({
            pnu,
            agbldgSn: 'PARTITION-SERIAL',
            buldNm: '  Ａ동  ',
            buldDongNm: index === 0 ? '000000' : '0000',
            buldFloorNm:
                unit.providerShapeBridgeKind ===
                PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX
                    ? `지상${unit.floor}`
                    : unit.floor,
            buldHoNm: unit.ho,
            buldRoomNm: '0000',
            ldaQotaRate: `${unit.numerator}/300`,
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            relateLdEmdLiCode: BASE_PNU.slice(0, 10),
            lastUpdtDt: '2099-01-01',
        })),
        {
            pnu,
            agbldgSn: 'PARTITION-SERIAL',
            buldNm: '  Ａ동  ',
            buldDongNm: '0000',
            buldFloorNm: '0000',
            buldHoNm: '0000',
            buldRoomNm: '0000',
            ldaQotaRate: '',
            clsSeCode: '0',
            clsSeCodeNm: '현재',
            relateLdEmdLiCode: BASE_PNU.slice(0, 10),
            lastUpdtDt: '2099-01-01',
        },
    ];
}

function rawPartitionTarget(): Omit<
    DevelopmentApiLdaregTarget,
    'manifestDigest'
> {
    const replication = validateLdaregReplication(
        [BASE_PNU, ATTACHED_PNU],
        [
            {
                pnu: BASE_PNU,
                ldaregRows: partitionLdaregRows(BASE_PNU),
                exposRows: partitionExposRows(),
                basisRows: partitionBasisRows(),
            },
            {
                pnu: ATTACHED_PNU,
                ldaregRows: partitionLdaregRows(ATTACHED_PNU),
                exposRows: [],
                basisRows: [],
            },
        ],
        BASE_PNU
    );
    assert.equal(replication.ok, true);
    return {
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        basePnu: BASE_PNU,
        managementPk: MANAGEMENT_PK,
        canonicalBuildingId: BUILDING_ID,
        scopePnus: [BASE_PNU, ATTACHED_PNU],
        propertyTargets: PARTITION_UNITS.slice(0, 9).map(
            (unit) => ({
                propertyUnitId: unit.propertyUnitId,
                expectedBuildingUnitId:
                    unit.expectedBuildingUnitId,
                expectedPnu: BASE_PNU,
                canonicalDong: '',
                normalizedFloor: unit.floor,
                normalizedHo: unit.ho,
                providerShapeBridgeKind: null,
                expectedNumerator: unit.numerator,
            })
        ),
        ignoredOfficialUnits: PARTITION_UNITS.slice(9).map(
            (unit) => ({
                canonicalDong: '',
                canonicalFloor: unit.floor,
                canonicalHo: unit.ho,
                providerShapeBridgeKind:
                    unit.providerShapeBridgeKind,
                expectedNumerator: unit.numerator,
                reason: 'NO_ACTIVE_PROPERTY_UNIT' as const,
            })
        ),
        expectedIgnoredOfficialUnitCount: 2,
        landParcels: [
            { pnu: BASE_PNU, expectedArea: '100' },
            { pnu: ATTACHED_PNU, expectedArea: '200' },
        ],
        expectedDenominator: '300',
        expectedLdaregRowCount:
            partitionLdaregRows(BASE_PNU).length,
        expectedIgnoredPlaceholderCount: 1,
        phase0: {
            runId: '90000000004',
            artifactVersion:
                'land-area-phase0-capture-artifact@6',
            artifactSha256: '3'.repeat(64),
            schemaHash:
                DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST[1],
        },
        databaseDigests: {
            scopeDigest: '4'.repeat(64),
            propertyUnitDigest: '5'.repeat(64),
        },
        officialHashes: {
            managementPkHash: sha256(
                `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
            ),
            basePnuHash: sha256(`PNU\u0000${BASE_PNU}`),
            attachedPnuHash: sha256(
                `PNU\u0000${ATTACHED_PNU}`
            ),
            pairsDigest: sha256(
                stableStringify([
                    {
                        managementPkHash: sha256(
                            `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
                        ),
                        basePnuHash: sha256(
                            `PNU\u0000${BASE_PNU}`
                        ),
                        attachedPnuHash: sha256(
                            `PNU\u0000${ATTACHED_PNU}`
                        ),
                    },
                ])
            ),
            titleSchemaHash: schemaHash(titleRows()),
            basisSchemaHash: schemaHash(partitionBasisRows()),
            attachedSchemaHash: schemaHash(attachedRows()),
            exposSchemaHash: schemaHash(partitionExposRows()),
            ladfrlSchemaHash: schemaHash(
                ladfrlRows(BASE_PNU)
            ),
            ldaregSchemaHash: schemaHash(
                partitionLdaregRows(BASE_PNU)
            ),
            ldaregRowMultisetDigest: replication.ok
                ? replication.evidence.rowMultisetDigest
                : '',
        },
    };
}

function partitionTarget(): DevelopmentApiLdaregTarget {
    const raw = rawPartitionTarget();
    return parseDevelopmentApiLdaregTarget({
        ...raw,
        manifestDigest:
            computeDevelopmentApiLdaregManifestDigest(raw),
    });
}

function partitionAdapter(input?: {
    reverseRows?: boolean;
    mutateLdareg?: (
        pnu: string,
        rows: LdaregRow[]
    ) => LdaregRow[];
    mutateExpos?: (rows: BrExposRow[]) => BrExposRow[];
}): DevelopmentApiLdaregScanAdapter {
    const ordered = <T>(rows: T[]): T[] =>
        input?.reverseRows ? [...rows].reverse() : rows;
    return {
        scanTitle: async () => complete(titleRows()),
        scanAttached: async () => complete(attachedRows()),
        scanBasis: async (pnu) =>
            complete(
                pnu === BASE_PNU
                    ? ordered(partitionBasisRows())
                    : []
            ),
        scanExpos: async (pnu) =>
            complete(
                pnu === BASE_PNU
                    ? ordered(
                          input?.mutateExpos?.(
                              partitionExposRows()
                          ) ?? partitionExposRows()
                      )
                    : []
            ),
        scanLadfrl: async (pnu) =>
            complete(ladfrlRows(pnu)),
        scanLdareg: async (pnu) => {
            const rows = partitionLdaregRows(pnu);
            return complete(
                ordered(
                    input?.mutateLdareg?.(pnu, rows) ?? rows
                )
            );
        },
    };
}

function complete<T>(rows: T[]): StrictScan<T> {
    return rows.length === 0
        ? {
              state: 'COMPLETE_ZERO',
              rows: [],
              totalCount: 0,
              pagesFetched: 1,
          }
        : {
              state: 'COMPLETE',
              rows,
              totalCount: rows.length,
              pagesFetched: 1,
          };
}

interface AdapterOptions {
    mutateLdareg?: (pnu: string, rows: LdaregRow[]) => LdaregRow[];
    mutateExpos?: (pnu: string, rows: BrExposRow[]) => BrExposRow[];
    mutateAttached?: (
        rows: BrAtchJibunRow[]
    ) => BrAtchJibunRow[];
    singlePnu?: boolean;
    bylotCountOverride?: number;
    reverseRows?: boolean;
    failTitleOnceIfConcurrent?: boolean;
}

function adapter(options: AdapterOptions = {}) {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const wrap = async <T>(
        label: string,
        rows: T[]
    ): Promise<StrictScan<T>> => {
        calls.push(label);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        if (
            options.failTitleOnceIfConcurrent &&
            label.startsWith('title:') &&
            maxActive > 1
        ) {
            return {
                state: 'FAILED',
                issue: {
                    kind: 'TRANSPORT_ERROR',
                    endpoint: 'getBrTitleInfo',
                    message: 'transient',
                },
            };
        }
        return complete(
            options.reverseRows ? [...rows].reverse() : rows
        );
    };
    const singlePnu = options.singlePnu === true;
    const bylotCount =
        options.bylotCountOverride ?? (singlePnu ? 0 : 1);
    const implementation: DevelopmentApiLdaregScanAdapter = {
        scanTitle(pnu) {
            return wrap(`title:${pnu}`, titleRows(bylotCount));
        },
        scanBasis(pnu) {
            return wrap(
                `basis:${pnu}`,
                pnu === BASE_PNU
                    ? basisRows(bylotCount)
                    : []
            );
        },
        scanAttached(pnu) {
            const rows = singlePnu ? [] : attachedRows();
            return wrap(
                `attached:${pnu}`,
                options.mutateAttached?.(rows) ?? rows
            );
        },
        scanExpos(pnu) {
            const rows = pnu === BASE_PNU ? exposRows() : [];
            return wrap(
                `expos:${pnu}`,
                options.mutateExpos?.(pnu, rows) ?? rows
            );
        },
        scanLadfrl(pnu) {
            return wrap(`ladfrl:${pnu}`, ladfrlRows(pnu));
        },
        scanLdareg(pnu) {
            const rows = ldaregRows(
                pnu,
                singlePnu ? '100' : '300'
            );
            return wrap(
                `ldareg:${pnu}`,
                options.mutateLdareg?.(pnu, rows) ?? rows
            );
        },
    };
    return {
        implementation,
        calls,
        maxActive: () => maxActive,
    };
}

function rawTarget(): Omit<DevelopmentApiLdaregTarget, 'manifestDigest'> {
    const replication = validateLdaregReplication(
        [BASE_PNU, ATTACHED_PNU],
        [
            {
                pnu: BASE_PNU,
                ldaregRows: ldaregRows(BASE_PNU),
                exposRows: exposRows(),
                basisRows: basisRows(),
            },
            {
                pnu: ATTACHED_PNU,
                ldaregRows: ldaregRows(ATTACHED_PNU),
                exposRows: [],
                basisRows: [],
            },
        ],
        BASE_PNU
    );
    assert.equal(replication.ok, true);
    return {
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        basePnu: BASE_PNU,
        managementPk: MANAGEMENT_PK,
        canonicalBuildingId: BUILDING_ID,
        scopePnus: [BASE_PNU, ATTACHED_PNU],
        propertyTargets: PROPERTIES.map((property) => ({
            propertyUnitId: property.propertyUnitId,
            expectedBuildingUnitId:
                property.expectedBuildingUnitId,
            expectedPnu: BASE_PNU,
            canonicalDong: '',
            normalizedFloor: property.floor,
            normalizedHo: property.ho,
            providerShapeBridgeKind: null,
            expectedNumerator: property.numerator,
        })),
        ignoredOfficialUnits: [],
        landParcels: [
            { pnu: BASE_PNU, expectedArea: '100' },
            { pnu: ATTACHED_PNU, expectedArea: '200' },
        ],
        expectedDenominator: '300',
        expectedLdaregRowCount: 5,
        expectedIgnoredPlaceholderCount: 1,
        phase0: {
            runId: '90000000001',
            artifactVersion: 'land-area-phase0-capture-artifact@6',
            artifactSha256: 'c'.repeat(64),
            schemaHash:
                DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST[1],
        },
        databaseDigests: {
            scopeDigest: 'b'.repeat(64),
            propertyUnitDigest: 'e'.repeat(64),
        },
        officialHashes: {
            managementPkHash: sha256(
                `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
            ),
            basePnuHash: sha256(`PNU\u0000${BASE_PNU}`),
            attachedPnuHash: sha256(
                `PNU\u0000${ATTACHED_PNU}`
            ),
            pairsDigest: sha256(
                stableStringify([
                    {
                        managementPkHash: sha256(
                            `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
                        ),
                        basePnuHash: sha256(
                            `PNU\u0000${BASE_PNU}`
                        ),
                        attachedPnuHash: sha256(
                            `PNU\u0000${ATTACHED_PNU}`
                        ),
                    },
                ])
            ),
            titleSchemaHash: schemaHash(titleRows()),
            basisSchemaHash: schemaHash(basisRows()),
            attachedSchemaHash: schemaHash(attachedRows()),
            exposSchemaHash: schemaHash(exposRows()),
            ladfrlSchemaHash: schemaHash(
                ladfrlRows(BASE_PNU)
            ),
            ldaregSchemaHash: schemaHash(
                ldaregRows(BASE_PNU)
            ),
            ldaregRowMultisetDigest: replication.ok
                ? replication.evidence.rowMultisetDigest
                : '',
        },
    };
}

function rawSingleTarget(): Omit<
    DevelopmentApiLdaregTarget,
    'manifestDigest'
> {
    const replication = validateLdaregReplication(
        [BASE_PNU],
        [
            {
                pnu: BASE_PNU,
                ldaregRows: ldaregRows(BASE_PNU, '100'),
                exposRows: exposRows(),
                basisRows: basisRows(0),
            },
        ],
        BASE_PNU
    );
    assert.equal(replication.ok, true);
    return {
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        basePnu: BASE_PNU,
        managementPk: MANAGEMENT_PK,
        canonicalBuildingId: BUILDING_ID,
        scopePnus: [BASE_PNU],
        propertyTargets: PROPERTIES.map((property) => ({
            propertyUnitId: property.propertyUnitId,
            expectedBuildingUnitId:
                property.expectedBuildingUnitId,
            expectedPnu: BASE_PNU,
            canonicalDong: '',
            normalizedFloor: property.floor,
            normalizedHo: property.ho,
            providerShapeBridgeKind: null,
            expectedNumerator: property.numerator,
        })),
        ignoredOfficialUnits: [],
        landParcels: [{ pnu: BASE_PNU, expectedArea: '100' }],
        expectedDenominator: '100',
        expectedLdaregRowCount: 5,
        expectedIgnoredPlaceholderCount: 1,
        phase0: {
            runId: '90000000002',
            artifactVersion:
                'land-area-phase0-capture-artifact@6',
            artifactSha256: '9'.repeat(64),
            schemaHash:
                DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST[0],
        },
        databaseDigests: {
            scopeDigest: '7'.repeat(64),
            propertyUnitDigest: '8'.repeat(64),
        },
        officialHashes: {
            managementPkHash: sha256(
                `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
            ),
            basePnuHash: sha256(`PNU\u0000${BASE_PNU}`),
            attachedPnuHash:
                DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH,
            pairsDigest:
                DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST,
            titleSchemaHash: schemaHash(titleRows(0)),
            basisSchemaHash: schemaHash(basisRows(0)),
            attachedSchemaHash:
                DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH,
            exposSchemaHash: schemaHash(exposRows()),
            ladfrlSchemaHash: schemaHash(
                ladfrlRows(BASE_PNU)
            ),
            ldaregSchemaHash: schemaHash(
                ldaregRows(BASE_PNU, '100')
            ),
            ldaregRowMultisetDigest: replication.ok
                ? replication.evidence.rowMultisetDigest
                : '',
        },
    };
}

function rawBridgeSingleTarget(): Omit<
    DevelopmentApiLdaregTarget,
    'manifestDigest'
> {
    const bridgeExpos = bridgeExposRows();
    const bridgeLdareg = bridgeLdaregRows(BASE_PNU);
    const replication = validateLdaregReplication(
        [BASE_PNU],
        [
            {
                pnu: BASE_PNU,
                ldaregRows: bridgeLdareg,
                exposRows: bridgeExpos,
                basisRows: basisRows(0),
            },
        ],
        BASE_PNU
    );
    assert.equal(replication.ok, true);
    return {
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        basePnu: BASE_PNU,
        managementPk: MANAGEMENT_PK,
        canonicalBuildingId: BUILDING_ID,
        scopePnus: [BASE_PNU],
        propertyTargets: BRIDGE_PROPERTIES.map((property) => ({
            propertyUnitId: property.propertyUnitId,
            expectedBuildingUnitId:
                property.expectedBuildingUnitId,
            expectedPnu: BASE_PNU,
            canonicalDong: '',
            normalizedFloor: property.floor,
            normalizedHo: property.ho,
            providerShapeBridgeKind:
                property.bridgeKind,
            expectedNumerator: property.numerator,
        })),
        ignoredOfficialUnits: [],
        landParcels: [{ pnu: BASE_PNU, expectedArea: '100' }],
        expectedDenominator: '100',
        expectedLdaregRowCount: bridgeLdareg.length,
        expectedIgnoredPlaceholderCount: 1,
        phase0: {
            runId: '90000000003',
            artifactVersion:
                'land-area-phase0-capture-artifact@6',
            artifactSha256: '4'.repeat(64),
            schemaHash:
                DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST[1],
        },
        databaseDigests: {
            scopeDigest: '6'.repeat(64),
            propertyUnitDigest: '7'.repeat(64),
        },
        officialHashes: {
            managementPkHash: sha256(
                `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
            ),
            basePnuHash: sha256(`PNU\u0000${BASE_PNU}`),
            attachedPnuHash:
                DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH,
            pairsDigest:
                DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST,
            titleSchemaHash: schemaHash(titleRows(0)),
            basisSchemaHash: schemaHash(basisRows(0)),
            attachedSchemaHash:
                DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH,
            exposSchemaHash: schemaHash(bridgeExpos),
            ladfrlSchemaHash: schemaHash(
                ladfrlRows(BASE_PNU)
            ),
            ldaregSchemaHash: schemaHash(bridgeLdareg),
            ldaregRowMultisetDigest: replication.ok
                ? replication.evidence.rowMultisetDigest
                : '',
        },
    };
}

function target(): DevelopmentApiLdaregTarget {
    const raw = rawTarget();
    return parseDevelopmentApiLdaregTarget({
        ...raw,
        manifestDigest:
            computeDevelopmentApiLdaregManifestDigest(raw),
    });
}

function singleTarget(): DevelopmentApiLdaregTarget {
    const raw = rawSingleTarget();
    return parseDevelopmentApiLdaregTarget({
        ...raw,
        manifestDigest:
            computeDevelopmentApiLdaregManifestDigest(raw),
    });
}

function bridgeSingleTarget(): DevelopmentApiLdaregTarget {
    const raw = rawBridgeSingleTarget();
    return parseDevelopmentApiLdaregTarget({
        ...raw,
        manifestDigest:
            computeDevelopmentApiLdaregManifestDigest(raw),
    });
}

function discoveryTargets(
    targetValue: DevelopmentApiLdaregTarget = target()
): DevelopmentApiLdaregInspectorTarget[] {
    return targetValue.propertyTargets.map((property) => ({
        propertyUnitId: property.propertyUnitId,
        matchedBuildingUnitId:
            property.expectedBuildingUnitId,
        pnu: property.expectedPnu,
        normalizedDong: '',
        normalizedHo: property.normalizedHo,
    }));
}

const INVARIANTS: DevelopmentApiLdaregInvariantDigests = {
    nonTargetPropertyUnits: '1'.repeat(64),
    propertyOwnerships: '2'.repeat(64),
    buildings: '3'.repeat(64),
    buildingUnits: '4'.repeat(64),
    buildingLandLots: '5'.repeat(64),
    buildingExternalRefs: '6'.repeat(64),
    landLots: '7'.repeat(64),
    nonTargetPropertyUnitLandRights: '8'.repeat(64),
};

function zeroCounters() {
    return {
        sourceReads: 0 as const,
        resolverReads: 0 as const,
        blockerReads: 0 as const,
        fallbackReads: 0 as const,
        selectionReads: 0 as const,
    };
}

function proposalOf(items: LandAreaSyncApplyLdaregItem[]) {
    return {
        digest: sha256(stableStringify(items)),
        itemCount: items.length,
        componentCount: items.reduce(
            (sum, item) => sum + item.components.length,
            0
        ),
        source: 'LDAREG' as const,
        allCurrentPositive: true as const,
        proposedAreas: items.map((item) => ({
            propertyUnitId: item.propertyUnitId,
            matchedBuildingUnitId:
                item.components[0].matchedBuildingUnitId!,
            landArea: item.components[0].ratioNumerator,
            itemDigest: sha256(stableStringify(item)),
        })),
    };
}

function snapshot(input: {
    target: DevelopmentApiLdaregTarget;
    items: LandAreaSyncApplyLdaregItem[] | null;
    targetDigest: string | null;
    post?: boolean;
    syncJobId?: string | null;
    receiptDigest?: string | null;
}): DevelopmentApiLdaregSnapshot {
    const post = input.post === true;
    return {
        contractVersion:
            'development-api-authoritative-ldareg-backfill-inspector@1',
        databaseTarget: 'development',
        unionId: input.target.unionId,
        basePnu: input.target.basePnu,
        managementPk: input.target.managementPk,
        canonicalBuildingId: input.target.canonicalBuildingId,
        scope: {
            pnus: [...input.target.scopePnus],
            count: input.target.scopePnus.length,
            digest: input.target.databaseDigests.scopeDigest,
        },
        propertyTargets: {
            ids: input.target.propertyTargets.map(
                (property) => property.propertyUnitId
            ),
            count: input.target.propertyTargets.length,
            digest:
                input.target.databaseDigests.propertyUnitDigest,
            targets: discoveryTargets(input.target),
        },
        proposal: input.items === null ? null : proposalOf(input.items),
        currentState: {
            prestateTupleDigest: post
                ? 'b'.repeat(64)
                : 'c'.repeat(64),
            targetRightsDigest: post
                ? 'd'.repeat(64)
                : 'e'.repeat(64),
        },
        relationPrerequisite: {
            required: input.target.scopePnus.length === 2,
            count: input.target.scopePnus.length - 1,
            linkedCount: input.target.scopePnus.length - 1,
            satisfied: true,
        },
        canonicalInvariantDigests: INVARIANTS,
        approval: {
            rowCount: input.targetDigest === null ? 0 : 1,
            enabled: input.targetDigest !== null && !post,
            consumedAt: post
                ? '2026-07-25T01:00:00.000Z'
                : null,
            consumedSyncJobId: post
                ? input.syncJobId ?? null
                : null,
            targetDigest: input.targetDigest,
            expiresAt:
                input.targetDigest === null
                    ? null
                    : '2099-07-25T02:00:00.000Z',
        },
        replay: {
            syncJobId: post ? input.syncJobId ?? null : null,
            eligible: post,
            receiptDigest: post
                ? input.receiptDigest ?? null
                : null,
        },
        manualDecisionCounters: zeroCounters(),
    };
}

class FakeDatabase implements DevelopmentApiLdaregDatabase {
    inspectCalls = 0;
    applyCalls = 0;
    lastItems: LandAreaSyncApplyLdaregItem[] | null = null;
    readonly proposalDigest: string;
    readonly targetDigest: string;
    readonly receiptDigest = 'f'.repeat(64);

    constructor(
        private readonly targetValue: DevelopmentApiLdaregTarget,
        private readonly items: LandAreaSyncApplyLdaregItem[],
        evidenceDigest: string,
        private readonly recoverOnSecondAttempt = false
    ) {
        this.proposalDigest = proposalOf(items).digest;
        this.targetDigest =
            computeDevelopmentApiLdaregExecutionTargetDigest({
                target: targetValue,
                scopeDigest:
                    targetValue.databaseDigests.scopeDigest,
                propertyUnitDigest:
                    targetValue.databaseDigests.propertyUnitDigest,
                proposedValuesDigest: this.proposalDigest,
                prestateTupleDigest: 'c'.repeat(64),
                prestateTargetRightsDigest: 'e'.repeat(64),
                evidenceDigest,
                sourceReleaseSha: RELEASE_SHA,
            });
    }

    async inspect(input: {
        target: DevelopmentApiLdaregTarget;
        items: LandAreaSyncApplyLdaregItem[] | null;
        syncJobId: string | null;
    }): Promise<DevelopmentApiLdaregSnapshot> {
        this.inspectCalls += 1;
        this.lastItems = input.items;
        if (input.items === null) {
            return snapshot({
                target: this.targetValue,
                items: null,
                targetDigest: null,
            });
        }
        if (input.syncJobId !== null) {
            return snapshot({
                target: this.targetValue,
                items: input.items,
                targetDigest: this.targetDigest,
                post: true,
                syncJobId: input.syncJobId,
                receiptDigest: this.receiptDigest,
            });
        }
        return snapshot({
            target: this.targetValue,
            items: input.items,
            targetDigest: this.targetDigest,
        });
    }

    async apply(input: {
        target: DevelopmentApiLdaregTarget;
        items: LandAreaSyncApplyLdaregItem[];
        expectedScopeDigest: string;
        expectedPropertyUnitDigest: string;
        expectedProposedValuesDigest: string;
        expectedPrestateTupleDigest: string;
        expectedPrestateTargetRightsDigest: string;
        evidenceDigest: string;
        sourceReleaseSha: string;
        targetDigest: string;
        syncJobId: string;
    }): Promise<DevelopmentApiLdaregApplyReceipt> {
        this.applyCalls += 1;
        assert.equal(input.targetDigest, this.targetDigest);
        assert.equal(
            input.expectedProposedValuesDigest,
            this.proposalDigest
        );
        assert.deepEqual(input.items, this.items);
        if (
            this.recoverOnSecondAttempt &&
            this.applyCalls === 1
        ) {
            throw new Error('COMMIT_RESPONSE_LOST');
        }
        return {
            status:
                this.recoverOnSecondAttempt &&
                this.applyCalls > 1
                    ? 'REUSED'
                    : 'APPLIED',
            syncJobId: input.syncJobId,
            targetDigest: input.targetDigest,
            scopeDigest: input.expectedScopeDigest,
            propertyUnitDigest:
                input.expectedPropertyUnitDigest,
            proposedValuesDigest:
                input.expectedProposedValuesDigest,
            prestateTupleDigest:
                input.expectedPrestateTupleDigest,
            prestateTargetRightsDigest:
                input.expectedPrestateTargetRightsDigest,
            poststateTupleDigest: 'b'.repeat(64),
            poststateTargetRightsDigest: 'd'.repeat(64),
            rightsRowCount:
                this.targetValue.propertyTargets.length *
                this.targetValue.scopePnus.length,
            updatedPropertyUnitCount:
                this.targetValue.propertyTargets.length,
            source: 'LDAREG',
            manualDecisionCounters: zeroCounters(),
            invariantDigests: {
                before: INVARIANTS,
                after: INVARIANTS,
                stable: true,
            },
            replay: {
                eligible: true,
                recovered:
                    this.recoverOnSecondAttempt &&
                    this.applyCalls > 1,
                receiptDigest: this.receiptDigest,
            },
        };
    }
}

async function officialFixture(targetValue = target()) {
    const fixture = adapter({
        failTitleOnceIfConcurrent: true,
        singlePnu: targetValue.scopePnus.length === 1,
    });
    const discovered = new Map(
        discoveryTargets(targetValue).map((property) => [
            property.propertyUnitId,
            property,
        ])
    );
    const result = await scanDevelopmentApiLdaregOfficialSource({
        target: targetValue,
        discoveredById: discovered,
        adapter: fixture.implementation,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
    });
    return { result, fixture };
}

async function bridgeOfficialFixture(input?: {
    reverseRows?: boolean;
    mutateLdareg?: (
        pnu: string,
        rows: LdaregRow[]
    ) => LdaregRow[];
    mutateExpos?: (
        pnu: string,
        rows: BrExposRow[]
    ) => BrExposRow[];
}) {
    const targetValue = bridgeSingleTarget();
    const fixture = adapter({
        singlePnu: true,
        reverseRows: input?.reverseRows,
        mutateExpos: (pnu) =>
            input?.mutateExpos?.(pnu, bridgeExposRows()) ??
            bridgeExposRows(),
        mutateLdareg: (pnu) =>
            input?.mutateLdareg?.(
                pnu,
                bridgeLdaregRows(pnu)
            ) ??
            bridgeLdaregRows(pnu),
    });
    const discovered = new Map(
        discoveryTargets(targetValue).map((property) => [
            property.propertyUnitId,
            property,
        ])
    );
    const result = await scanDevelopmentApiLdaregOfficialSource({
        target: targetValue,
        discoveredById: discovered,
        adapter: fixture.implementation,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
    });
    return { targetValue, result, fixture };
}

async function partitionOfficialFixture(input?: {
    targetValue?: DevelopmentApiLdaregTarget;
    reverseRows?: boolean;
    mutateLdareg?: (
        pnu: string,
        rows: LdaregRow[]
    ) => LdaregRow[];
    mutateExpos?: (rows: BrExposRow[]) => BrExposRow[];
}) {
    const targetValue = input?.targetValue ?? partitionTarget();
    const discovered = new Map(
        discoveryTargets(targetValue).map((property) => [
            property.propertyUnitId,
            property,
        ])
    );
    const result = await scanDevelopmentApiLdaregOfficialSource({
        target: targetValue,
        discoveredById: discovered,
        adapter: partitionAdapter(input),
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
    });
    return { targetValue, result };
}

function targetBundleFixture(): {
    bundle: DevelopmentApiLdaregTargetBundle;
    pins: DevelopmentApiLdaregTargetPins;
} {
    const entries =
        DEVELOPMENT_API_LDAREG_TARGET_KEYS.map((key, index) => {
            if (key === 'ldareg-target-07') {
                return { key, target: target() };
            }
            const raw = {
                ...rawSingleTarget(),
                phase0: {
                    ...rawSingleTarget().phase0,
                    runId: String(90000000100 + index),
                },
            };
            return {
                key,
                target: parseDevelopmentApiLdaregTarget({
                    ...raw,
                    manifestDigest:
                        computeDevelopmentApiLdaregManifestDigest(
                            raw
                        ),
                }),
            };
        });
    const pins = Object.fromEntries(
        entries.map((entry) => [
            entry.key,
            {
                manifestDigest: entry.target.manifestDigest,
                scopePnuCount: entry.target.scopePnus
                    .length as 1 | 2,
                bylotCount: (entry.target.scopePnus.length -
                    1) as 0 | 1,
                provisioned: true,
            },
        ])
    ) as unknown as DevelopmentApiLdaregTargetPins;
    return {
        bundle: {
            version:
                DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION,
            targets: entries,
        },
        pins,
    };
}

test('synthetic target fixture는 exact UUID, 두 PNU, 분자/분모와 digest를 고정한다', () => {
    const parsed = target();
    assert.equal(parsed.propertyTargets.length, 4);
    assert.deepEqual(
        parsed.propertyTargets.map(
            (property) => property.expectedNumerator
        ),
        ['30', '40', '10', '20']
    );
    assert.equal(parsed.expectedDenominator, '300');
    assert.throws(() =>
        parseDevelopmentApiLdaregTarget({
            ...parsed,
            propertyTargets: parsed.propertyTargets.map(
                (property, index) =>
                    index === 0
                        ? {
                              ...property,
                              expectedNumerator: '8.26',
                          }
                        : property
            ),
        })
    );
});

test('target parser는 기존 linked 계약을 보존하고 single은 zero-pair sentinel만 허용한다', () => {
    const linked = target();
    const single = singleTarget();
    assert.equal(
        linked.version,
        DEVELOPMENT_API_LDAREG_TARGET_VERSION
    );
    assert.equal(linked.scopePnus.length, 2);
    assert.equal(single.scopePnus.length, 1);
    assert.deepEqual(single.ignoredOfficialUnits, []);
    assert.equal(
        single.phase0.schemaHash,
        DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST[0]
    );
    assert.equal(
        single.officialHashes.attachedPnuHash,
        DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH
    );
    assert.equal(
        single.officialHashes.pairsDigest,
        DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST
    );
    assert.equal(
        single.officialHashes.attachedSchemaHash,
        DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH
    );

    const mismatched = {
        ...rawSingleTarget(),
        officialHashes: {
            ...rawSingleTarget().officialHashes,
            attachedPnuHash: sha256(`PNU\u0000${ATTACHED_PNU}`),
        },
    };
    assert.throws(
        () =>
            parseDevelopmentApiLdaregTarget({
                ...mismatched,
                manifestDigest:
                    computeDevelopmentApiLdaregManifestDigest(
                        mismatched
                    ),
            }),
        /TARGET_OFFICIAL_HASHES_SCOPE_MISMATCH/
    );
    const legacyVersion = {
        ...rawSingleTarget(),
        version:
            'development-api-authoritative-ldareg-backfill-target@1',
    };
    assert.throws(() =>
        parseDevelopmentApiLdaregTarget({
            ...legacyVersion,
            manifestDigest: sha256(
                stableStringify(legacyVersion)
            ),
        })
    );
});

test('single-PNU는 COMPLETE_ZERO attached와 bylot=0으로 prepare/apply를 끝까지 통과한다', async () => {
    const targetValue = singleTarget();
    const { result, fixture } =
        await officialFixture(targetValue);
    assert.deepEqual(fixture.calls, [
        `title:${BASE_PNU}`,
        `attached:${BASE_PNU}`,
        `basis:${BASE_PNU}`,
        `expos:${BASE_PNU}`,
        `ladfrl:${BASE_PNU}`,
        `ldareg:${BASE_PNU}`,
    ]);
    assert.equal(result.evidence.totalPairs, 0);
    assert.equal(result.evidence.bylotCount, 0);
    assert.equal(result.evidence.componentCount, 4);
    assert.ok(
        result.items.every(
            (item) =>
                item.components.length === 1 &&
                item.expectedTargetPnus.length === 1
        )
    );

    const prepareDatabase = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const prepared = await prepareDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter({ singlePnu: true }).implementation,
        database: prepareDatabase,
        now: () => new Date('2026-07-25T02:00:00.000Z'),
    });
    assert.equal(prepared.artifact.gate.status, 'PASS');
    assert.deepEqual(prepared.artifact.relationPrerequisite, {
        required: false,
        satisfied: true,
        count: 0,
        linkedCount: 0,
    });
    validateDevelopmentApiLdaregPrepareArtifact({
        target: targetValue,
        expectedSourceReleaseSha: RELEASE_SHA,
        artifact: prepared.artifact,
    });

    const applyDatabase = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const applied = await runDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter({ singlePnu: true }).implementation,
        database: applyDatabase,
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(applied.gate.status, 'PASS');
    assert.equal(applied.applyCall.rightsRowCount, 4);
    assert.deepEqual(applied.relationPrerequisite, {
        required: false,
        beforeSatisfied: true,
        afterSatisfied: true,
        beforeCount: 0,
        afterCount: 0,
        beforeLinkedCount: 0,
        afterLinkedCount: 0,
    });
    validateDevelopmentApiLdaregArtifact({
        target: targetValue,
        expectedSourceReleaseSha: RELEASE_SHA,
        artifact: applied,
    });
});

test('single-PNU scanner는 non-zero attached와 bylot=1을 각각 fail-closed한다', async () => {
    const targetValue = singleTarget();
    const discovered = new Map(
        discoveryTargets(targetValue).map((property) => [
            property.propertyUnitId,
            property,
        ])
    );
    await assert.rejects(
        scanDevelopmentApiLdaregOfficialSource({
            target: targetValue,
            discoveredById: discovered,
            adapter: adapter({
                singlePnu: true,
                mutateAttached: () => attachedRows(),
            }).implementation,
            buildingHubServiceKey: 'hub-key',
            vworldKey: 'vworld-key',
            vworldDomain: 'www.tonghari.kr',
        }),
        /OFFICIAL_ATTACHED_PAIR_INVALID/
    );
    await assert.rejects(
        scanDevelopmentApiLdaregOfficialSource({
            target: targetValue,
            discoveredById: discovered,
            adapter: adapter({
                singlePnu: true,
                bylotCountOverride: 1,
            }).implementation,
            buildingHubServiceKey: 'hub-key',
            vworldKey: 'vworld-key',
            vworldDomain: 'www.tonghari.kr',
        }),
        /OFFICIAL_BUILDING_ROOT_INVALID/
    );
});

test('official evidence와 items는 single/linked 모두 provider row 순서와 무관하다', async () => {
    for (const targetValue of [singleTarget(), target()]) {
        const discovered = new Map(
            discoveryTargets(targetValue).map((property) => [
                property.propertyUnitId,
                property,
            ])
        );
        const common = {
            target: targetValue,
            discoveredById: discovered,
            buildingHubServiceKey: 'hub-key',
            vworldKey: 'vworld-key',
            vworldDomain: 'www.tonghari.kr',
        };
        const normal =
            await scanDevelopmentApiLdaregOfficialSource({
                ...common,
                adapter: adapter({
                    singlePnu:
                        targetValue.scopePnus.length === 1,
                }).implementation,
            });
        const reversed =
            await scanDevelopmentApiLdaregOfficialSource({
                ...common,
                adapter: adapter({
                    singlePnu:
                        targetValue.scopePnus.length === 1,
                    reverseRows: true,
                }).implementation,
            });
        assert.deepEqual(reversed, normal);
    }
});

test('private bundle은 정확한 7 opaque key를 순서 독립 파싱하고 선택 key의 digest/shape pin만 허용한다', () => {
    const { bundle, pins } = targetBundleFixture();
    const parsed = parseDevelopmentApiLdaregTargetBundle({
        ...bundle,
        targets: [...bundle.targets].reverse(),
    });
    assert.deepEqual(
        parsed.targets.map((entry) => entry.key),
        [...DEVELOPMENT_API_LDAREG_TARGET_KEYS]
    );
    assert.equal(
        selectDevelopmentApiLdaregTargetFromBundle({
            bundle,
            targetKey: 'ldareg-target-01',
            pins,
        }).scopePnus.length,
        1
    );
    assert.equal(
        selectDevelopmentApiLdaregTargetFromBundle({
            bundle,
            targetKey: 'ldareg-target-07',
            pins,
        }).scopePnus.length,
        2
    );

    assert.throws(
        () =>
            parseDevelopmentApiLdaregTargetBundle({
                ...bundle,
                targets: bundle.targets.slice(1),
            }),
        /TARGET_BUNDLE_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentApiLdaregTargetBundle({
                ...bundle,
                targets: [
                    ...bundle.targets,
                    bundle.targets[0],
                ],
            }),
        /TARGET_BUNDLE_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentApiLdaregTargetBundle({
                ...bundle,
                targets: bundle.targets.map((entry, index) =>
                    index === 1
                        ? {
                              ...entry,
                              target: bundle.targets[0].target,
                          }
                        : entry
                ),
            }),
        /TARGET_BUNDLE_INVALID/
    );

    const mismatchedPins = {
        ...pins,
        'ldareg-target-01': {
            ...pins['ldareg-target-01'],
            manifestDigest: 'f'.repeat(64),
        },
    };
    assert.throws(
        () =>
            selectDevelopmentApiLdaregTargetFromBundle({
                bundle,
                targetKey: 'ldareg-target-01',
                pins: mismatchedPins,
            }),
        /TARGET_BUNDLE_PIN_MISMATCH/
    );
    const unprovisionedPins = {
        ...pins,
        'ldareg-target-01': {
            ...pins['ldareg-target-01'],
            provisioned: false,
        },
    };
    assert.throws(
        () =>
            selectDevelopmentApiLdaregTargetFromBundle({
                bundle,
                targetKey: 'ldareg-target-01',
                pins: unprovisionedPins,
            }),
        /TARGET_BUNDLE_PIN_MISMATCH/
    );
});

test('bundle selector CLI는 0600 input에서 한 target만 새 0600 파일로 추출하고 고정 문구만 출력한다', async () => {
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ldareg-bundle-selector-')
    );
    const privateRoot = path.join(
        temporary,
        '.development-api-authoritative-ldareg-backfill'
    );
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const { bundle, pins } = targetBundleFixture();
    const bundlePath = path.join(privateRoot, 'bundle.json');
    const outputPath = path.join(privateRoot, 'target.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle), {
        mode: 0o600,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
        assert.equal(
            await runDevelopmentApiLdaregTargetBundleSelector(
                [
                    '--bundle',
                    '.development-api-authoritative-ldareg-backfill/bundle.json',
                    '--target-key',
                    'ldareg-target-07',
                    '--out',
                    '.development-api-authoritative-ldareg-backfill/target.json',
                ],
                {
                    cwd: temporary,
                    pins,
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            0
        );
        assert.deepEqual(stdout, [
            'Development API-authoritative LDAREG target selected.',
        ]);
        assert.deepEqual(stderr, []);
        assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(outputPath, 'utf8')),
            target()
        );
        assert.equal(
            stdout.join('\n').includes(BASE_PNU),
            false
        );
        const externalPath = path.join(
            temporary,
            'external-target.json'
        );
        const symlinkPath = path.join(
            privateRoot,
            'symlink-target.json'
        );
        fs.writeFileSync(externalPath, 'unchanged\n', {
            mode: 0o600,
        });
        fs.symlinkSync(externalPath, symlinkPath);
        assert.equal(
            await runDevelopmentApiLdaregTargetBundleSelector(
                [
                    '--bundle',
                    '.development-api-authoritative-ldareg-backfill/bundle.json',
                    '--target-key',
                    'ldareg-target-07',
                    '--out',
                    '.development-api-authoritative-ldareg-backfill/symlink-target.json',
                ],
                {
                    cwd: temporary,
                    pins,
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            2
        );
        assert.equal(
            fs.readFileSync(externalPath, 'utf8'),
            'unchanged\n'
        );
        const externalBundlePath = path.join(
            temporary,
            'external-bundle.json'
        );
        const bundleSymlinkPath = path.join(
            privateRoot,
            'bundle-symlink.json'
        );
        fs.writeFileSync(
            externalBundlePath,
            JSON.stringify(bundle),
            { mode: 0o600 }
        );
        fs.symlinkSync(externalBundlePath, bundleSymlinkPath);
        assert.equal(
            await runDevelopmentApiLdaregTargetBundleSelector(
                [
                    '--bundle',
                    '.development-api-authoritative-ldareg-backfill/bundle-symlink.json',
                    '--target-key',
                    'ldareg-target-07',
                    '--out',
                    '.development-api-authoritative-ldareg-backfill/symlink-input-output.json',
                ],
                {
                    cwd: temporary,
                    pins,
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            2
        );
        assert.equal(
            fs.existsSync(
                path.join(
                    privateRoot,
                    'symlink-input-output.json'
                )
            ),
            false
        );
        assert.equal(
            await runDevelopmentApiLdaregTargetBundleSelector(
                [
                    '--bundle',
                    '.development-api-authoritative-ldareg-backfill/bundle.json',
                    '--target-key',
                    'ldareg-target-07',
                    '--out',
                    '.development-api-authoritative-ldareg-backfill/target.json',
                ],
                {
                    cwd: temporary,
                    pins,
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            ),
            2
        );
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('execution target digest는 PostgreSQL과 공유하는 terminal-newline 없는 explicit canonical이다', () => {
    const digest = computeDevelopmentApiLdaregExecutionTargetDigest({
        target: {
            manifestDigest: '1'.repeat(64),
            phase0: {
                runId: '90000000001',
                artifactVersion:
                    'land-area-phase0-capture-artifact@6',
                artifactSha256: '6'.repeat(64),
                schemaHash: '7'.repeat(64),
            },
        } as DevelopmentApiLdaregTarget,
        scopeDigest: '2'.repeat(64),
        propertyUnitDigest: '3'.repeat(64),
        proposedValuesDigest: '4'.repeat(64),
        prestateTupleDigest: '5'.repeat(64),
        prestateTargetRightsDigest: 'a'.repeat(64),
        evidenceDigest: '8'.repeat(64),
        sourceReleaseSha: '9'.repeat(40),
    });
    assert.equal(
        digest,
        'a61e68ab48bb3546033d775b8d2e52468f0b5616fc5ffe3d2a440431087ae933'
    );
});

test('official source는 대표/부속 모든 endpoint를 직렬 호출하고 정확한 8 CURRENT component만 만든다', async () => {
    const targetValue = target();
    const { result, fixture } =
        await officialFixture(targetValue);
    assert.equal(fixture.maxActive(), 1);
    assert.deepEqual(fixture.calls, [
        `title:${BASE_PNU}`,
        `attached:${BASE_PNU}`,
        `basis:${BASE_PNU}`,
        `expos:${BASE_PNU}`,
        `ladfrl:${BASE_PNU}`,
        `ldareg:${BASE_PNU}`,
        `basis:${ATTACHED_PNU}`,
        `expos:${ATTACHED_PNU}`,
        `ladfrl:${ATTACHED_PNU}`,
        `ldareg:${ATTACHED_PNU}`,
    ]);
    assert.equal(result.items.length, 4);
    assert.equal(
        result.items.flatMap((item) => item.components).length,
        8
    );
    for (const item of result.items) {
        const targetProperty =
            targetValue.propertyTargets.find(
                (property) =>
                    property.propertyUnitId ===
                    item.propertyUnitId
            )!;
        assert.deepEqual(item.expectedTargetPnus, [
            BASE_PNU,
            ATTACHED_PNU,
        ]);
        assert.equal(
            new Set(
                item.components.map(
                    (component) => component.sourceIdentity
                )
            ).size,
            1
        );
        assert.match(
            item.components[0].sourceIdentity,
            /^primary:v2:[0-9a-f]{64}$/
        );
        assert.ok(
            item.components.every(
                (component) =>
                    component.sourceState === 'CURRENT' &&
                    component.matchMethod ===
                        'BUILDING_UNIT_ID' &&
                    component.matchedBuildingUnitId ===
                        targetProperty.expectedBuildingUnitId &&
                    component.sourceRecord.pnu ===
                        component.targetPnu &&
                    component.ratioRaw ===
                        `${targetProperty.expectedNumerator}/300` &&
                    component.ratioNumerator ===
                        targetProperty.expectedNumerator &&
                    component.sourceRecord.clsSeCode === '0' &&
                    component.sourceRecord.clsSeCodeNm ===
                        '현재' &&
                    component.sourceRecord.ldaQotaRate ===
                        `${targetProperty.expectedNumerator}/300` &&
                    component.ratioDenominator === '300' &&
                    component.retiredReason === null
            )
        );
    }
});

test('provider exact bridge는 네 가지 실측 shape를 EXPOS canonical tuple에만 1:1로 결합하고 fallback identity를 보존한다', async () => {
    const { targetValue, result } =
        await bridgeOfficialFixture();
    assert.equal(result.items.length, BRIDGE_PROPERTIES.length);
    assert.equal(
        new Set(
            result.items.map(
                (item) => item.components[0].sourceIdentity
            )
        ).size,
        BRIDGE_PROPERTIES.length
    );
    assert.ok(
        result.items.every((item) =>
            /^fallback:v2:[0-9a-f]{64}$/.test(
                item.components[0].sourceIdentity
            )
        )
    );
    assert.deepEqual(
        [
            ...new Set(
                result.items.map(
                    (item) =>
                        item.components[0].sourceAgbldgSn
                )
            ),
        ],
        ['9900']
    );
    for (const item of result.items) {
        const propertyIndex =
            targetValue.propertyTargets.findIndex(
                (property) =>
                    property.propertyUnitId ===
                    item.propertyUnitId
            );
        const targetProperty =
            targetValue.propertyTargets[propertyIndex];
        const expectedShape = BRIDGE_PROPERTIES[propertyIndex];
        assert.equal(item.components.length, 1);
        assert.deepEqual(
            {
                canonicalDong:
                    item.components[0].canonicalDong,
                canonicalFloor:
                    item.components[0].canonicalFloor,
                canonicalHo:
                    item.components[0].canonicalHo,
                providerShapeBridgeKind:
                    item.components[0]
                        .providerShapeBridgeKind,
            },
            {
                canonicalDong: '',
                canonicalFloor:
                    targetProperty.normalizedFloor,
                canonicalHo: targetProperty.normalizedHo,
                providerShapeBridgeKind:
                    expectedShape.bridgeKind,
            }
        );
    }
    assert.equal(
        validateDevelopmentApiLdaregApprovalItems({
            target: targetValue,
            items: result.items,
        }),
        result.items
    );
});

test('provider exact bridge 결과는 row order와 무관하고 canonical/helper/raw 변조를 fail-closed한다', async () => {
    const canonical = await bridgeOfficialFixture();
    const reversed = await bridgeOfficialFixture({
        reverseRows: true,
    });
    assert.deepEqual(reversed.result.items, canonical.result.items);
    assert.equal(
        reversed.result.evidence.evidenceDigest,
        canonical.result.evidence.evidenceDigest
    );

    const canonicalTamper = structuredClone(
        canonical.result.items
    );
    canonicalTamper[0].components[0].canonicalFloor = '4';
    assert.throws(() =>
        validateDevelopmentApiLdaregApprovalItems({
            target: canonical.targetValue,
            items: canonicalTamper,
        })
    );

    const bridgeKindTamper = structuredClone(
        canonical.result.items
    );
    bridgeKindTamper[0].components[0].providerShapeBridgeKind =
        null;
    assert.throws(() =>
        validateDevelopmentApiLdaregApprovalItems({
            target: canonical.targetValue,
            items: bridgeKindTamper,
        })
    );

    const rawShapeTamper = structuredClone(
        canonical.result.items
    );
    rawShapeTamper[0].components[0].sourceRecord.buldFloorNm =
        '지상03';
    assert.throws(() =>
        validateDevelopmentApiLdaregApprovalItems({
            target: canonical.targetValue,
            items: rawShapeTamper,
        })
    );
});

test('2315형 official 11건은 property 9 + ignored 2로 exact partition하고 placeholder를 별도 검증한다', async () => {
    const normal = await partitionOfficialFixture();
    const reversed = await partitionOfficialFixture({
        reverseRows: true,
    });
    assert.deepEqual(reversed.result, normal.result);
    assert.equal(normal.result.evidence.exposUnitCount, 11);
    assert.equal(
        normal.result.evidence.currentTargetCount,
        9
    );
    assert.equal(
        normal.result.evidence.ignoredOfficialUnitCount,
        2
    );
    assert.equal(
        normal.result.evidence.ignoredPlaceholderCount,
        1
    );
    assert.equal(normal.result.items.length, 9);
    assert.equal(
        normal.result.items.flatMap((item) => item.components)
            .length,
        18
    );
    const baseComponents = normal.result.items.map(
        (item) => item.components[0]
    );
    assert.equal(
        new Set(
            baseComponents.map(
                (component) => component.sourceIdentity
            )
        ).size,
        9
    );
    assert.equal(
        baseComponents.every((component) =>
            component.sourceIdentity.startsWith(
                'fallback:v2:'
            )
        ),
        true
    );
    assert.equal(
        new Set(
            baseComponents.map(
                (component) => component.sourceAgbldgSn
            )
        ).size,
        1
    );
    assert.equal(
        baseComponents.every(
            (component) => component.canonicalDong === ''
        ),
        true
    );
    assert.equal(
        baseComponents.some(
            (component) =>
                component.sourceRecord.buldDongNm ===
                '000000'
        ),
        true
    );
    assert.equal(
        baseComponents.some(
            (component) =>
                component.sourceRecord.buldDongNm === '0000'
        ),
        true
    );
    assert.equal(
        baseComponents.every(
            (component) =>
                component.sourceRecord.buldNm === '  Ａ동  '
        ),
        true
    );
    const evidenceJson = JSON.stringify(normal.result.evidence);
    assert.equal(
        evidenceJson.includes('ignoredOfficialUnits'),
        false
    );
    assert.equal(
        evidenceJson.includes('NO_ACTIVE_PROPERTY_UNIT'),
        false
    );

    const prepareDatabase = new FakeDatabase(
        normal.targetValue,
        normal.result.items,
        normal.result.evidence.evidenceDigest
    );
    const prepared =
        await prepareDevelopmentApiLdaregBackfill({
            target: normal.targetValue,
            sourceReleaseSha: RELEASE_SHA,
            database: prepareDatabase,
            adapter: partitionAdapter(),
            buildingHubServiceKey: 'hub-key',
            vworldKey: 'vworld-key',
            vworldDomain: 'www.tonghari.kr',
            now: () =>
                new Date('2026-07-25T01:00:00.000Z'),
        });
    assert.equal(prepared.artifact.gate.status, 'PASS');
    assert.equal(
        prepared.approvalRequest?.ownerApproval.args.p_items
            .length,
        9
    );
    assert.deepEqual(
        prepared.approvalRequest?.ownerApproval.args.p_property_unit_ids,
        normal.targetValue.propertyTargets.map(
            (property) => property.propertyUnitId
        )
    );
    assert.equal(
        JSON.stringify(prepared.approvalRequest).includes(
            'NO_ACTIVE_PROPERTY_UNIT'
        ),
        false
    );

    const applyDatabase = new FakeDatabase(
        normal.targetValue,
        normal.result.items,
        normal.result.evidence.evidenceDigest
    );
    const artifact = await runDevelopmentApiLdaregBackfill({
        target: normal.targetValue,
        sourceReleaseSha: RELEASE_SHA,
        database: applyDatabase,
        adapter: partitionAdapter(),
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(
        artifact.officialScan?.ignoredOfficialUnitCount,
        2
    );
    assert.equal(
        JSON.stringify(artifact).includes(
            'NO_ACTIVE_PROPERTY_UNIT'
        ),
        false
    );
    validateDevelopmentApiLdaregArtifact({
        target: normal.targetValue,
        expectedSourceReleaseSha: RELEASE_SHA,
        artifact,
    });
    assert.throws(() =>
        validateDevelopmentApiLdaregArtifact({
            target: normal.targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact: {
                ...artifact,
                ignoredOfficialUnits:
                    normal.targetValue.ignoredOfficialUnits,
            },
        })
    );
});

test('target@2 ignoredOfficialUnits parser는 exact shape, canonical order, disjoint와 두 Phase0 schema만 허용한다', () => {
    const parseRaw = (
        raw: Omit<DevelopmentApiLdaregTarget, 'manifestDigest'>
    ) =>
        parseDevelopmentApiLdaregTarget({
            ...raw,
            manifestDigest:
                computeDevelopmentApiLdaregManifestDigest(raw),
        });
    const base = rawPartitionTarget();
    assert.equal(parseRaw(base).ignoredOfficialUnits.length, 2);
    const {
        expectedIgnoredOfficialUnitCount: _omittedCount,
        ...withoutCount
    } = base;
    assert.equal(
        parseRaw(withoutCount).ignoredOfficialUnits.length,
        2
    );
    for (const schemaHash of DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST) {
        assert.equal(
            parseRaw({
                ...base,
                phase0: { ...base.phase0, schemaHash },
            }).phase0.schemaHash,
            schemaHash
        );
    }

    const invalidCandidates: Array<
        Omit<DevelopmentApiLdaregTarget, 'manifestDigest'>
    > = [
        {
            ...base,
            ignoredOfficialUnits: [
                ...base.ignoredOfficialUnits,
            ].reverse(),
        },
        {
            ...base,
            expectedIgnoredOfficialUnitCount: 1,
        },
        {
            ...base,
            ignoredOfficialUnits: [
                {
                    ...base.ignoredOfficialUnits[0],
                    canonicalDong: '0000',
                },
                base.ignoredOfficialUnits[1],
            ],
        },
        {
            ...base,
            ignoredOfficialUnits: [
                {
                    ...base.ignoredOfficialUnits[0],
                    canonicalDong:
                        base.propertyTargets[0].canonicalDong,
                    canonicalFloor:
                        base.propertyTargets[0].normalizedFloor,
                    canonicalHo:
                        base.propertyTargets[0].normalizedHo,
                    providerShapeBridgeKind:
                        base.propertyTargets[0]
                            .providerShapeBridgeKind,
                },
                base.ignoredOfficialUnits[1],
            ],
        },
        {
            ...base,
            ignoredOfficialUnits: [
                {
                    ...base.ignoredOfficialUnits[0],
                    providerShapeBridgeKind:
                        'COUNT_BASED_GUESS' as never,
                },
                base.ignoredOfficialUnits[1],
            ],
        },
        {
            ...base,
            ignoredOfficialUnits: [
                {
                    ...base.ignoredOfficialUnits[0],
                    reason: 'MANUAL' as never,
                },
                base.ignoredOfficialUnits[1],
            ],
        },
        {
            ...base,
            phase0: {
                ...base.phase0,
                schemaHash: `2d7${'0'.repeat(61)}`,
            },
        },
        {
            ...base,
            phase0: {
                ...base.phase0,
                schemaHash: 'f'.repeat(64),
            },
        },
    ];
    for (const candidate of invalidCandidates) {
        assert.throws(() => parseRaw(candidate));
    }

    const extraKey = {
        ...base,
        ignoredOfficialUnits: base.ignoredOfficialUnits.map(
            (ignored, index) =>
                index === 0
                    ? {
                          ...ignored,
                          unexpected: true,
                      }
                    : ignored
        ),
    };
    assert.throws(() =>
        parseDevelopmentApiLdaregTarget({
            ...extraKey,
            manifestDigest: sha256(
                stableStringify(extraKey)
            ),
        })
    );
});

test('ignored official partition의 extra/missing/kind/numerator/dong/replica 변조는 모두 fail-closed한다', async () => {
    const parseRaw = (
        raw: Omit<DevelopmentApiLdaregTarget, 'manifestDigest'>
    ) =>
        parseDevelopmentApiLdaregTarget({
            ...raw,
            manifestDigest:
                computeDevelopmentApiLdaregManifestDigest(raw),
        });
    const base = rawPartitionTarget();
    const extraTarget = parseRaw({
        ...base,
        ignoredOfficialUnits: [
            ...base.ignoredOfficialUnits,
            {
                canonicalDong: '',
                canonicalFloor: '12',
                canonicalHo: '1201',
                providerShapeBridgeKind: null,
                expectedNumerator: '12',
                reason: 'NO_ACTIVE_PROPERTY_UNIT',
            },
        ],
        expectedIgnoredOfficialUnitCount: 3,
    });
    const missingTarget = parseRaw({
        ...base,
        ignoredOfficialUnits:
            base.ignoredOfficialUnits.slice(1),
        expectedIgnoredOfficialUnitCount: 1,
    });
    const numeratorTarget = parseRaw({
        ...base,
        ignoredOfficialUnits:
            base.ignoredOfficialUnits.map((ignored, index) =>
                index === 0
                    ? {
                          ...ignored,
                          expectedNumerator: '99',
                      }
                    : ignored
            ),
    });
    const kindTarget = parseRaw({
        ...base,
        ignoredOfficialUnits:
            base.ignoredOfficialUnits.map((ignored, index) =>
                index === 1
                    ? {
                          ...ignored,
                          providerShapeBridgeKind: null,
                      }
                    : ignored
            ),
    });
    const dongTarget = parseRaw({
        ...base,
        ignoredOfficialUnits:
            base.ignoredOfficialUnits.map((ignored, index) =>
                index === 1
                    ? { ...ignored, canonicalDong: 'A' }
                    : ignored
            ),
    });
    for (const targetValue of [
        extraTarget,
        missingTarget,
        numeratorTarget,
        kindTarget,
        dongTarget,
    ]) {
        await assert.rejects(() =>
            partitionOfficialFixture({ targetValue })
        );
    }

    await assert.rejects(
        () =>
            partitionOfficialFixture({
                mutateLdareg: (pnu, rows) =>
                    pnu === ATTACHED_PNU
                        ? rows.map((row, index) =>
                              index === 9
                                  ? {
                                        ...row,
                                        ldaQotaRate:
                                            '99/300',
                                    }
                                  : row
                          )
                        : rows,
            }),
        /OFFICIAL_LDAREG_SCOPE_REPLICATION_INVALID/
    );
    const mutatePlaceholder = (_pnu: string, rows: LdaregRow[]) =>
        rows.map((row, index) =>
            index === rows.length - 1
                ? { ...row, buldHoNm: '1000' }
                : row
        );
    const placeholderBaseRows = mutatePlaceholder(
        BASE_PNU,
        partitionLdaregRows(BASE_PNU)
    );
    const placeholderAttachedRows = mutatePlaceholder(
        ATTACHED_PNU,
        partitionLdaregRows(ATTACHED_PNU)
    );
    const placeholderReplication = validateLdaregReplication(
        [BASE_PNU, ATTACHED_PNU],
        [
            {
                pnu: BASE_PNU,
                ldaregRows: placeholderBaseRows,
                exposRows: partitionExposRows(),
                basisRows: partitionBasisRows(),
            },
            {
                pnu: ATTACHED_PNU,
                ldaregRows: placeholderAttachedRows,
                exposRows: [],
                basisRows: [],
            },
        ],
        BASE_PNU
    );
    assert.equal(placeholderReplication.ok, true);
    const placeholderTarget = parseRaw({
        ...base,
        officialHashes: {
            ...base.officialHashes,
            ldaregRowMultisetDigest: placeholderReplication.ok
                ? placeholderReplication.evidence
                      .rowMultisetDigest
                : '',
        },
    });
    await assert.rejects(
        () =>
            partitionOfficialFixture({
                targetValue: placeholderTarget,
                mutateLdareg: mutatePlaceholder,
            }),
        /OFFICIAL_LDAREG_PLACEHOLDER_INVALID/
    );
});

test('prepare는 official 재조회와 inspect 2회만 수행하고 owner-only 승인 요청을 만든다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const preparedAt = new Date(
        '2026-07-25T02:00:00.000Z'
    );
    const prepared = await prepareDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        now: () => preparedAt,
    });
    assert.equal(prepared.artifact.gate.status, 'PASS');
    assert.equal(database.inspectCalls, 2);
    assert.equal(database.applyCalls, 0);
    assert.deepEqual(prepared.artifact.executionBoundary, {
        inspectCallCount: 2,
        applyRpcCallCount: 0,
        approvalRpcCallCount: 0,
        syncJobWriteCount: 0,
        propertyWriteCount: 0,
        propertyRightWriteCount: 0,
        verificationBoundary:
            'READ_ONLY_OFFICIAL_SCAN_AND_DATABASE_INSPECT_ONLY',
    });
    assert.equal(
        validateDevelopmentApiLdaregPrepareArtifact({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact: prepared.artifact,
        }),
        prepared.artifact
    );
    assert.equal(
        JSON.stringify(prepared.artifact).includes(BASE_PNU),
        false
    );
    assert.equal(
        JSON.stringify(prepared.artifact).includes(UNION_ID),
        false
    );
    assert.ok(prepared.approvalRequest);
    const request = validateDevelopmentApiLdaregApprovalRequest({
        target: targetValue,
        expectedSourceReleaseSha: RELEASE_SHA,
        request: prepared.approvalRequest,
        now: new Date('2026-07-25T02:01:00.000Z'),
    });
    assert.equal(
        request.ownerApproval.name,
        'replace_development_api_authoritative_ldareg_backfill_approval_v1'
    );
    assert.deepEqual(
        Object.keys(request.ownerApproval.args).sort(),
        [
            'p_base_pnu',
            'p_enabled',
            'p_evidence_digest',
            'p_expected_prestate_rights_digest',
            'p_expected_prestate_tuple_digest',
            'p_expected_property_unit_digest',
            'p_expected_proposed_values_digest',
            'p_expected_scope_digest',
            'p_expires_at',
            'p_items',
            'p_mgm_bldrgst_pk',
            'p_phase0_artifact_sha256',
            'p_phase0_artifact_version',
            'p_phase0_run_id',
            'p_phase0_schema_hash',
            'p_property_unit_ids',
            'p_scope_pnus',
            'p_source_release_sha',
            'p_target_digest',
            'p_target_manifest_digest',
            'p_union_id',
        ]
    );
    assert.deepEqual(
        request.ownerApproval.args.p_scope_pnus,
        [BASE_PNU, ATTACHED_PNU]
    );
    assert.deepEqual(
        request.ownerApproval.args.p_property_unit_ids,
        targetValue.propertyTargets.map(
            (property) => property.propertyUnitId
        )
    );
    assert.equal(
        request.ownerApproval.args.p_target_digest,
        prepared.artifact.targetDigest
    );
    assert.equal(
        request.ownerApproval.args.p_expires_at,
        '2026-07-25T02:15:00.000Z'
    );
    assert.equal(
        request.ownerApproval.args.p_items.length,
        4
    );
    assert.ok(
        request.ownerApproval.args.p_items
            .flatMap((item) => item.components)
            .every(
                (component) =>
                    component.matchMethod ===
                        'BUILDING_UNIT_ID' &&
                    /^primary:v2:[0-9a-f]{64}$/.test(
                        component.sourceIdentity
                    ) &&
                    component.sourceRecord.pnu ===
                        component.targetPnu
            )
    );
});

test('owner-only 승인 요청 validator는 만료, digest, raw source item 변조를 모두 거부한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const prepared = await prepareDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        now: () =>
            new Date('2026-07-25T02:00:00.000Z'),
    });
    assert.ok(prepared.approvalRequest);
    assert.throws(() =>
        validateDevelopmentApiLdaregApprovalRequest({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            request: prepared.approvalRequest,
            now: new Date('2026-07-25T02:15:00.000Z'),
        })
    );
    assert.throws(() =>
        validateDevelopmentApiLdaregApprovalRequest({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            request: {
                ...prepared.approvalRequest!,
                requestDigest: '0'.repeat(64),
            },
            now: new Date('2026-07-25T02:01:00.000Z'),
        })
    );
    const tampered = structuredClone(
        prepared.approvalRequest!
    );
    tampered.ownerApproval.args.p_items[0].components[0].matchMethod =
        'ROOM';
    assert.throws(() =>
        validateDevelopmentApiLdaregApprovalRequest({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            request: tampered,
            now: new Date('2026-07-25T02:01:00.000Z'),
        })
    );
});

test('prepare inspect 사이 DB state drift는 승인 요청 없이 fail-closed하고 write counter는 0이다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const originalInspect = database.inspect.bind(database);
    database.inspect = async (input) => {
        const value = await originalInspect(input);
        return input.items === null
            ? value
            : {
                  ...value,
                  currentState: {
                      ...value.currentState,
                      targetRightsDigest: '0'.repeat(64),
                  },
              };
    };
    const prepared = await prepareDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        now: () =>
            new Date('2026-07-25T02:00:00.000Z'),
    });
    assert.equal(prepared.artifact.gate.status, 'FAIL');
    assert.deepEqual(prepared.artifact.gate.failureCodes, [
        'DEVELOPMENT_API_LDAREG_PREPARE_INCOMPLETE',
        'READ_ONLY_PREFLIGHT_STATE_CHANGED',
    ]);
    assert.equal(prepared.approvalRequest, null);
    assert.equal(database.inspectCalls, 2);
    assert.equal(database.applyCalls, 0);
    assert.equal(
        prepared.artifact.executionBoundary.applyRpcCallCount,
        0
    );
    assert.equal(
        validateDevelopmentApiLdaregPrepareArtifact({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact: prepared.artifact,
        }),
        prepared.artifact
    );
});

test('CLI prepare/apply는 분리된 private 파일 계약과 mode별 write 경계를 지킨다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const validEnvironment = {
        DATA_PORTAL_API_KEY: 'hub-key',
        VWORLD_API_KEY: 'vworld-key',
        VWORLD_API_DOMAIN: 'www.tonghari.kr',
        DEV_SUPABASE_URL:
            'https://yxypndgipnxrdfyctmvh.supabase.co',
        DEV_SUPABASE_SERVICE_ROLE_KEY: 'service-role',
        LAND_AREA_SYNC_ENABLED: 'false',
        LAND_AREA_SYNC_ALLOWED_TARGETS: '',
    };
    const runMode = async (mode: 'prepare' | 'apply') => {
        const cwd = fs.mkdtempSync(
            path.join(os.tmpdir(), `ldareg-${mode}-`)
        );
        const privateRoot = path.join(
            cwd,
            '.development-api-authoritative-ldareg-backfill'
        );
        fs.mkdirSync(privateRoot, { mode: 0o700 });
        fs.writeFileSync(
            path.join(privateRoot, 'target.json'),
            `${JSON.stringify(targetValue)}\n`,
            { mode: 0o600 }
        );
        const database = new FakeDatabase(
            targetValue,
            result.items,
            result.evidence.evidenceDigest
        );
        const stdout: string[] = [];
        const stderr: string[] = [];
        try {
            const status = await runDevelopmentApiLdaregCli(
                [
                    '--mode',
                    mode,
                    '--target',
                    '.development-api-authoritative-ldareg-backfill/target.json',
                    '--source-release-sha',
                    RELEASE_SHA,
                    '--out',
                    '.development-api-authoritative-ldareg-backfill/artifact.json',
                    '--approval-request-out',
                    '.development-api-authoritative-ldareg-backfill/owner-package.json',
                ],
                {
                    cwd,
                    env: validEnvironment,
                    database,
                    adapter: adapter().implementation,
                    stdout: (message) => stdout.push(message),
                    stderr: (message) => stderr.push(message),
                }
            );
            assert.equal(status, 0);
            assert.deepEqual(stderr, []);
            assert.equal(
                stdout.some(
                    (message) =>
                        message.includes(BASE_PNU) ||
                        message.includes(UNION_ID)
                ),
                false
            );
            assert.equal(
                await runDevelopmentApiLdaregValidatorCli(
                    [
                        '--target',
                        '.development-api-authoritative-ldareg-backfill/target.json',
                        '--artifact',
                        '.development-api-authoritative-ldareg-backfill/artifact.json',
                        '--source-release-sha',
                        RELEASE_SHA,
                    ],
                    { cwd }
                ),
                0
            );
            const requestPath = path.join(
                privateRoot,
                'owner-package.json'
            );
            if (mode === 'prepare') {
                assert.equal(database.inspectCalls, 2);
                assert.equal(database.applyCalls, 0);
                assert.equal(fs.existsSync(requestPath), true);
                assert.equal(
                    fs.statSync(requestPath).mode & 0o077,
                    0
                );
                assert.equal(
                    await runDevelopmentApiLdaregApprovalValidatorCli(
                        [
                            '--target',
                            '.development-api-authoritative-ldareg-backfill/target.json',
                            '--artifact',
                            '.development-api-authoritative-ldareg-backfill/artifact.json',
                            '--request',
                            '.development-api-authoritative-ldareg-backfill/owner-package.json',
                            '--source-release-sha',
                            RELEASE_SHA,
                        ],
                        { cwd }
                    ),
                    0
                );
            } else {
                assert.equal(database.applyCalls, 1);
                assert.equal(fs.existsSync(requestPath), false);
            }
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    };
    await runMode('prepare');
    await runMode('apply');
});

test('Supabase adapter의 inspect/apply named args와 apply receipt shape는 DB contract와 exact 일치한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const fakeDatabase = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const applyInput = {
        target: targetValue,
        items: result.items,
        expectedScopeDigest:
            targetValue.databaseDigests.scopeDigest,
        expectedPropertyUnitDigest:
            targetValue.databaseDigests.propertyUnitDigest,
        expectedProposedValuesDigest:
            fakeDatabase.proposalDigest,
        expectedPrestateTupleDigest: 'c'.repeat(64),
        expectedPrestateTargetRightsDigest: 'e'.repeat(64),
        evidenceDigest: result.evidence.evidenceDigest,
        sourceReleaseSha: RELEASE_SHA,
        targetDigest: fakeDatabase.targetDigest,
        syncJobId: SYNC_JOB_ID,
    };
    const receipt = await fakeDatabase.apply(applyInput);
    const calls: Array<{
        name: string;
        args: Record<string, unknown>;
    }> = [];
    const client = {
        async rpc(
            name: string,
            args: Record<string, unknown>
        ) {
            calls.push({ name, args });
            const inspectorSnapshot = snapshot({
                target: targetValue,
                items: null,
                targetDigest: null,
            });
            const {
                managementPk,
                ...inspectorSnapshotWithoutManagementPk
            } = inspectorSnapshot;
            return {
                data: name.startsWith('inspect_')
                    ? {
                          ...inspectorSnapshotWithoutManagementPk,
                          mgmBldrgstPk: managementPk,
                      }
                    : receipt,
                error: null,
            };
        },
    };
    const database =
        new SupabaseDevelopmentApiLdaregDatabase(
            client as never
        );
    await database.inspect({
        target: targetValue,
        items: null,
        syncJobId: null,
    });
    await database.apply(applyInput);
    assert.deepEqual(Object.keys(calls[0].args), [
        'p_union_id',
        'p_base_pnu',
        'p_mgm_bldrgst_pk',
        'p_scope_pnus',
        'p_property_unit_ids',
        'p_items',
        'p_sync_job_id',
    ]);
    assert.deepEqual(Object.keys(calls[1].args), [
        'p_union_id',
        'p_base_pnu',
        'p_mgm_bldrgst_pk',
        'p_scope_pnus',
        'p_property_unit_ids',
        'p_items',
        'p_expected_scope_digest',
        'p_expected_property_unit_digest',
        'p_expected_proposed_values_digest',
        'p_expected_prestate_tuple_digest',
        'p_expected_prestate_rights_digest',
        'p_target_manifest_digest',
        'p_phase0_run_id',
        'p_phase0_artifact_version',
        'p_phase0_artifact_sha256',
        'p_phase0_schema_hash',
        'p_evidence_digest',
        'p_source_release_sha',
        'p_target_digest',
        'p_sync_job_id',
    ]);
    assert.deepEqual(Object.keys(receipt), [
        'status',
        'syncJobId',
        'targetDigest',
        'scopeDigest',
        'propertyUnitDigest',
        'proposedValuesDigest',
        'prestateTupleDigest',
        'prestateTargetRightsDigest',
        'poststateTupleDigest',
        'poststateTargetRightsDigest',
        'rightsRowCount',
        'updatedPropertyUnitCount',
        'source',
        'manualDecisionCounters',
        'invariantDigests',
        'replay',
    ]);
});

test('receipt와 replay는 pre/post target-rights digest를 봉인한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const originalApply = database.apply.bind(database);
    database.apply = async (input) => ({
        ...(await originalApply(input)),
        poststateTargetRightsDigest:
            input.expectedPrestateTargetRightsDigest,
    });
    const artifact = await runDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'DB_APPLY_RECEIPT_INVALID'
        )
    );
    assert.equal(database.applyCalls, 3);
});

test('manual 값 없이 공식 분자만 APPLIED하고 redacted PASS artifact를 검증한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const artifact = await runDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.deepEqual(artifact.gate.failureCodes, []);
    assert.equal(artifact.applyCall.status, 'APPLIED');
    assert.equal(artifact.applyCall.updatedPropertyUnitCount, 4);
    assert.equal(artifact.applyCall.rightsRowCount, 8);
    assert.deepEqual(artifact.manualDecisionCounters, zeroCounters());
    assert.equal(JSON.stringify(artifact).includes(BASE_PNU), false);
    assert.equal(JSON.stringify(artifact).includes(UNION_ID), false);
    assert.equal(
        JSON.stringify(artifact).includes(
            PROPERTIES[0].propertyUnitId
        ),
        false
    );
    assert.equal(
        validateDevelopmentApiLdaregArtifact({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact,
        }),
        artifact
    );
});

test('동일 syncJobId 재시도로 commit-response-loss를 REUSED로 복구한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest,
        true
    );
    const artifact = await runDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(database.applyCalls, 2);
    assert.equal(artifact.applyCall.status, 'REUSED');
    assert.equal(
        artifact.applyCall.recoveredAfterAmbiguousError,
        true
    );
});

test('대표/부속 raw pnu replica가 다르면 DB 호출 전 FAIL한다', async () => {
    const targetValue = target();
    const fixture = adapter({
        mutateLdareg(pnu, rows) {
            return pnu === ATTACHED_PNU
                ? rows.map((row) => ({
                      ...row,
                      pnu: BASE_PNU,
                  }))
                : rows;
        },
    });
    await assert.rejects(
        scanDevelopmentApiLdaregOfficialSource({
            target: targetValue,
            discoveredById: new Map(
                discoveryTargets().map((property) => [
                    property.propertyUnitId,
                    property,
                ])
            ),
            adapter: fixture.implementation,
            buildingHubServiceKey: 'hub-key',
            vworldKey: 'vworld-key',
            vworldDomain: 'www.tonghari.kr',
        }),
        /OFFICIAL_LDAREG_SCOPE_REPLICATION_INVALID/
    );
});

test('0 분자, 중복 room, CURRENT가 아닌 target row는 각각 fail-closed한다', async () => {
    const cases: Array<{
        name: string;
        mutate: AdapterOptions['mutateLdareg'];
    }> = [
        {
            name: 'zero',
            mutate(pnu, rows) {
                return rows.map((row) =>
                    row.buldHoNm === '101'
                        ? { ...row, ldaQotaRate: '0/300' }
                        : row
                );
            },
        },
        {
            name: 'duplicate',
            mutate(pnu, rows) {
                return [...rows, { ...rows[0] }];
            },
        },
        {
            name: 'closed',
            mutate(pnu, rows) {
                return rows.map((row) =>
                    row.buldHoNm === '101'
                        ? {
                              ...row,
                              clsSeCode: '2',
                              clsSeCodeNm: '말소',
                          }
                        : row
                );
            },
        },
    ];
    for (const entry of cases) {
        const fixture = adapter({
            mutateLdareg: entry.mutate,
        });
        await assert.rejects(
            scanDevelopmentApiLdaregOfficialSource({
                target: target(),
                discoveredById: new Map(
                    discoveryTargets().map((property) => [
                        property.propertyUnitId,
                        property,
                    ])
                ),
                adapter: fixture.implementation,
                buildingHubServiceKey: 'hub-key',
                vworldKey: 'vworld-key',
                vworldDomain: 'www.tonghari.kr',
            }),
            undefined,
            entry.name
        );
    }
});

test('canonical building-unit ambiguity와 relation 미충족은 official apply 이전 FAIL한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const originalInspect = database.inspect.bind(database);
    database.inspect = async (input) => {
        const value = await originalInspect(input);
        if (input.items === null) {
            return {
                ...value,
                propertyTargets: {
                    ...value.propertyTargets,
                    targets: value.propertyTargets.targets.map(
                        (property, index) =>
                            index === 0
                                ? {
                                      ...property,
                                      matchedBuildingUnitId:
                                          value.propertyTargets
                                              .targets[1]
                                              .matchedBuildingUnitId,
                                  }
                                : property
                    ),
                },
            };
        }
        return value;
    };
    const artifact = await runDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'DB_CANONICAL_BUILDING_UNIT_AMBIGUOUS'
        )
    );
    assert.equal(database.applyCalls, 0);
    assert.equal(
        validateDevelopmentApiLdaregArtifact({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact,
        }),
        artifact
    );
});

test('운영 URL, enabled flag, non-empty 일반 allowlist를 환경 gate가 거부한다', () => {
    const valid = {
        DATA_PORTAL_API_KEY: 'hub',
        VWORLD_API_KEY: 'vworld',
        VWORLD_API_DOMAIN: 'www.tonghari.kr',
        DEV_SUPABASE_URL:
            'https://yxypndgipnxrdfyctmvh.supabase.co',
        DEV_SUPABASE_SERVICE_ROLE_KEY: 'service-role',
        LAND_AREA_SYNC_ENABLED: 'false',
        LAND_AREA_SYNC_ALLOWED_TARGETS: '',
    };
    assert.equal(
        validateDevelopmentApiLdaregEnvironment(valid)
            .developmentUrl,
        valid.DEV_SUPABASE_URL
    );
    for (const patch of [
        {
            DEV_SUPABASE_URL:
                'https://bpdjashtxqrcgxfequgf.supabase.co',
        },
        { LAND_AREA_SYNC_ENABLED: 'true' },
        { LAND_AREA_SYNC_ALLOWED_TARGETS: UNION_ID },
    ]) {
        assert.throws(() =>
            validateDevelopmentApiLdaregEnvironment({
                ...valid,
                ...patch,
            })
        );
    }
});

test('artifact validator는 raw identifier, MANUAL provenance, nested shape/count/digest 변조를 거부한다', async () => {
    const targetValue = target();
    const { result } = await officialFixture(targetValue);
    const database = new FakeDatabase(
        targetValue,
        result.items,
        result.evidence.evidenceDigest
    );
    const artifact = await runDevelopmentApiLdaregBackfill({
        target: targetValue,
        sourceReleaseSha: RELEASE_SHA,
        buildingHubServiceKey: 'hub-key',
        vworldKey: 'vworld-key',
        vworldDomain: 'www.tonghari.kr',
        adapter: adapter().implementation,
        database,
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.throws(() =>
        validateDevelopmentApiLdaregArtifact({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact: {
                ...artifact,
                rawTarget: BASE_PNU,
            },
        })
    );
    assert.throws(() =>
        validateDevelopmentApiLdaregArtifact({
            target: targetValue,
            expectedSourceReleaseSha: RELEASE_SHA,
            artifact: {
                ...artifact,
                proposal: {
                    ...artifact.proposal,
                    source: 'MANUAL',
                },
            },
        })
    );
    const mutations: unknown[] = [
        {
            ...artifact,
            officialScan: {
                ...artifact.officialScan!,
                evidenceDigest: '0'.repeat(64),
            },
        },
        {
            ...artifact,
            officialScan: {
                ...artifact.officialScan!,
                endpointScans:
                    artifact.officialScan!.endpointScans.map(
                        (scan, index) =>
                            index === 0
                                ? { ...scan, unexpected: true }
                                : scan
                    ),
            },
        },
        {
            ...artifact,
            proposal: {
                ...artifact.proposal,
                itemCount: 3,
            },
        },
        {
            ...artifact,
            invariantDigests: {
                ...artifact.invariantDigests,
                after: {
                    ...artifact.invariantDigests.after!,
                    buildingUnits: '0'.repeat(64),
                },
            },
        },
        {
            ...artifact,
            applyCall: {
                ...artifact.applyCall,
                rightsRowCount: 7,
            },
        },
        {
            ...artifact,
            stateDigests: {
                ...artifact.stateDigests,
                targetRightsAfterDigest:
                    artifact.stateDigests
                        .targetRightsBeforeDigest,
            },
        },
        {
            ...artifact,
            gate: {
                status: 'FAIL',
                failureCodes: [],
            },
        },
    ];
    for (const mutation of mutations) {
        assert.throws(() =>
            validateDevelopmentApiLdaregArtifact({
                target: targetValue,
                expectedSourceReleaseSha: RELEASE_SHA,
                artifact: mutation,
            })
        );
    }
});
