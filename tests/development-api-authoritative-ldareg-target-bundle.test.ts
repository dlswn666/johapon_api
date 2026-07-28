import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmod,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST,
    DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH,
    DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH,
    DEVELOPMENT_API_LDAREG_TARGET_KEYS,
    type DevelopmentApiLdaregTarget,
    type DevelopmentApiLdaregTargetKey,
    type DevelopmentApiLdaregTargetPins,
} from '../src/operations/development-api-authoritative-ldareg-backfill';
import {
    DEVELOPMENT_API_LDAREG_CAPTURE_INDEX_VERSION,
    DEVELOPMENT_API_LDAREG_DB_SNAPSHOT_VERSION,
    buildDevelopmentApiLdaregTargetBundle,
    parseDevelopmentApiLdaregBundleDbSnapshot,
    parseDevelopmentApiLdaregCaptureIndex,
    transformLegacyDevelopmentApiLdaregTarget,
    type DevelopmentApiLdaregBundleDbGroup,
    type DevelopmentApiLdaregBundleDbSnapshot,
    type DevelopmentApiLdaregResolvedCapture,
} from '../src/operations/development-api-authoritative-ldareg-target-bundle';
import {
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
    providerUnitShapeWitness,
    providerUnitShapeWitnessKey,
    type ProviderUnitShapeBridgeKind,
} from '../src/services/land-area-sync/provider-unit-shape-bridge';
import {
    readPinnedPrivateFile,
    writeExclusivePrivateFile,
} from '../src/cli/development-api-authoritative-ldareg-private-files';
import {
    DEVELOPMENT_API_LDAREG_APPROVAL_INSTALL_SENTINEL,
    DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL,
    invokePinnedDevelopmentApiLdaregApprovalRpc,
    runDevelopmentApiLdaregApprovalRpcInstaller,
} from '../src/cli/development-api-authoritative-ldareg-approval-rpc-install';
import {
    DEVELOPMENT_API_LDAREG_BUNDLE_BUILD_SENTINEL,
    runDevelopmentApiLdaregTargetBundleBuilder,
} from '../src/cli/development-api-authoritative-ldareg-target-bundle-build';
import {
    LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH,
    type LandAreaPhase0CaptureArtifact,
    type LandAreaPhase0SampleArtifact,
} from '../src/verification/land-area-phase0-capture';

const ACTIVE_COUNTS = [5, 4, 6, 3, 9, 8, 4] as const;
const TEST_SCHEMA = 'a'.repeat(64);
const TEST_RUN_ID = '90000000001';

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (
        value !== null &&
        typeof value === 'object'
    ) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, nested]) => nested !== undefined)
                .sort(([left], [right]) =>
                    left < right ? -1 : 1
                )
                .map(([key, nested]) => [
                    key,
                    canonicalize(nested),
                ])
        );
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function uuid(kind: number, group: number, unit = 0): string {
    const suffix = String(
        kind * 1_000_000 + group * 1_000 + unit
    ).padStart(12, '0');
    return `00000000-0000-4000-8000-${suffix}`;
}

function pnu(group: number, attached = false): string {
    const suffix = String(
        10_000 + group * 10 + (attached ? 1 : 0)
    ).padStart(8, '0');
    return `11110101001${suffix}`;
}

function unitTupleHash(input: {
    canonicalDong: string;
    normalizedFloor: string;
    normalizedHo: string;
}): string {
    return sha256(
        `UNIT_TUPLE_JSON\u0000${stableStringify([
            input.canonicalDong || null,
            input.normalizedFloor,
            input.normalizedHo,
        ])}`
    );
}

function floorHoTupleHash(input: {
    normalizedFloor: string;
    normalizedHo: string;
}): string {
    return sha256(
        `FLOOR_HO_TUPLE_JSON\u0000${stableStringify([
            input.normalizedFloor,
            input.normalizedHo,
        ])}`
    );
}

function phase0ProviderHash(
    kind: ProviderUnitShapeBridgeKind,
    token: string
): string {
    return sha256(
        `PHASE0_PROVIDER_UNIT_SHAPE\u0000${kind}\u0001${token}`
    );
}

function bridgeFor(
    group: number,
    unit: number
): {
    kind: ProviderUnitShapeBridgeKind;
    hash: string;
} | null {
    if (group === 1) {
        const floor = String(unit + 1);
        const ho = String((unit + 1) * 100 + 1);
        return {
            kind: PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
            hash: phase0ProviderHash(
                PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
                `ABOVE_NO_SUFFIX:${floor}:${ho}`
            ),
        };
    }
    if (group === 3 && unit < 2) {
        return {
            kind: PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
            hash: phase0ProviderHash(
                PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
                `BASEMENT_B_HO:${unit + 1}`
            ),
        };
    }
    if (group === 4 && unit < 2) {
        return {
            kind: PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
            hash: phase0ProviderHash(
                PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
                `FLOOR_AS_UNIT_ABOVE:${unit + 1}`
            ),
        };
    }
    if (group === 4 && unit === 2) {
        return {
            kind: PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
            hash: phase0ProviderHash(
                PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
                'FLOOR_AS_UNIT_BASEMENT:1'
            ),
        };
    }
    return null;
}

function unitTuple(
    group: number,
    unit: number
): {
    canonicalDong: string;
    normalizedFloor: string;
    normalizedHo: string;
} {
    const bridge = bridgeFor(group, unit);
    const canonicalDong =
        (group === 1 && unit === 0) || group === 7
            ? '101'
            : '';
    if (
        bridge?.kind ===
        PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO
    ) {
        return {
            canonicalDong,
            normalizedFloor: '1',
            normalizedHo: `B${unit + 1}`,
        };
    }
    if (
        bridge?.kind ===
        PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE
    ) {
        return {
            canonicalDong,
            normalizedFloor: String(unit + 1),
            normalizedHo: `${unit + 1}층`,
        };
    }
    if (
        bridge?.kind ===
        PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT
    ) {
        return {
            canonicalDong,
            normalizedFloor: '1',
            normalizedHo: '지층',
        };
    }
    return {
        canonicalDong,
        normalizedFloor: String(unit + 1),
        normalizedHo: String((unit + 1) * 100 + 1),
    };
}

