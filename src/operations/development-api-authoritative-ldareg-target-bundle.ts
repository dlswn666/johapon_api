import { createHash } from 'node:crypto';
import {
    DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST,
    DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH,
    DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH,
    DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST,
    DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION,
    DEVELOPMENT_API_LDAREG_TARGET_KEYS,
    DEVELOPMENT_API_LDAREG_TARGET_VERSION,
    computeDevelopmentApiLdaregManifestDigest,
    parseDevelopmentApiLdaregTarget,
    parseDevelopmentApiLdaregTargetBundle,
    type DevelopmentApiLdaregTarget,
    type DevelopmentApiLdaregTargetBundle,
    type DevelopmentApiLdaregTargetKey,
    type DevelopmentApiLdaregTargetPins,
} from './development-api-authoritative-ldareg-backfill';
import {
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
    type ProviderUnitShapeBridgeKind,
} from '../services/land-area-sync/provider-unit-shape-bridge';
import { normalizeUnitSegment } from '../services/land-area-sync/normalizer';
import { normalizeFloorLabel } from '../services/land-area-sync/preview';
import { parseLdaQotaRate } from '../services/land-area-sync/ratio';
import { normalizeRegistryManagementPk } from '../services/land-area-sync/registry-pk';
import type {
    LandAreaPhase0CaptureArtifact,
    LandAreaPhase0SampleArtifact,
} from '../verification/land-area-phase0-capture';
import { resolveLandAreaPhase0ScopeExposRecords } from '../verification/land-area-phase0-capture';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^\d{10}[12]\d{8}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const SAFE_DECIMAL_RE =
    /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;
const OPAQUE_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PROJECT_REF = 'yxypndgipnxrdfyctmvh';
const LEGACY_TARGET_VERSION =
    'development-api-authoritative-ldareg-backfill-target@1';
const FORBIDDEN_SNAPSHOT_KEYS = new Set([
    'manual',
    'land_area',
    'landarea',
    'source',
]);

const BRIDGE_KINDS = new Set<ProviderUnitShapeBridgeKind>([
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
]);

export const DEVELOPMENT_API_LDAREG_DB_SNAPSHOT_VERSION =
    'development-api-authoritative-ldareg-db-snapshot@1' as const;
export const DEVELOPMENT_API_LDAREG_CAPTURE_INDEX_VERSION =
    'development-api-authoritative-ldareg-phase0-capture-index@1' as const;

export interface DevelopmentApiLdaregBundleDbUnit {
    buildingUnitId: string;
    buildingUnitPnu: string;
    rawDong: string | null;
    rawFloor: string | null;
    rawHo: string | null;
    activePropertyUnit: {
        propertyUnitId: string;
        pnu: string;
    } | null;
}

export interface DevelopmentApiLdaregBundleDbGroup {
    key: DevelopmentApiLdaregTargetKey;
    unionId: string;
    basePnu: string;
    managementPk: string;
    canonicalBuildingId: string;
    scopePnus: string[];
    scopeDigest: string;
    propertyUnitDigest: string;
    units: DevelopmentApiLdaregBundleDbUnit[];
    landParcels: Array<{
        pnu: string;
        area: string;
    }>;
    expectedIgnoredOfficialUnitCount?: number;
}

export interface DevelopmentApiLdaregBundleDbSnapshot {
    version: typeof DEVELOPMENT_API_LDAREG_DB_SNAPSHOT_VERSION;
    databaseTarget: 'development';
    projectRef: typeof PROJECT_REF;
    groups: DevelopmentApiLdaregBundleDbGroup[];
}

interface ParsedDbUnit
    extends Omit<
        DevelopmentApiLdaregBundleDbUnit,
        'buildingUnitId'
    > {
    unitId: string;
}

interface ParsedDbGroup
    extends Omit<DevelopmentApiLdaregBundleDbGroup, 'units'> {
    units: ParsedDbUnit[];
}

interface ParsedDbSnapshot
    extends Omit<DevelopmentApiLdaregBundleDbSnapshot, 'groups'> {
    groups: ParsedDbGroup[];
}

export interface DevelopmentApiLdaregCaptureIndex {
    version: typeof DEVELOPMENT_API_LDAREG_CAPTURE_INDEX_VERSION;
    artifacts: Array<{
        key: string;
        artifactFile: string;
        artifactSha256: string;
        manifestFile: string;
        manifestSha256: string;
        runId: string;
    }>;
    bindings: Array<{
        targetKey: DevelopmentApiLdaregTargetKey;
        artifactKey: string;
        alias: string;
    }>;
}

export interface DevelopmentApiLdaregResolvedCapture {
    targetKey: DevelopmentApiLdaregTargetKey;
    runId: string;
    artifactSha256: string;
    artifact: LandAreaPhase0CaptureArtifact;
    sample: LandAreaPhase0SampleArtifact;
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .filter((key) => value[key] !== undefined)
                .map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function isRecord(
    value: unknown
): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function record(
    value: unknown,
    code: string
): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(code);
    return value;
}

function exactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    const allowed = new Set([...required, ...optional]);
    return (
        required.every((key) =>
            Object.prototype.hasOwnProperty.call(value, key)
        ) &&
        Object.keys(value).every((key) => allowed.has(key))
    );
}

function isTargetKey(
    value: unknown
): value is DevelopmentApiLdaregTargetKey {
    return (
        typeof value === 'string' &&
        (
            DEVELOPMENT_API_LDAREG_TARGET_KEYS as readonly string[]
        ).includes(value)
    );
}

function canonicalDecimal(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    return canonicalFraction
        ? `${canonicalWhole}.${canonicalFraction}`
        : canonicalWhole;
}

function positiveDecimal(value: unknown, code: string): string {
    if (typeof value !== 'string' || !SAFE_DECIMAL_RE.test(value)) {
        throw new Error(code);
    }
    const canonical = canonicalDecimal(value);
    if (decimalUnits(canonical) <= 0n) throw new Error(code);
    return canonical;
}

function decimalUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return (
        BigInt(whole) * 100_000_000n +
        BigInt(fraction.padEnd(8, '0'))
    );
}

function unitsDecimal(value: bigint): string {
    const whole = value / 100_000_000n;
    const fraction = String(value % 100_000_000n)
        .padStart(8, '0')
        .replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : String(whole);
}

function canonicalDong(value: unknown): string {
    if (typeof value !== 'string') return '';
    const normalized = normalizeUnitSegment(value);
    return normalized !== '' && /^0+$/.test(normalized)
        ? ''
        : normalized;
}

function assertNoDecisionContamination(
    value: unknown,
    seen = new Set<unknown>()
): void {
    if (
        value === null ||
        typeof value !== 'object' ||
        seen.has(value)
    ) {
        return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((entry) =>
            assertNoDecisionContamination(entry, seen)
        );
        return;
    }
    for (const [key, nested] of Object.entries(
        value as Record<string, unknown>
    )) {
        const normalized = key.toLowerCase().replaceAll('-', '_');
        if (FORBIDDEN_SNAPSHOT_KEYS.has(normalized)) {
            throw new Error('DB_SNAPSHOT_FORBIDDEN_DECISION_FIELD');
        }
        assertNoDecisionContamination(nested, seen);
    }
}

function exactSortedUnique(values: string[]): boolean {
    return (
        new Set(values).size === values.length &&
        values.every(
            (value, index) =>
                index === 0 || values[index - 1] < value
        )
    );
}

