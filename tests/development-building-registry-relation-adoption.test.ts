import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    computeDevelopmentRelationAdoptionExecutionTargetDigest,
    computeDevelopmentRelationAdoptionManifestDigest,
    controlledRelationAdoptionFailureCode,
    parseDevelopmentRelationAdoptionTarget,
    runDevelopmentRelationAdoption,
    scanAndValidateDevelopmentOfficialRelation,
    toDevelopmentRelationAdoptionPublicArtifact,
    validateDevelopmentRelationAdoptionPublicArtifact,
    type DevelopmentRelationAdoptionDatabase,
    type DevelopmentRelationAdoptionReceipt,
    type DevelopmentRelationAdoptionTarget,
    type DevelopmentRelationSnapshot,
} from '../src/operations/development-building-registry-relation-adoption';
import {
    SupabaseDevelopmentRelationAdoptionDatabase,
    validateDevelopmentRelationAdoptionEnvironment,
} from '../src/cli/development-building-registry-relation-adoption';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrTitleRow,
    StrictScan,
} from '../src/types/land-area-sync.types';

const UNION_ID = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
const BASE_PNU = '1130510100107912280';
const ATTACHED_PNU = '1130510100107912281';
const MANAGEMENT_PK = '10101100184244';
const SOURCE_SHA = 'a'.repeat(40);
const SYNC_JOB_ID = '00000000-0000-4000-8000-000000000010';
const RELATION_ID = '00000000-0000-4000-8000-000000000011';
const OBSERVATION_ID = '00000000-0000-4000-8000-000000000012';
const BUILDING_ID = '00000000-0000-4000-8000-000000000013';
const OPERATION_ID = '00000000-0000-4000-8000-000000000014';
const COMMAND_ID = '00000000-0000-4000-8000-000000000015';
const MEMBER_DIGEST = 'b'.repeat(64);
const SCOPE_DIGEST = 'c'.repeat(64);

const titleRows: BrTitleRow[] = [
    {
        mgmBldrgstPk: MANAGEMENT_PK,
        bylotCnt: '1',
        sigunguCd: '11305',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '0791',
        ji: '2280',
    },
];
const basisRows: BrBasisOulnRow[] = [
    {
        mgmBldrgstPk: MANAGEMENT_PK,
        mgmUpBldrgstPk: '0',
        bylotCnt: 1,
        sigunguCd: '11305',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '0791',
        ji: '2280',
    },
];
const attachedRows: BrAtchJibunRow[] = [
    {
        mgmBldrgstPk: MANAGEMENT_PK,
        sigunguCd: '11305',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '0791',
        ji: '2280',
        atchSigunguCd: '11305',
        atchBjdongCd: '10100',
        atchPlatGbCd: '0',
        atchBun: '0791',
        atchJi: '2281',
    },
];

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (record[key] !== undefined) {
                result[key] = canonicalize(record[key]);
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
        } else if (value === null) {
            tokens.add(`${path}:null`);
        } else if (Array.isArray(value)) {
            tokens.add(`${path}:array`);
            value.forEach((item) => visit(item, `${path}[]`, depth + 1));
        } else if (typeof value === 'object') {
            tokens.add(`${path}:object`);
            Object.keys(value as Record<string, unknown>)
                .sort()
                .forEach((key) =>
                    visit(
                        (value as Record<string, unknown>)[key],
                        `${path}.${key}`,
                        depth + 1
                    )
                );
        } else {
            tokens.add(`${path}:${typeof value}`);
        }
    };
    rows.forEach((row) => visit(row, '$', 0));
    return sha256([...tokens].sort().join('\n'));
}