function groupDenominator(group: number): string {
    return group === 7 ? '300' : String(100 + group);
}

function makeGroup(
    groupNumber: number
): DevelopmentApiLdaregBundleDbGroup {
    const activeCount = ACTIVE_COUNTS[groupNumber - 1];
    const ignoredCount = groupNumber === 5 ? 2 : 0;
    const basePnu = pnu(groupNumber);
    const scopePnus =
        groupNumber === 7
            ? [basePnu, pnu(groupNumber, true)].sort()
            : [basePnu];
    const units = Array.from(
        { length: activeCount + ignoredCount },
        (_, index) => {
            const tuple = unitTuple(groupNumber, index);
            return {
                buildingUnitId: uuid(
                    3,
                    groupNumber,
                    index + 1
                ),
                buildingUnitPnu: basePnu,
                rawDong:
                    (groupNumber === 1 && index === 0) ||
                    groupNumber === 7
                        ? null
                        : tuple.canonicalDong || null,
                rawFloor:
                    index === 0 ? tuple.normalizedFloor : null,
                rawHo: tuple.normalizedHo,
                activePropertyUnit:
                    index < activeCount
                        ? {
                              propertyUnitId: uuid(
                                  4,
                                  groupNumber,
                                  index + 1
                              ),
                              pnu: basePnu,
                          }
                        : null,
            };
        }
    );
    if (groupNumber === 1) {
        const tuple = unitTuple(groupNumber, 0);
        units.push({
            buildingUnitId: uuid(7, groupNumber, 1),
            buildingUnitPnu: basePnu,
            rawDong: '제0101동',
            rawFloor: null,
            rawHo: `${tuple.normalizedHo}호`,
            activePropertyUnit: null,
        });
    }
    if (groupNumber === 2) {
        units.push({
            buildingUnitId: uuid(7, groupNumber, 1),
            buildingUnitPnu: basePnu,
            rawDong: null,
            rawFloor: null,
            rawHo: `${unitTuple(groupNumber, 0).normalizedHo}호`,
            activePropertyUnit: null,
        });
    }
    if (groupNumber === 3) {
        for (let index = 0; index < 2; index += 1) {
            units.push({
                buildingUnitId: uuid(
                    7,
                    groupNumber,
                    index + 1
                ),
                buildingUnitPnu: basePnu,
                rawDong: null,
                rawFloor: null,
                rawHo: `B0${index + 1}`,
                activePropertyUnit: null,
            });
        }
    }
    if (groupNumber === 5) {
        units.push({
            buildingUnitId: uuid(7, groupNumber, 1),
            buildingUnitPnu: basePnu,
            rawDong: null,
            rawFloor: null,
            rawHo: null,
            activePropertyUnit: null,
        });
    }
    if (groupNumber === 7) {
        units.push({
            buildingUnitId: uuid(7, groupNumber, 1),
            buildingUnitPnu: basePnu,
            rawDong: '제0101동',
            rawFloor: null,
            rawHo: `${unitTuple(groupNumber, 0).normalizedHo}호`,
            activePropertyUnit: null,
        });
    }
    return {
        key: `ldareg-target-0${groupNumber}` as DevelopmentApiLdaregTargetKey,
        unionId: uuid(1, groupNumber),
        basePnu,
        managementPk: String(
            20_000_000_000_000 + groupNumber
        ),
        canonicalBuildingId: uuid(2, groupNumber),
        scopePnus,
        scopeDigest: String(groupNumber).repeat(64),
        propertyUnitDigest: String(
            (groupNumber + 1) % 10
        ).repeat(64),
        units,
        landParcels:
            groupNumber === 7
                ? [
                      { pnu: basePnu, area: '100' },
                      {
                          pnu: pnu(groupNumber, true),
                          area: '200',
                      },
                  ].sort((left, right) =>
                      left.pnu < right.pnu ? -1 : 1
                  )
                : [
                      {
                          pnu: basePnu,
                          area: String(100 + groupNumber),
                      },
                  ],
        ...(groupNumber === 5
            ? { expectedIgnoredOfficialUnitCount: 2 }
            : {}),
    };
}

function boundedInventory(
    kind: string,
    records: Array<Record<string, unknown>>
) {
    return {
        kind,
        records,
        totalRecords: records.length,
        truncated: false,
        sanitizedDigest: sha256(stableStringify(records)),
    };
}