function parseDbUnit(
    input: unknown
): ParsedDbUnit {
    const value = record(input, 'DB_UNIT_INVALID');
    if (
        !exactKeys(value, [
            'buildingUnitId',
            'buildingUnitPnu',
            'rawDong',
            'rawFloor',
            'rawHo',
            'activePropertyUnit',
        ]) ||
        typeof value.buildingUnitId !== 'string' ||
        !UUID_RE.test(value.buildingUnitId) ||
        typeof value.buildingUnitPnu !== 'string' ||
        !PNU_RE.test(value.buildingUnitPnu) ||
        !(
            value.rawDong === null ||
            (typeof value.rawDong === 'string' &&
                value.rawDong.length <= 100)
        ) ||
        !(
            value.rawFloor === null ||
            (typeof value.rawFloor === 'string' &&
                value.rawFloor.length <= 100)
        ) ||
        !(
            value.rawHo === null ||
            (typeof value.rawHo === 'string' &&
                value.rawHo.length <= 100)
        )
    ) {
        throw new Error('DB_UNIT_INVALID');
    }
    let activePropertyUnit: ParsedDbUnit['activePropertyUnit'] =
        null;
    if (value.activePropertyUnit !== null) {
        const active = record(
            value.activePropertyUnit,
            'DB_UNIT_INVALID'
        );
        if (
            !exactKeys(active, ['propertyUnitId', 'pnu']) ||
            typeof active.propertyUnitId !== 'string' ||
            !UUID_RE.test(active.propertyUnitId) ||
            typeof active.pnu !== 'string' ||
            !PNU_RE.test(active.pnu)
        ) {
            throw new Error('DB_UNIT_INVALID');
        }
        activePropertyUnit = {
            propertyUnitId: active.propertyUnitId.toLowerCase(),
            pnu: active.pnu,
        };
    }
    return {
        unitId: value.buildingUnitId.toLowerCase(),
        buildingUnitPnu: value.buildingUnitPnu,
        rawDong: value.rawDong,
        rawFloor: value.rawFloor,
        rawHo: value.rawHo,
        activePropertyUnit,
    };
}

function parseDbGroup(
    input: unknown
): ParsedDbGroup {
    const value = record(input, 'DB_GROUP_INVALID');
    const hasExpectedIgnored = Object.prototype.hasOwnProperty.call(
        value,
        'expectedIgnoredOfficialUnitCount'
    );
    if (
        !exactKeys(
            value,
            [
                'key',
                'unionId',
                'basePnu',
                'managementPk',
                'canonicalBuildingId',
                'scopePnus',
                'scopeDigest',
                'propertyUnitDigest',
                'units',
                'landParcels',
            ],
            ['expectedIgnoredOfficialUnitCount']
        ) ||
        !isTargetKey(value.key) ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        typeof value.basePnu !== 'string' ||
        !PNU_RE.test(value.basePnu) ||
        typeof value.managementPk !== 'string' ||
        normalizeRegistryManagementPk(value.managementPk) !==
            value.managementPk ||
        typeof value.canonicalBuildingId !== 'string' ||
        !UUID_RE.test(value.canonicalBuildingId) ||
        !Array.isArray(value.scopePnus) ||
        ![1, 2].includes(value.scopePnus.length) ||
        !value.scopePnus.every(
            (pnu) =>
                typeof pnu === 'string' && PNU_RE.test(pnu)
        ) ||
        !exactSortedUnique(value.scopePnus as string[]) ||
        !(value.scopePnus as string[]).includes(value.basePnu) ||
        typeof value.scopeDigest !== 'string' ||
        !HEX64_RE.test(value.scopeDigest) ||
        typeof value.propertyUnitDigest !== 'string' ||
        !HEX64_RE.test(value.propertyUnitDigest) ||
        !Array.isArray(value.units) ||
        value.units.length < 1 ||
        value.units.length > 200 ||
        !Array.isArray(value.landParcels) ||
        value.landParcels.length !== value.scopePnus.length ||
        (hasExpectedIgnored &&
            (typeof value.expectedIgnoredOfficialUnitCount !==
                'number' ||
                !Number.isSafeInteger(
                    value.expectedIgnoredOfficialUnitCount
                ) ||
                value.expectedIgnoredOfficialUnitCount < 0))
    ) {
        throw new Error('DB_GROUP_INVALID');
    }
    const scopePnus = [...(value.scopePnus as string[])];
    const units = value.units
        .map(parseDbUnit)
        .sort((left, right) =>
            left.unitId < right.unitId ? -1 : 1
        );
    const propertyIds = units
        .map((unit) => unit.activePropertyUnit?.propertyUnitId)
        .filter((id): id is string => id !== undefined);
    const unitIds = units.map((unit) => unit.unitId);
    if (
        !exactSortedUnique(unitIds) ||
        new Set(propertyIds).size !== propertyIds.length ||
        units.some(
            (unit) =>
                !scopePnus.includes(unit.buildingUnitPnu) ||
                (unit.activePropertyUnit !== null &&
                    !scopePnus.includes(
                        unit.activePropertyUnit.pnu
                    ))
        )
    ) {
        throw new Error('DB_GROUP_MEMBERSHIP_INVALID');
    }
    const landParcels = value.landParcels
        .map((entry) => {
            const row = record(entry, 'DB_LAND_PARCEL_INVALID');
            if (
                !exactKeys(row, ['pnu', 'area']) ||
                typeof row.pnu !== 'string' ||
                !PNU_RE.test(row.pnu)
            ) {
                throw new Error('DB_LAND_PARCEL_INVALID');
            }
            return {
                pnu: row.pnu,
                area: positiveDecimal(
                    row.area,
                    'DB_LAND_PARCEL_INVALID'
                ),
            };
        })
        .sort((left, right) => (left.pnu < right.pnu ? -1 : 1));
    if (
        !exactSortedUnique(
            landParcels.map((parcel) => parcel.pnu)
        ) ||
        stableStringify(
            landParcels.map((parcel) => parcel.pnu)
        ) !== stableStringify(scopePnus)
    ) {
        throw new Error('DB_LAND_PARCEL_INVALID');
    }
    return {
        key: value.key,
        unionId: value.unionId.toLowerCase(),
        basePnu: value.basePnu,
        managementPk: value.managementPk,
        canonicalBuildingId:
            value.canonicalBuildingId.toLowerCase(),
        scopePnus,
        scopeDigest: value.scopeDigest,
        propertyUnitDigest: value.propertyUnitDigest,
        units,
        landParcels,
        ...(hasExpectedIgnored
            ? {
                  expectedIgnoredOfficialUnitCount:
                      value.expectedIgnoredOfficialUnitCount as number,
              }
            : {}),
    };
}

export function parseDevelopmentApiLdaregBundleDbSnapshot(
    input: unknown
): ParsedDbSnapshot {
    assertNoDecisionContamination(input);
    const value = record(input, 'DB_SNAPSHOT_INVALID');
    if (
        !exactKeys(value, [
            'version',
            'databaseTarget',
            'projectRef',
            'groups',
        ]) ||
        value.version !==
            DEVELOPMENT_API_LDAREG_DB_SNAPSHOT_VERSION ||
        value.databaseTarget !== 'development' ||
        value.projectRef !== PROJECT_REF ||
        !Array.isArray(value.groups) ||
        value.groups.length !==
            DEVELOPMENT_API_LDAREG_TARGET_KEYS.length
    ) {
        throw new Error('DB_SNAPSHOT_INVALID');
    }
    const groups = value.groups
        .map(parseDbGroup)
        .sort((left, right) => (left.key < right.key ? -1 : 1));
    if (
        stableStringify(groups.map((group) => group.key)) !==
        stableStringify(DEVELOPMENT_API_LDAREG_TARGET_KEYS)
    ) {
        throw new Error('DB_SNAPSHOT_KEY_SET_INVALID');
    }
    return {
        version: DEVELOPMENT_API_LDAREG_DB_SNAPSHOT_VERSION,
        databaseTarget: 'development',
        projectRef: PROJECT_REF,
        groups,
    };
}