function makeTarget(): DevelopmentRelationAdoptionTarget {
    const managementPkHash = sha256(
        `MGM_BLDRGST_PK\u0000${MANAGEMENT_PK}`
    );
    const basePnuHash = sha256(`PNU\u0000${BASE_PNU}`);
    const attachedPnuHash = sha256(`PNU\u0000${ATTACHED_PNU}`);
    const withoutDigest = {
        version:
            'development-building-registry-relation-adoption-target@1' as const,
        databaseTarget: 'development' as const,
        unionId: UNION_ID,
        basePnu: BASE_PNU,
        attachedPnu: ATTACHED_PNU,
        managementPk: MANAGEMENT_PK,
        expectedActivePropertyUnitCount: 4,
        scopeDigest: SCOPE_DIGEST,
        phase0: {
            runId: '30146538770',
            artifactVersion:
                'land-area-phase0-capture-artifact@6' as const,
            artifactSha256: 'd'.repeat(64),
            schemaHash: 'e'.repeat(64),
        },
        officialHashes: {
            managementPkHash,
            basePnuHash,
            attachedPnuHash,
            pairsDigest: sha256(
                stableStringify([
                    {
                        managementPkHash,
                        basePnuHash,
                        attachedPnuHash,
                    },
                ])
            ),
            titleSchemaHash: schemaHash(titleRows),
            basisSchemaHash: schemaHash(basisRows),
            attachedSchemaHash: schemaHash(attachedRows),
        },
    };
    return {
        ...withoutDigest,
        manifestDigest:
            computeDevelopmentRelationAdoptionManifestDigest(
                withoutDigest
            ),
    };
}

function complete<T>(rows: T[]): StrictScan<T> {
    return {
        state: 'COMPLETE',
        rows,
        totalCount: rows.length,
        pagesFetched: 1,
    };
}

function adapter(overrides: {
    title?: BrTitleRow[];
    basis?: BrBasisOulnRow[];
    attached?: BrAtchJibunRow[];
} = {}) {
    return {
        scanTitle: async () => complete(overrides.title ?? titleRows),
        scanBasis: async () => complete(overrides.basis ?? basisRows),
        scanAttached: async () =>
            complete(overrides.attached ?? attachedRows),
    };
}

function hashes(value = '1'): DevelopmentRelationSnapshot['hashes'] {
    return {
        propertyUnits: value.repeat(64),
        propertyOwnerships: value.repeat(64),
        buildingLandLots: value.repeat(64),
        buildings: value.repeat(64),
        buildingUnits: value.repeat(64),
        buildingExternalRefs: value.repeat(64),
        landLots: value.repeat(64),
        landAreaTuples: value.repeat(64),
        landRightRows: value.repeat(64),
        landAreaSyncJobs: value.repeat(64),
        nonTargetRelations: value.repeat(64),
    };
}

function snapshot(
    relationCount: number,
    options: {
        landAreaDigest?: string;
        linked?: boolean;
        approvalState?: 'PREINSTALLED' | 'CONSUMED' | 'MISSING';
    } = {}
): DevelopmentRelationSnapshot {
    const approvalState =
        options.approvalState ??
        (relationCount > 0 ? 'CONSUMED' : 'PREINSTALLED');
    const targetDigest =
        computeDevelopmentRelationAdoptionExecutionTargetDigest({
            target: makeTarget(),
            expectedPropertyUnitDigest: MEMBER_DIGEST,
            sourceReleaseSha: SOURCE_SHA,
        });
    return {
        expectedActivePropertyUnitCount: 4,
        expectedPropertyUnitDigest: MEMBER_DIGEST,
        landAreaApproval: {
            enabled: false,
            stableDigest: options.landAreaDigest ?? '2'.repeat(64),
        },
        relationAdoptionApproval: {
            rowCount: approvalState === 'MISSING' ? 0 : 1,
            enabled: approvalState === 'PREINSTALLED',
            consumedAt:
                approvalState === 'CONSUMED'
                    ? '2026-07-25T00:00:01.000Z'
                    : null,
            targetDigest:
                approvalState === 'MISSING'
                    ? null
                    : targetDigest,
            expiresAt:
                approvalState === 'MISSING'
                    ? null
                    : '2026-07-25T00:15:00.000Z',
        },
        targetRelation: {
            count: relationCount,
            digest: (relationCount === 0 ? '3' : '4').repeat(64),
            activeCount: relationCount,
            linkedCount: options.linked === false ? 0 : relationCount,
        },
        hashes: hashes(),
        writeAttribution:
            relationCount > 0
                ? {
                      counts: {
                          syncJobs: 1,
                          operations: 1,
                          inputPnus: 1,
                          commands: 1,
                          observations: 1,
                          observationPairs: 1,
                          groupStates: 1,
                          relations: 1,
                      },
                      digest: '5'.repeat(64),
                      relationProjectionStatuses: ['LINKED'],
                      attributedIdDigest: '6'.repeat(64),
                  }
                : null,
    };
}