function makeCapture(
    group: DevelopmentApiLdaregBundleDbGroup
): DevelopmentApiLdaregResolvedCapture {
    const groupNumber = Number(group.key.slice(-2));
    const denominator = groupDenominator(groupNumber);
    const managementPkHash = sha256(
        `MGM_BLDRGST_PK\u0000${group.managementPk}`
    );
    const basePnuHash = sha256(
        `PNU\u0000${group.basePnu}`
    );
    const officialUnitCount =
        ACTIVE_COUNTS[groupNumber - 1] +
        (groupNumber === 5 ? 2 : 0);
    const exposures = Array.from(
        { length: officialUnitCount },
        (_, index) => {
        const unit = unitTuple(groupNumber, index);
        const bridge = bridgeFor(groupNumber, index);
        return {
            managementPkHash,
            unitIdentityShape: unit.canonicalDong
                ? 'DONG_FLOOR_HO'
                : 'FLOOR_HO',
            unitIdentityHash: unitTupleHash(unit),
            floorHoIdentityHash: floorHoTupleHash(unit),
            ...(unit.canonicalDong
                ? {
                      dongIdentityHash: sha256(
                          `DONG-${unit.canonicalDong}`
                      ),
                  }
                : {}),
            ...(bridge
                ? {
                      providerUnitBridgeHash: bridge.hash,
                      providerUnitBridgeKind: bridge.kind,
                  }
                : {}),
        };
    });
    const ldareg = Array.from(
        { length: officialUnitCount },
        (_, index) => {
        const unit = unitTuple(groupNumber, index);
        const bridge = bridgeFor(groupNumber, index);
        return {
            unitIdentityShape: unit.canonicalDong
                ? 'DONG_FLOOR_HO'
                : 'FLOOR_HO',
            unitIdentityHash: bridge
                ? sha256(
                      `LDAREG-DIFFERENT-${groupNumber}-${index}`
                  )
                : unitTupleHash(unit),
            floorHoIdentityHash: sha256(
                `LDAREG-FLOOR-HO-${groupNumber}-${index}`
            ),
            ...(bridge
                ? {
                      providerUnitBridgeHash: bridge.hash,
                      providerUnitBridgeKind: bridge.kind,
                  }
                : {}),
            quotaRatioState: 'VALID',
            quotaRatioInput: {
                presence: 'PRESENT',
                jsonType: 'string',
                parseState: 'VALID',
                stringShape: 'NON_EMPTY',
            },
            quotaRatio: `${10 + index}.${groupNumber}/${denominator}`,
            classificationCode: '0',
            classificationLabel: '현재',
        };
    });
    ldareg.push({
        unitIdentityShape: 'INCOMPLETE',
        unitIdentityHash: sha256(`PLACEHOLDER-${groupNumber}`),
        floorHoIdentityHash: sha256(
            `PLACEHOLDER-FLOOR-${groupNumber}`
        ),
        quotaRatioState: 'MISSING',
        quotaRatioInput: {
            presence: 'PRESENT',
            jsonType: 'string',
            parseState: 'MISSING',
            stringShape: 'EMPTY',
        },
        quotaRatio: '',
        classificationCode: '0',
        classificationLabel: '현재',
    });
    const attachedPnu =
        group.scopePnus.length === 2
            ? group.scopePnus.find(
                  (candidate) => candidate !== group.basePnu
              )!
            : null;
    const attachedPnuHash = attachedPnu
        ? sha256(`PNU\u0000${attachedPnu}`)
        : DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH;
    const scopeExposRecords = exposures
        .map((exposure) => {
            const {
                managementPkHash:
                    _endpointManagementPkHash,
                ...unitEvidence
            } = exposure;
            return {
                queryPnuHash: basePnuHash,
                rowPnuHash: basePnuHash,
                selfManagementPkHash: managementPkHash,
                rootManagementPkHash: managementPkHash,
                rootIdentitySource: 'SELF',
                ...unitEvidence,
            };
        })
        .sort((left, right) =>
            stableStringify(left).localeCompare(
                stableStringify(right)
            )
        );
    const pair = attachedPnu
        ? {
              managementPkHash,
              basePnuHash,
              attachedPnuHash,
          }
        : null;
    const attachedPairs = pair ? [pair] : [];
    const sample = {
        aliasHash: sha256(`ALIAS\u0000alias-${groupNumber}`),
        expectedBylot:
            group.scopePnus.length === 1
                ? 'ZERO'
                : 'POSITIVE',
        pnuHash: basePnuHash,
        endpoints: [
            {
                endpoint: 'getBrTitleInfo',
                state: 'COMPLETE',
                schemaHash: TEST_SCHEMA,
                totalCount: 1,
                pagesFetched: 1,
                inventory: boundedInventory('TITLE', [
                    {
                        managementPkHash,
                        bylot: {
                            presence: 'PRESENT',
                            jsonType: 'string',
                            parseState: 'VALID',
                            rawValue:
                                group.scopePnus.length - 1,
                            count: group.scopePnus.length - 1,
                        },
                    },
                ]),
            },
            {
                endpoint: 'getBrBasisOulnInfo',
                state: 'COMPLETE',
                schemaHash: TEST_SCHEMA,
                totalCount: 1,
                pagesFetched: 1,
                inventory: boundedInventory('BASIS', [
                    {
                        managementPkHash,
                        bylot: {
                            presence: 'PRESENT',
                            jsonType: 'string',
                            parseState: 'VALID',
                            rawValue:
                                group.scopePnus.length - 1,
                            count: group.scopePnus.length - 1,
                        },
                    },
                ]),
            },
            {
                endpoint: 'getBrAtchJibunInfo',
                state: attachedPnu
                    ? 'COMPLETE'
                    : 'COMPLETE_ZERO',
                schemaHash: attachedPnu
                    ? TEST_SCHEMA
                    : DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH,
                totalCount: attachedPairs.length,
                pagesFetched: 1,
                inventory: {
                    kind: 'ATTACHED',
                    pairs: attachedPairs,
                    rejected: [],
                    totalPairs: attachedPairs.length,
                    pairsTruncated: false,
                    pairsDigest: pair
                        ? sha256(stableStringify([pair]))
                        : DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST,
                    totalRejected: 0,
                    rejectedDigest: sha256('[]'),
                },
            },
            {
                endpoint: 'getBrExposInfo',
                state: 'COMPLETE',
                schemaHash: TEST_SCHEMA,
                totalCount: exposures.length,
                pagesFetched: 1,
                inventory: boundedInventory('EXPOS', exposures),
            },
            {
                endpoint: 'ladfrlList',
                state: 'COMPLETE',
                schemaHash: TEST_SCHEMA,
                totalCount: 1,
                pagesFetched: 1,
                inventory: boundedInventory('LADFRL', [
                    {
                        pnuHash: basePnuHash,
                        landArea: group.landParcels[0].area,
                    },
                ]),
            },
            {
                endpoint: 'ldaregList',
                state: 'COMPLETE',
                schemaHash: TEST_SCHEMA,
                totalCount: ldareg.length,
                pagesFetched: 1,
                inventory: boundedInventory('LDAREG', ldareg),
            },
        ],
        evidence: {
            scopeLadfrl: {
                status: 'PASS',
                records: group.landParcels
                    .map((parcel) => ({
                        pnuHash: sha256(`PNU\u0000${parcel.pnu}`),
                        area: parcel.area,
                    }))
                    .sort((left, right) =>
                        left.pnuHash < right.pnuHash ? -1 : 1
                    ),
                totalArea: denominator,
            },
            scopeExpos: {
                status: 'PASS',
                queries: group.scopePnus
                    .map((scopePnu) => {
                        const scopePnuHash = sha256(
                            `PNU\u0000${scopePnu}`
                        );
                        const isBase =
                            scopePnu === group.basePnu;
                        return {
                            pnuHash: scopePnuHash,
                            state: isBase
                                ? 'COMPLETE'
                                : 'COMPLETE_ZERO',
                            totalCount: isBase
                                ? scopeExposRecords.length
                                : 0,
                            pagesFetched: 1,
                        };
                    })
                    .sort((left, right) =>
                        stableStringify(left).localeCompare(
                            stableStringify(right)
                        )
                    ),
                records: scopeExposRecords,
                totalRecords: scopeExposRecords.length,
                truncated: false,
                sanitizedDigest: sha256(
                    stableStringify(scopeExposRecords)
                ),
            },
            ldaregReplication: {
                status: 'PASS',
                canonicalSourcePnuHash: basePnuHash,
                comparedPnuHashes: group.scopePnus
                    .map((scopePnu) =>
                        sha256(`PNU\u0000${scopePnu}`)
                    )
                    .sort(),
                rowCount: ldareg.length,
                rowMultisetDigest: sha256(
                    `REPLICATION-${groupNumber}`
                ),
            },
        },
        failureCodes: [],
        reviewCodes: ['LDAREG_RATIO_MISSING_OBSERVED'],
    } as unknown as LandAreaPhase0SampleArtifact;
    const artifact = {
        version: 'land-area-phase0-capture-artifact@6',
        schemaHash: LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH,
        gate: {
            status: 'PASS',
            failureCodes: [],
            reviewCodes: ['LDAREG_RATIO_MISSING_OBSERVED'],
        },
        samples: [sample],
    } as LandAreaPhase0CaptureArtifact;
    return {
        targetKey: group.key,
        runId: TEST_RUN_ID,
        artifactSha256: sha256(
            `ARTIFACT-${groupNumber}`
        ),
        artifact,
        sample,
    };
}