export function parseDevelopmentApiLdaregCaptureIndex(
    input: unknown
): DevelopmentApiLdaregCaptureIndex {
    const value = record(input, 'CAPTURE_INDEX_INVALID');
    if (
        !exactKeys(value, ['version', 'artifacts', 'bindings']) ||
        value.version !==
            DEVELOPMENT_API_LDAREG_CAPTURE_INDEX_VERSION ||
        !Array.isArray(value.artifacts) ||
        value.artifacts.length < 1 ||
        value.artifacts.length > 7 ||
        !Array.isArray(value.bindings) ||
        value.bindings.length !==
            DEVELOPMENT_API_LDAREG_TARGET_KEYS.length
    ) {
        throw new Error('CAPTURE_INDEX_INVALID');
    }
    const artifacts = value.artifacts
        .map((entry) => {
            const row = record(entry, 'CAPTURE_INDEX_INVALID');
            if (
                !exactKeys(row, [
                    'key',
                    'artifactFile',
                    'artifactSha256',
                    'manifestFile',
                    'manifestSha256',
                    'runId',
                ]) ||
                typeof row.key !== 'string' ||
                !OPAQUE_KEY_RE.test(row.key) ||
                typeof row.artifactFile !== 'string' ||
                typeof row.manifestFile !== 'string' ||
                row.artifactFile === row.manifestFile ||
                typeof row.artifactSha256 !== 'string' ||
                !HEX64_RE.test(row.artifactSha256) ||
                typeof row.manifestSha256 !== 'string' ||
                !HEX64_RE.test(row.manifestSha256) ||
                typeof row.runId !== 'string' ||
                !POSITIVE_INTEGER_RE.test(row.runId)
            ) {
                throw new Error('CAPTURE_INDEX_INVALID');
            }
            return {
                key: row.key,
                artifactFile: row.artifactFile,
                artifactSha256: row.artifactSha256,
                manifestFile: row.manifestFile,
                manifestSha256: row.manifestSha256,
                runId: row.runId,
            };
        })
        .sort((left, right) => (left.key < right.key ? -1 : 1));
    const bindings = value.bindings
        .map((entry) => {
            const row = record(entry, 'CAPTURE_INDEX_INVALID');
            if (
                !exactKeys(row, [
                    'targetKey',
                    'artifactKey',
                    'alias',
                ]) ||
                !isTargetKey(row.targetKey) ||
                typeof row.artifactKey !== 'string' ||
                !OPAQUE_KEY_RE.test(row.artifactKey) ||
                typeof row.alias !== 'string' ||
                !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(row.alias)
            ) {
                throw new Error('CAPTURE_INDEX_INVALID');
            }
            return {
                targetKey: row.targetKey,
                artifactKey: row.artifactKey,
                alias: row.alias,
            };
        })
        .sort((left, right) =>
            left.targetKey < right.targetKey ? -1 : 1
        );
    if (
        !exactSortedUnique(
            artifacts.map((artifact) => artifact.key)
        ) ||
        new Set(
            artifacts.flatMap((artifact) => [
                artifact.artifactFile,
                artifact.manifestFile,
            ])
        ).size !==
            artifacts.length * 2 ||
        stableStringify(
            bindings.map((binding) => binding.targetKey)
        ) !== stableStringify(DEVELOPMENT_API_LDAREG_TARGET_KEYS) ||
        new Set(
            bindings.map((binding) =>
                stableStringify([
                    binding.artifactKey,
                    binding.alias,
                ])
            )
        ).size !== bindings.length ||
        bindings.some(
            (binding) =>
                !artifacts.some(
                    (artifact) =>
                        artifact.key === binding.artifactKey
                )
        ) ||
        artifacts.some(
            (artifact) =>
                !bindings.some(
                    (binding) =>
                        binding.artifactKey === artifact.key
                )
        )
    ) {
        throw new Error('CAPTURE_INDEX_INVALID');
    }
    return {
        version: DEVELOPMENT_API_LDAREG_CAPTURE_INDEX_VERSION,
        artifacts,
        bindings,
    };
}

function endpoint(
    sample: LandAreaPhase0SampleArtifact,
    name:
        | 'getBrTitleInfo'
        | 'getBrBasisOulnInfo'
        | 'getBrAtchJibunInfo'
        | 'getBrExposInfo'
        | 'ladfrlList'
        | 'ldaregList'
) {
    const matches = sample.endpoints.filter(
        (candidate) => candidate.endpoint === name
    );
    if (
        matches.length !== 1 ||
        !['COMPLETE', 'COMPLETE_ZERO'].includes(
            matches[0].state
        )
    ) {
        throw new Error('PHASE0_ENDPOINT_INVALID');
    }
    return matches[0];
}

function inventoryRecords(
    endpointArtifact: ReturnType<typeof endpoint>,
    expectedKind: string
): Array<Record<string, unknown>> {
    const inventory = record(
        endpointArtifact.inventory,
        'PHASE0_INVENTORY_INVALID'
    );
    if (
        inventory.kind !== expectedKind ||
        !Array.isArray(inventory.records) ||
        inventory.truncated !== false ||
        inventory.totalRecords !== inventory.records.length
    ) {
        throw new Error('PHASE0_INVENTORY_INVALID');
    }
    return inventory.records.map((entry) =>
        record(entry, 'PHASE0_INVENTORY_INVALID')
    );
}

function isCanonicalRecordOrder(
    values: readonly unknown[]
): boolean {
    const sorted = [...values].sort((left, right) =>
        stableStringify(left).localeCompare(
            stableStringify(right)
        )
    );
    return values.every(
        (value, index) =>
            stableStringify(value) ===
            stableStringify(sorted[index])
    );
}