function adoptionReceipt(): DevelopmentRelationAdoptionReceipt {
    const target = makeTarget();
    return {
        status: 'CREATED',
        relationId: RELATION_ID,
        observationId: OBSERVATION_ID,
        buildingId: BUILDING_ID,
        operationId: OPERATION_ID,
        operationEpoch: 12,
        commandId: COMMAND_ID,
        syncJobId: SYNC_JOB_ID,
        projectionStatus: 'LINKED',
        basePnu: BASE_PNU,
        attachedPnu: ATTACHED_PNU,
        managementPk: MANAGEMENT_PK,
        expectedPropertyUnitCount: 4,
        expectedPropertyUnitDigest: MEMBER_DIGEST,
        targetDigest:
            computeDevelopmentRelationAdoptionExecutionTargetDigest({
                target,
                expectedPropertyUnitDigest: MEMBER_DIGEST,
                sourceReleaseSha: SOURCE_SHA,
            }),
        phase0RunId: 30146538770,
        phase0ArtifactSha256: target.phase0.artifactSha256,
        phase0SchemaHash: target.phase0.schemaHash,
        phase0PairDigest: target.officialHashes.pairsDigest,
        sourceReleaseSha: SOURCE_SHA,
        landAreaApprovalStableDigest: '2'.repeat(64),
    };
}

function priorPhase0Validation() {
    const target = makeTarget();
    return {
        artifactSha256: target.phase0.artifactSha256,
        schemaHash: target.phase0.schemaHash,
        managementPkHash:
            target.officialHashes.managementPkHash,
        basePnuHash: target.officialHashes.basePnuHash,
        attachedPnuHash:
            target.officialHashes.attachedPnuHash,
        pairsDigest: target.officialHashes.pairsDigest,
    };
}

class FakeDatabase implements DevelopmentRelationAdoptionDatabase {
    readonly calls: string[] = [];
    private snapshotIndex = 0;

    constructor(
        private readonly snapshots: DevelopmentRelationSnapshot[] = [
            snapshot(0),
            snapshot(1),
        ],
        private readonly adoptError: Error | null = null
    ) {}

    async readSnapshot(): Promise<DevelopmentRelationSnapshot> {
        this.calls.push('read');
        const value =
            this.snapshots[
                Math.min(this.snapshotIndex, this.snapshots.length - 1)
            ];
        this.snapshotIndex += 1;
        return value;
    }

    async adoptRelation(): Promise<DevelopmentRelationAdoptionReceipt> {
        this.calls.push('adopt');
        if (this.adoptError) throw this.adoptError;
        return adoptionReceipt();
    }

}

test('repository target@1은 Phase0 provenance와 자체 digest를 exact 검증한다', () => {
    const target = makeTarget();
    assert.deepEqual(parseDevelopmentRelationAdoptionTarget(target), target);
    assert.throws(
        () =>
            parseDevelopmentRelationAdoptionTarget({
                ...target,
                expectedActivePropertyUnitCount: 5,
            }),
        (error) =>
            controlledRelationAdoptionFailureCode(error) ===
            'RELATION_TARGET_INVALID'
    );
});