function fixture() {
    const groups = ACTIVE_COUNTS.map((_, index) =>
        makeGroup(index + 1)
    );
    const snapshot: DevelopmentApiLdaregBundleDbSnapshot = {
        version: DEVELOPMENT_API_LDAREG_DB_SNAPSHOT_VERSION,
        databaseTarget: 'development',
        projectRef: 'yxypndgipnxrdfyctmvh',
        groups,
    };
    const captures = groups.map(makeCapture);
    const unpinned = Object.fromEntries(
        DEVELOPMENT_API_LDAREG_TARGET_KEYS.map((key, index) => [
            key,
            {
                manifestDigest: String(index + 1).repeat(64),
                scopePnuCount:
                    key === 'ldareg-target-07' ? 2 : 1,
                bylotCount:
                    key === 'ldareg-target-07' ? 1 : 0,
                provisioned: false,
            },
        ])
    ) as DevelopmentApiLdaregTargetPins;
    return { snapshot, captures, unpinned };
}

function legacyFromTarget(
    target: DevelopmentApiLdaregTarget
): Record<string, unknown> {
    const {
        manifestDigest: _manifestDigest,
        ignoredOfficialUnits: _ignoredOfficialUnits,
        expectedIgnoredOfficialUnitCount:
            _expectedIgnoredOfficialUnitCount,
        ...rest
    } = target;
    const legacyWithoutDigest = {
        ...rest,
        version:
            'development-api-authoritative-ldareg-backfill-target@1',
        propertyTargets: target.propertyTargets.map(
            ({
                canonicalDong: _canonicalDong,
                providerShapeBridgeKind:
                    _providerShapeBridgeKind,
                ...property
            }) => property
        ),
    };
    return {
        ...legacyWithoutDigest,
        manifestDigest: sha256(
            stableStringify({
                ...legacyWithoutDigest,
                unionId: target.unionId.toLowerCase(),
                canonicalBuildingId:
                    target.canonicalBuildingId.toLowerCase(),
            })
        ),
    };
}

test('7-key 합성 bundle은 active 39, ignored 2를 exact partition하고 optional ignored count를 보존한다', () => {
    const { snapshot, captures, unpinned } = fixture();
    const bundle = buildDevelopmentApiLdaregTargetBundle({
        snapshot,
        captures,
        pins: unpinned,
    });
    assert.equal(bundle.targets.length, 7);
    assert.equal(
        bundle.targets.reduce(
            (sum, entry) =>
                sum + entry.target.propertyTargets.length,
            0
        ),
        39
    );
    assert.equal(
        bundle.targets.reduce(
            (sum, entry) =>
                sum +
                entry.target.ignoredOfficialUnits.length,
            0
        ),
        2
    );
    const shaped = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-05'
    )!.target;
    assert.equal(shaped.propertyTargets.length, 9);
    assert.equal(shaped.ignoredOfficialUnits.length, 2);
    assert.equal(shaped.expectedIgnoredPlaceholderCount, 1);
    assert.equal(shaped.expectedLdaregRowCount, 12);
    assert.equal(shaped.expectedIgnoredOfficialUnitCount, 2);
    assert.deepEqual(
        shaped.ignoredOfficialUnits.map(
            (unit) => unit.canonicalHo
        ),
        ['1001', '1101']
    );
    const dongFallback = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-01'
    )!.target;
    assert.equal(
        dongFallback.propertyTargets[0].expectedBuildingUnitId,
        uuid(3, 1, 1)
    );
    assert.equal(
        dongFallback.propertyTargets[0].canonicalDong,
        '101'
    );
    const target07 = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-07'
    )!.target;
    assert.ok(
        target07.propertyTargets.every(
            (target) => target.canonicalDong === '101'
        )
    );
    const activeAlias = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-02'
    )!.target;
    assert.equal(
        activeAlias.propertyTargets[0].expectedBuildingUnitId,
        uuid(3, 2, 1)
    );
    for (const entry of bundle.targets.filter(
        (candidate) => candidate.key !== 'ldareg-target-05'
    )) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                entry.target,
                'expectedIgnoredOfficialUnitCount'
            ),
            false
        );
    }
});