function resolvedOfficialScopeExposRows(input: {
    sample: LandAreaPhase0SampleArtifact;
    expectedManagementPkHash: string;
    expectedScopePnuHashes: readonly string[];
}): Array<Record<string, unknown>> {
    const evidence = record(
        input.sample.evidence.scopeExpos,
        'OFFICIAL_SCOPE_EXPOS_INVALID'
    );
    if (
        !exactKeys(evidence, [
            'status',
            'queries',
            'records',
            'totalRecords',
            'truncated',
            'sanitizedDigest',
        ]) ||
        evidence.status !== 'PASS' ||
        evidence.truncated !== false ||
        !Array.isArray(evidence.queries) ||
        !Array.isArray(evidence.records) ||
        evidence.records.length === 0 ||
        evidence.totalRecords !== evidence.records.length ||
        typeof evidence.sanitizedDigest !== 'string' ||
        evidence.sanitizedDigest !==
            sha256(stableStringify(evidence.records)) ||
        !isCanonicalRecordOrder(evidence.queries) ||
        !isCanonicalRecordOrder(evidence.records)
    ) {
        throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
    }
    const queryCounts = new Map<string, number>();
    for (const queryInput of evidence.queries) {
        const query = record(
            queryInput,
            'OFFICIAL_SCOPE_EXPOS_INVALID'
        );
        if (
            !exactKeys(query, [
                'pnuHash',
                'state',
                'totalCount',
                'pagesFetched',
            ]) ||
            typeof query.pnuHash !== 'string' ||
            !HEX64_RE.test(query.pnuHash) ||
            !['COMPLETE', 'COMPLETE_ZERO'].includes(
                String(query.state)
            ) ||
            typeof query.totalCount !== 'number' ||
            !Number.isSafeInteger(query.totalCount) ||
            query.totalCount < 0 ||
            typeof query.pagesFetched !== 'number' ||
            !Number.isSafeInteger(query.pagesFetched) ||
            query.pagesFetched < 1 ||
            (query.state === 'COMPLETE_ZERO') !==
                (query.totalCount === 0) ||
            queryCounts.has(query.pnuHash)
        ) {
            throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
        }
        queryCounts.set(
            query.pnuHash,
            query.totalCount
        );
    }
    if (
        stableStringify([...queryCounts.keys()].sort()) !==
        stableStringify([...input.expectedScopePnuHashes].sort())
    ) {
        throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
    }
    const observedCounts = new Map<string, number>();
    const scopeRows = evidence.records.map((rowInput) => {
        const row = record(
            rowInput,
            'OFFICIAL_SCOPE_EXPOS_INVALID'
        );
        if (
            !exactKeys(
                row,
                ['queryPnuHash', 'unitIdentityShape'],
                [
                    'rowPnuHash',
                    'selfManagementPkHash',
                    'rootManagementPkHash',
                    'rootIdentitySource',
                    'rawUpManagementPkHash',
                    'unitIdentityHash',
                    'floorHoIdentityHash',
                    'dongIdentityHash',
                    'providerUnitBridgeHash',
                    'providerUnitBridgeKind',
                ]
            ) ||
            typeof row.queryPnuHash !== 'string' ||
            !queryCounts.has(row.queryPnuHash) ||
            row.rowPnuHash !== row.queryPnuHash ||
            typeof row.selfManagementPkHash !== 'string' ||
            !HEX64_RE.test(row.selfManagementPkHash) ||
            row.rootManagementPkHash !==
                input.expectedManagementPkHash ||
            !['SELF', 'RAW_UP', 'BASIS_UNIQUE'].includes(
                String(row.rootIdentitySource)
            ) ||
            !['DONG_FLOOR_HO', 'FLOOR_HO'].includes(
                String(row.unitIdentityShape)
            ) ||
            typeof row.unitIdentityHash !== 'string' ||
            !HEX64_RE.test(row.unitIdentityHash) ||
            typeof row.floorHoIdentityHash !== 'string' ||
            !HEX64_RE.test(row.floorHoIdentityHash) ||
            (row.unitIdentityShape === 'DONG_FLOOR_HO') !==
                (typeof row.dongIdentityHash === 'string') ||
            (typeof row.dongIdentityHash === 'string' &&
                !HEX64_RE.test(row.dongIdentityHash)) ||
            (row.providerUnitBridgeHash === undefined) !==
                (row.providerUnitBridgeKind === undefined) ||
            (row.providerUnitBridgeHash !== undefined &&
                (typeof row.providerUnitBridgeHash !==
                    'string' ||
                    !HEX64_RE.test(
                        row.providerUnitBridgeHash
                    ) ||
                    typeof row.providerUnitBridgeKind !==
                        'string' ||
                    !BRIDGE_KINDS.has(
                        row.providerUnitBridgeKind as ProviderUnitShapeBridgeKind
                    ))) ||
            (row.rootIdentitySource === 'SELF' &&
                (row.selfManagementPkHash !==
                    row.rootManagementPkHash ||
                    row.rawUpManagementPkHash !==
                        undefined)) ||
            (row.rootIdentitySource === 'RAW_UP' &&
                (typeof row.rawUpManagementPkHash !==
                    'string' ||
                    row.rawUpManagementPkHash !==
                        row.rootManagementPkHash)) ||
            (row.rootIdentitySource === 'BASIS_UNIQUE' &&
                row.rawUpManagementPkHash !== undefined)
        ) {
            throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
        }
        observedCounts.set(
            row.queryPnuHash,
            (observedCounts.get(row.queryPnuHash) ?? 0) + 1
        );
        return row;
    });
    if (
        [...queryCounts].some(
            ([pnuHash, expectedCount]) =>
                (observedCounts.get(pnuHash) ?? 0) !==
                expectedCount
        )
    ) {
        throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
    }
    const baseInventoryRows = inventoryRecords(
        endpoint(input.sample, 'getBrExposInfo'),
        'EXPOS'
    );
    const baseBindingKey = (
        row: Record<string, unknown>,
        scope: boolean
    ) =>
        stableStringify({
            selfManagementPkHash: scope
                ? row.selfManagementPkHash ?? null
                : row.managementPkHash ?? null,
            rawUpManagementPkHash: scope
                ? row.rawUpManagementPkHash ?? null
                : row.upManagementPkHash ?? null,
            unitIdentityShape: row.unitIdentityShape,
            unitIdentityHash:
                row.unitIdentityHash ?? null,
            floorHoIdentityHash:
                row.floorHoIdentityHash ?? null,
            dongIdentityHash:
                row.dongIdentityHash ?? null,
        });
    const inventoryBindings = baseInventoryRows
        .map((row) => baseBindingKey(row, false))
        .sort();
    const scopeBaseBindings = scopeRows
        .filter(
            (row) =>
                row.queryPnuHash === input.sample.pnuHash
        )
        .map((row) => baseBindingKey(row, true))
        .sort();
    if (
        stableStringify(inventoryBindings) !==
        stableStringify(scopeBaseBindings)
    ) {
        throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
    }
    const resolved =
        resolveLandAreaPhase0ScopeExposRecords(
            input.sample.evidence.scopeExpos
        );
    if (
        resolved === null ||
        resolved.length === 0 ||
        resolved.some(
            (row) =>
                row.rootManagementPkHash !==
                input.expectedManagementPkHash
        )
    ) {
        throw new Error('OFFICIAL_SCOPE_EXPOS_INVALID');
    }
    return resolved.map((row) =>
        record(row, 'OFFICIAL_SCOPE_EXPOS_INVALID')
    );
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

interface OfficialCorrelation {
    expos: Record<string, unknown>;
    ldareg: Record<string, unknown>;
    numerator: string;
    denominator: string;
    bridgeKind: ProviderUnitShapeBridgeKind | null;
}

function correlateOfficialUnits(
    sample: LandAreaPhase0SampleArtifact,
    targetKey: DevelopmentApiLdaregTargetKey,
    expectedManagementPkHash: string,
    expectedScopePnuHashes: readonly string[]
): {
    correlated: OfficialCorrelation[];
    placeholderCount: number;
    ldaregRowCount: number;
} {
    const exposRows = resolvedOfficialScopeExposRows({
        sample,
        expectedManagementPkHash,
        expectedScopePnuHashes,
    });
    const ldaregRows = inventoryRecords(
        endpoint(sample, 'ldaregList'),
        'LDAREG'
    );
    const placeholders = ldaregRows.filter(
        (row) => row.quotaRatioState === 'MISSING'
    );
    const positive = ldaregRows.filter(
        (row) => row.quotaRatioState === 'VALID'
    );
    if (
        positive.length + placeholders.length !==
            ldaregRows.length ||
        positive.length !== exposRows.length
    ) {
        throw new Error('OFFICIAL_LDAREG_SET_INVALID');
    }
    const consumedExpos = new Set<number>();
    const correlated: OfficialCorrelation[] = [];
    type ResidualEntry = {
        ldareg: Record<string, unknown>;
        ratio: Extract<
            ReturnType<typeof parseLdaQotaRate>,
            { ok: true }
        >;
    };
    const residual: ResidualEntry[] = [];
    const appendCorrelation = (
        expos: Record<string, unknown>,
        entry: ResidualEntry,
        bridgeKind: ProviderUnitShapeBridgeKind | null
    ): void => {
        correlated.push({
            expos,
            ldareg: entry.ldareg,
            numerator: canonicalDecimal(
                entry.ratio.numeratorText
            ),
            denominator: canonicalDecimal(
                entry.ratio.denominatorText
            ),
            bridgeKind,
        });
    };
    for (const ldareg of positive) {
        if (
            ldareg.classificationCode !== '0' ||
            ldareg.classificationLabel !== '현재' ||
            typeof ldareg.quotaRatio !== 'string'
        ) {
            throw new Error('OFFICIAL_LDAREG_ROW_INVALID');
        }
        const ratio = parseLdaQotaRate(ldareg.quotaRatio);
        if (!ratio.ok) {
            throw new Error('OFFICIAL_LDAREG_RATIO_INVALID');
        }
        const exact = exposRows
            .map((expos, index) => ({ expos, index }))
            .filter(
                ({ expos, index }) =>
                    !consumedExpos.has(index) &&
                    typeof ldareg.unitIdentityHash === 'string' &&
                    expos.unitIdentityHash ===
                        ldareg.unitIdentityHash
            );
        if (exact.length > 1) {
            throw new Error('OFFICIAL_EXACT_MATCH_AMBIGUOUS');
        }
        if (exact.length === 1) {
            consumedExpos.add(exact[0].index);
            appendCorrelation(
                exact[0].expos,
                { ldareg, ratio },
                null
            );
        } else {
            residual.push({ ldareg, ratio });
        }
    }
    const remainingExpos = exposRows
        .map((expos, index) => ({ expos, index }))
        .filter(({ index }) => !consumedExpos.has(index));
    const exposFloorHoCounts = new Map<string, number>();
    const ldaregFloorHoCounts = new Map<string, number>();
    for (const { expos } of remainingExpos) {
        const hash = expos.floorHoIdentityHash;
        if (typeof hash !== 'string' || !HEX64_RE.test(hash)) {
            throw new Error('OFFICIAL_EXPOS_HASH_INVALID');
        }
        exposFloorHoCounts.set(
            hash,
            (exposFloorHoCounts.get(hash) ?? 0) + 1
        );
    }
    for (const entry of residual) {
        const hash = entry.ldareg.floorHoIdentityHash;
        if (typeof hash !== 'string' || !HEX64_RE.test(hash)) {
            throw new Error('OFFICIAL_LDAREG_ROW_INVALID');
        }
        ldaregFloorHoCounts.set(
            hash,
            (ldaregFloorHoCounts.get(hash) ?? 0) + 1
        );
    }
    const providerResidual: ResidualEntry[] = [];
    for (const entry of residual) {
        const floorHoHash =
            entry.ldareg.floorHoIdentityHash as string;
        const matches = remainingExpos.filter(
            ({ expos, index }) =>
                !consumedExpos.has(index) &&
                expos.floorHoIdentityHash === floorHoHash
        );
        if (
            exposFloorHoCounts.get(floorHoHash) === 1 &&
            ldaregFloorHoCounts.get(floorHoHash) === 1 &&
            matches.length === 1
        ) {
            consumedExpos.add(matches[0].index);
            appendCorrelation(matches[0].expos, entry, null);
        } else {
            providerResidual.push(entry);
        }
    }
    for (const entry of providerResidual) {
        const hash = entry.ldareg.providerUnitBridgeHash;
        const kind = entry.ldareg.providerUnitBridgeKind;
        if (
            typeof hash !== 'string' ||
            !HEX64_RE.test(hash) ||
            typeof kind !== 'string' ||
            !BRIDGE_KINDS.has(
                kind as ProviderUnitShapeBridgeKind
            )
        ) {
            throw targetScopedBuildError(
                'OFFICIAL_PROVIDER_BRIDGE_INVALID',
                targetKey
            );
        }
        const matches = exposRows
            .map((expos, index) => ({ expos, index }))
            .filter(
                ({ expos, index }) =>
                    !consumedExpos.has(index) &&
                    expos.providerUnitBridgeHash === hash &&
                    expos.providerUnitBridgeKind === kind
            );
        if (matches.length !== 1) {
            throw targetScopedBuildError(
                'OFFICIAL_PROVIDER_BRIDGE_INVALID',
                targetKey
            );
        }
        consumedExpos.add(matches[0].index);
        appendCorrelation(
            matches[0].expos,
            entry,
            kind as ProviderUnitShapeBridgeKind
        );
    }
    if (
        correlated.length !== positive.length ||
        consumedExpos.size !== exposRows.length
    ) {
        throw new Error('OFFICIAL_CORRELATION_INCOMPLETE');
    }
    return {
        correlated,
        placeholderCount: placeholders.length,
        ldaregRowCount: ldaregRows.length,
    };
}

function resolveOfficialHashes(input: {
    group: ParsedDbGroup;
    sample: LandAreaPhase0SampleArtifact;
}): DevelopmentApiLdaregTarget['officialHashes'] {
    const expectedManagementHash = sha256(
        `MGM_BLDRGST_PK\u0000${input.group.managementPk}`
    );
    const expectedBasePnuHash = sha256(
        `PNU\u0000${input.group.basePnu}`
    );
    const expectedBylot =
        input.group.scopePnus.length === 1
            ? 'ZERO'
            : 'POSITIVE';
    if (
        input.sample.pnuHash !== expectedBasePnuHash ||
        input.sample.expectedBylot !== expectedBylot
    ) {
        throw new Error('PHASE0_SAMPLE_TARGET_MISMATCH');
    }
    const title = endpoint(input.sample, 'getBrTitleInfo');
    const basis = endpoint(input.sample, 'getBrBasisOulnInfo');
    const attached = endpoint(
        input.sample,
        'getBrAtchJibunInfo'
    );
    const expos = endpoint(input.sample, 'getBrExposInfo');
    const ladfrl = endpoint(input.sample, 'ladfrlList');
    const ldareg = endpoint(input.sample, 'ldaregList');
    const titleRows = inventoryRecords(title, 'TITLE');
    const basisRows = inventoryRecords(basis, 'BASIS');
    if (
        ![...titleRows, ...basisRows].some(
            (row) =>
                row.managementPkHash === expectedManagementHash ||
                row.upManagementPkHash === expectedManagementHash
        )
    ) {
        throw new Error('PHASE0_MANAGEMENT_PK_MISMATCH');
    }
    const attachedInventory = record(
        attached.inventory,
        'PHASE0_ATTACHED_INVALID'
    );
    if (
        attachedInventory.kind !== 'ATTACHED' ||
        !Array.isArray(attachedInventory.pairs) ||
        attachedInventory.totalRejected !== 0 ||
        typeof attachedInventory.pairsDigest !== 'string' ||
        !HEX64_RE.test(attachedInventory.pairsDigest)
    ) {
        throw new Error('PHASE0_ATTACHED_INVALID');
    }
    let attachedPnuHash: string =
        DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH;
    if (input.group.scopePnus.length === 1) {
        if (
            attachedInventory.totalPairs !== 0 ||
            attachedInventory.pairs.length !== 0 ||
            attachedInventory.pairsDigest !==
                DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST ||
            attached.schemaHash !==
                DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH
        ) {
            throw new Error('PHASE0_ATTACHED_INVALID');
        }
    } else {
        const attachedPnu = input.group.scopePnus.find(
            (pnu) => pnu !== input.group.basePnu
        )!;
        attachedPnuHash = sha256(`PNU\u0000${attachedPnu}`);
        const expectedPair = {
            managementPkHash: expectedManagementHash,
            basePnuHash: expectedBasePnuHash,
            attachedPnuHash,
        };
        if (
            attachedInventory.totalPairs !== 1 ||
            attachedInventory.pairs.length !== 1 ||
            stableStringify(attachedInventory.pairs[0]) !==
                stableStringify(expectedPair) ||
            attachedInventory.pairsDigest !==
                sha256(stableStringify([expectedPair]))
        ) {
            throw new Error('PHASE0_ATTACHED_INVALID');
        }
    }
    const replication = input.sample.evidence.ldaregReplication;
    if (
        replication.status !== 'PASS' ||
        replication.canonicalSourcePnuHash !==
            expectedBasePnuHash ||
        replication.rowCount === null ||
        typeof replication.rowMultisetDigest !== 'string' ||
        !HEX64_RE.test(replication.rowMultisetDigest) ||
        stableStringify(
            [...replication.comparedPnuHashes].sort()
        ) !==
            stableStringify(
                input.group.scopePnus
                    .map((pnu) => sha256(`PNU\u0000${pnu}`))
                    .sort()
            )
    ) {
        throw new Error('PHASE0_REPLICATION_INVALID');
    }
    return {
        managementPkHash: expectedManagementHash,
        basePnuHash: expectedBasePnuHash,
        attachedPnuHash,
        pairsDigest: attachedInventory.pairsDigest,
        titleSchemaHash: title.schemaHash,
        basisSchemaHash: basis.schemaHash,
        attachedSchemaHash: attached.schemaHash,
        exposSchemaHash: expos.schemaHash,
        ladfrlSchemaHash: ladfrl.schemaHash,
        ldaregSchemaHash: ldareg.schemaHash,
        ldaregRowMultisetDigest:
            replication.rowMultisetDigest,
    };
}

interface ResolvedDbUnit {
    unit: ParsedDbUnit;
    officialHash: string;
    normalizedFloor: string;
    normalizedHo: string;
}

function resolveDbUnitAgainstOfficialHashes(input: {
    unit: ParsedDbUnit;
    officialHashes: ReadonlySet<string>;
    officialHashesByFloorHoHash: ReadonlyMap<
        string,
        readonly string[]
    >;
    targetKey: DevelopmentApiLdaregTargetKey;
}): ResolvedDbUnit | null {
    const canonicalDongValue = canonicalDong(input.unit.rawDong);
    const normalizedHo = normalizeUnitSegment(input.unit.rawHo);
    if (normalizedHo === '') return null;
    const fullMatches: Array<{
        normalizedFloor: string;
        officialHash: string;
    }> = [];
    const floorHoMatches: Array<{
        normalizedFloor: string;
        officialHashes: readonly string[];
    }> = [];
    for (let floor = 1; floor <= 999; floor += 1) {
        const normalizedFloor = String(floor);
        const candidateHash = unitTupleHash({
            canonicalDong: canonicalDongValue,
            normalizedFloor,
            normalizedHo,
        });
        if (input.officialHashes.has(candidateHash)) {
            fullMatches.push({
                normalizedFloor,
                officialHash: candidateHash,
            });
        }
        if (canonicalDongValue === '') {
            const officialHashes =
                input.officialHashesByFloorHoHash.get(
                    floorHoTupleHash({
                        normalizedFloor,
                        normalizedHo,
                    })
                );
            if (officialHashes) {
                floorHoMatches.push({
                    normalizedFloor,
                    officialHashes,
                });
            }
        }
    }
    const exactMatches =
        fullMatches.length > 0
            ? fullMatches
            : floorHoMatches.flatMap((match) => {
                  if (match.officialHashes.length !== 1) {
                      throw targetScopedBuildError(
                          'OFFICIAL_DB_FLOOR_HO_AMBIGUOUS',
                          input.targetKey
                      );
                  }
                  return [
                      {
                          normalizedFloor:
                              match.normalizedFloor,
                          officialHash:
                              match.officialHashes[0],
                      },
                  ];
              });
    if (exactMatches.length === 0) return null;
    if (exactMatches.length !== 1) {
        throw new Error('DB_UNIT_FLOOR_PREIMAGE_AMBIGUOUS');
    }
    const [match] = exactMatches;
    const normalizedFloor = match.normalizedFloor;
    if (input.unit.rawFloor !== null) {
        const observedFloor = normalizeFloorLabel(
            input.unit.rawFloor
        );
        if (
            !/^[1-9]\d{0,2}$/.test(observedFloor) ||
            observedFloor !== normalizedFloor
        ) {
            throw new Error('DB_UNIT_RAW_FLOOR_MISMATCH');
        }
    }
    return {
        unit: input.unit,
        officialHash: match.officialHash,
        normalizedFloor,
        normalizedHo,
    };
}

function targetScopedBuildError(
    code:
        | 'OFFICIAL_DB_UNIT_ACTIVE_AMBIGUOUS'
        | 'OFFICIAL_DB_DONG_WITNESS_AMBIGUOUS'
        | 'OFFICIAL_DB_DONG_CANDIDATE_BOUND_INVALID'
        | 'OFFICIAL_DB_DONG_WITNESS_MISSING'
        | 'OFFICIAL_DB_FLOOR_HO_AMBIGUOUS'
        | 'OFFICIAL_DB_UNIT_INACTIVE_AMBIGUOUS'
        | 'OFFICIAL_DB_UNIT_MISSING'
        | 'OFFICIAL_PROVIDER_BRIDGE_INVALID',
    key: DevelopmentApiLdaregTargetKey
): Error {
    const suffixByKey: Record<
        DevelopmentApiLdaregTargetKey,
        string
    > = {
        'ldareg-target-01': 'TARGET_01',
        'ldareg-target-02': 'TARGET_02',
        'ldareg-target-03': 'TARGET_03',
        'ldareg-target-04': 'TARGET_04',
        'ldareg-target-05': 'TARGET_05',
        'ldareg-target-06': 'TARGET_06',
        'ldareg-target-07': 'TARGET_07',
    };
    return new Error(`${code}_${suffixByKey[key]}`);
}

function resolveOfficialCanonicalDong(input: {
    correlation: OfficialCorrelation;
    boundedDongCandidates: readonly string[];
    targetKey: DevelopmentApiLdaregTargetKey;
    normalizedFloor: string;
    normalizedHo: string;
}): string {
    const expos = input.correlation.expos;
    const canonicalDongs =
        expos.unitIdentityShape === 'FLOOR_HO'
            ? ['']
            : input.boundedDongCandidates.filter(
                  (dong) =>
                      typeof expos.unitIdentityHash ===
                          'string' &&
                      unitTupleHash({
                          canonicalDong: dong,
                          normalizedFloor:
                              input.normalizedFloor,
                          normalizedHo:
                              input.normalizedHo,
                      }) === expos.unitIdentityHash
              );
    if (canonicalDongs.length === 0) {
        throw targetScopedBuildError(
            'OFFICIAL_DB_DONG_WITNESS_MISSING',
            input.targetKey
        );
    }
    if (canonicalDongs.length !== 1) {
        throw targetScopedBuildError(
            'OFFICIAL_DB_DONG_WITNESS_AMBIGUOUS',
            input.targetKey
        );
    }
    const canonicalDongValue = canonicalDongs[0];
    const expectedUnitHash = unitTupleHash({
        canonicalDong: canonicalDongValue,
        normalizedFloor: input.normalizedFloor,
        normalizedHo: input.normalizedHo,
    });
    const expectedFloorHoHash = floorHoTupleHash({
        normalizedFloor: input.normalizedFloor,
        normalizedHo: input.normalizedHo,
    });
    if (
        expos.unitIdentityHash !== expectedUnitHash ||
        expos.floorHoIdentityHash !==
            expectedFloorHoHash ||
        (canonicalDongValue === ''
            ? expos.unitIdentityShape !== 'FLOOR_HO'
            : expos.unitIdentityShape !==
              'DONG_FLOOR_HO')
    ) {
        throw targetScopedBuildError(
            'OFFICIAL_DB_DONG_WITNESS_AMBIGUOUS',
            input.targetKey
        );
    }
    return canonicalDongValue;
}

function buildTarget(input: {
    group: ParsedDbGroup;
    capture: DevelopmentApiLdaregResolvedCapture;
}): DevelopmentApiLdaregTarget {
    if (
        input.capture.targetKey !== input.group.key ||
        input.capture.artifact.version !==
            'land-area-phase0-capture-artifact@6' ||
        !DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST.includes(
            input.capture.artifact.schemaHash as (typeof DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST)[number]
        ) ||
        input.capture.artifact.gate.status !== 'PASS' ||
        input.capture.sample.failureCodes.length !== 0
    ) {
        throw new Error('PHASE0_CAPTURE_INVALID');
    }
    const landParcels = input.group.landParcels.map((parcel) => ({
        pnu: parcel.pnu,
        expectedArea: parcel.area,
    }));
    const expectedDenominator = unitsDecimal(
        landParcels.reduce(
            (sum, parcel) =>
                sum + decimalUnits(parcel.expectedArea),
            0n
        )
    );
    const ladfrlEvidence =
        input.capture.sample.evidence.scopeLadfrl;
    const expectedLadfrl = landParcels
        .map((parcel) => ({
            pnuHash: sha256(`PNU\u0000${parcel.pnu}`),
            area: parcel.expectedArea,
        }))
        .sort((left, right) =>
            left.pnuHash < right.pnuHash ? -1 : 1
        );
    if (
        ladfrlEvidence.status !== 'PASS' ||
        ladfrlEvidence.totalArea !== expectedDenominator ||
        stableStringify(
            [...ladfrlEvidence.records].sort((left, right) =>
                left.pnuHash < right.pnuHash ? -1 : 1
            )
        ) !== stableStringify(expectedLadfrl)
    ) {
        throw new Error('PHASE0_LADFRL_DB_MISMATCH');
    }
    const official = correlateOfficialUnits(
        input.capture.sample,
        input.group.key,
        sha256(
            `MGM_BLDRGST_PK\u0000${input.group.managementPk}`
        ),
        input.group.scopePnus.map((pnu) =>
            sha256(`PNU\u0000${pnu}`)
        )
    );
    if (
        official.correlated.some(
            (row) => row.denominator !== expectedDenominator
        )
    ) {
        throw new Error('OFFICIAL_DENOMINATOR_DB_MISMATCH');
    }
    const correlationsByExposHash = new Map<
        string,
        OfficialCorrelation
    >();
    const officialHashesByFloorHoHash = new Map<
        string,
        string[]
    >();
    for (const correlation of official.correlated) {
        const exposHash = correlation.expos.unitIdentityHash;
        const floorHoHash =
            correlation.expos.floorHoIdentityHash;
        if (
            typeof exposHash !== 'string' ||
            !HEX64_RE.test(exposHash) ||
            typeof floorHoHash !== 'string' ||
            !HEX64_RE.test(floorHoHash) ||
            correlationsByExposHash.has(exposHash)
        ) {
            throw new Error('OFFICIAL_EXPOS_HASH_INVALID');
        }
        correlationsByExposHash.set(exposHash, correlation);
        const hashes =
            officialHashesByFloorHoHash.get(floorHoHash) ??
            [];
        hashes.push(exposHash);
        officialHashesByFloorHoHash.set(
            floorHoHash,
            hashes
        );
    }
    const officialHashes = new Set(
        correlationsByExposHash.keys()
    );
    const boundedDongCandidates = [
        ...new Set(
            input.group.units
                .map((unit) => canonicalDong(unit.rawDong))
                .filter((dong) => dong !== '')
        ),
    ].sort();
    if (
        boundedDongCandidates.length > 32 ||
        boundedDongCandidates.some(
            (dong) => dong.length < 1 || dong.length > 32
        )
    ) {
        throw targetScopedBuildError(
            'OFFICIAL_DB_DONG_CANDIDATE_BOUND_INVALID',
            input.group.key
        );
    }
    const resolvedByOfficialHash = new Map<
        string,
        ResolvedDbUnit[]
    >();
    for (const unit of input.group.units) {
        const resolved = resolveDbUnitAgainstOfficialHashes({
            unit,
            officialHashes,
            officialHashesByFloorHoHash,
            targetKey: input.group.key,
        });
        if (resolved === null) continue;
        const candidates =
            resolvedByOfficialHash.get(resolved.officialHash) ?? [];
        candidates.push(resolved);
        resolvedByOfficialHash.set(
            resolved.officialHash,
            candidates
        );
    }
    const matchedActiveUnits = new Set<string>();
    const propertyTargets: DevelopmentApiLdaregTarget['propertyTargets'] =
        [];
    const ignoredOfficialUnits: DevelopmentApiLdaregTarget['ignoredOfficialUnits'] =
        [];
    const resolvedOfficialDongs = new Set<string>();
    for (const [exposHash, correlation] of correlationsByExposHash) {
        const candidates =
            resolvedByOfficialHash.get(exposHash) ?? [];
        const activeCandidates = candidates.filter(
            (candidate) =>
                candidate.unit.activePropertyUnit !== null
        );
        if (activeCandidates.length > 1) {
            throw targetScopedBuildError(
                'OFFICIAL_DB_UNIT_ACTIVE_AMBIGUOUS',
                input.group.key
            );
        }
        if (
            activeCandidates.length === 0 &&
            candidates.length === 0
        ) {
            throw targetScopedBuildError(
                'OFFICIAL_DB_UNIT_MISSING',
                input.group.key
            );
        }
        if (
            activeCandidates.length === 0 &&
            candidates.length > 1
        ) {
            throw targetScopedBuildError(
                'OFFICIAL_DB_UNIT_INACTIVE_AMBIGUOUS',
                input.group.key
            );
        }
        const selected =
            activeCandidates.length === 1
                ? activeCandidates[0]
                : candidates[0];
        const unit = selected.unit;
        const officialCanonicalDong =
            resolveOfficialCanonicalDong({
                correlation,
                boundedDongCandidates,
                targetKey: input.group.key,
                normalizedFloor:
                    selected.normalizedFloor,
                normalizedHo: selected.normalizedHo,
            });
        if (officialCanonicalDong !== '') {
            resolvedOfficialDongs.add(officialCanonicalDong);
        }
        if (unit.activePropertyUnit === null) {
            ignoredOfficialUnits.push({
                canonicalDong: officialCanonicalDong,
                canonicalFloor: selected.normalizedFloor,
                canonicalHo: selected.normalizedHo,
                providerShapeBridgeKind:
                    correlation.bridgeKind,
                expectedNumerator: correlation.numerator,
                reason: 'NO_ACTIVE_PROPERTY_UNIT',
            });
        } else {
            matchedActiveUnits.add(unit.unitId);
            propertyTargets.push({
                propertyUnitId:
                    unit.activePropertyUnit.propertyUnitId,
                expectedBuildingUnitId: unit.unitId,
                expectedPnu: unit.activePropertyUnit.pnu,
                canonicalDong: officialCanonicalDong,
                normalizedFloor: selected.normalizedFloor,
                normalizedHo: selected.normalizedHo,
                providerShapeBridgeKind:
                    correlation.bridgeKind,
                expectedNumerator: correlation.numerator,
            });
        }
    }
    const activeUnits = input.group.units.filter(
        (unit) => unit.activePropertyUnit !== null
    );
    const expectedIgnoredOfficialUnitCount =
        input.group.expectedIgnoredOfficialUnitCount ?? 0;
    if (
        propertyTargets.length !== activeUnits.length ||
        activeUnits.some(
            (unit) => !matchedActiveUnits.has(unit.unitId)
        ) ||
        ignoredOfficialUnits.length !==
            expectedIgnoredOfficialUnitCount
    ) {
        throw new Error('OFFICIAL_DB_PARTITION_INVALID');
    }
    if (resolvedOfficialDongs.size > 1) {
        throw targetScopedBuildError(
            'OFFICIAL_DB_DONG_WITNESS_AMBIGUOUS',
            input.group.key
        );
    }
    propertyTargets.sort((left, right) =>
        left.propertyUnitId < right.propertyUnitId ? -1 : 1
    );
    ignoredOfficialUnits.sort((left, right) => {
        const leftKey = stableStringify([
            left.canonicalDong,
            left.canonicalFloor,
            left.canonicalHo,
            left.providerShapeBridgeKind,
        ]);
        const rightKey = stableStringify([
            right.canonicalDong,
            right.canonicalFloor,
            right.canonicalHo,
            right.providerShapeBridgeKind,
        ]);
        return leftKey < rightKey ? -1 : 1;
    });
    const withoutDigest: Omit<
        DevelopmentApiLdaregTarget,
        'manifestDigest'
    > = {
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        databaseTarget: 'development',
        unionId: input.group.unionId,
        basePnu: input.group.basePnu,
        managementPk: input.group.managementPk,
        canonicalBuildingId:
            input.group.canonicalBuildingId,
        scopePnus: [...input.group.scopePnus],
        propertyTargets,
        ignoredOfficialUnits,
        ...(input.group.expectedIgnoredOfficialUnitCount !==
        undefined
            ? {
                  expectedIgnoredOfficialUnitCount:
                      input.group
                          .expectedIgnoredOfficialUnitCount,
              }
            : {}),
        landParcels,
        expectedDenominator,
        expectedLdaregRowCount: official.ldaregRowCount,
        expectedIgnoredPlaceholderCount:
            official.placeholderCount,
        phase0: {
            runId: input.capture.runId,
            artifactVersion:
                'land-area-phase0-capture-artifact@6',
            artifactSha256:
                input.capture.artifactSha256,
            schemaHash: input.capture.artifact.schemaHash,
        },
        databaseDigests: {
            scopeDigest: input.group.scopeDigest,
            propertyUnitDigest:
                input.group.propertyUnitDigest,
        },
        officialHashes: resolveOfficialHashes({
            group: input.group,
            sample: input.capture.sample,
        }),
    };
    return parseDevelopmentApiLdaregTarget({
        ...withoutDigest,
        manifestDigest:
            computeDevelopmentApiLdaregManifestDigest(
                withoutDigest
            ),
    });
}

function legacyTargetDigest(
    target: Record<string, unknown>
): string {
    const identity = {
        ...target,
        unionId:
            typeof target.unionId === 'string'
                ? target.unionId.toLowerCase()
                : target.unionId,
        canonicalBuildingId:
            typeof target.canonicalBuildingId === 'string'
                ? target.canonicalBuildingId.toLowerCase()
                : target.canonicalBuildingId,
    };
    return sha256(stableStringify(identity));
}

export function transformLegacyDevelopmentApiLdaregTarget(
    input: unknown
): DevelopmentApiLdaregTarget {
    const value = record(input, 'LEGACY_TARGET_INVALID');
    const rootKeys = [
        'version',
        'databaseTarget',
        'unionId',
        'basePnu',
        'managementPk',
        'canonicalBuildingId',
        'scopePnus',
        'propertyTargets',
        'landParcels',
        'expectedDenominator',
        'expectedLdaregRowCount',
        'expectedIgnoredPlaceholderCount',
        'phase0',
        'databaseDigests',
        'officialHashes',
        'manifestDigest',
    ];
    if (
        !exactKeys(value, rootKeys) ||
        value.version !== LEGACY_TARGET_VERSION ||
        value.databaseTarget !== 'development' ||
        !Array.isArray(value.propertyTargets) ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest)
    ) {
        throw new Error('LEGACY_TARGET_INVALID');
    }
    const legacyWithoutDigest = Object.fromEntries(
        Object.entries(value).filter(
            ([key]) => key !== 'manifestDigest'
        )
    );
    if (
        legacyTargetDigest(legacyWithoutDigest) !==
        value.manifestDigest
    ) {
        throw new Error('LEGACY_TARGET_DIGEST_MISMATCH');
    }
    const propertyTargets = value.propertyTargets.map((entry) => {
        const row = record(entry, 'LEGACY_TARGET_INVALID');
        if (
            !exactKeys(row, [
                'propertyUnitId',
                'expectedBuildingUnitId',
                'expectedPnu',
                'normalizedFloor',
                'normalizedHo',
                'expectedNumerator',
            ])
        ) {
            throw new Error('LEGACY_TARGET_INVALID');
        }
        return {
            ...row,
            canonicalDong: '',
            providerShapeBridgeKind: null,
        };
    });
    const transformedWithoutDigest = {
        ...legacyWithoutDigest,
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        propertyTargets,
        ignoredOfficialUnits: [],
    } as unknown as Omit<
        DevelopmentApiLdaregTarget,
        'manifestDigest'
    >;
    return parseDevelopmentApiLdaregTarget({
        ...transformedWithoutDigest,
        manifestDigest:
            computeDevelopmentApiLdaregManifestDigest(
                transformedWithoutDigest
            ),
    });
}