test('fresh strict scan은 COMPLETE 3종, exact base/root/bylot/pair와 Phase0 hash를 통과한다', async () => {
    const result =
        await scanAndValidateDevelopmentOfficialRelation({
            target: makeTarget(),
            adapter: adapter(),
            serviceKey: 'secret',
        });
    assert.equal(result.totalPairs, 1);
    assert.equal(result.totalRejected, 0);
    assert.equal(result.bylotCount, 1);
    assert.equal(
        result.pairsDigest,
        makeTarget().officialHashes.pairsDigest
    );
});

test('부속 pair가 달라지면 DB 승인 이전에 fail-close한다', async () => {
    await assert.rejects(
        scanAndValidateDevelopmentOfficialRelation({
            target: makeTarget(),
            adapter: adapter({
                attached: [
                    {
                        ...attachedRows[0],
                        atchJi: '9999',
                    },
                ],
            }),
            serviceKey: 'secret',
        }),
        (error) =>
            controlledRelationAdoptionFailureCode(error) ===
            'OFFICIAL_ATTACHED_PAIR_MISMATCH'
    );
});

test('성공 경로는 사전 설치된 relation 승인을 소비하고 불변성과 attribution을 검증한다', async () => {
    const database = new FakeDatabase();
    const artifact = await runDevelopmentRelationAdoption({
        target: makeTarget(),
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database,
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.deepEqual(artifact.gate.failureCodes, []);
    assert.deepEqual(database.calls, ['read', 'adopt', 'read']);
    assert.deepEqual(artifact.dbApproval, {
        preinstalledVerified: true,
        consumedVerified: true,
    });
    assert.deepEqual(artifact.adoptionCall, {
        attempts: 1,
        maxAttempts: 3,
        receiptVerified: true,
        recoveredAfterAmbiguousError: false,
    });
    assert.equal(artifact.relation.afterLinkedCount, 1);
    assert.equal(artifact.productionWrites.observedWriteCount, 0);
    const serialized = JSON.stringify(artifact);
    assert.doesNotMatch(serialized, new RegExp(BASE_PNU));
    assert.doesNotMatch(serialized, new RegExp(ATTACHED_PNU));
    assert.doesNotMatch(serialized, new RegExp(MANAGEMENT_PK));
    assert.doesNotMatch(serialized, /secret/);
});

test('adoption RPC가 계속 실패하면 동일 요청을 3회까지만 시도하고 postflight를 읽는다', async () => {
    const database = new FakeDatabase(
        [snapshot(0), snapshot(0)],
        new Error('network')
    );
    const artifact = await runDevelopmentRelationAdoption({
        target: makeTarget(),
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database,
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'UNEXPECTED_RELATION_ADOPTION_FAILURE'
        )
    );
    assert.equal(artifact.dbApproval.preinstalledVerified, true);
    assert.equal(artifact.dbApproval.consumedVerified, false);
    assert.equal(artifact.adoptionCall.attempts, 3);
    assert.equal(artifact.adoptionCall.receiptVerified, false);
    assert.deepEqual(database.calls, [
        'read',
        'adopt',
        'adopt',
        'adopt',
        'read',
    ]);
});

test('사전 설치된 exact approval이 없으면 adoption RPC를 호출하지 않는다', async () => {
    const missingApproval = snapshot(0, {
        approvalState: 'MISSING',
    });
    const database = new FakeDatabase([
        missingApproval,
        missingApproval,
    ]);
    const artifact = await runDevelopmentRelationAdoption({
        target: makeTarget(),
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database,
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'RELATION_PREINSTALLED_APPROVAL_INVALID'
        )
    );
    assert.deepEqual(database.calls, ['read', 'read']);
    assert.equal(artifact.adoptionCall.attempts, 0);
});

test('commit 뒤 응답 유실은 동일 syncJobId와 동일 args 재호출로 REUSED 복구한다', async () => {
    const adoptionInputs: Array<{
        target: DevelopmentRelationAdoptionTarget;
        expectedPropertyUnitDigest: string;
        targetDigest: string;
        sourceReleaseSha: string;
        syncJobId: string;
    }> = [];
    let readIndex = 0;
    const database: DevelopmentRelationAdoptionDatabase = {
        readSnapshot: async () => {
            const value =
                readIndex === 0 ? snapshot(0) : snapshot(1);
            readIndex += 1;
            return value;
        },
        adoptRelation: async (input) => {
            adoptionInputs.push(input);
            if (adoptionInputs.length === 1) {
                throw new Error('commit response lost');
            }
            return {
                ...adoptionReceipt(),
                status: 'REUSED',
            };
        },
    };
    const artifact = await runDevelopmentRelationAdoption({
        target: makeTarget(),
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database,
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.adoptionCall.attempts, 2);
    assert.equal(
        artifact.adoptionCall.recoveredAfterAmbiguousError,
        true
    );
    assert.equal(adoptionInputs.length, 2);
    assert.strictEqual(adoptionInputs[1], adoptionInputs[0]);
    assert.equal(adoptionInputs[0].syncJobId, SYNC_JOB_ID);
});

test('기존 land-area approval digest가 바뀌면 relation 결과가 있어도 FAIL이다', async () => {
    const database = new FakeDatabase([
        snapshot(0, { landAreaDigest: '2'.repeat(64) }),
        snapshot(1, { landAreaDigest: '7'.repeat(64) }),
    ]);
    const artifact = await runDevelopmentRelationAdoption({
        target: makeTarget(),
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database,
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'LAND_AREA_APPROVAL_BARRIER_CHANGED'
        )
    );
});

test('환경 gate는 개발 project URL과 LAND_AREA_SYNC_ENABLED=false를 exact 강제한다', () => {
    const valid = {
        DATA_PORTAL_API_KEY: 'api-key',
        DEV_SUPABASE_URL:
            'https://yxypndgipnxrdfyctmvh.supabase.co',
        DEV_SUPABASE_SERVICE_ROLE_KEY: 'development-key',
        LAND_AREA_SYNC_ENABLED: 'false',
    };
    assert.equal(
        validateDevelopmentRelationAdoptionEnvironment(valid)
            .developmentUrl,
        valid.DEV_SUPABASE_URL
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionEnvironment({
            ...valid,
            DEV_SUPABASE_URL:
                'https://production-project.supabase.co',
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionEnvironment({
            ...valid,
            LAND_AREA_SYNC_ENABLED: 'true',
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionEnvironment({
            ...valid,
            LAND_AREA_SYNC_ENABLED: 'False',
        })
    );
});

test('공개 artifact validator는 수동값 0과 식별자 비공개, PASS 수량을 강제한다', async () => {
    const target = makeTarget();
    const artifact = await runDevelopmentRelationAdoption({
        target,
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database: new FakeDatabase(),
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    const publicArtifact =
        toDevelopmentRelationAdoptionPublicArtifact(artifact);
    assert.deepEqual(
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: publicArtifact,
        }),
        publicArtifact
    );
    assert.deepEqual(publicArtifact.manualDataUsage, {
        sourceReads: 0,
        blockerReads: 0,
        fallbackWrites: 0,
    });
    const serialized = JSON.stringify(publicArtifact);
    assert.doesNotMatch(serialized, new RegExp(BASE_PNU));
    assert.doesNotMatch(serialized, new RegExp(ATTACHED_PNU));
    assert.doesNotMatch(serialized, new RegExp(MANAGEMENT_PK));

    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                relation: {
                    ...publicArtifact.relation,
                    afterLinkedCount: 0,
                },
            },
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                manualDataUsage: {
                    ...publicArtifact.manualDataUsage,
                    sourceReads: 1,
                },
            },
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                invariantHashes: {
                    before: {},
                    after: {},
                },
            },
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                officialScan: {
                    ...publicArtifact.officialScan!,
                    title: {
                        ...publicArtifact.officialScan!.title,
                        propertyOwnerName: '비공개',
                    },
                },
            },
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                targetDigest: 'f'.repeat(64),
            },
        })
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                writeAttribution: {
                    ...publicArtifact.writeAttribution!,
                    relationProjectionStatuses: [
                        'owner@example.com',
                    ],
                },
            },
        })
    );
});