test('scope EXPOS logical union은 부속 PNU 전용 호실과 cross-PNU exact replica를 모두 보존한다', () => {
    const rewriteTarget07Scope = (
        value: ReturnType<typeof fixture>,
        mode: 'ATTACHED_ONLY' | 'EXACT_REPLICA'
    ) => {
        const capture = value.captures[6];
        const sample = capture.sample;
        const scope = sample.evidence.scopeExpos;
        const baseHash = sample.pnuHash;
        const attachedHash = sha256(
            `PNU\u0000${pnu(7, true)}`
        );
        const baseRows = scope.records.map((row) => ({
            ...row,
            queryPnuHash: baseHash,
            rowPnuHash: baseHash,
        }));
        const attachedRows = baseRows.map((row) => ({
            ...row,
            queryPnuHash: attachedHash,
            rowPnuHash: attachedHash,
        }));
        scope.records =
            mode === 'ATTACHED_ONLY'
                ? attachedRows
                : [...baseRows, ...attachedRows];
        scope.records.sort((left, right) =>
            stableStringify(left).localeCompare(
                stableStringify(right)
            )
        );
        scope.queries = [
            {
                pnuHash: baseHash,
                state:
                    mode === 'ATTACHED_ONLY'
                        ? 'COMPLETE_ZERO'
                        : 'COMPLETE',
                totalCount:
                    mode === 'ATTACHED_ONLY'
                        ? 0
                        : baseRows.length,
                pagesFetched: 1,
            },
            {
                pnuHash: attachedHash,
                state: 'COMPLETE',
                totalCount: attachedRows.length,
                pagesFetched: 1,
            },
        ].sort((left, right) =>
            stableStringify(left).localeCompare(
                stableStringify(right)
            )
        ) as typeof scope.queries;
        scope.totalRecords = scope.records.length;
        scope.sanitizedDigest = sha256(
            stableStringify(scope.records)
        );
        if (mode === 'ATTACHED_ONLY') {
            const endpoint = sample.endpoints.find(
                (entry) =>
                    entry.endpoint === 'getBrExposInfo'
            )!;
            endpoint.state = 'COMPLETE_ZERO';
            endpoint.schemaHash =
                DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH;
            endpoint.totalCount = 0;
            const inventory = endpoint.inventory as {
                kind: 'EXPOS';
                records: Array<Record<string, unknown>>;
                totalRecords: number;
                truncated: boolean;
                sanitizedDigest: string;
            };
            inventory.records = [];
            inventory.totalRecords = 0;
            inventory.sanitizedDigest = sha256('[]');
        }
    };

    for (const mode of [
        'ATTACHED_ONLY',
        'EXACT_REPLICA',
    ] as const) {
        const value = fixture();
        rewriteTarget07Scope(value, mode);
        const bundle = buildDevelopmentApiLdaregTargetBundle({
            snapshot: value.snapshot,
            captures: value.captures,
            pins: value.unpinned,
        });
        assert.equal(
            bundle.targets.find(
                (entry) => entry.key === 'ldareg-target-07'
            )!.target.propertyTargets.length,
            4
        );
    }
});

test('standard hash를 먼저 사용하고 exact provider bridge만 residual 1:1로 사용한다', () => {
    const { snapshot, captures, unpinned } = fixture();
    const bundle = buildDevelopmentApiLdaregTargetBundle({
        snapshot,
        captures,
        pins: unpinned,
    });
    const above = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-01'
    )!.target;
    assert.ok(
        above.propertyTargets.every(
            (target) =>
                target.providerShapeBridgeKind ===
                PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX
        )
    );
    const basement = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-03'
    )!.target;
    assert.equal(
        basement.propertyTargets.filter(
            (target) =>
                target.providerShapeBridgeKind ===
                PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO
        ).length,
        2
    );
    const floor = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-04'
    )!.target;
    assert.deepEqual(
        floor.propertyTargets
            .map((target) => target.providerShapeBridgeKind)
            .sort(),
        [
            PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
            PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
            PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
        ].sort()
    );
    const standard = bundle.targets.find(
        (entry) => entry.key === 'ldareg-target-02'
    )!.target;
    assert.ok(
        standard.propertyTargets.every(
            (target) => target.providerShapeBridgeKind === null
        )
    );
});