function legacyRepresentableTargetProjection(
    target: DevelopmentApiLdaregTarget
): Record<string, unknown> {
    const {
        manifestDigest: _manifestDigest,
        ignoredOfficialUnits: _ignoredOfficialUnits,
        expectedIgnoredOfficialUnitCount:
            _expectedIgnoredOfficialUnitCount,
        propertyTargets,
        ...legacyRepresentableRoot
    } = target;
    return {
        ...legacyRepresentableRoot,
        propertyTargets: propertyTargets.map(
            ({
                canonicalDong: _canonicalDong,
                providerShapeBridgeKind:
                    _providerShapeBridgeKind,
                ...legacyRepresentableProperty
            }) => legacyRepresentableProperty
        ),
    };
}

function isLegacyTargetExtensionUpgradeOnly(input: {
    transformedLegacy: DevelopmentApiLdaregTarget;
    candidate: DevelopmentApiLdaregTarget;
}): boolean {
    const extensionProjection = (
        target: DevelopmentApiLdaregTarget
    ): Record<string, unknown> => ({
        ignoredOfficialUnits: target.ignoredOfficialUnits,
        ...(Object.prototype.hasOwnProperty.call(
            target,
            'expectedIgnoredOfficialUnitCount'
        )
            ? {
                  expectedIgnoredOfficialUnitCount:
                      target.expectedIgnoredOfficialUnitCount,
              }
            : {}),
        propertyTargets: target.propertyTargets.map(
            (property) => ({
                propertyUnitId: property.propertyUnitId,
                canonicalDong: property.canonicalDong,
                providerShapeBridgeKind:
                    property.providerShapeBridgeKind,
            })
        ),
    });
    return (
        stableStringify(
            legacyRepresentableTargetProjection(
                input.transformedLegacy
            )
        ) ===
            stableStringify(
                legacyRepresentableTargetProjection(
                    input.candidate
                )
            ) &&
        stableStringify(
            extensionProjection(input.transformedLegacy)
        ) !==
            stableStringify(
                extensionProjection(input.candidate)
            )
    );
}