test('공개 FAIL artifact도 exact 중첩 구조만 허용해 PII 필드 삽입을 차단한다', async () => {
    const target = makeTarget();
    const artifact = await runDevelopmentRelationAdoption({
        target,
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database: new FakeDatabase([
            snapshot(0, { approvalState: 'MISSING' }),
            snapshot(0, { approvalState: 'MISSING' }),
        ]),
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    const publicArtifact =
        toDevelopmentRelationAdoptionPublicArtifact(artifact);
    assert.deepEqual(
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: publicArtifact,
        }),
        publicArtifact
    );
    assert.throws(() =>
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: {
                ...publicArtifact,
                relation: {
                    ...publicArtifact.relation,
                    propertyOwnerId:
                        '00000000-0000-4000-8000-000000000099',
                },
            },
        })
    );
});

test('PRE property count mismatch로 실행 digest 계산 전 중단된 FAIL artifact도 공개 검증된다', async () => {
    const target = makeTarget();
    const mismatchedSnapshot = snapshot(0);
    mismatchedSnapshot.expectedActivePropertyUnitCount = 5;
    const artifact = await runDevelopmentRelationAdoption({
        target,
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database: new FakeDatabase([
            mismatchedSnapshot,
            mismatchedSnapshot,
        ]),
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(artifact.targetDigest, null);
    assert.equal(artifact.adoptionCall.attempts, 0);
    assert.ok(
        artifact.gate.failureCodes.includes(
            'PREFLIGHT_SNAPSHOT_INVALID'
        )
    );
    const publicArtifact =
        toDevelopmentRelationAdoptionPublicArtifact(artifact);
    assert.deepEqual(
        validateDevelopmentRelationAdoptionPublicArtifact({
            target,
            expectedSourceReleaseSha: SOURCE_SHA,
            artifact: publicArtifact,
        }),
        publicArtifact
    );
});

test('Supabase adapter는 exact inspector/adoption RPC 계약만 사용한다', async () => {
    const target = makeTarget();
    const targetDigest =
        computeDevelopmentRelationAdoptionExecutionTargetDigest({
            target,
            expectedPropertyUnitDigest: MEMBER_DIGEST,
            sourceReleaseSha: SOURCE_SHA,
        });
    const calls: Array<{
        name: string;
        args: Record<string, unknown>;
    }> = [];
    const canonicalTableDigests = {
        propertyUnits: '1'.repeat(64),
        propertyOwnerships: '1'.repeat(64),
        buildings: '1'.repeat(64),
        buildingUnits: '1'.repeat(64),
        buildingLandLots: '1'.repeat(64),
        buildingExternalRefs: '1'.repeat(64),
        landLots: '1'.repeat(64),
        propertyUnitLandRights: '1'.repeat(64),
        landAreaProvenance: '1'.repeat(64),
        landAreaSyncJobs: '1'.repeat(64),
        nonTargetOfficialRelations: '1'.repeat(64),
    };
    const fakeClient = {
        rpc: async (
            name: string,
            args: Record<string, unknown>
        ) => {
            calls.push({ name, args });
            if (
                name ===
                'inspect_development_verified_building_registry_relation_v1'
            ) {
                return {
                    data: {
                        contractVersion:
                            'development-building-registry-relation-inspector@1',
                        databaseTarget: 'development',
                        unionId: UNION_ID,
                        basePnu: BASE_PNU,
                        attachedPnu: ATTACHED_PNU,
                        mgmBldrgstPk: MANAGEMENT_PK,
                        propertyMembership: {
                            count: 4,
                            digest: MEMBER_DIGEST,
                        },
                        relationProjection: {
                            count: 0,
                            digest: '7'.repeat(64),
                            activeCount: 0,
                            linkedCount: 0,
                        },
                        canonicalTableDigests,
                        landAreaApproval: {
                            rowCount: 1,
                            enabledCount: 0,
                            targetRowCount: 1,
                            targetCount: 2,
                            manifestDigest: '8'.repeat(64),
                            stableDigest: '2'.repeat(64),
                        },
                        relationAdoptionApproval: {
                            rowCount: 1,
                            enabled: true,
                            consumedAt: null,
                            targetDigest,
                            expiresAt:
                                '2026-07-25T00:15:00.000Z',
                        },
                        writeAttribution: null,
                    },
                    error: null,
                };
            }
            const {
                managementPk: _managementPk,
                ...receipt
            } = adoptionReceipt();
            return {
                data: {
                    ...receipt,
                    mgmBldrgstPk: MANAGEMENT_PK,
                },
                error: null,
            };
        },
    };
    const database =
        new SupabaseDevelopmentRelationAdoptionDatabase(
            fakeClient as unknown as SupabaseClient
        );
    const read = await database.readSnapshot(target, null);
    assert.equal(read.expectedActivePropertyUnitCount, 4);
    assert.equal(read.landAreaApproval.enabled, false);
    assert.equal(read.relationAdoptionApproval.rowCount, 1);
    assert.equal(read.relationAdoptionApproval.enabled, true);

    const adopted = await database.adoptRelation({
        target,
        expectedPropertyUnitDigest: MEMBER_DIGEST,
        targetDigest,
        sourceReleaseSha: SOURCE_SHA,
        syncJobId: SYNC_JOB_ID,
    });
    assert.equal(adopted.managementPk, MANAGEMENT_PK);
    assert.deepEqual(
        calls.map((call) => call.name),
        [
            'inspect_development_verified_building_registry_relation_v1',
            'adopt_development_verified_building_registry_relation_v1',
        ]
    );
    assert.deepEqual(calls[0].args, {
        p_union_id: UNION_ID,
        p_base_pnu: BASE_PNU,
        p_attached_pnu: ATTACHED_PNU,
        p_mgm_bldrgst_pk: MANAGEMENT_PK,
        p_sync_job_id: null,
    });
    assert.deepEqual(calls[1].args, {
        p_union_id: UNION_ID,
        p_base_pnu: BASE_PNU,
        p_attached_pnu: ATTACHED_PNU,
        p_mgm_bldrgst_pk: MANAGEMENT_PK,
        p_expected_property_unit_count: 4,
        p_expected_property_unit_digest: MEMBER_DIGEST,
        p_target_digest: targetDigest,
        p_phase0_run_id: 30146538770,
        p_phase0_artifact_version:
            'land-area-phase0-capture-artifact@6',
        p_phase0_artifact_sha256:
            target.phase0.artifactSha256,
        p_phase0_schema_hash: target.phase0.schemaHash,
        p_phase0_pair_digest:
            target.officialHashes.pairsDigest,
        p_source_release_sha: SOURCE_SHA,
        p_sync_job_id: SYNC_JOB_ID,
    });
});

test('성공 postflight는 consumed relation approval receipt를 요구한다', async () => {
    const invalidPost = snapshot(1);
    invalidPost.relationAdoptionApproval.consumedAt = null;
    const artifact = await runDevelopmentRelationAdoption({
        target: makeTarget(),
        sourceReleaseSha: SOURCE_SHA,
        buildingHubServiceKey: 'secret',
        adapter: adapter(),
        database: new FakeDatabase([snapshot(0), invalidPost]),
        priorPhase0Validation: priorPhase0Validation(),
        randomUuid: () => SYNC_JOB_ID,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes(
            'RELATION_APPROVAL_POSTSTATE_INVALID'
        )
    );
});