test('provider helper는 padded 지하와 above/floor exact witness를 동일 bridge key로 만든다', () => {
    const basementExpos = providerUnitShapeWitness(
        'EXPOS_UNIT',
        { flrGbCd: '10', flrNoNm: '1', hoNm: 'B01' }
    );
    const basementLdareg = providerUnitShapeWitness(
        'LDAREG_UNIT',
        { buldFloorNm: '지하', buldHoNm: '비01' }
    );
    assert.ok(basementExpos);
    assert.ok(basementLdareg);
    assert.equal(
        providerUnitShapeWitnessKey(basementExpos),
        providerUnitShapeWitnessKey(basementLdareg)
    );
    const aboveExpos = providerUnitShapeWitness(
        'EXPOS_UNIT',
        { flrGbCd: '20', flrNoNm: '2', hoNm: '201' }
    );
    const aboveLdareg = providerUnitShapeWitness(
        'LDAREG_UNIT',
        { buldFloorNm: '지상2', buldHoNm: '201' }
    );
    assert.equal(
        providerUnitShapeWitnessKey(aboveExpos!),
        providerUnitShapeWitnessKey(aboveLdareg!)
    );
    const floorExpos = providerUnitShapeWitness(
        'EXPOS_UNIT',
        { flrGbCd: '20', flrNoNm: '3', hoNm: '3층' }
    );
    const floorLdareg = providerUnitShapeWitness(
        'LDAREG_UNIT',
        { buldFloorNm: '3', buldHoNm: '0000' }
    );
    assert.equal(
        providerUnitShapeWitnessKey(floorExpos!),
        providerUnitShapeWitnessKey(floorLdareg!)
    );
});

test('hash mismatch, ambiguity, duplicate tuple, unmatched active, denominator drift를 fail-closed한다', () => {
    const cases: Array<
        (fixtureValue: ReturnType<typeof fixture>) => void
    > = [
        ({ captures }) => {
            const record = (
                captures[1].sample.endpoints.find(
                    (entry) =>
                        entry.endpoint === 'ldaregList'
                )!.inventory as {
                records: Array<Record<string, unknown>>;
            }
            ).records[0];
            record.unitIdentityHash = 'f'.repeat(64);
        },
        ({ captures }) => {
            const inventory = captures[1].sample.endpoints.find(
                (entry) => entry.endpoint === 'getBrExposInfo'
            )!.inventory as {
                records: Array<Record<string, unknown>>;
                totalRecords: number;
            };
            inventory.records[1].unitIdentityHash =
                inventory.records[0].unitIdentityHash;
        },
        ({ snapshot }) => {
            snapshot.groups[1].units.push({
                buildingUnitId: uuid(9, 2, 98),
                buildingUnitPnu: snapshot.groups[1].basePnu,
                rawDong:
                    snapshot.groups[1].units[0].rawDong,
                rawFloor:
                    snapshot.groups[1].units[0].rawFloor,
                rawHo: snapshot.groups[1].units[0].rawHo,
                activePropertyUnit: {
                    propertyUnitId: uuid(8, 2, 98),
                    pnu: snapshot.groups[1].basePnu,
                },
            });
        },
        ({ snapshot }) => {
            snapshot.groups[1].units.push({
                buildingUnitId: uuid(9, 2, 99),
                buildingUnitPnu: snapshot.groups[1].basePnu,
                rawDong: null,
                rawFloor: null,
                rawHo: '9901',
                activePropertyUnit: {
                    propertyUnitId: uuid(8, 2, 99),
                    pnu: snapshot.groups[1].basePnu,
                },
            });
        },
        ({ snapshot }) => {
            snapshot.groups[1].units[0].activePropertyUnit =
                null;
        },
        ({ captures }) => {
            const record = (
                captures[1].sample.endpoints.find(
                    (entry) =>
                        entry.endpoint === 'ldaregList'
                )!.inventory as {
                records: Array<Record<string, unknown>>;
            }
            ).records[0];
            record.quotaRatio = '10/999';
        },
        ({ snapshot }) => {
            snapshot.groups[1].units[0].rawFloor = '99';
        },
        ({ captures }) => {
            captures[1].sample.evidence.ldaregReplication.comparedPnuHashes =
                ['f'.repeat(64)];
        },
        ({ captures }) => {
            captures[1].sample.evidence.ldaregReplication.rowMultisetDigest =
                'not-a-digest';
        },
        ({ snapshot }) => {
            snapshot.groups[0].units.forEach((unit) => {
                unit.rawDong = null;
            });
        },
        ({ snapshot, captures }) => {
            const expos = captures[0].sample.endpoints.find(
                (entry) => entry.endpoint === 'getBrExposInfo'
            )!.inventory as {
                records: Array<Record<string, unknown>>;
            };
            expos.records[1].floorHoIdentityHash =
                expos.records[0].floorHoIdentityHash;
            snapshot.groups[0].units[0].rawFloor = null;
        },
        ({ snapshot }) => {
            snapshot.groups[0].units[0].rawDong = '999동';
        },
        ({ snapshot }) => {
            for (let index = 0; index < 33; index += 1) {
                snapshot.groups[1].units.push({
                    buildingUnitId: uuid(9, 2, index + 1),
                    buildingUnitPnu:
                        snapshot.groups[1].basePnu,
                    rawDong: `${index + 1}동`,
                    rawFloor: null,
                    rawHo: null,
                    activePropertyUnit: null,
                });
            }
        },
    ];
    for (const mutate of cases) {
        const value = fixture();
        mutate(value);
        assert.throws(() =>
            buildDevelopmentApiLdaregTargetBundle({
                snapshot: value.snapshot,
                captures: value.captures,
                pins: value.unpinned,
            })
        );
    }
});