export function buildDevelopmentApiLdaregTargetBundle(input: {
    snapshot: unknown;
    captures: DevelopmentApiLdaregResolvedCapture[];
    legacyTarget07?: unknown;
    pins?: DevelopmentApiLdaregTargetPins;
}): DevelopmentApiLdaregTargetBundle {
    const snapshot =
        parseDevelopmentApiLdaregBundleDbSnapshot(input.snapshot);
    const captures = [...input.captures].sort((left, right) =>
        left.targetKey < right.targetKey ? -1 : 1
    );
    if (
        stableStringify(
            captures.map((capture) => capture.targetKey)
        ) !== stableStringify(DEVELOPMENT_API_LDAREG_TARGET_KEYS)
    ) {
        throw new Error('CAPTURE_TARGET_SET_INVALID');
    }
    const targets = snapshot.groups.map((group) => {
        const capture = captures.find(
            (candidate) => candidate.targetKey === group.key
        );
        if (!capture) throw new Error('CAPTURE_TARGET_MISSING');
        return {
            key: group.key,
            target: buildTarget({ group, capture }),
        };
    });
    const target07 = targets.find(
        (entry) => entry.key === 'ldareg-target-07'
    );
    if (!target07) throw new Error('TARGET_07_MISSING');
    if (input.legacyTarget07 !== undefined) {
        const transformed =
            transformLegacyDevelopmentApiLdaregTarget(
                input.legacyTarget07
            );
        if (
            stableStringify(transformed) !==
            stableStringify(target07.target)
        ) {
            if (
                isLegacyTargetExtensionUpgradeOnly({
                    transformedLegacy: transformed,
                    candidate: target07.target,
                })
            ) {
                throw new Error(
                    'LEGACY_TARGET_07_CANONICAL_DONG_UPGRADE_REQUIRED'
                );
            }
            throw new Error('LEGACY_TARGET_07_PIN_MISMATCH');
        }
        if (
            input.pins?.['ldareg-target-07'].provisioned &&
            transformed.manifestDigest !==
                input.pins['ldareg-target-07'].manifestDigest
        ) {
            throw new Error('LEGACY_TARGET_07_PIN_MISMATCH');
        }
        target07.target = transformed;
    } else if (
        input.pins?.['ldareg-target-07'].provisioned &&
        target07.target.manifestDigest !==
            input.pins['ldareg-target-07'].manifestDigest
    ) {
        throw new Error('TARGET_07_PIN_MISMATCH');
    }
    return parseDevelopmentApiLdaregTargetBundle({
        version: DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION,
        targets,
    });
}