test('snapshot/artifact schema·version drift와 MANUAL 계열 decision field를 거부한다', () => {
    const { snapshot, captures, unpinned } = fixture();
    assert.throws(() =>
        parseDevelopmentApiLdaregBundleDbSnapshot({
            ...snapshot,
            version: 'wrong',
        })
    );
    assert.throws(() =>
        parseDevelopmentApiLdaregBundleDbSnapshot({
            ...snapshot,
            MANUAL: true,
        })
    );
    assert.throws(() =>
        parseDevelopmentApiLdaregBundleDbSnapshot({
            ...snapshot,
            groups: snapshot.groups.map((group, index) =>
                index === 0
                    ? {
                          ...group,
                          units: group.units.map((unit, unitIndex) =>
                              unitIndex === 0
                                  ? {
                                        ...unit,
                                        land_area: '999',
                                    }
                                  : unit
                          ),
                      }
                    : group
            ),
        })
    );
    const versionDrift = structuredClone(captures);
    (
        versionDrift[0].artifact as unknown as {
            version: string;
        }
    ).version = 'wrong';
    assert.throws(() =>
        buildDevelopmentApiLdaregTargetBundle({
            snapshot,
            captures: versionDrift,
            pins: unpinned,
        })
    );
    const schemaDrift = structuredClone(captures);
    schemaDrift[0].artifact.schemaHash = '0'.repeat(64);
    assert.throws(() =>
        buildDevelopmentApiLdaregTargetBundle({
            snapshot,
            captures: schemaDrift,
            pins: unpinned,
        })
    );
});

test('capture index는 six-shared artifact와 target07 별도 artifact를 opaque key로 표현한다', () => {
    const bindings = DEVELOPMENT_API_LDAREG_TARGET_KEYS.map(
        (targetKey, index) => ({
            targetKey,
            artifactKey:
                index < 6 ? 'shared-six' : 'legacy-seven',
            alias: `alias-${index + 1}`,
        })
    );
    const parsed = parseDevelopmentApiLdaregCaptureIndex({
        version: DEVELOPMENT_API_LDAREG_CAPTURE_INDEX_VERSION,
        artifacts: [
            {
                key: 'shared-six',
                artifactFile: 'six.json',
                artifactSha256: '1'.repeat(64),
                manifestFile: 'six-manifest.json',
                manifestSha256: '2'.repeat(64),
                runId: '90000000001',
            },
            {
                key: 'legacy-seven',
                artifactFile: 'seven.json',
                artifactSha256: '3'.repeat(64),
                manifestFile: 'seven-manifest.json',
                manifestSha256: '4'.repeat(64),
                runId: '90000000002',
            },
        ],
        bindings,
    });
    assert.equal(
        parsed.bindings.filter(
            (binding) => binding.artifactKey === 'shared-six'
        ).length,
        6
    );
    assert.equal(
        parsed.bindings.filter(
            (binding) => binding.artifactKey === 'legacy-seven'
        ).length,
        1
    );
    assert.throws(() =>
        parseDevelopmentApiLdaregCaptureIndex({
            ...parsed,
            artifacts: parsed.artifacts.map(
                (artifact, index) =>
                    index === 1
                        ? {
                              ...artifact,
                              artifactFile:
                                  parsed.artifacts[0]
                                      .artifactFile,
                          }
                        : artifact
            ),
        })
    );
    assert.throws(() =>
        parseDevelopmentApiLdaregCaptureIndex({
            ...parsed,
            bindings: parsed.bindings.map(
                (binding, index) =>
                    index === 6
                        ? {
                              ...binding,
                              artifactKey:
                                  parsed.bindings[0]
                                      .artifactKey,
                              alias: parsed.bindings[0].alias,
                          }
                        : binding
            ),
        })
    );
});

test('legacy target07 empty-dong은 canonical-dong v2 전환을 요구하고 새 digest만 explicit pin 가능하다', () => {
    const { snapshot, captures, unpinned } = fixture();
    const initial = buildDevelopmentApiLdaregTargetBundle({
        snapshot,
        captures,
        pins: unpinned,
    });
    const target07 = initial.targets.find(
        (entry) => entry.key === 'ldareg-target-07'
    )!.target;
    const legacy = legacyFromTarget(target07);
    const transformed =
        transformLegacyDevelopmentApiLdaregTarget(legacy);
    assert.ok(
        transformed.propertyTargets.every(
            (target) => target.canonicalDong === ''
        )
    );
    assert.ok(
        target07.propertyTargets.every(
            (target) => target.canonicalDong === '101'
        )
    );
    assert.throws(
        () =>
            buildDevelopmentApiLdaregTargetBundle({
                snapshot,
                captures,
                legacyTarget07: legacy,
                pins: unpinned,
            }),
        /LEGACY_TARGET_07_CANONICAL_DONG_UPGRADE_REQUIRED/
    );
    const driftedSnapshot = structuredClone(snapshot);
    driftedSnapshot.groups[6].propertyUnitDigest =
        '9'.repeat(64);
    assert.throws(
        () =>
            buildDevelopmentApiLdaregTargetBundle({
                snapshot: driftedSnapshot,
                captures,
                legacyTarget07: legacy,
                pins: unpinned,
            }),
        /LEGACY_TARGET_07_PIN_MISMATCH/
    );
    const newV2Pinned = {
        ...unpinned,
        'ldareg-target-07': {
            ...unpinned['ldareg-target-07'],
            manifestDigest: target07.manifestDigest,
            provisioned: true,
        },
    } as DevelopmentApiLdaregTargetPins;
    const rebuilt = buildDevelopmentApiLdaregTargetBundle({
        snapshot,
        captures,
        pins: newV2Pinned,
    });
    assert.equal(
        rebuilt.targets.find(
            (entry) => entry.key === 'ldareg-target-07'
        )!.target.manifestDigest,
        target07.manifestDigest
    );
    const staleLegacyPinned = {
        ...unpinned,
        'ldareg-target-07': {
            ...unpinned['ldareg-target-07'],
            manifestDigest: transformed.manifestDigest,
            provisioned: true,
        },
    } as DevelopmentApiLdaregTargetPins;
    assert.throws(() =>
        buildDevelopmentApiLdaregTargetBundle({
            snapshot,
            captures,
            pins: staleLegacyPinned,
        })
    );
});

test('private file 경계는 0700 root/0600 regular/fd inode를 요구하고 symlink·재사용 출력을 거부한다', async () => {
    const root = await mkdtemp(
        path.join(tmpdir(), 'ldareg-private-test-')
    );
    await chmod(root, 0o700);
    const input = path.join(root, 'input.json');
    await writeFile(input, '{"ok":true}\n', { mode: 0o600 });
    await chmod(input, 0o600);
    const read = await readPinnedPrivateFile({
        privateRoot: root,
        filename: 'input.json',
        maxBytes: 1024,
    });
    assert.equal(read.body.toString('utf8'), '{"ok":true}\n');
    await writeExclusivePrivateFile({
        privateRoot: root,
        filename: 'output.json',
        body: Buffer.from('{"built":true}\n'),
        maxBytes: 1024,
    });
    assert.equal(
        (await lstat(path.join(root, 'output.json'))).mode &
            0o777,
        0o600
    );
    await assert.rejects(() =>
        writeExclusivePrivateFile({
            privateRoot: root,
            filename: 'output.json',
            body: Buffer.from('{"again":true}\n'),
            maxBytes: 1024,
        })
    );
    await symlink(input, path.join(root, 'link.json'));
    await assert.rejects(() =>
        readPinnedPrivateFile({
            privateRoot: root,
            filename: 'link.json',
            maxBytes: 1024,
        })
    );
    const hardSource = path.join(root, 'hard-source.json');
    await writeFile(hardSource, '{"hard":true}\n', {
        mode: 0o600,
    });
    await chmod(hardSource, 0o600);
    await link(hardSource, path.join(root, 'hard-alias.json'));
    await assert.rejects(() =>
        readPinnedPrivateFile({
            privateRoot: root,
            filename: 'hard-source.json',
            maxBytes: 1024,
        })
    );
    await chmod(input, 0o644);
    await assert.rejects(() =>
        readPinnedPrivateFile({
            privateRoot: root,
            filename: 'input.json',
            maxBytes: 1024,
        })
    );
    assert.equal(
        await readFile(path.join(root, 'output.json'), 'utf8'),
        '{"built":true}\n'
    );
});

test('approval installer는 production URL을 credential/file/network 전에 거부하고 secret을 출력하지 않는다', async () => {
    let networkCalls = 0;
    let credentialReads = 0;
    const secret = 'SYNTHETIC-SECRET-NEVER-OUTPUT-123456';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code =
        await runDevelopmentApiLdaregApprovalRpcInstaller(
            [
                '--private-root',
                '/nonexistent-private-root',
                '--target',
                'target.json',
                '--artifact',
                'artifact.json',
                '--request',
                'request.json',
                '--source-release-sha',
                'a'.repeat(40),
                '--project-url',
                'https://synthetic-production.supabase.co',
            ],
            {
                env: {
                    LDAREG_OWNER_SUPABASE_SERVICE_ROLE_KEY:
                        secret,
                },
                readCredential: async () => {
                    credentialReads += 1;
                    return secret;
                },
                fetchImpl: async () => {
                    networkCalls += 1;
                    return new Response(null, { status: 204 });
                },
                stdout: (message) => stdout.push(message),
                stderr: (message) => stderr.push(message),
            }
        );
    assert.equal(code, 2);
    assert.equal(networkCalls, 0);
    assert.equal(credentialReads, 0);
    assert.deepEqual(stdout, []);
    assert.equal(stderr.length, 1);
    assert.doesNotMatch(stderr[0], new RegExp(secret));
    assert.equal(
        DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL,
        'https://yxypndgipnxrdfyctmvh.supabase.co'
    );
    assert.equal(
        DEVELOPMENT_API_LDAREG_APPROVAL_INSTALL_SENTINEL,
        'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_OWNER_APPROVAL_INSTALLED'
    );
});

test('pinned DEV approval helper는 exact RPC URL/body로 한 번만 호출한다', async () => {
    const credential =
        'SYNTHETIC-DEV-OWNER-CREDENTIAL-ONLY-FOR-TEST';
    const approvalArgs = {
        p_target_digest: 'a'.repeat(64),
        p_evidence_digest: 'b'.repeat(64),
    };
    const calls: Array<{
        url: string;
        init: RequestInit | undefined;
    }> = [];
    await invokePinnedDevelopmentApiLdaregApprovalRpc(
        {
            projectUrl:
                DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL,
            approvalName:
                'replace_development_api_authoritative_ldareg_backfill_approval_v1',
            approvalArgs,
            credential,
        },
        {
            fetchImpl: async (url, init) => {
                calls.push({
                    url: String(url),
                    init,
                });
                return new Response(null, { status: 204 });
            },
        }
    );
    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].url,
        `${DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL}/rest/v1/rpc/replace_development_api_authoritative_ldareg_backfill_approval_v1`
    );
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(
        calls[0].init?.body,
        JSON.stringify(approvalArgs)
    );
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get('apikey'), credential);
    assert.equal(
        headers.get('authorization'),
        `Bearer ${credential}`
    );
});

test('bundle builder 진단은 allowlisted code만 출력하고 argv 원문을 반사하지 않는다', async () => {
    const secret = 'SYNTHETIC-ARGV-SECRET-NEVER-REFLECT';
    const stderr: string[] = [];
    const code = await runDevelopmentApiLdaregTargetBundleBuilder(
        ['--unknown', secret],
        {
            stdout: () => {
                assert.fail('stdout must remain empty');
            },
            stderr: (message) => stderr.push(message),
        }
    );
    assert.equal(code, 2);
    assert.equal(stderr.length, 1);
    assert.match(
        stderr[0],
        /code=BUNDLE_BUILD_ARGUMENT_INVALID$/
    );
    assert.doesNotMatch(stderr[0], new RegExp(secret));
    assert.equal(
        DEVELOPMENT_API_LDAREG_BUNDLE_BUILD_SENTINEL,
        'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_TARGET_BUNDLE_BUILT'
    );
});
