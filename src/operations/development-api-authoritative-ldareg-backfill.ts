import { createHash, randomUUID } from 'node:crypto';
import { parseBylotCnt } from '../services/land-area-sync/bylot';
import {
    buildBasisRootIndex,
    resolveExposRootIdentity,
} from '../services/land-area-sync/expos-root';
import {
    dedupLdaregObservations,
    type LdaregSourceRecord,
} from '../services/land-area-sync/identity';
import {
    normalizeUnitSegment,
} from '../services/land-area-sync/normalizer';
import {
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
    providerUnitShapeWitness,
    providerUnitShapeWitnessKey,
    type ProviderUnitShapeBridgeKind,
    type ProviderUnitShapeWitness,
} from '../services/land-area-sync/provider-unit-shape-bridge';
import { normalizeFloorLabel } from '../services/land-area-sync/preview';
import { parseLdaQotaRate } from '../services/land-area-sync/ratio';
import {
    validateLdaregReplication,
} from '../services/land-area-sync/ldareg-branch';
import { normalizeRegistryManagementPk } from '../services/land-area-sync/registry-pk';
import {
    assembleAttachedPnus,
    buildingHubRowsMatchPnu,
    type AtchJibunRowInput,
} from '../services/gis-shared/pnu';
import type {
    LandAreaSyncApplyLdaregComponent,
    LandAreaSyncApplyLdaregItem,
} from '../types/land-area-sync-job.types';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../types/land-area-sync.types';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^\d{10}[12]\d{8}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const SAFE_DECIMAL_RE = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;
const SOURCE_IDENTITY_RE =
    /^(?:primary|fallback):v2:[0-9a-f]{64}$/;
const CURRENT_CLASSIFICATION_CODE = '0';
const CURRENT_CLASSIFICATION_NAME = '현재';
const PROVIDER_SHAPE_BRIDGE_KINDS = new Set<
    ProviderUnitShapeBridgeKind
>([
    PROVIDER_UNIT_BRIDGE_ABOVE_NO_SUFFIX,
    PROVIDER_UNIT_BRIDGE_BASEMENT_B_HO,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_ABOVE,
    PROVIDER_UNIT_BRIDGE_FLOOR_AS_UNIT_BASEMENT,
]);

export const DEVELOPMENT_API_LDAREG_TARGET_VERSION =
    'development-api-authoritative-ldareg-backfill-target@2' as const;
export const DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION =
    'development-api-authoritative-ldareg-private-target-bundle@1' as const;
export const DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH =
    'a0d4ccaa97b102a07efbd729cd3b44ded54552041697d4cc045296f9fc686f65' as const;
export const DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST =
    '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' as const;
export const DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as const;
export const DEVELOPMENT_API_LDAREG_ARTIFACT_VERSION =
    'development-api-authoritative-ldareg-backfill-artifact@1' as const;
export const DEVELOPMENT_API_LDAREG_PREPARE_ARTIFACT_VERSION =
    'development-api-authoritative-ldareg-backfill-prepare-artifact@1' as const;
export const DEVELOPMENT_API_LDAREG_APPROVAL_REQUEST_VERSION =
    'development-api-authoritative-ldareg-backfill-approval-request@1' as const;
export const DEVELOPMENT_API_LDAREG_INSPECTOR_CONTRACT =
    'development-api-authoritative-ldareg-backfill-inspector@1' as const;
export const DEVELOPMENT_API_LDAREG_PHASE0_ARTIFACT_VERSION =
    'land-area-phase0-capture-artifact@6' as const;
export const DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST =
    Object.freeze([
        '99d06939e77afcf8220fc1b6cef55ea22315f11b38a24a13aeecb45a47c49e16',
        '0909518650db9d6330549bf67998a75b1c17378ece1dd14473be5f3c3cb3a05a',
    ] as const);
export const DEVELOPMENT_API_LDAREG_MAX_APPLY_ATTEMPTS = 3;
export const DEVELOPMENT_API_LDAREG_APPROVAL_TTL_MS =
    15 * 60 * 1000;

export interface DevelopmentApiLdaregPropertyTarget {
    propertyUnitId: string;
    expectedBuildingUnitId: string;
    expectedPnu: string;
    canonicalDong: string;
    normalizedFloor: string;
    normalizedHo: string;
    providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
    expectedNumerator: string;
}

export interface DevelopmentApiLdaregIgnoredOfficialUnit {
    canonicalDong: string;
    canonicalFloor: string;
    canonicalHo: string;
    providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
    expectedNumerator: string;
    reason: 'NO_ACTIVE_PROPERTY_UNIT';
}

export interface DevelopmentApiLdaregTarget {
    version: typeof DEVELOPMENT_API_LDAREG_TARGET_VERSION;
    databaseTarget: 'development';
    unionId: string;
    basePnu: string;
    managementPk: string;
    canonicalBuildingId: string;
    scopePnus: string[];
    propertyTargets: DevelopmentApiLdaregPropertyTarget[];
    ignoredOfficialUnits: DevelopmentApiLdaregIgnoredOfficialUnit[];
    expectedIgnoredOfficialUnitCount?: number;
    landParcels: Array<{
        pnu: string;
        expectedArea: string;
    }>;
    expectedDenominator: string;
    expectedLdaregRowCount: number;
    expectedIgnoredPlaceholderCount: number;
    phase0: {
        runId: string;
        artifactVersion: typeof DEVELOPMENT_API_LDAREG_PHASE0_ARTIFACT_VERSION;
        artifactSha256: string;
        schemaHash: string;
    };
    databaseDigests: {
        scopeDigest: string;
        propertyUnitDigest: string;
    };
    officialHashes: {
        managementPkHash: string;
        basePnuHash: string;
        attachedPnuHash: string;
        pairsDigest: string;
        titleSchemaHash: string;
        basisSchemaHash: string;
        attachedSchemaHash: string;
        exposSchemaHash: string;
        ladfrlSchemaHash: string;
        ldaregSchemaHash: string;
        ldaregRowMultisetDigest: string;
    };
    manifestDigest: string;
}

export type DevelopmentApiLdaregTargetKey =
    | 'ldareg-target-01'
    | 'ldareg-target-02'
    | 'ldareg-target-03'
    | 'ldareg-target-04'
    | 'ldareg-target-05'
    | 'ldareg-target-06'
    | 'ldareg-target-07';

export const DEVELOPMENT_API_LDAREG_TARGET_KEYS = Object.freeze([
    'ldareg-target-01',
    'ldareg-target-02',
    'ldareg-target-03',
    'ldareg-target-04',
    'ldareg-target-05',
    'ldareg-target-06',
    'ldareg-target-07',
] as const);

export interface DevelopmentApiLdaregTargetPin {
    manifestDigest: string;
    scopePnuCount: 1 | 2;
    bylotCount: 0 | 1;
    provisioned: boolean;
}

export type DevelopmentApiLdaregTargetPins = Readonly<
    Record<
        DevelopmentApiLdaregTargetKey,
        Readonly<DevelopmentApiLdaregTargetPin>
    >
>;

export interface DevelopmentApiLdaregTargetBundle {
    version: typeof DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION;
    targets: Array<{
        key: DevelopmentApiLdaregTargetKey;
        target: DevelopmentApiLdaregTarget;
    }>;
}

// 실제 비공개 bundle은 보호된 환경 secret으로만 공급한다. 저장소에는
// key별 manifest digest와 single/linked shape만 pin하고 raw 식별자는 두지 않는다.
export const DEVELOPMENT_API_LDAREG_TARGET_PINS: DevelopmentApiLdaregTargetPins =
    Object.freeze({
        'ldareg-target-01': Object.freeze({
            manifestDigest:
                '3852e734d114f1017832293bb82e9417c10c05c9f9c8ac7896e350a39307811e',
            scopePnuCount: 1,
            bylotCount: 0,
            provisioned: true,
        }),
        'ldareg-target-02': Object.freeze({
            manifestDigest:
                '2ca3914067d6f9b746f54ae17af736c01a2f0c171c875449b0180da685cadd73',
            scopePnuCount: 1,
            bylotCount: 0,
            provisioned: true,
        }),
        'ldareg-target-03': Object.freeze({
            manifestDigest:
                '5b0aa8bbe739311d418eae86a50ac728e559c1b1e35f00c7bce3fb84ae078398',
            scopePnuCount: 1,
            bylotCount: 0,
            provisioned: true,
        }),
        'ldareg-target-04': Object.freeze({
            manifestDigest:
                '4ca1a4c555b6e5ca435177bd273f20f75d3a3268c199b07bab9a55552862b106',
            scopePnuCount: 1,
            bylotCount: 0,
            provisioned: true,
        }),
        'ldareg-target-05': Object.freeze({
            manifestDigest:
                'f0e56c644779fc8e403a31b25b66351d60e69b94de42e0231516f07ef1340fa9',
            scopePnuCount: 1,
            bylotCount: 0,
            provisioned: true,
        }),
        'ldareg-target-06': Object.freeze({
            manifestDigest:
                'a76f4dc8a3d4a70f9c2c8851b15fa3961f74736d184cc9a9d4b0d2de611bd104',
            scopePnuCount: 1,
            bylotCount: 0,
            provisioned: true,
        }),
        'ldareg-target-07': Object.freeze({
            manifestDigest:
                '89f05d3c4c98809cfec87e321476c884c5be1baf517e80f798ef6ede02b50999',
            scopePnuCount: 2,
            bylotCount: 1,
            provisioned: true,
        }),
    });

export interface DevelopmentApiLdaregScanAdapter {
    scanTitle(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrTitleRow>>;
    scanBasis(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrBasisOulnRow>>;
    scanAttached(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrAtchJibunRow>>;
    scanExpos(
        pnu: string,
        auth: { serviceKey: string }
    ): Promise<StrictScan<BrExposRow>>;
    scanLadfrl(
        pnu: string,
        auth: { key: string; domain: string }
    ): Promise<StrictScan<LadfrlRow>>;
    scanLdareg(
        pnu: string,
        auth: { key: string; domain: string }
    ): Promise<StrictScan<LdaregRow>>;
}

export interface DevelopmentApiLdaregManualDecisionCounters {
    sourceReads: 0;
    resolverReads: 0;
    blockerReads: 0;
    fallbackReads: 0;
    selectionReads: 0;
}

export interface DevelopmentApiLdaregInvariantDigests {
    nonTargetPropertyUnits: string;
    propertyOwnerships: string;
    buildings: string;
    buildingUnits: string;
    buildingLandLots: string;
    buildingExternalRefs: string;
    landLots: string;
    nonTargetPropertyUnitLandRights: string;
}

export interface DevelopmentApiLdaregInspectorTarget {
    propertyUnitId: string;
    matchedBuildingUnitId: string;
    pnu: string;
    normalizedDong: string;
    normalizedHo: string;
}

export interface DevelopmentApiLdaregProposalArea {
    propertyUnitId: string;
    matchedBuildingUnitId: string;
    landArea: string;
    itemDigest: string;
}

export interface DevelopmentApiLdaregSnapshot {
    contractVersion: typeof DEVELOPMENT_API_LDAREG_INSPECTOR_CONTRACT;
    databaseTarget: 'development';
    unionId: string;
    basePnu: string;
    managementPk: string;
    canonicalBuildingId: string;
    scope: {
        pnus: string[];
        count: number;
        digest: string;
    };
    propertyTargets: {
        ids: string[];
        count: number;
        digest: string;
        targets: DevelopmentApiLdaregInspectorTarget[];
    };
    proposal: {
        digest: string;
        itemCount: number;
        componentCount: number;
        source: 'LDAREG';
        allCurrentPositive: true;
        proposedAreas: DevelopmentApiLdaregProposalArea[];
    } | null;
    currentState: {
        prestateTupleDigest: string;
        targetRightsDigest: string;
    };
    relationPrerequisite: {
        required: boolean;
        count: number;
        linkedCount: number;
        satisfied: boolean;
    };
    canonicalInvariantDigests: DevelopmentApiLdaregInvariantDigests;
    approval: {
        rowCount: number;
        enabled: boolean;
        consumedAt: string | null;
        consumedSyncJobId: string | null;
        targetDigest: string | null;
        expiresAt: string | null;
    };
    replay: {
        syncJobId: string | null;
        eligible: boolean;
        receiptDigest: string | null;
    };
    manualDecisionCounters: DevelopmentApiLdaregManualDecisionCounters;
}

export interface DevelopmentApiLdaregApplyReceipt {
    status: 'APPLIED' | 'REUSED';
    syncJobId: string;
    targetDigest: string;
    scopeDigest: string;
    propertyUnitDigest: string;
    proposedValuesDigest: string;
    prestateTupleDigest: string;
    prestateTargetRightsDigest: string;
    poststateTupleDigest: string;
    poststateTargetRightsDigest: string;
    rightsRowCount: number;
    updatedPropertyUnitCount: number;
    source: 'LDAREG';
    manualDecisionCounters: DevelopmentApiLdaregManualDecisionCounters;
    invariantDigests: {
        before: DevelopmentApiLdaregInvariantDigests;
        after: DevelopmentApiLdaregInvariantDigests;
        stable: true;
    };
    replay: {
        eligible: true;
        recovered: boolean;
        receiptDigest: string;
    };
}

export interface DevelopmentApiLdaregDatabase {
    inspect(input: {
        target: DevelopmentApiLdaregTarget;
        items: DevelopmentApiLdaregApprovalItem[] | null;
        syncJobId: string | null;
    }): Promise<DevelopmentApiLdaregSnapshot>;
    apply(input: {
        target: DevelopmentApiLdaregTarget;
        items: DevelopmentApiLdaregApprovalItem[];
        expectedScopeDigest: string;
        expectedPropertyUnitDigest: string;
        expectedProposedValuesDigest: string;
        expectedPrestateTupleDigest: string;
        expectedPrestateTargetRightsDigest: string;
        evidenceDigest: string;
        sourceReleaseSha: string;
        targetDigest: string;
        syncJobId: string;
    }): Promise<DevelopmentApiLdaregApplyReceipt>;
}

interface EndpointScanSummary {
    endpoint:
        | 'getBrTitleInfo'
        | 'getBrBasisOulnInfo'
        | 'getBrAtchJibunInfo'
        | 'getBrExposInfo'
        | 'ladfrlList'
        | 'ldaregList';
    queryPnuHash: string;
    state: 'COMPLETE' | 'COMPLETE_ZERO';
    totalCount: number;
    pagesFetched: number;
    schemaHash: string;
}

export interface DevelopmentApiLdaregOfficialEvidence {
    version: 'development-api-authoritative-ldareg-evidence@1';
    endpointScans: EndpointScanSummary[];
    managementPkHash: string;
    scopePnuHashes: string[];
    pairsDigest: string;
    totalPairs: 0 | 1;
    totalRejectedPairs: 0;
    bylotCount: 0 | 1;
    landParcelCount: number;
    landAreaTotal: string;
    exposUnitCount: number;
    ldaregRowCount: number;
    ignoredOfficialUnitCount: number;
    ignoredPlaceholderCount: number;
    currentTargetCount: number;
    componentCount: number;
    proposalAreas: Array<{
        propertyUnitIdHash: string;
        matchedBuildingUnitIdHash: string;
        roomHash: string;
        landArea: string;
        sourceIdentityHash: string;
    }>;
    ldaregRowMultisetDigest: string;
    evidenceDigest: string;
}

export interface DevelopmentApiLdaregApprovalComponent
    extends LandAreaSyncApplyLdaregComponent {
    canonicalDong: string;
    canonicalFloor: string;
    canonicalHo: string;
    providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
}

export interface DevelopmentApiLdaregApprovalItem
    extends Omit<LandAreaSyncApplyLdaregItem, 'components'> {
    components: DevelopmentApiLdaregApprovalComponent[];
}

export interface DevelopmentApiLdaregRunArtifact {
    version: typeof DEVELOPMENT_API_LDAREG_ARTIFACT_VERSION;
    databaseTarget: 'development';
    manifestDigest: string;
    targetDigest: string | null;
    sourceReleaseSha: string;
    syncJobIdHash: string;
    phase0: DevelopmentApiLdaregTarget['phase0'];
    officialScan: DevelopmentApiLdaregOfficialEvidence | null;
    proposal: {
        digest: string | null;
        itemCount: number | null;
        componentCount: number | null;
        source: 'LDAREG';
    };
    stateDigests: {
        prestateTupleDigest: string | null;
        poststateTupleDigest: string | null;
        targetRightsBeforeDigest: string | null;
        targetRightsAfterDigest: string | null;
    };
    invariantDigests: {
        before: DevelopmentApiLdaregInvariantDigests | null;
        after: DevelopmentApiLdaregInvariantDigests | null;
        stable: boolean;
    };
    relationPrerequisite: {
        required: boolean | null;
        beforeSatisfied: boolean | null;
        afterSatisfied: boolean | null;
        beforeCount: number | null;
        afterCount: number | null;
        beforeLinkedCount: number | null;
        afterLinkedCount: number | null;
    };
    dbApproval: {
        preinstalledVerified: boolean;
        consumedVerified: boolean;
    };
    applyCall: {
        attempts: number;
        maxAttempts: 3;
        receiptVerified: boolean;
        recoveredAfterAmbiguousError: boolean;
        status: 'APPLIED' | 'REUSED' | null;
        updatedPropertyUnitCount: number | null;
        rightsRowCount: number | null;
        receiptDigest: string | null;
    };
    verification: {
        discoveryVerified: boolean;
        proposalPreflightVerified: boolean;
        postflightVerified: boolean;
        exactCanonicalTargetCount: number;
    };
    productionWrites: {
        observedWriteCount: 0;
        verificationBoundary:
            'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED';
    };
    manualDecisionCounters: DevelopmentApiLdaregManualDecisionCounters;
    gate: {
        status: 'PASS' | 'FAIL';
        failureCodes: string[];
    };
}

export interface DevelopmentApiLdaregApprovalRequest {
    version: typeof DEVELOPMENT_API_LDAREG_APPROVAL_REQUEST_VERSION;
    databaseTarget: 'development';
    createdAt: string;
    expiresAt: string;
    manifestDigest: string;
    sourceReleaseSha: string;
    officialEvidence: DevelopmentApiLdaregOfficialEvidence;
    ownerApproval: {
        name: 'replace_development_api_authoritative_ldareg_backfill_approval_v1';
        args: {
            p_union_id: string;
            p_base_pnu: string;
            p_mgm_bldrgst_pk: string;
            p_scope_pnus: string[];
            p_property_unit_ids: string[];
            p_items: DevelopmentApiLdaregApprovalItem[];
            p_expected_scope_digest: string;
            p_expected_property_unit_digest: string;
            p_expected_proposed_values_digest: string;
            p_expected_prestate_tuple_digest: string;
            p_expected_prestate_rights_digest: string;
            p_target_manifest_digest: string;
            p_phase0_run_id: number;
            p_phase0_artifact_version: typeof DEVELOPMENT_API_LDAREG_PHASE0_ARTIFACT_VERSION;
            p_phase0_artifact_sha256: string;
            p_phase0_schema_hash: string;
            p_evidence_digest: string;
            p_source_release_sha: string;
            p_target_digest: string;
            p_enabled: true;
            p_expires_at: string;
        };
    };
    requestDigest: string;
}

export interface DevelopmentApiLdaregPrepareArtifact {
    version: typeof DEVELOPMENT_API_LDAREG_PREPARE_ARTIFACT_VERSION;
    mode: 'prepare';
    databaseTarget: 'development';
    manifestDigest: string;
    targetDigest: string | null;
    sourceReleaseSha: string;
    phase0: DevelopmentApiLdaregTarget['phase0'];
    officialScan: DevelopmentApiLdaregOfficialEvidence | null;
    proposal: {
        digest: string | null;
        itemCount: number | null;
        componentCount: number | null;
        source: 'LDAREG';
    };
    stateDigests: {
        prestateTupleDigest: string | null;
        targetRightsDigest: string | null;
    };
    invariantDigests:
        | DevelopmentApiLdaregInvariantDigests
        | null;
    relationPrerequisite: {
        required: boolean | null;
        satisfied: boolean | null;
        count: number | null;
        linkedCount: number | null;
    };
    approvalRequest: {
        requestDigest: string | null;
        expiresAt: string | null;
    };
    verification: {
        discoveryVerified: boolean;
        proposalPreflightVerified: boolean;
        approvalRequestVerified: boolean;
        exactCanonicalTargetCount: number;
    };
    executionBoundary: {
        inspectCallCount: number;
        applyRpcCallCount: 0;
        approvalRpcCallCount: 0;
        syncJobWriteCount: 0;
        propertyWriteCount: 0;
        propertyRightWriteCount: 0;
        verificationBoundary:
            'READ_ONLY_OFFICIAL_SCAN_AND_DATABASE_INSPECT_ONLY';
    };
    productionWrites: {
        observedWriteCount: 0;
        verificationBoundary:
            'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED';
    };
    manualDecisionCounters: DevelopmentApiLdaregManualDecisionCounters;
    gate: {
        status: 'PASS' | 'FAIL';
        failureCodes: string[];
    };
}

export interface RunDevelopmentApiLdaregBackfillInput {
    target: DevelopmentApiLdaregTarget;
    sourceReleaseSha: string;
    buildingHubServiceKey: string;
    vworldKey: string;
    vworldDomain: string;
    adapter: DevelopmentApiLdaregScanAdapter;
    database: DevelopmentApiLdaregDatabase;
    randomUuid?: () => string;
}

export interface PrepareDevelopmentApiLdaregBackfillInput
    extends Omit<
        RunDevelopmentApiLdaregBackfillInput,
        'randomUuid'
    > {
    now?: () => Date;
}

interface OfficialScanResult {
    evidence: DevelopmentApiLdaregOfficialEvidence;
    items: DevelopmentApiLdaregApprovalItem[];
}

class ControlledDevelopmentApiLdaregError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ControlledDevelopmentApiLdaregError';
    }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlledDevelopmentApiLdaregError(code);
    }
    return value as Record<string, unknown>;
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    return (
        JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...keys].sort())
    );
}

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

function canonicalDecimal(value: string): string {
    const [whole, fraction = ''] = value.trim().split('.');
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    return canonicalFraction
        ? `${canonicalWhole}.${canonicalFraction}`
        : canonicalWhole;
}

function positiveDecimal(value: unknown, code: string): string {
    if (typeof value !== 'string' || !SAFE_DECIMAL_RE.test(value)) {
        throw new ControlledDevelopmentApiLdaregError(code);
    }
    const canonical = canonicalDecimal(value);
    if (Number(canonical) <= 0) {
        throw new ControlledDevelopmentApiLdaregError(code);
    }
    return canonical;
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

function canonicalDongToken(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const normalized = normalizeUnitSegment(value);
    return normalized !== '' && /^0+$/u.test(normalized)
        ? ''
        : normalized;
}

function canonicalOfficialUnitKey(input: {
    canonicalDong: string;
    canonicalFloor: string;
    canonicalHo: string;
    providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
}): string {
    return [
        input.canonicalDong,
        input.canonicalFloor,
        input.canonicalHo,
        input.providerShapeBridgeKind ?? '',
    ].join('\u0000');
}

function canonicalOfficialLocationKey(input: {
    canonicalDong: string;
    canonicalFloor: string;
    canonicalHo: string;
}): string {
    return [
        input.canonicalDong,
        input.canonicalFloor,
        input.canonicalHo,
    ].join('\u0000');
}

function propertyCanonicalUnitKey(
    target: DevelopmentApiLdaregPropertyTarget
): string {
    return canonicalOfficialUnitKey({
        canonicalDong: target.canonicalDong,
        canonicalFloor: target.normalizedFloor,
        canonicalHo: target.normalizedHo,
        providerShapeBridgeKind:
            target.providerShapeBridgeKind,
    });
}

function parsePropertyTarget(
    value: unknown
): DevelopmentApiLdaregPropertyTarget {
    const row = asRecord(value, 'TARGET_PROPERTY_INVALID');
    if (
        !hasExactKeys(row, [
            'propertyUnitId',
            'expectedBuildingUnitId',
            'expectedPnu',
            'canonicalDong',
            'normalizedFloor',
            'normalizedHo',
            'providerShapeBridgeKind',
            'expectedNumerator',
        ]) ||
        typeof row.propertyUnitId !== 'string' ||
        !UUID_RE.test(row.propertyUnitId) ||
        typeof row.expectedBuildingUnitId !== 'string' ||
        !UUID_RE.test(row.expectedBuildingUnitId) ||
        typeof row.expectedPnu !== 'string' ||
        !PNU_RE.test(row.expectedPnu) ||
        typeof row.canonicalDong !== 'string' ||
        canonicalDongToken(row.canonicalDong) !==
            row.canonicalDong ||
        typeof row.normalizedFloor !== 'string' ||
        !/^[1-9]\d{0,2}$/u.test(row.normalizedFloor) ||
        normalizeFloorLabel(row.normalizedFloor) !==
            row.normalizedFloor ||
        row.normalizedFloor.length === 0 ||
        typeof row.normalizedHo !== 'string' ||
        normalizeUnitSegment(row.normalizedHo) !==
            row.normalizedHo ||
        row.normalizedHo.length === 0 ||
        !(
            row.providerShapeBridgeKind === null ||
            (typeof row.providerShapeBridgeKind === 'string' &&
                PROVIDER_SHAPE_BRIDGE_KINDS.has(
                    row.providerShapeBridgeKind as ProviderUnitShapeBridgeKind
                ))
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_PROPERTY_INVALID'
        );
    }
    return {
        propertyUnitId: row.propertyUnitId.toLowerCase(),
        expectedBuildingUnitId:
            row.expectedBuildingUnitId.toLowerCase(),
        expectedPnu: row.expectedPnu,
        canonicalDong: row.canonicalDong,
        normalizedFloor: row.normalizedFloor,
        normalizedHo: row.normalizedHo,
        providerShapeBridgeKind:
            row.providerShapeBridgeKind as ProviderUnitShapeBridgeKind | null,
        expectedNumerator: positiveDecimal(
            row.expectedNumerator,
            'TARGET_PROPERTY_INVALID'
        ),
    };
}

function parseIgnoredOfficialUnit(
    value: unknown
): DevelopmentApiLdaregIgnoredOfficialUnit {
    const row = asRecord(
        value,
        'TARGET_IGNORED_OFFICIAL_UNIT_INVALID'
    );
    if (
        !hasExactKeys(row, [
            'canonicalDong',
            'canonicalFloor',
            'canonicalHo',
            'providerShapeBridgeKind',
            'expectedNumerator',
            'reason',
        ]) ||
        typeof row.canonicalDong !== 'string' ||
        canonicalDongToken(row.canonicalDong) !==
            row.canonicalDong ||
        typeof row.canonicalFloor !== 'string' ||
        !/^[1-9]\d{0,2}$/u.test(row.canonicalFloor) ||
        normalizeFloorLabel(row.canonicalFloor) !==
            row.canonicalFloor ||
        typeof row.canonicalHo !== 'string' ||
        row.canonicalHo.length === 0 ||
        normalizeUnitSegment(row.canonicalHo) !==
            row.canonicalHo ||
        !(
            row.providerShapeBridgeKind === null ||
            (typeof row.providerShapeBridgeKind === 'string' &&
                PROVIDER_SHAPE_BRIDGE_KINDS.has(
                    row.providerShapeBridgeKind as ProviderUnitShapeBridgeKind
                ))
        ) ||
        row.reason !== 'NO_ACTIVE_PROPERTY_UNIT'
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_IGNORED_OFFICIAL_UNIT_INVALID'
        );
    }
    return {
        canonicalDong: row.canonicalDong,
        canonicalFloor: row.canonicalFloor,
        canonicalHo: row.canonicalHo,
        providerShapeBridgeKind:
            row.providerShapeBridgeKind as ProviderUnitShapeBridgeKind | null,
        expectedNumerator: positiveDecimal(
            row.expectedNumerator,
            'TARGET_IGNORED_OFFICIAL_UNIT_INVALID'
        ),
        reason: 'NO_ACTIVE_PROPERTY_UNIT',
    };
}

function targetIdentity(
    target: Omit<DevelopmentApiLdaregTarget, 'manifestDigest'>
): string {
    return stableStringify({
        ...target,
        unionId: target.unionId.toLowerCase(),
        canonicalBuildingId:
            target.canonicalBuildingId.toLowerCase(),
    });
}

export function computeDevelopmentApiLdaregManifestDigest(
    target: Omit<DevelopmentApiLdaregTarget, 'manifestDigest'>
): string {
    return sha256(targetIdentity(target));
}

export function parseDevelopmentApiLdaregTarget(
    input: unknown
): DevelopmentApiLdaregTarget {
    const value = asRecord(input, 'TARGET_MANIFEST_INVALID');
    const hasExpectedIgnoredOfficialUnitCount =
        Object.prototype.hasOwnProperty.call(
            value,
            'expectedIgnoredOfficialUnitCount'
        );
    const targetKeys = [
        'version',
        'databaseTarget',
        'unionId',
        'basePnu',
        'managementPk',
        'canonicalBuildingId',
        'scopePnus',
        'propertyTargets',
        'ignoredOfficialUnits',
        'landParcels',
        'expectedDenominator',
        'expectedLdaregRowCount',
        'expectedIgnoredPlaceholderCount',
        'phase0',
        'databaseDigests',
        'officialHashes',
        'manifestDigest',
        ...(hasExpectedIgnoredOfficialUnitCount
            ? ['expectedIgnoredOfficialUnitCount']
            : []),
    ];
    if (
        !hasExactKeys(value, targetKeys) ||
        value.version !== DEVELOPMENT_API_LDAREG_TARGET_VERSION ||
        value.databaseTarget !== 'development' ||
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
        (value.scopePnus.length !== 1 &&
            value.scopePnus.length !== 2) ||
        !value.scopePnus.every(
            (pnu): pnu is string =>
                typeof pnu === 'string' && PNU_RE.test(pnu)
        ) ||
        !exactSortedUnique(value.scopePnus) ||
        !value.scopePnus.includes(value.basePnu) ||
        !Array.isArray(value.propertyTargets) ||
        value.propertyTargets.length === 0 ||
        value.propertyTargets.length > 100 ||
        !Array.isArray(value.ignoredOfficialUnits) ||
        value.ignoredOfficialUnits.length > 100 ||
        (hasExpectedIgnoredOfficialUnitCount &&
            (typeof value.expectedIgnoredOfficialUnitCount !==
                'number' ||
                !Number.isSafeInteger(
                    value.expectedIgnoredOfficialUnitCount
                ) ||
                value.expectedIgnoredOfficialUnitCount < 0)) ||
        !Array.isArray(value.landParcels) ||
        value.landParcels.length !== value.scopePnus.length ||
        typeof value.expectedLdaregRowCount !== 'number' ||
        !Number.isSafeInteger(value.expectedLdaregRowCount) ||
        value.expectedLdaregRowCount <= 0 ||
        typeof value.expectedIgnoredPlaceholderCount !== 'number' ||
        !Number.isSafeInteger(
            value.expectedIgnoredPlaceholderCount
        ) ||
        value.expectedIgnoredPlaceholderCount < 0 ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_MANIFEST_INVALID'
        );
    }
    const propertyTargets = value.propertyTargets.map(
        parsePropertyTarget
    );
    const ignoredOfficialUnits = value.ignoredOfficialUnits.map(
        parseIgnoredOfficialUnit
    );
    const scopePnus = [...(value.scopePnus as string[])];
    const ignoredOfficialUnitKeys = ignoredOfficialUnits.map(
        canonicalOfficialUnitKey
    );
    const propertyOfficialUnitKeys = propertyTargets.map(
        propertyCanonicalUnitKey
    );
    const propertyOfficialLocationKeys = propertyTargets.map(
        (target) =>
            canonicalOfficialLocationKey({
                canonicalDong: target.canonicalDong,
                canonicalFloor: target.normalizedFloor,
                canonicalHo: target.normalizedHo,
            })
    );
    const ignoredOfficialLocationKeys = ignoredOfficialUnits.map(
        canonicalOfficialLocationKey
    );
    const propertyOfficialUnitKeySet = new Set(
        propertyOfficialUnitKeys
    );
    const propertyOfficialLocationKeySet = new Set(
        propertyOfficialLocationKeys
    );
    if (
        !exactSortedUnique(
            propertyTargets.map((target) => target.propertyUnitId)
        ) ||
        new Set(propertyOfficialUnitKeys).size !==
            propertyTargets.length ||
        new Set(propertyOfficialLocationKeys).size !==
            propertyTargets.length ||
        propertyTargets.some(
            (target) => !scopePnus.includes(target.expectedPnu)
        ) ||
        new Set(
            propertyTargets.map(
                (target) => target.expectedBuildingUnitId
            )
        ).size !== propertyTargets.length ||
        !exactSortedUnique(ignoredOfficialUnitKeys) ||
        new Set(ignoredOfficialLocationKeys).size !==
            ignoredOfficialUnits.length ||
        ignoredOfficialUnitKeys.some((key) =>
            propertyOfficialUnitKeySet.has(key)
        ) ||
        ignoredOfficialLocationKeys.some((key) =>
            propertyOfficialLocationKeySet.has(key)
        ) ||
        (hasExpectedIgnoredOfficialUnitCount &&
            value.expectedIgnoredOfficialUnitCount !==
                ignoredOfficialUnits.length)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_PROPERTY_INVALID'
        );
    }
    const landParcels = value.landParcels.map((entry) => {
        const row = asRecord(entry, 'TARGET_LAND_PARCEL_INVALID');
        if (
            !hasExactKeys(row, ['pnu', 'expectedArea']) ||
            typeof row.pnu !== 'string' ||
            !PNU_RE.test(row.pnu)
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'TARGET_LAND_PARCEL_INVALID'
            );
        }
        return {
            pnu: row.pnu,
            expectedArea: positiveDecimal(
                row.expectedArea,
                'TARGET_LAND_PARCEL_INVALID'
            ),
        };
    });
    if (
        !exactSortedUnique(
            landParcels.map((parcel) => parcel.pnu)
        ) ||
        stableStringify(
            landParcels.map((parcel) => parcel.pnu)
        ) !== stableStringify(scopePnus)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_LAND_PARCEL_INVALID'
        );
    }
    const expectedDenominator = positiveDecimal(
        value.expectedDenominator,
        'TARGET_DENOMINATOR_INVALID'
    );
    const calculatedDenominator = landParcels.reduce(
        (sum, parcel) => sum + Number(parcel.expectedArea),
        0
    );
    if (
        canonicalDecimal(String(calculatedDenominator)) !==
        expectedDenominator
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_DENOMINATOR_INVALID'
        );
    }
    const phase0 = asRecord(value.phase0, 'TARGET_PHASE0_INVALID');
    if (
        !hasExactKeys(phase0, [
            'runId',
            'artifactVersion',
            'artifactSha256',
            'schemaHash',
        ]) ||
        typeof phase0.runId !== 'string' ||
        !POSITIVE_INTEGER_RE.test(phase0.runId) ||
        phase0.artifactVersion !==
            DEVELOPMENT_API_LDAREG_PHASE0_ARTIFACT_VERSION ||
        typeof phase0.artifactSha256 !== 'string' ||
        !HEX64_RE.test(phase0.artifactSha256) ||
        typeof phase0.schemaHash !== 'string' ||
        !HEX64_RE.test(phase0.schemaHash) ||
        !DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST.includes(
            phase0.schemaHash as (typeof DEVELOPMENT_API_LDAREG_PHASE0_SCHEMA_HASH_ALLOWLIST)[number]
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_PHASE0_INVALID'
        );
    }
    const officialHashes = asRecord(
        value.officialHashes,
        'TARGET_OFFICIAL_HASHES_INVALID'
    );
    const officialHashKeys = [
        'managementPkHash',
        'basePnuHash',
        'attachedPnuHash',
        'pairsDigest',
        'titleSchemaHash',
        'basisSchemaHash',
        'attachedSchemaHash',
        'exposSchemaHash',
        'ladfrlSchemaHash',
        'ldaregSchemaHash',
        'ldaregRowMultisetDigest',
    ] as const;
    if (
        !hasExactKeys(officialHashes, officialHashKeys) ||
        officialHashKeys.some(
            (key) =>
                typeof officialHashes[key] !== 'string' ||
                !HEX64_RE.test(officialHashes[key])
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_OFFICIAL_HASHES_INVALID'
        );
    }
    const singlePnu = scopePnus.length === 1;
    if (
        (singlePnu &&
            (officialHashes.attachedPnuHash !==
                DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH ||
                officialHashes.pairsDigest !==
                    DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST ||
                officialHashes.attachedSchemaHash !==
                    DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH)) ||
        (!singlePnu &&
            (officialHashes.attachedPnuHash ===
                DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH ||
                officialHashes.pairsDigest ===
                    DEVELOPMENT_API_LDAREG_EMPTY_PAIRS_DIGEST ||
                officialHashes.attachedSchemaHash ===
                    DEVELOPMENT_API_LDAREG_EMPTY_SCHEMA_HASH))
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_OFFICIAL_HASHES_SCOPE_MISMATCH'
        );
    }
    const databaseDigests = asRecord(
        value.databaseDigests,
        'TARGET_DATABASE_DIGESTS_INVALID'
    );
    if (
        !hasExactKeys(databaseDigests, [
            'scopeDigest',
            'propertyUnitDigest',
        ]) ||
        typeof databaseDigests.scopeDigest !== 'string' ||
        !HEX64_RE.test(databaseDigests.scopeDigest) ||
        typeof databaseDigests.propertyUnitDigest !== 'string' ||
        !HEX64_RE.test(databaseDigests.propertyUnitDigest)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_DATABASE_DIGESTS_INVALID'
        );
    }
    const parsed: DevelopmentApiLdaregTarget = {
        version: DEVELOPMENT_API_LDAREG_TARGET_VERSION,
        databaseTarget: 'development',
        unionId: value.unionId.toLowerCase(),
        basePnu: value.basePnu,
        managementPk: value.managementPk,
        canonicalBuildingId:
            value.canonicalBuildingId.toLowerCase(),
        scopePnus,
        propertyTargets,
        ignoredOfficialUnits,
        ...(hasExpectedIgnoredOfficialUnitCount
            ? {
                  expectedIgnoredOfficialUnitCount:
                      value.expectedIgnoredOfficialUnitCount as number,
              }
            : {}),
        landParcels,
        expectedDenominator,
        expectedLdaregRowCount: value.expectedLdaregRowCount,
        expectedIgnoredPlaceholderCount:
            value.expectedIgnoredPlaceholderCount,
        phase0: {
            runId: phase0.runId,
            artifactVersion:
                DEVELOPMENT_API_LDAREG_PHASE0_ARTIFACT_VERSION,
            artifactSha256: phase0.artifactSha256,
            schemaHash: phase0.schemaHash,
        },
        databaseDigests: {
            scopeDigest: databaseDigests.scopeDigest,
            propertyUnitDigest:
                databaseDigests.propertyUnitDigest,
        },
        officialHashes: Object.fromEntries(
            officialHashKeys.map((key) => [
                key,
                officialHashes[key] as string,
            ])
        ) as DevelopmentApiLdaregTarget['officialHashes'],
        manifestDigest: value.manifestDigest,
    };
    const expectedManifestDigest =
        computeDevelopmentApiLdaregManifestDigest(
            (({ manifestDigest: _omitted, ...target }) =>
                target)(parsed)
        );
    if (expectedManifestDigest !== parsed.manifestDigest) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_MANIFEST_DIGEST_MISMATCH'
        );
    }
    return parsed;
}

function isDevelopmentApiLdaregTargetKey(
    value: unknown
): value is DevelopmentApiLdaregTargetKey {
    return (
        typeof value === 'string' &&
        (
            DEVELOPMENT_API_LDAREG_TARGET_KEYS as readonly string[]
        ).includes(value)
    );
}

export function parseDevelopmentApiLdaregTargetBundle(
    input: unknown
): DevelopmentApiLdaregTargetBundle {
    const value = asRecord(input, 'TARGET_BUNDLE_INVALID');
    if (
        !hasExactKeys(value, ['version', 'targets']) ||
        value.version !==
            DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION ||
        !Array.isArray(value.targets) ||
        value.targets.length !==
            DEVELOPMENT_API_LDAREG_TARGET_KEYS.length
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_BUNDLE_INVALID'
        );
    }
    const targets = value.targets.map((entry) => {
        const row = asRecord(entry, 'TARGET_BUNDLE_INVALID');
        if (
            !hasExactKeys(row, ['key', 'target']) ||
            !isDevelopmentApiLdaregTargetKey(row.key)
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'TARGET_BUNDLE_INVALID'
            );
        }
        return {
            key: row.key,
            target: parseDevelopmentApiLdaregTarget(row.target),
        };
    });
    const observedKeys = targets.map((entry) => entry.key).sort();
    const expectedKeys = [...DEVELOPMENT_API_LDAREG_TARGET_KEYS].sort();
    const manifestDigests = targets
        .map((entry) => entry.target.manifestDigest)
        .sort();
    if (
        stableStringify(observedKeys) !==
            stableStringify(expectedKeys) ||
        !exactSortedUnique(manifestDigests)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_BUNDLE_INVALID'
        );
    }
    return {
        version: DEVELOPMENT_API_LDAREG_TARGET_BUNDLE_VERSION,
        targets: targets.sort((left, right) =>
            left.key < right.key ? -1 : 1
        ),
    };
}

export function selectDevelopmentApiLdaregTargetFromBundle(input: {
    bundle: unknown;
    targetKey: string;
    pins?: DevelopmentApiLdaregTargetPins;
}): DevelopmentApiLdaregTarget {
    if (!isDevelopmentApiLdaregTargetKey(input.targetKey)) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_BUNDLE_KEY_INVALID'
        );
    }
    const bundle = parseDevelopmentApiLdaregTargetBundle(input.bundle);
    const entry = bundle.targets.find(
        (candidate) => candidate.key === input.targetKey
    );
    const pin = (input.pins ?? DEVELOPMENT_API_LDAREG_TARGET_PINS)[
        input.targetKey
    ];
    if (
        !entry ||
        !pin ||
        pin.provisioned !== true ||
        !HEX64_RE.test(pin.manifestDigest) ||
        entry.target.manifestDigest !== pin.manifestDigest ||
        entry.target.scopePnus.length !== pin.scopePnuCount ||
        entry.target.scopePnus.length - 1 !== pin.bylotCount
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'TARGET_BUNDLE_PIN_MISMATCH'
        );
    }
    return entry.target;
}

export function computeDevelopmentApiLdaregExecutionTargetDigest(input: {
    target: DevelopmentApiLdaregTarget;
    scopeDigest: string;
    propertyUnitDigest: string;
    proposedValuesDigest: string;
    prestateTupleDigest: string;
    prestateTargetRightsDigest: string;
    evidenceDigest: string;
    sourceReleaseSha: string;
}): string {
    if (
        ![
            input.scopeDigest,
            input.propertyUnitDigest,
            input.proposedValuesDigest,
            input.prestateTupleDigest,
            input.prestateTargetRightsDigest,
            input.evidenceDigest,
        ].every((value) => HEX64_RE.test(value)) ||
        !HEX40_RE.test(input.sourceReleaseSha)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'EXECUTION_TARGET_DIGEST_INPUT_INVALID'
        );
    }
    // PostgreSQL의 concat_ws(E'\n', ...)와 byte-for-byte 동일하다.
    // 마지막 newline은 없으며 manifest digest가 target의 raw 식별자/매핑을 봉인한다.
    return sha256(
        [
            'development-api-authoritative-ldareg-execution-target@1',
            'development',
            input.target.manifestDigest,
            input.scopeDigest,
            input.propertyUnitDigest,
            input.proposedValuesDigest,
            input.prestateTupleDigest,
            input.prestateTargetRightsDigest,
            input.target.phase0.runId,
            input.target.phase0.artifactVersion,
            input.target.phase0.artifactSha256,
            input.target.phase0.schemaHash,
            input.evidenceDigest,
            input.sourceReleaseSha,
        ].join('\n')
    );
}

function completeRows<T>(
    scan: StrictScan<T>,
    endpoint: EndpointScanSummary['endpoint'],
    queryPnu: string,
    allowZero: boolean
): {
    rows: T[];
    summary: EndpointScanSummary;
} {
    const endpointCode: Record<
        EndpointScanSummary['endpoint'],
        string
    > = {
        getBrTitleInfo: 'GET_BR_TITLE_INFO',
        getBrBasisOulnInfo: 'GET_BR_BASIS_OULN_INFO',
        getBrAtchJibunInfo: 'GET_BR_ATCH_JIBUN_INFO',
        getBrExposInfo: 'GET_BR_EXPOS_INFO',
        ladfrlList: 'LADFRL_LIST',
        ldaregList: 'LDAREG_LIST',
    };
    if (scan.state === 'FAILED' || scan.state === 'INCOMPLETE') {
        throw new ControlledDevelopmentApiLdaregError(
            `OFFICIAL_${endpointCode[endpoint]}_NOT_COMPLETE`
        );
    }
    if (scan.state === 'COMPLETE_ZERO' && !allowZero) {
        throw new ControlledDevelopmentApiLdaregError(
            `OFFICIAL_${endpointCode[endpoint]}_ZERO`
        );
    }
    const rows = scan.rows;
    if (
        !Number.isSafeInteger(scan.pagesFetched) ||
        scan.pagesFetched < 1 ||
        !Number.isSafeInteger(scan.totalCount) ||
        scan.totalCount < 0 ||
        (scan.state === 'COMPLETE' &&
            (rows.length === 0 ||
                scan.totalCount !== rows.length)) ||
        (scan.state === 'COMPLETE_ZERO' &&
            (rows.length !== 0 || scan.totalCount !== 0))
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            `OFFICIAL_${endpointCode[endpoint]}_NOT_COMPLETE`
        );
    }
    return {
        rows,
        summary: {
            endpoint,
            queryPnuHash: sha256(`PNU\u0000${queryPnu}`),
            state: scan.state,
            totalCount: scan.totalCount,
            pagesFetched: scan.pagesFetched,
            schemaHash: schemaHash(rows),
        },
    };
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

function recordString(
    row: Record<string, unknown>,
    ...keys: string[]
): string {
    for (const key of keys) {
        const value = row[key];
        if (
            typeof value === 'string' ||
            (typeof value === 'number' && Number.isFinite(value))
        ) {
            const normalized = String(value).normalize('NFKC').trim();
            if (normalized) return normalized;
        }
    }
    return '';
}

function toAttachedInput(row: BrAtchJibunRow): AtchJibunRowInput {
    const optionalString = (
        value: string | number | undefined
    ): string | undefined =>
        value === undefined ? undefined : String(value);
    return {
        mgmBldrgstPk: optionalString(row.mgmBldrgstPk) ?? '',
        sigunguCd: optionalString(row.sigunguCd) ?? '',
        bjdongCd: optionalString(row.bjdongCd) ?? '',
        platGbCd: optionalString(row.platGbCd) ?? '',
        bun: optionalString(row.bun) ?? '',
        ji: optionalString(row.ji) ?? '',
        atchSigunguCd: optionalString(row.atchSigunguCd) ?? '',
        atchBjdongCd: optionalString(row.atchBjdongCd) ?? '',
        atchPlatGbCd: optionalString(row.atchPlatGbCd) ?? '',
        atchBun: optionalString(row.atchBun) ?? '',
        atchJi: optionalString(row.atchJi) ?? '',
    };
}

function rootManagementPk(
    row: BrTitleRow | BrBasisOulnRow
): string | null {
    const self = normalizeRegistryManagementPk(
        row.mgmBldrgstPk
    );
    const up = normalizeRegistryManagementPk(
        row.mgmUpBldrgstPk
    );
    return up ?? self;
}

interface OfficialExposUnit {
    selfIdentity: string;
    rootIdentity: string;
    normalizedDong: string;
    normalizedFloor: string;
    normalizedHo: string;
    providerShapeWitness: ProviderUnitShapeWitness | null;
}

function collectOfficialExposUnits(input: {
    target: DevelopmentApiLdaregTarget;
    perPnuRows: Array<{ pnu: string; rows: BrExposRow[] }>;
    basisRows: BrBasisOulnRow[];
}): OfficialExposUnit[] {
    const basisIndex = buildBasisRootIndex(input.basisRows, [
        input.target.managementPk,
    ]);
    if (!basisIndex.ok) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_EXPOS_ROOT_AMBIGUOUS'
        );
    }
    const representativeByKey = new Map<
        string,
        OfficialExposUnit
    >();
    for (const query of input.perPnuRows) {
        const localKeys = new Set<string>();
        for (const rawRow of query.rows) {
            const resolved = resolveExposRootIdentity(
                rawRow,
                basisIndex.index
            );
            if (
                !resolved.ok ||
                resolved.evidence.rootIdentity !==
                    input.target.managementPk
            ) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_EXPOS_ROOT_AMBIGUOUS'
                );
            }
            const row = rawRow as Record<string, unknown>;
            const normalizedDong = canonicalDongToken(
                recordString(
                    row,
                    'dongNm',
                    'buldDongNm',
                    'dong'
                )
            );
            const normalizedFloor = normalizeFloorLabel(
                recordString(
                    row,
                    'flrNoNm',
                    'buldFloorNm',
                    'floor',
                    'flrNo'
                )
            );
            const normalizedHo = normalizeUnitSegment(
                recordString(
                    row,
                    'hoNm',
                    'buldHoNm',
                    'ho'
                )
            );
            if (!normalizedFloor || !normalizedHo) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_EXPOS_ROOM_INCOMPLETE'
                );
            }
            const key = canonicalOfficialLocationKey({
                canonicalDong: normalizedDong,
                canonicalFloor: normalizedFloor,
                canonicalHo: normalizedHo,
            });
            if (localKeys.has(key)) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_EXPOS_DUPLICATE_ROOM'
                );
            }
            localKeys.add(key);
            const candidate: OfficialExposUnit = {
                selfIdentity: resolved.evidence.selfIdentity,
                rootIdentity: resolved.evidence.rootIdentity,
                normalizedDong,
                normalizedFloor,
                normalizedHo,
                providerShapeWitness:
                    providerUnitShapeWitness(
                        'EXPOS_UNIT',
                        rawRow as Record<string, unknown>
                    ),
            };
            const prior = representativeByKey.get(key);
            if (
                prior &&
                stableStringify(prior) !== stableStringify(candidate)
            ) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_EXPOS_AMBIGUOUS_ROOM'
                );
            }
            representativeByKey.set(key, prior ?? candidate);
        }
    }
    const units = [...representativeByKey.values()].sort((a, b) =>
        canonicalOfficialLocationKey({
            canonicalDong: a.normalizedDong,
            canonicalFloor: a.normalizedFloor,
            canonicalHo: a.normalizedHo,
        }) <
        canonicalOfficialLocationKey({
            canonicalDong: b.normalizedDong,
            canonicalFloor: b.normalizedFloor,
            canonicalHo: b.normalizedHo,
        })
            ? -1
            : 1
    );
    return units;
}

const LDAREG_SOURCE_RECORD_FIELDS = [
    'pnu',
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

function extractSourceRecord(
    row: LdaregRow
): Record<string, string | null> {
    const source = row as Record<string, unknown>;
    return Object.fromEntries(
        LDAREG_SOURCE_RECORD_FIELDS.map((key) => {
            const value = source[key];
            if (value === undefined || value === null) {
                return [key, null];
            }
            if (typeof value !== 'string') {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_LDAREG_SOURCE_RECORD_INVALID'
                );
            }
            return [key, value];
        })
    );
}

function isAllZeroRawToken(value: string | null): boolean {
    return (
        value !== null &&
        /^0+$/u.test(value.normalize('NFKC').trim())
    );
}

function isIgnoredPlaceholderSourceRecord(
    source: Record<string, string | null>
): boolean {
    return (
        isAllZeroRawToken(source.buldDongNm) &&
        isAllZeroRawToken(source.buldFloorNm) &&
        isAllZeroRawToken(source.buldHoNm) &&
        isAllZeroRawToken(source.buldRoomNm) &&
        source.clsSeCode === CURRENT_CLASSIFICATION_CODE &&
        source.clsSeCodeNm === CURRENT_CLASSIFICATION_NAME
    );
}

function canonicalLdaregLogicalKey(row: LdaregRow): string {
    const source = extractSourceRecord(row);
    const ratio = parseLdaQotaRate(source.ldaQotaRate);
    const normalizedFloor = normalizeFloorLabel(
        source.buldFloorNm
    );
    const normalizedHo = normalizeUnitSegment(source.buldHoNm);
    const normalizedDong = canonicalDongToken(
        source.buldDongNm
    );
    const normalizedRoom = normalizeUnitSegment(
        source.buldRoomNm === '0000'
            ? ''
            : source.buldRoomNm
    );
    return stableStringify({
        agbldgSn: source.agbldgSn,
        buldNm: source.buldNm,
        normalizedDong,
        normalizedFloor,
        normalizedHo,
        normalizedRoom,
        ratio: ratio.ok
            ? {
                  numerator: canonicalDecimal(
                      ratio.numeratorText
                  ),
                  denominator: canonicalDecimal(
                      ratio.denominatorText
                  ),
              }
            : { invalid: source.ldaQotaRate },
        clsSeCode: source.clsSeCode,
        clsSeCodeNm: source.clsSeCodeNm,
        relateLdEmdLiCode: source.relateLdEmdLiCode,
        lastUpdtDt: source.lastUpdtDt,
    });
}

function validateLandParcels(input: {
    target: DevelopmentApiLdaregTarget;
    scans: Array<{ pnu: string; rows: LadfrlRow[] }>;
}): string {
    const observed = input.scans.map((scan) => {
        if (scan.rows.length !== 1) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LADFRL_NOT_EXACT_ONE'
            );
        }
        const row = scan.rows[0] as Record<string, unknown>;
        const pnu = recordString(row, 'pnu');
        const area = positiveDecimal(
            recordString(row, 'lndpclAr'),
            'OFFICIAL_LADFRL_AREA_INVALID'
        );
        if (pnu !== scan.pnu) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LADFRL_PNU_MISMATCH'
            );
        }
        return { pnu, area };
    });
    const expected = input.target.landParcels.map((parcel) => ({
        pnu: parcel.pnu,
        area: parcel.expectedArea,
    }));
    if (stableStringify(observed) !== stableStringify(expected)) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LADFRL_SCOPE_AREA_MISMATCH'
        );
    }
    const total = canonicalDecimal(
        String(
            observed.reduce(
                (sum, parcel) => sum + Number(parcel.area),
                0
            )
        )
    );
    if (total !== input.target.expectedDenominator) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LADFRL_DENOMINATOR_MISMATCH'
        );
    }
    return total;
}

function expectedRelationPrerequisite(
    target: DevelopmentApiLdaregTarget
): {
    required: boolean;
    count: number;
    linkedCount: number;
    satisfied: true;
} {
    const attachedCount = target.scopePnus.length - 1;
    return {
        required: attachedCount === 1,
        count: attachedCount,
        linkedCount: attachedCount,
        satisfied: true,
    };
}

function validateDiscoveryTarget(input: {
    target: DevelopmentApiLdaregTarget;
    snapshot: DevelopmentApiLdaregSnapshot;
    expectedProposal: 'NULL' | 'PRESENT';
}): Map<string, DevelopmentApiLdaregInspectorTarget> {
    const { target, snapshot } = input;
    const expectedRelation =
        expectedRelationPrerequisite(target);
    if (
        snapshot.contractVersion !==
            DEVELOPMENT_API_LDAREG_INSPECTOR_CONTRACT ||
        snapshot.databaseTarget !== 'development' ||
        snapshot.unionId !== target.unionId ||
        snapshot.basePnu !== target.basePnu ||
        snapshot.managementPk !== target.managementPk ||
        snapshot.canonicalBuildingId !==
            target.canonicalBuildingId ||
        snapshot.scope.count !== target.scopePnus.length ||
        stableStringify(snapshot.scope.pnus) !==
            stableStringify(target.scopePnus) ||
        !HEX64_RE.test(snapshot.scope.digest) ||
        snapshot.scope.digest !==
            target.databaseDigests.scopeDigest ||
        snapshot.propertyTargets.count !==
            target.propertyTargets.length ||
        !HEX64_RE.test(snapshot.propertyTargets.digest) ||
        snapshot.propertyTargets.digest !==
            target.databaseDigests.propertyUnitDigest ||
        !HEX64_RE.test(
            snapshot.currentState.prestateTupleDigest
        ) ||
        !HEX64_RE.test(
            snapshot.currentState.targetRightsDigest
        ) ||
        stableStringify(snapshot.relationPrerequisite) !==
            stableStringify(expectedRelation) ||
        !manualCountersAreZero(snapshot.manualDecisionCounters) ||
        Object.values(snapshot.canonicalInvariantDigests).some(
            (digest) => !HEX64_RE.test(digest)
        ) ||
        (input.expectedProposal === 'NULL'
            ? snapshot.proposal !== null
            : snapshot.proposal === null)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_INSPECTOR_TARGET_INVALID'
        );
    }
    const ids = snapshot.propertyTargets.targets.map(
        (property) => property.propertyUnitId
    );
    const expectedIds = target.propertyTargets.map(
        (property) => property.propertyUnitId
    );
    if (
        snapshot.propertyTargets.targets.length !==
            target.propertyTargets.length ||
        !exactSortedUnique(ids) ||
        stableStringify(snapshot.propertyTargets.ids) !==
            stableStringify(ids) ||
        stableStringify(ids) !== stableStringify(expectedIds)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_CANONICAL_PROPERTY_TARGET_MISMATCH'
        );
    }
    const targetById = new Map(
        target.propertyTargets.map((property) => [
            property.propertyUnitId,
            property,
        ])
    );
    const discoveredById = new Map<
        string,
        DevelopmentApiLdaregInspectorTarget
    >();
    const buildingUnitIds = new Set<string>();
    for (const property of snapshot.propertyTargets.targets) {
        const expected = targetById.get(property.propertyUnitId);
        if (
            !expected ||
            !UUID_RE.test(property.matchedBuildingUnitId) ||
            property.matchedBuildingUnitId.toLowerCase() !==
                expected.expectedBuildingUnitId ||
            !PNU_RE.test(property.pnu) ||
            property.pnu !== expected.expectedPnu ||
            normalizeUnitSegment(property.normalizedHo) !==
                expected.normalizedHo ||
            typeof property.normalizedDong !== 'string' ||
            property.normalizedDong.length > 100 ||
            buildingUnitIds.has(
                property.matchedBuildingUnitId.toLowerCase()
            )
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'DB_CANONICAL_BUILDING_UNIT_AMBIGUOUS'
            );
        }
        buildingUnitIds.add(
            property.matchedBuildingUnitId.toLowerCase()
        );
        discoveredById.set(property.propertyUnitId, {
            ...property,
            propertyUnitId:
                property.propertyUnitId.toLowerCase(),
            matchedBuildingUnitId:
                property.matchedBuildingUnitId.toLowerCase(),
        });
    }
    return discoveredById;
}

function manualCountersAreZero(
    counters: DevelopmentApiLdaregManualDecisionCounters
): boolean {
    return (
        counters.sourceReads === 0 &&
        counters.resolverReads === 0 &&
        counters.blockerReads === 0 &&
        counters.fallbackReads === 0 &&
        counters.selectionReads === 0
    );
}

function invariantDigestsEqual(
    left: DevelopmentApiLdaregInvariantDigests,
    right: DevelopmentApiLdaregInvariantDigests
): boolean {
    return stableStringify(left) === stableStringify(right);
}

function assertReadOnlySnapshotsStable(
    discovery: DevelopmentApiLdaregSnapshot,
    preflight: DevelopmentApiLdaregSnapshot
): void {
    if (
        discovery.scope.digest !== preflight.scope.digest ||
        discovery.propertyTargets.digest !==
            preflight.propertyTargets.digest ||
        discovery.currentState.prestateTupleDigest !==
            preflight.currentState.prestateTupleDigest ||
        discovery.currentState.targetRightsDigest !==
            preflight.currentState.targetRightsDigest ||
        !invariantDigestsEqual(
            discovery.canonicalInvariantDigests,
            preflight.canonicalInvariantDigests
        ) ||
        stableStringify(discovery.relationPrerequisite) !==
            stableStringify(preflight.relationPrerequisite)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'READ_ONLY_PREFLIGHT_STATE_CHANGED'
        );
    }
}

function validateProposal(input: {
    target: DevelopmentApiLdaregTarget;
    snapshot: DevelopmentApiLdaregSnapshot;
    discoveredById: Map<
        string,
        DevelopmentApiLdaregInspectorTarget
    >;
}): void {
    const proposal = input.snapshot.proposal;
    if (
        proposal === null ||
        !HEX64_RE.test(proposal.digest) ||
        proposal.itemCount !== input.target.propertyTargets.length ||
        proposal.componentCount !==
            input.target.propertyTargets.length *
                input.target.scopePnus.length ||
        proposal.source !== 'LDAREG' ||
        proposal.allCurrentPositive !== true ||
        proposal.proposedAreas.length !==
            input.target.propertyTargets.length
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_PROPOSAL_INVALID'
        );
    }
    const expectedById = new Map(
        input.target.propertyTargets.map((property) => [
            property.propertyUnitId,
            property,
        ])
    );
    const ids = proposal.proposedAreas.map(
        (area) => area.propertyUnitId
    );
    if (!exactSortedUnique(ids)) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_PROPOSAL_INVALID'
        );
    }
    for (const area of proposal.proposedAreas) {
        const expected = expectedById.get(area.propertyUnitId);
        const discovered = input.discoveredById.get(
            area.propertyUnitId
        );
        if (
            !expected ||
            !discovered ||
            area.matchedBuildingUnitId !==
                discovered.matchedBuildingUnitId ||
            canonicalDecimal(area.landArea) !==
                expected.expectedNumerator ||
            !HEX64_RE.test(area.itemDigest)
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'DB_PROPOSAL_INVALID'
            );
        }
    }
}

function validatePreinstalledApproval(input: {
    snapshot: DevelopmentApiLdaregSnapshot;
    targetDigest: string;
}): void {
    const approval = input.snapshot.approval;
    if (
        approval.rowCount !== 1 ||
        approval.enabled !== true ||
        approval.consumedAt !== null ||
        approval.consumedSyncJobId !== null ||
        approval.targetDigest !== input.targetDigest ||
        approval.expiresAt === null ||
        !Number.isFinite(Date.parse(approval.expiresAt)) ||
        Date.parse(approval.expiresAt) <= Date.now()
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_PREINSTALLED_APPROVAL_INVALID'
        );
    }
}

function validateConsumedApproval(input: {
    snapshot: DevelopmentApiLdaregSnapshot;
    targetDigest: string;
    syncJobId: string;
    receiptDigest: string;
}): void {
    const { approval, replay } = input.snapshot;
    if (
        approval.rowCount !== 1 ||
        approval.enabled !== false ||
        approval.consumedAt === null ||
        approval.consumedSyncJobId !== input.syncJobId ||
        approval.targetDigest !== input.targetDigest ||
        replay.syncJobId !== input.syncJobId ||
        replay.eligible !== true ||
        replay.receiptDigest !== input.receiptDigest
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_CONSUMED_APPROVAL_INVALID'
        );
    }
}

interface DevelopmentApiLdaregSourceCandidate {
    raw: LdaregRow;
    source: Record<string, string | null>;
    logicalKey: string;
    ratio: ReturnType<typeof parseLdaQotaRate>;
    normalizedDong: string;
    normalizedFloor: string;
    normalizedHo: string;
    normalizedRoom: string;
}

interface DevelopmentApiLdaregCorrelatedUnit {
    source: DevelopmentApiLdaregSourceCandidate;
    expos: OfficialExposUnit;
    providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
}

function dongTokensAreCompatible(
    sourceDong: string,
    exposDong: string
): boolean {
    return (
        sourceDong === '' ||
        exposDong === '' ||
        sourceDong === exposDong
    );
}

function normalizedWitnessTupleMatches(
    witness: ProviderUnitShapeWitness,
    floor: string,
    ho: string
): boolean {
    return (
        normalizeFloorLabel(witness.canonicalFloor) === floor &&
        normalizeUnitSegment(witness.canonicalHo) === ho
    );
}

function correlateLdaregSourcesToExpos(input: {
    sources: DevelopmentApiLdaregSourceCandidate[];
    exposUnits: OfficialExposUnit[];
}): DevelopmentApiLdaregCorrelatedUnit[] {
    const correlated: DevelopmentApiLdaregCorrelatedUnit[] = [];
    const consumedExposIndexes = new Set<number>();
    const residualSources: DevelopmentApiLdaregSourceCandidate[] =
        [];

    // 기존 exact floor/ho 경로를 먼저 소진한다. 비율·행 순서·건수는 identity가 아니다.
    for (const source of input.sources) {
        const matches = input.exposUnits
            .map((expos, index) => ({ expos, index }))
            .filter(
                ({ expos }) =>
                    expos.normalizedFloor ===
                        source.normalizedFloor &&
                    expos.normalizedHo === source.normalizedHo &&
                    dongTokensAreCompatible(
                        source.normalizedDong,
                        expos.normalizedDong
                    )
            );
        if (matches.length > 1) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_EXPOS_CORRELATION_AMBIGUOUS'
            );
        }
        if (matches.length === 0) {
            residualSources.push(source);
            continue;
        }
        const match = matches[0];
        if (consumedExposIndexes.has(match.index)) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_EXPOS_CORRELATION_AMBIGUOUS'
            );
        }
        consumedExposIndexes.add(match.index);
        correlated.push({
            source,
            expos: match.expos,
            providerShapeBridgeKind: null,
        });
    }

    const residualExpos = input.exposUnits
        .map((expos, index) => ({ expos, index }))
        .filter(
            ({ index }) => !consumedExposIndexes.has(index)
        );
    if (residualSources.length === 0) {
        if (residualExpos.length !== 0) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_EXPOS_CORRELATION_AMBIGUOUS'
            );
        }
        return correlated;
    }

    const buildingNames = new Set(
        input.sources
            .map((source) => source.source.buldNm ?? '')
            .filter(Boolean)
    );
    const aggregateSerials = new Set(
        input.sources
            .map((source) => source.source.agbldgSn ?? '')
            .filter(Boolean)
    );
    if (
        input.sources.some(
            (source) =>
                !source.source.buldNm ||
                !source.source.agbldgSn
        ) ||
        buildingNames.size !== 1 ||
        aggregateSerials.size !== 1
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_PROVIDER_SHAPE_BRIDGE_INVALID'
        );
    }

    const sourceWitnesses = residualSources.map((source) => {
        const witness = providerUnitShapeWitness(
            'LDAREG_UNIT',
            source.raw as Record<string, unknown>
        );
        return {
            source,
            witness,
            key: witness
                ? providerUnitShapeWitnessKey(witness)
                : null,
        };
    });
    const exposWitnesses = residualExpos.map(
        ({ expos, index }) => ({
            expos,
            index,
            witness: expos.providerShapeWitness,
            key: expos.providerShapeWitness
                ? providerUnitShapeWitnessKey(
                      expos.providerShapeWitness
                  )
                : null,
        })
    );
    const sourceKeys = sourceWitnesses.map(({ key }) => key);
    const exposKeys = exposWitnesses.map(({ key }) => key);
    if (
        sourceKeys.some((key) => key === null) ||
        exposKeys.some((key) => key === null) ||
        new Set(sourceKeys).size !== sourceKeys.length ||
        new Set(exposKeys).size !== exposKeys.length ||
        sourceKeys.length !== exposKeys.length ||
        stableStringify([...sourceKeys].sort()) !==
            stableStringify([...exposKeys].sort())
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_PROVIDER_SHAPE_BRIDGE_INVALID'
        );
    }

    const bridgedDongPairs: Array<{
        sourceDong: string;
        exposDong: string;
    }> = [];
    for (const sourceEntry of sourceWitnesses) {
        const witness = sourceEntry.witness!;
        const matches = exposWitnesses.filter(
            (exposEntry) =>
                exposEntry.key === sourceEntry.key &&
                exposEntry.witness !== null &&
                exposEntry.witness.canonicalFloor ===
                    witness.canonicalFloor &&
                exposEntry.witness.canonicalHo ===
                    witness.canonicalHo &&
                normalizedWitnessTupleMatches(
                    witness,
                    exposEntry.expos.normalizedFloor,
                    exposEntry.expos.normalizedHo
                ) &&
                normalizedWitnessTupleMatches(
                    exposEntry.witness,
                    exposEntry.expos.normalizedFloor,
                    exposEntry.expos.normalizedHo
                ) &&
                dongTokensAreCompatible(
                    sourceEntry.source.normalizedDong,
                    exposEntry.expos.normalizedDong
                )
        );
        if (matches.length !== 1) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_PROVIDER_SHAPE_BRIDGE_INVALID'
            );
        }
        const match = matches[0];
        consumedExposIndexes.add(match.index);
        bridgedDongPairs.push({
            sourceDong: sourceEntry.source.normalizedDong,
            exposDong: match.expos.normalizedDong,
        });
        correlated.push({
            source: sourceEntry.source,
            expos: match.expos,
            providerShapeBridgeKind: witness.kind,
        });
    }
    const hasOneSidedDong = bridgedDongPairs.some(
        ({ sourceDong, exposDong }) =>
            (sourceDong === '') !== (exposDong === '')
    );
    if (
        hasOneSidedDong &&
        (new Set(
            bridgedDongPairs.map(({ sourceDong }) => sourceDong)
        ).size !== 1 ||
            new Set(
                bridgedDongPairs.map(({ exposDong }) => exposDong)
            ).size !== 1)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_PROVIDER_SHAPE_BRIDGE_INVALID'
        );
    }
    if (
        correlated.length !== input.sources.length ||
        consumedExposIndexes.size !== input.exposUnits.length
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_PROVIDER_SHAPE_BRIDGE_INVALID'
        );
    }
    return correlated;
}

function sourceRecordMatchesCanonicalComponent(input: {
    sourceRecord: Record<string, unknown>;
    canonicalDong: string;
    canonicalFloor: string;
    canonicalHo: string;
    providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
}): boolean {
    const sourceDong = canonicalDongToken(
        recordString(
            input.sourceRecord,
            'buldDongNm',
            'dongNm',
            'dong'
        )
    );
    if (
        !dongTokensAreCompatible(
            sourceDong,
            input.canonicalDong
        )
    ) {
        return false;
    }
    if (input.providerShapeBridgeKind === null) {
        return (
            normalizeFloorLabel(
                recordString(
                    input.sourceRecord,
                    'buldFloorNm',
                    'flrNoNm',
                    'floor'
                )
            ) === input.canonicalFloor &&
            normalizeUnitSegment(
                recordString(
                    input.sourceRecord,
                    'buldHoNm',
                    'hoNm',
                    'ho'
                )
            ) === input.canonicalHo
        );
    }
    const witness = providerUnitShapeWitness(
        'LDAREG_UNIT',
        input.sourceRecord
    );
    return (
        witness !== null &&
        witness.kind === input.providerShapeBridgeKind &&
        normalizedWitnessTupleMatches(
            witness,
            input.canonicalFloor,
            input.canonicalHo
        )
    );
}

function buildLdaregItems(input: {
    target: DevelopmentApiLdaregTarget;
    discoveredById: Map<
        string,
        DevelopmentApiLdaregInspectorTarget
    >;
    perPnuRows: Array<{ pnu: string; rows: LdaregRow[] }>;
    exposUnits: OfficialExposUnit[];
}): {
    items: DevelopmentApiLdaregApprovalItem[];
    ignoredOfficialUnitCount: number;
    ignoredPlaceholderCount: number;
    currentTargetCount: number;
    proposalAreas: DevelopmentApiLdaregOfficialEvidence['proposalAreas'];
} {
    const canonical = input.perPnuRows.find(
        (scan) => scan.pnu === input.target.basePnu
    );
    if (!canonical) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_CANONICAL_SCAN_MISSING'
        );
    }
    const expectedByCanonicalUnit = new Map(
        input.target.propertyTargets.map((target) => [
            propertyCanonicalUnitKey(target),
            target,
        ])
    );
    const ignoredByCanonicalUnit = new Map(
        input.target.ignoredOfficialUnits.map((ignored) => [
            canonicalOfficialUnitKey(ignored),
            ignored,
        ])
    );
    const positiveTargetRows: Array<{
        target: DevelopmentApiLdaregPropertyTarget;
        raw: LdaregRow;
        logicalKey: string;
        ratio: Extract<
            ReturnType<typeof parseLdaQotaRate>,
            { ok: true }
        >;
        canonicalDong: string;
        normalizedFloor: string;
        normalizedHo: string;
        normalizedRoom: string;
        providerShapeBridgeKind: ProviderUnitShapeBridgeKind | null;
    }> = [];
    const officialIdentityRows: Array<
        Omit<(typeof positiveTargetRows)[number], 'target'>
    > = [];
    let ignoredPlaceholderCount = 0;
    const sourceCandidates: DevelopmentApiLdaregSourceCandidate[] =
        [];

    for (const raw of canonical.rows) {
        const source = extractSourceRecord(raw);
        const ratio = parseLdaQotaRate(source.ldaQotaRate);
        if (!ratio.ok && ratio.reason === 'EMPTY') {
            if (!isIgnoredPlaceholderSourceRecord(source)) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_LDAREG_PLACEHOLDER_INVALID'
                );
            }
            ignoredPlaceholderCount += 1;
            continue;
        }
        sourceCandidates.push({
            raw,
            source,
            logicalKey: canonicalLdaregLogicalKey(raw),
            ratio,
            normalizedDong: canonicalDongToken(
                source.buldDongNm
            ),
            normalizedFloor: normalizeFloorLabel(
                source.buldFloorNm
            ),
            normalizedHo: normalizeUnitSegment(
                source.buldHoNm
            ),
            normalizedRoom: normalizeUnitSegment(
                source.buldRoomNm === '0000'
                    ? ''
                    : source.buldRoomNm
            ),
        });
    }
    const correlated = correlateLdaregSourcesToExpos({
        sources: sourceCandidates,
        exposUnits: input.exposUnits,
    });
    const seenPropertyIds = new Set<string>();
    const seenIgnoredOfficialUnitKeys = new Set<string>();
    for (const correlation of correlated) {
        const { source: candidate, expos } = correlation;
        const source = candidate.source;
        const ignoredKey = canonicalOfficialUnitKey({
            canonicalDong: expos.normalizedDong,
            canonicalFloor: expos.normalizedFloor,
            canonicalHo: expos.normalizedHo,
            providerShapeBridgeKind:
                correlation.providerShapeBridgeKind,
        });
        const expected = expectedByCanonicalUnit.get(
            ignoredKey
        );
        const ignored = ignoredByCanonicalUnit.get(ignoredKey);
        if (
            (expected === undefined) === (ignored === undefined) ||
            source.clsSeCode !== CURRENT_CLASSIFICATION_CODE ||
            source.clsSeCodeNm !== CURRENT_CLASSIFICATION_NAME ||
            !candidate.ratio.ok ||
            !/^[1-9]\d{0,2}$/.test(expos.normalizedFloor) ||
            canonicalDecimal(candidate.ratio.denominatorText) !==
                input.target.expectedDenominator
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_TARGET_ROW_INVALID'
            );
        }
        if (
            expos.rootIdentity !== input.target.managementPk ||
            !sourceRecordMatchesCanonicalComponent({
                sourceRecord: candidate.raw as Record<
                    string,
                    unknown
                >,
                canonicalDong: expos.normalizedDong,
                canonicalFloor: expos.normalizedFloor,
                canonicalHo: expos.normalizedHo,
                providerShapeBridgeKind:
                    correlation.providerShapeBridgeKind,
            })
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_EXPOS_CORRELATION_AMBIGUOUS'
            );
        }
        const officialIdentityRow = {
            raw: candidate.raw,
            logicalKey: candidate.logicalKey,
            ratio: candidate.ratio,
            canonicalDong: expos.normalizedDong,
            normalizedFloor: expos.normalizedFloor,
            normalizedHo: expos.normalizedHo,
            normalizedRoom: candidate.normalizedRoom,
            providerShapeBridgeKind:
                correlation.providerShapeBridgeKind,
        };
        officialIdentityRows.push(officialIdentityRow);
        if (ignored !== undefined) {
            if (
                seenIgnoredOfficialUnitKeys.has(ignoredKey) ||
                canonicalDecimal(
                    candidate.ratio.numeratorText
                ) !== ignored.expectedNumerator ||
                ignored.reason !== 'NO_ACTIVE_PROPERTY_UNIT'
            ) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_LDAREG_IGNORED_UNIT_INVALID'
                );
            }
            seenIgnoredOfficialUnitKeys.add(ignoredKey);
            continue;
        }
        if (
            expected === undefined ||
            seenPropertyIds.has(expected.propertyUnitId) ||
            canonicalDecimal(candidate.ratio.numeratorText) !==
                expected.expectedNumerator
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_TARGET_ROW_INVALID'
            );
        }
        seenPropertyIds.add(expected.propertyUnitId);
        positiveTargetRows.push({
            target: expected,
            ...officialIdentityRow,
        });
    }
    if (
        positiveTargetRows.length !==
            input.target.propertyTargets.length ||
        seenIgnoredOfficialUnitKeys.size !==
            input.target.ignoredOfficialUnits.length ||
        ignoredPlaceholderCount !==
            input.target.expectedIgnoredPlaceholderCount
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_CANONICAL_SET_INCOMPLETE'
        );
    }
    const observations = officialIdentityRows.map((row, index) => {
        const source = extractSourceRecord(row.raw);
        return {
            targetPnu: input.target.basePnu,
            identityRoot: input.target.managementPk,
            agbldgSn: source.agbldgSn,
            buildingName: source.buldNm,
            dong: row.canonicalDong,
            floor: row.normalizedFloor,
            ho: row.normalizedHo,
            room: row.normalizedRoom,
            ldaQotaRate: source.ldaQotaRate,
            clsSeCode: source.clsSeCode,
            sourceState: 'CURRENT' as const,
            sourceStateAmbiguous: false,
            sourceIndex: index,
        };
    });
    const dedup = dedupLdaregObservations(observations);
    if (
        dedup.issues.length !== 0 ||
        dedup.excludedIdentities.length !== 0 ||
        dedup.records.length !== officialIdentityRows.length ||
        dedup.records.some(
            (record) =>
                record.state !== 'CURRENT' ||
                record.agbldgSn === null ||
                !SOURCE_IDENTITY_RE.test(record.identity.value)
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_IDENTITY_AMBIGUOUS'
        );
    }
    const recordByCanonicalLocation = new Map<
        string,
        LdaregSourceRecord
    >();
    for (const record of dedup.records) {
        const key = canonicalOfficialLocationKey({
            canonicalDong: canonicalDongToken(
                record.normalized.dong
            ),
            canonicalFloor: record.normalized.floor,
            canonicalHo: record.normalized.ho,
        });
        if (recordByCanonicalLocation.has(key)) {
            throw new ControlledDevelopmentApiLdaregError(
                'OFFICIAL_LDAREG_IDENTITY_AMBIGUOUS'
            );
        }
        recordByCanonicalLocation.set(key, record);
    }
    const rowsByPnuAndKey = new Map<
        string,
        Map<string, LdaregRow>
    >();
    for (const scan of input.perPnuRows) {
        const byKey = new Map<string, LdaregRow>();
        for (const raw of scan.rows) {
            const key = canonicalLdaregLogicalKey(raw);
            if (byKey.has(key)) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_LDAREG_DUPLICATE_LOGICAL_ROW'
                );
            }
            byKey.set(key, raw);
        }
        rowsByPnuAndKey.set(scan.pnu, byKey);
    }
    const items = positiveTargetRows
        .map((row): DevelopmentApiLdaregApprovalItem => {
            const discovered = input.discoveredById.get(
                row.target.propertyUnitId
            );
            const sourceIdentity =
                recordByCanonicalLocation.get(
                    canonicalOfficialLocationKey({
                        canonicalDong: row.canonicalDong,
                        canonicalFloor:
                            row.normalizedFloor,
                        canonicalHo: row.normalizedHo,
                    })
                );
            if (!discovered || !sourceIdentity) {
                throw new ControlledDevelopmentApiLdaregError(
                    'OFFICIAL_LDAREG_CANONICAL_JOIN_INCOMPLETE'
                );
            }
            const components = input.target.scopePnus.map(
                (
                    targetPnu
                ): DevelopmentApiLdaregApprovalComponent => {
                    const targetRaw = rowsByPnuAndKey
                        .get(targetPnu)
                        ?.get(row.logicalKey);
                    if (!targetRaw) {
                        throw new ControlledDevelopmentApiLdaregError(
                            'OFFICIAL_LDAREG_SCOPE_REPLICA_MISSING'
                        );
                    }
                    const sourceRecord =
                        extractSourceRecord(targetRaw);
                    if (
                        sourceRecord.pnu !== targetPnu ||
                        sourceRecord.buldHoNm === null ||
                        !sourceRecordMatchesCanonicalComponent({
                            sourceRecord,
                            canonicalDong: row.canonicalDong,
                            canonicalFloor:
                                row.normalizedFloor,
                            canonicalHo: row.normalizedHo,
                            providerShapeBridgeKind:
                                row.providerShapeBridgeKind,
                        }) ||
                        sourceRecord.ldaQotaRate === null ||
                        sourceRecord.clsSeCode !==
                            CURRENT_CLASSIFICATION_CODE ||
                        sourceRecord.clsSeCodeNm !==
                            CURRENT_CLASSIFICATION_NAME
                    ) {
                        throw new ControlledDevelopmentApiLdaregError(
                            'OFFICIAL_LDAREG_SCOPE_SOURCE_RECORD_INVALID'
                        );
                    }
                    return {
                        targetPnu,
                        sourceState: 'CURRENT',
                        matchMethod: 'BUILDING_UNIT_ID',
                        matchedBuildingUnitId:
                            discovered.matchedBuildingUnitId,
                        sourceIdentity:
                            sourceIdentity.identity.value,
                        sourceAgbldgSn: sourceIdentity.agbldgSn,
                        ratioRaw: sourceRecord.ldaQotaRate,
                        ratioNumerator:
                            row.target.expectedNumerator,
                        ratioDenominator:
                            input.target.expectedDenominator,
                        retiredReason: null,
                        canonicalDong: row.canonicalDong,
                        canonicalFloor: row.normalizedFloor,
                        canonicalHo: row.normalizedHo,
                        providerShapeBridgeKind:
                            row.providerShapeBridgeKind,
                        sourceRecord,
                    };
                }
            );
            return {
                propertyUnitId: row.target.propertyUnitId,
                expectedTargetPnus: [...input.target.scopePnus],
                components,
            };
        })
        .sort((a, b) =>
            a.propertyUnitId < b.propertyUnitId ? -1 : 1
        );
    const proposalAreas = items.map((item) => {
        const target = input.target.propertyTargets.find(
            (candidate) =>
                candidate.propertyUnitId === item.propertyUnitId
        )!;
        const matchedBuildingUnitId =
            item.components[0].matchedBuildingUnitId!;
        return {
            propertyUnitIdHash: sha256(
                `PROPERTY_UNIT_ID\u0000${item.propertyUnitId}`
            ),
            matchedBuildingUnitIdHash: sha256(
                `BUILDING_UNIT_ID\u0000${matchedBuildingUnitId}`
            ),
            roomHash: sha256(
                `ROOM\u0000${target.normalizedHo}`
            ),
            landArea: target.expectedNumerator,
            sourceIdentityHash: sha256(
                `SOURCE_IDENTITY\u0000${item.components[0].sourceIdentity}`
            ),
        };
    });
    return {
        items,
        ignoredOfficialUnitCount:
            seenIgnoredOfficialUnitKeys.size,
        ignoredPlaceholderCount,
        currentTargetCount: positiveTargetRows.length,
        proposalAreas,
    };
}

export function validateDevelopmentApiLdaregApprovalItems(input: {
    target: DevelopmentApiLdaregTarget;
    items: unknown;
}): DevelopmentApiLdaregApprovalItem[] {
    if (
        !Array.isArray(input.items) ||
        input.items.length !==
            input.target.propertyTargets.length
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_ITEMS_INVALID'
        );
    }
    const expectedIds = input.target.propertyTargets.map(
        (property) => property.propertyUnitId
    );
    const observedIds: string[] = [];
    const observedSourceIdentities = new Set<string>();
    for (
        let itemIndex = 0;
        itemIndex < input.items.length;
        itemIndex += 1
    ) {
        const item = asRecord(
            input.items[itemIndex],
            'APPROVAL_REQUEST_ITEMS_INVALID'
        );
        const expected = input.target.propertyTargets[itemIndex];
        if (
            !hasExactKeys(item, [
                'components',
                'expectedTargetPnus',
                'propertyUnitId',
            ]) ||
            item.propertyUnitId !== expected.propertyUnitId ||
            !Array.isArray(item.expectedTargetPnus) ||
            stableStringify(item.expectedTargetPnus) !==
                stableStringify(input.target.scopePnus) ||
            !Array.isArray(item.components) ||
            item.components.length !==
                input.target.scopePnus.length
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'APPROVAL_REQUEST_ITEMS_INVALID'
            );
        }
        observedIds.push(expected.propertyUnitId);
        let sharedSourceIdentity: string | null = null;
        let sharedAgbldgSn: string | null = null;
        let sharedRatioRaw: string | null = null;
        let sharedCanonicalDong: string | null = null;
        let sharedCanonicalFloor: string | null = null;
        let sharedCanonicalHo: string | null = null;
        let sharedProviderShapeBridgeKind:
            | ProviderUnitShapeBridgeKind
            | null = null;
        for (
            let componentIndex = 0;
            componentIndex < item.components.length;
            componentIndex += 1
        ) {
            const component = asRecord(
                item.components[componentIndex],
                'APPROVAL_REQUEST_ITEMS_INVALID'
            );
            const targetPnu =
                input.target.scopePnus[componentIndex];
            if (
                !hasExactKeys(component, [
                    'targetPnu',
                    'sourceState',
                    'matchMethod',
                    'matchedBuildingUnitId',
                    'sourceIdentity',
                    'sourceAgbldgSn',
                    'ratioRaw',
                    'ratioNumerator',
                    'ratioDenominator',
                    'retiredReason',
                    'canonicalDong',
                    'canonicalFloor',
                    'canonicalHo',
                    'providerShapeBridgeKind',
                    'sourceRecord',
                ]) ||
                component.targetPnu !== targetPnu ||
                component.sourceState !== 'CURRENT' ||
                component.matchMethod !== 'BUILDING_UNIT_ID' ||
                component.matchedBuildingUnitId !==
                    expected.expectedBuildingUnitId ||
                typeof component.sourceIdentity !== 'string' ||
                !SOURCE_IDENTITY_RE.test(
                    component.sourceIdentity
                ) ||
                typeof component.sourceAgbldgSn !== 'string' ||
                component.sourceAgbldgSn.length === 0 ||
                component.sourceAgbldgSn.length > 100 ||
                typeof component.ratioRaw !== 'string' ||
                component.ratioNumerator !==
                    expected.expectedNumerator ||
                component.ratioDenominator !==
                    input.target.expectedDenominator ||
                component.retiredReason !== null ||
                typeof component.canonicalDong !== 'string' ||
                canonicalDongToken(component.canonicalDong) !==
                    component.canonicalDong ||
                component.canonicalDong !==
                    expected.canonicalDong ||
                typeof component.canonicalFloor !== 'string' ||
                !/^[1-9]\d{0,2}$/.test(
                    component.canonicalFloor
                ) ||
                component.canonicalFloor !==
                    expected.normalizedFloor ||
                typeof component.canonicalHo !== 'string' ||
                component.canonicalHo.length === 0 ||
                normalizeUnitSegment(component.canonicalHo) !==
                    component.canonicalHo ||
                component.canonicalHo !== expected.normalizedHo ||
                !(
                    component.providerShapeBridgeKind === null ||
                    (typeof component.providerShapeBridgeKind ===
                        'string' &&
                        PROVIDER_SHAPE_BRIDGE_KINDS.has(
                            component.providerShapeBridgeKind as ProviderUnitShapeBridgeKind
                        ))
                ) ||
                component.providerShapeBridgeKind !==
                    expected.providerShapeBridgeKind
            ) {
                throw new ControlledDevelopmentApiLdaregError(
                    'APPROVAL_REQUEST_ITEMS_INVALID'
                );
            }
            const ratio = parseLdaQotaRate(component.ratioRaw);
            const sourceRecord = asRecord(
                component.sourceRecord,
                'APPROVAL_REQUEST_ITEMS_INVALID'
            );
            if (
                !ratio.ok ||
                canonicalDecimal(ratio.numeratorText) !==
                    expected.expectedNumerator ||
                canonicalDecimal(ratio.denominatorText) !==
                    input.target.expectedDenominator ||
                !hasExactKeys(
                    sourceRecord,
                    LDAREG_SOURCE_RECORD_FIELDS
                ) ||
                Object.values(sourceRecord).some(
                    (value) =>
                        value !== null &&
                        typeof value !== 'string'
                ) ||
                sourceRecord.pnu !== targetPnu ||
                sourceRecord.agbldgSn !==
                    component.sourceAgbldgSn ||
                sourceRecord.ldaQotaRate !==
                    component.ratioRaw ||
                sourceRecord.clsSeCode !==
                    CURRENT_CLASSIFICATION_CODE ||
                sourceRecord.clsSeCodeNm !==
                    CURRENT_CLASSIFICATION_NAME ||
                !sourceRecordMatchesCanonicalComponent({
                    sourceRecord,
                    canonicalDong:
                        component.canonicalDong as string,
                    canonicalFloor:
                        component.canonicalFloor as string,
                    canonicalHo: component.canonicalHo as string,
                    providerShapeBridgeKind:
                        component.providerShapeBridgeKind as ProviderUnitShapeBridgeKind | null,
                })
            ) {
                throw new ControlledDevelopmentApiLdaregError(
                    'APPROVAL_REQUEST_ITEMS_INVALID'
                );
            }
            if (componentIndex === 0) {
                sharedSourceIdentity =
                    component.sourceIdentity as string;
                sharedAgbldgSn =
                    component.sourceAgbldgSn as string;
                sharedRatioRaw = component.ratioRaw as string;
                sharedCanonicalDong =
                    component.canonicalDong as string;
                sharedCanonicalFloor =
                    component.canonicalFloor as string;
                sharedCanonicalHo =
                    component.canonicalHo as string;
                sharedProviderShapeBridgeKind =
                    component.providerShapeBridgeKind as ProviderUnitShapeBridgeKind | null;
            }
            if (
                component.sourceIdentity !==
                    sharedSourceIdentity ||
                component.sourceAgbldgSn !== sharedAgbldgSn ||
                component.ratioRaw !== sharedRatioRaw ||
                component.canonicalDong !==
                    sharedCanonicalDong ||
                component.canonicalFloor !==
                    sharedCanonicalFloor ||
                component.canonicalHo !== sharedCanonicalHo ||
                component.providerShapeBridgeKind !==
                    sharedProviderShapeBridgeKind
            ) {
                throw new ControlledDevelopmentApiLdaregError(
                    'APPROVAL_REQUEST_ITEMS_INVALID'
                );
            }
        }
        if (
            sharedSourceIdentity === null ||
            sharedAgbldgSn === null ||
            observedSourceIdentities.has(sharedSourceIdentity)
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'APPROVAL_REQUEST_ITEMS_INVALID'
            );
        }
        observedSourceIdentities.add(sharedSourceIdentity);
    }
    if (
        stableStringify(observedIds) !==
        stableStringify(expectedIds)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_ITEMS_INVALID'
        );
    }
    return input.items as DevelopmentApiLdaregApprovalItem[];
}

export async function scanDevelopmentApiLdaregOfficialSource(input: {
    target: DevelopmentApiLdaregTarget;
    discoveredById: Map<
        string,
        DevelopmentApiLdaregInspectorTarget
    >;
    adapter: DevelopmentApiLdaregScanAdapter;
    buildingHubServiceKey: string;
    vworldKey: string;
    vworldDomain: string;
}): Promise<OfficialScanResult> {
    const hubAuth = { serviceKey: input.buildingHubServiceKey };
    const vworldAuth = {
        key: input.vworldKey,
        domain: input.vworldDomain,
    };
    const attachedPnu = input.target.scopePnus.find(
        (pnu) => pnu !== input.target.basePnu
    );
    const expectedBylotCount =
        input.target.scopePnus.length - 1;
    // 실환경 Building HUB는 동시 호출에서 transient failure가 관측되었다.
    // 같은 실행의 official evidence를 흔들지 않도록 endpoint 호출 전체를 직렬화한다.
    const titleRaw = await input.adapter.scanTitle(
        input.target.basePnu,
        hubAuth
    );
    const attachedRaw = await input.adapter.scanAttached(
        input.target.basePnu,
        hubAuth
    );
    const title = completeRows(
        titleRaw,
        'getBrTitleInfo',
        input.target.basePnu,
        false
    );
    const attached = completeRows(
        attachedRaw,
        'getBrAtchJibunInfo',
        input.target.basePnu,
        attachedPnu === undefined
    );
    const perPnu: Array<{
        pnu: string;
        basis: ReturnType<typeof completeRows<BrBasisOulnRow>>;
        expos: ReturnType<typeof completeRows<BrExposRow>>;
        ladfrl: ReturnType<typeof completeRows<LadfrlRow>>;
        ldareg: ReturnType<typeof completeRows<LdaregRow>>;
    }> = [];
    for (
        let index = 0;
        index < input.target.scopePnus.length;
        index += 1
    ) {
        const pnu = input.target.scopePnus[index];
        const basisRaw = await input.adapter.scanBasis(pnu, hubAuth);
        const exposRaw = await input.adapter.scanExpos(pnu, hubAuth);
        const ladfrlRaw = await input.adapter.scanLadfrl(
            pnu,
            vworldAuth
        );
        const ldaregRaw = await input.adapter.scanLdareg(
            pnu,
            vworldAuth
        );
        perPnu.push({
            pnu,
            basis: completeRows(
                basisRaw,
                'getBrBasisOulnInfo',
                pnu,
                pnu !== input.target.basePnu
            ),
            expos: completeRows(
                exposRaw,
                'getBrExposInfo',
                pnu,
                true
            ),
            ladfrl: completeRows(
                ladfrlRaw,
                'ladfrlList',
                pnu,
                false
            ),
            ldareg: completeRows(
                ldaregRaw,
                'ldaregList',
                pnu,
                false
            ),
        });
    }
    if (
        !buildingHubRowsMatchPnu(
            title.rows as Array<Record<string, unknown>>,
            input.target.basePnu
        ) ||
        !buildingHubRowsMatchPnu(
            perPnu
                .find((scan) => scan.pnu === input.target.basePnu)!
                .basis.rows as Array<Record<string, unknown>>,
            input.target.basePnu
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_BUILDING_HUB_PNU_MISMATCH'
        );
    }
    const titleRoots = new Set(
        title.rows
            .map(rootManagementPk)
            .filter((value): value is string => value !== null)
    );
    if (
        titleRoots.size !== 1 ||
        !titleRoots.has(input.target.managementPk) ||
        title.rows.some((row) => {
            const bylot = parseBylotCnt(row.bylotCnt);
            return (
                rootManagementPk(row) !==
                    input.target.managementPk ||
                !bylot.valid ||
                bylot.count !== expectedBylotCount
            );
        })
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_BUILDING_ROOT_INVALID'
        );
    }
    const assembled = assembleAttachedPnus(
        attached.rows.map(toAttachedInput)
    );
    if (
        (attachedPnu === undefined
            ? attached.summary.state !== 'COMPLETE_ZERO'
            : attached.summary.state !== 'COMPLETE') ||
        assembled.rejected.length !== 0 ||
        assembled.pairs.length !== expectedBylotCount ||
        (attachedPnu !== undefined &&
            (assembled.pairs[0].basePnu !==
                input.target.basePnu ||
                assembled.pairs[0].attachedPnu !== attachedPnu ||
                assembled.pairs[0].mgmBldrgstPk !==
                    input.target.managementPk))
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_ATTACHED_PAIR_INVALID'
        );
    }
    const managementPkHash = sha256(
        `MGM_BLDRGST_PK\u0000${input.target.managementPk}`
    );
    const scopePnuHashes = input.target.scopePnus
        .map((pnu) => sha256(`PNU\u0000${pnu}`))
        .sort();
    const pairDigest = sha256(
        stableStringify(
            attachedPnu === undefined
                ? []
                : [
                      {
                          managementPkHash,
                          basePnuHash: sha256(
                              `PNU\u0000${input.target.basePnu}`
                          ),
                          attachedPnuHash: sha256(
                              `PNU\u0000${attachedPnu}`
                          ),
                      },
                  ]
        )
    );
    const attachedPnuHash =
        attachedPnu === undefined
            ? DEVELOPMENT_API_LDAREG_NO_ATTACHED_PNU_HASH
            : sha256(`PNU\u0000${attachedPnu}`);
    const expected = input.target.officialHashes;
    const nonemptyBasisSchema = perPnu
        .filter((scan) => scan.basis.rows.length > 0)
        .map((scan) => scan.basis.summary.schemaHash);
    const nonemptyExposSchema = perPnu
        .filter((scan) => scan.expos.rows.length > 0)
        .map((scan) => scan.expos.summary.schemaHash);
    const nonemptyLadfrlSchema = perPnu
        .filter((scan) => scan.ladfrl.rows.length > 0)
        .map((scan) => scan.ladfrl.summary.schemaHash);
    const nonemptyLdaregSchema = perPnu
        .filter((scan) => scan.ldareg.rows.length > 0)
        .map((scan) => scan.ldareg.summary.schemaHash);
    if (
        managementPkHash !== expected.managementPkHash ||
        sha256(`PNU\u0000${input.target.basePnu}`) !==
            expected.basePnuHash ||
        attachedPnuHash !== expected.attachedPnuHash ||
        pairDigest !== expected.pairsDigest ||
        title.summary.schemaHash !== expected.titleSchemaHash ||
        attached.summary.schemaHash !==
            expected.attachedSchemaHash ||
        nonemptyBasisSchema.some(
            (hash) => hash !== expected.basisSchemaHash
        ) ||
        nonemptyExposSchema.some(
            (hash) => hash !== expected.exposSchemaHash
        ) ||
        nonemptyLadfrlSchema.some(
            (hash) => hash !== expected.ladfrlSchemaHash
        ) ||
        nonemptyLdaregSchema.some(
            (hash) => hash !== expected.ldaregSchemaHash
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_SCHEMA_OR_IDENTITY_HASH_MISMATCH'
        );
    }
    const allBasisRows = perPnu.flatMap(
        (scan) => scan.basis.rows
    );
    const exposUnits = collectOfficialExposUnits({
        target: input.target,
        perPnuRows: perPnu.map((scan) => ({
            pnu: scan.pnu,
            rows: scan.expos.rows,
        })),
        basisRows: allBasisRows,
    });
    const landAreaTotal = validateLandParcels({
        target: input.target,
        scans: perPnu.map((scan) => ({
            pnu: scan.pnu,
            rows: scan.ladfrl.rows,
        })),
    });
    const ldaregPerPnu = perPnu.map((scan) => ({
        pnu: scan.pnu,
        ldaregRows: scan.ldareg.rows,
        exposRows: scan.expos.rows,
        basisRows: scan.basis.rows,
    }));
    const replication = validateLdaregReplication(
        input.target.scopePnus,
        ldaregPerPnu,
        input.target.basePnu
    );
    if (
        !replication.ok ||
        replication.evidence.rowCount !==
            input.target.expectedLdaregRowCount ||
        replication.evidence.rowMultisetDigest !==
            expected.ldaregRowMultisetDigest
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'OFFICIAL_LDAREG_SCOPE_REPLICATION_INVALID'
        );
    }
    const built = buildLdaregItems({
        target: input.target,
        discoveredById: input.discoveredById,
        perPnuRows: perPnu.map((scan) => ({
            pnu: scan.pnu,
            rows: scan.ldareg.rows,
        })),
        exposUnits,
    });
    validateDevelopmentApiLdaregApprovalItems({
        target: input.target,
        items: built.items,
    });
    const endpointScans = [
        title.summary,
        attached.summary,
        ...perPnu.flatMap((scan) => [
            scan.basis.summary,
            scan.expos.summary,
            scan.ladfrl.summary,
            scan.ldareg.summary,
        ]),
    ].sort((left, right) =>
        `${left.endpoint}\u0000${left.queryPnuHash}` <
        `${right.endpoint}\u0000${right.queryPnuHash}`
            ? -1
            : 1
    );
    const evidenceCore = {
        version:
            'development-api-authoritative-ldareg-evidence@1' as const,
        endpointScans,
        managementPkHash,
        scopePnuHashes,
        pairsDigest: pairDigest,
        totalPairs: expectedBylotCount as 0 | 1,
        totalRejectedPairs: 0 as const,
        bylotCount: expectedBylotCount as 0 | 1,
        landParcelCount: input.target.landParcels.length,
        landAreaTotal,
        exposUnitCount: exposUnits.length,
        ldaregRowCount: replication.evidence.rowCount,
        ignoredOfficialUnitCount:
            built.ignoredOfficialUnitCount,
        ignoredPlaceholderCount: built.ignoredPlaceholderCount,
        currentTargetCount: built.currentTargetCount,
        componentCount: built.items.reduce(
            (sum, item) => sum + item.components.length,
            0
        ),
        proposalAreas: built.proposalAreas,
        ldaregRowMultisetDigest:
            replication.evidence.rowMultisetDigest,
    };
    return {
        items: built.items,
        evidence: {
            ...evidenceCore,
            evidenceDigest: sha256(stableStringify(evidenceCore)),
        },
    };
}

function validateApplyReceipt(input: {
    target: DevelopmentApiLdaregTarget;
    receipt: DevelopmentApiLdaregApplyReceipt;
    preflight: DevelopmentApiLdaregSnapshot;
    targetDigest: string;
    syncJobId: string;
}): void {
    const proposal = input.preflight.proposal!;
    const receipt = input.receipt;
    const expectedRights =
        input.target.propertyTargets.length *
        input.target.scopePnus.length;
    if (
        (receipt.status !== 'APPLIED' &&
            receipt.status !== 'REUSED') ||
        receipt.syncJobId !== input.syncJobId ||
        receipt.targetDigest !== input.targetDigest ||
        receipt.scopeDigest !== input.preflight.scope.digest ||
        receipt.propertyUnitDigest !==
            input.preflight.propertyTargets.digest ||
        receipt.proposedValuesDigest !== proposal.digest ||
        receipt.prestateTupleDigest !==
            input.preflight.currentState.prestateTupleDigest ||
        receipt.prestateTargetRightsDigest !==
            input.preflight.currentState.targetRightsDigest ||
        !HEX64_RE.test(receipt.poststateTupleDigest) ||
        !HEX64_RE.test(
            receipt.poststateTargetRightsDigest
        ) ||
        receipt.poststateTupleDigest ===
            receipt.prestateTupleDigest ||
        receipt.poststateTargetRightsDigest ===
            receipt.prestateTargetRightsDigest ||
        receipt.rightsRowCount !== expectedRights ||
        receipt.updatedPropertyUnitCount !==
            input.target.propertyTargets.length ||
        receipt.source !== 'LDAREG' ||
        !manualCountersAreZero(receipt.manualDecisionCounters) ||
        receipt.invariantDigests.stable !== true ||
        !invariantDigestsEqual(
            receipt.invariantDigests.before,
            input.preflight.canonicalInvariantDigests
        ) ||
        !invariantDigestsEqual(
            receipt.invariantDigests.before,
            receipt.invariantDigests.after
        ) ||
        receipt.replay.eligible !== true ||
        !HEX64_RE.test(receipt.replay.receiptDigest) ||
        receipt.replay.recovered !==
            (receipt.status === 'REUSED')
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'DB_APPLY_RECEIPT_INVALID'
        );
    }
}

async function applyWithRetry(input: {
    database: DevelopmentApiLdaregDatabase;
    request: Parameters<
        DevelopmentApiLdaregDatabase['apply']
    >[0];
    preflight: DevelopmentApiLdaregSnapshot;
    onAttempt: (attempt: number) => void;
}): Promise<DevelopmentApiLdaregApplyReceipt> {
    let lastError: unknown = null;
    for (
        let attempt = 1;
        attempt <= DEVELOPMENT_API_LDAREG_MAX_APPLY_ATTEMPTS;
        attempt += 1
    ) {
        input.onAttempt(attempt);
        try {
            const receipt = await input.database.apply(
                input.request
            );
            validateApplyReceipt({
                target: input.request.target,
                receipt,
                preflight: input.preflight,
                targetDigest: input.request.targetDigest,
                syncJobId: input.request.syncJobId,
            });
            return receipt;
        } catch (error) {
            lastError = error;
        }
    }
    throw (
        lastError ??
        new ControlledDevelopmentApiLdaregError(
            'DB_APPLY_RETRY_EXHAUSTED'
        )
    );
}

function failureCode(error: unknown): string {
    return error instanceof ControlledDevelopmentApiLdaregError
        ? error.code
        : 'UNEXPECTED_DEVELOPMENT_API_LDAREG_FAILURE';
}

const ZERO_MANUAL_COUNTERS: DevelopmentApiLdaregManualDecisionCounters =
    Object.freeze({
        sourceReads: 0,
        resolverReads: 0,
        blockerReads: 0,
        fallbackReads: 0,
        selectionReads: 0,
    });

function exactIsoTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parsed = Date.parse(value);
    return (
        Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === value
    );
}

function approvalRequestDigest(
    request: Omit<
        DevelopmentApiLdaregApprovalRequest,
        'requestDigest'
    >
): string {
    return sha256(stableStringify(request));
}

function createDevelopmentApiLdaregApprovalRequest(input: {
    target: DevelopmentApiLdaregTarget;
    sourceReleaseSha: string;
    official: OfficialScanResult;
    preflight: DevelopmentApiLdaregSnapshot;
    targetDigest: string;
    now: Date;
}): DevelopmentApiLdaregApprovalRequest {
    if (!Number.isFinite(input.now.getTime())) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_TIME_INVALID'
        );
    }
    const createdAt = input.now.toISOString();
    const expiresAt = new Date(
        input.now.getTime() +
            DEVELOPMENT_API_LDAREG_APPROVAL_TTL_MS
    ).toISOString();
    const proposal = input.preflight.proposal!;
    const request = {
        version: DEVELOPMENT_API_LDAREG_APPROVAL_REQUEST_VERSION,
        databaseTarget: 'development' as const,
        createdAt,
        expiresAt,
        manifestDigest: input.target.manifestDigest,
        sourceReleaseSha: input.sourceReleaseSha,
        officialEvidence: input.official.evidence,
        ownerApproval: {
            name: 'replace_development_api_authoritative_ldareg_backfill_approval_v1' as const,
            args: {
                p_union_id: input.target.unionId,
                p_base_pnu: input.target.basePnu,
                p_mgm_bldrgst_pk: input.target.managementPk,
                p_scope_pnus: [...input.target.scopePnus],
                p_property_unit_ids:
                    input.target.propertyTargets.map(
                        (property) =>
                            property.propertyUnitId
                    ),
                p_items: input.official.items,
                p_expected_scope_digest:
                    input.preflight.scope.digest,
                p_expected_property_unit_digest:
                    input.preflight.propertyTargets.digest,
                p_expected_proposed_values_digest:
                    proposal.digest,
                p_expected_prestate_tuple_digest:
                    input.preflight.currentState
                        .prestateTupleDigest,
                p_expected_prestate_rights_digest:
                    input.preflight.currentState
                        .targetRightsDigest,
                p_target_manifest_digest:
                    input.target.manifestDigest,
                p_phase0_run_id: Number(
                    input.target.phase0.runId
                ),
                p_phase0_artifact_version:
                    input.target.phase0.artifactVersion,
                p_phase0_artifact_sha256:
                    input.target.phase0.artifactSha256,
                p_phase0_schema_hash:
                    input.target.phase0.schemaHash,
                p_evidence_digest:
                    input.official.evidence.evidenceDigest,
                p_source_release_sha: input.sourceReleaseSha,
                p_target_digest: input.targetDigest,
                p_enabled: true as const,
                p_expires_at: expiresAt,
            },
        },
    };
    return {
        ...request,
        requestDigest: approvalRequestDigest(request),
    };
}

export function validateDevelopmentApiLdaregApprovalRequest(input: {
    target: DevelopmentApiLdaregTarget;
    expectedSourceReleaseSha: string;
    request: unknown;
    now?: Date;
}): DevelopmentApiLdaregApprovalRequest {
    const request = asRecord(
        input.request,
        'APPROVAL_REQUEST_INVALID'
    );
    if (
        !hasExactKeys(request, [
            'version',
            'databaseTarget',
            'createdAt',
            'expiresAt',
            'manifestDigest',
            'sourceReleaseSha',
            'officialEvidence',
            'ownerApproval',
            'requestDigest',
        ]) ||
        request.version !==
            DEVELOPMENT_API_LDAREG_APPROVAL_REQUEST_VERSION ||
        request.databaseTarget !== 'development' ||
        request.manifestDigest !== input.target.manifestDigest ||
        request.sourceReleaseSha !==
            input.expectedSourceReleaseSha ||
        !HEX40_RE.test(input.expectedSourceReleaseSha) ||
        !exactIsoTimestamp(request.createdAt) ||
        !exactIsoTimestamp(request.expiresAt) ||
        typeof request.requestDigest !== 'string' ||
        !HEX64_RE.test(request.requestDigest)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_INVALID'
        );
    }
    const now = input.now ?? new Date();
    if (
        !Number.isFinite(now.getTime()) ||
        Date.parse(request.expiresAt) -
            Date.parse(request.createdAt) !==
            DEVELOPMENT_API_LDAREG_APPROVAL_TTL_MS ||
        Date.parse(request.createdAt) >
            now.getTime() + 30_000 ||
        Date.parse(request.expiresAt) <= now.getTime()
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_EXPIRED'
        );
    }
    const officialEvidence =
        validateOfficialArtifactEvidence({
            target: input.target,
            value: request.officialEvidence,
        });
    const ownerApproval = asRecord(
        request.ownerApproval,
        'APPROVAL_REQUEST_INVALID'
    );
    if (
        !hasExactKeys(ownerApproval, ['name', 'args']) ||
        ownerApproval.name !==
            'replace_development_api_authoritative_ldareg_backfill_approval_v1'
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_INVALID'
        );
    }
    const args = asRecord(
        ownerApproval.args,
        'APPROVAL_REQUEST_INVALID'
    );
    const argumentKeys = [
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
        'p_enabled',
        'p_expires_at',
    ] as const;
    if (
        !hasExactKeys(args, argumentKeys) ||
        args.p_union_id !== input.target.unionId ||
        args.p_base_pnu !== input.target.basePnu ||
        args.p_mgm_bldrgst_pk !==
            input.target.managementPk ||
        stableStringify(args.p_scope_pnus) !==
            stableStringify(input.target.scopePnus) ||
        stableStringify(args.p_property_unit_ids) !==
            stableStringify(
                input.target.propertyTargets.map(
                    (property) => property.propertyUnitId
                )
            ) ||
        args.p_expected_scope_digest !==
            input.target.databaseDigests.scopeDigest ||
        args.p_expected_property_unit_digest !==
            input.target.databaseDigests.propertyUnitDigest ||
        typeof args.p_expected_proposed_values_digest !==
            'string' ||
        !HEX64_RE.test(
            args.p_expected_proposed_values_digest
        ) ||
        typeof args.p_expected_prestate_tuple_digest !==
            'string' ||
        !HEX64_RE.test(
            args.p_expected_prestate_tuple_digest
        ) ||
        typeof args.p_expected_prestate_rights_digest !==
            'string' ||
        !HEX64_RE.test(
            args.p_expected_prestate_rights_digest
        ) ||
        args.p_target_manifest_digest !==
            input.target.manifestDigest ||
        args.p_phase0_run_id !==
            Number(input.target.phase0.runId) ||
        args.p_phase0_artifact_version !==
            input.target.phase0.artifactVersion ||
        args.p_phase0_artifact_sha256 !==
            input.target.phase0.artifactSha256 ||
        args.p_phase0_schema_hash !==
            input.target.phase0.schemaHash ||
        args.p_evidence_digest !==
            officialEvidence.evidenceDigest ||
        args.p_source_release_sha !==
            input.expectedSourceReleaseSha ||
        typeof args.p_target_digest !== 'string' ||
        !HEX64_RE.test(args.p_target_digest) ||
        args.p_enabled !== true ||
        args.p_expires_at !== request.expiresAt
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_INVALID'
        );
    }
    const validatedItems =
        validateDevelopmentApiLdaregApprovalItems({
            target: input.target,
            items: args.p_items,
        });
    for (
        let index = 0;
        index < validatedItems.length;
        index += 1
    ) {
        if (
            officialEvidence.proposalAreas[index]
                .sourceIdentityHash !==
            sha256(
                `SOURCE_IDENTITY\u0000${validatedItems[index].components[0].sourceIdentity}`
            )
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'APPROVAL_REQUEST_EVIDENCE_BINDING_INVALID'
            );
        }
    }
    const expectedTargetDigest =
        computeDevelopmentApiLdaregExecutionTargetDigest({
            target: input.target,
            scopeDigest:
                input.target.databaseDigests.scopeDigest,
            propertyUnitDigest:
                input.target.databaseDigests.propertyUnitDigest,
            proposedValuesDigest:
                args.p_expected_proposed_values_digest,
            prestateTupleDigest:
                args.p_expected_prestate_tuple_digest,
            prestateTargetRightsDigest:
                args.p_expected_prestate_rights_digest,
            evidenceDigest: args.p_evidence_digest,
            sourceReleaseSha: input.expectedSourceReleaseSha,
        });
    const { requestDigest, ...requestCore } = request;
    if (
        args.p_target_digest !== expectedTargetDigest ||
        requestDigest !==
            approvalRequestDigest(
                requestCore as unknown as Omit<
                    DevelopmentApiLdaregApprovalRequest,
                    'requestDigest'
                >
            )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'APPROVAL_REQUEST_DIGEST_INVALID'
        );
    }
    return request as unknown as DevelopmentApiLdaregApprovalRequest;
}

export async function prepareDevelopmentApiLdaregBackfill(
    input: PrepareDevelopmentApiLdaregBackfillInput
): Promise<{
    artifact: DevelopmentApiLdaregPrepareArtifact;
    approvalRequest: DevelopmentApiLdaregApprovalRequest | null;
}> {
    let discovery: DevelopmentApiLdaregSnapshot | null = null;
    let preflight: DevelopmentApiLdaregSnapshot | null = null;
    let official: OfficialScanResult | null = null;
    let approvalRequest:
        | DevelopmentApiLdaregApprovalRequest
        | null = null;
    let discoveredById:
        | Map<string, DevelopmentApiLdaregInspectorTarget>
        | null = null;
    let targetDigest: string | null = null;
    let discoveryVerified = false;
    let proposalPreflightVerified = false;
    let approvalRequestVerified = false;
    let inspectCallCount = 0;
    const failureCodes = new Set<string>();
    try {
        if (
            !HEX40_RE.test(input.sourceReleaseSha) ||
            !input.buildingHubServiceKey.trim() ||
            input.buildingHubServiceKey.length > 4096 ||
            !input.vworldKey.trim() ||
            input.vworldKey.length > 4096 ||
            !input.vworldDomain.trim() ||
            input.vworldDomain.length > 253
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'RUN_ENVIRONMENT_INVALID'
            );
        }
        inspectCallCount += 1;
        discovery = await input.database.inspect({
            target: input.target,
            items: null,
            syncJobId: null,
        });
        discoveredById = validateDiscoveryTarget({
            target: input.target,
            snapshot: discovery,
            expectedProposal: 'NULL',
        });
        discoveryVerified = true;
        official = await scanDevelopmentApiLdaregOfficialSource({
            target: input.target,
            discoveredById,
            adapter: input.adapter,
            buildingHubServiceKey:
                input.buildingHubServiceKey,
            vworldKey: input.vworldKey,
            vworldDomain: input.vworldDomain,
        });
        inspectCallCount += 1;
        preflight = await input.database.inspect({
            target: input.target,
            items: official.items,
            syncJobId: null,
        });
        const preflightTargets = validateDiscoveryTarget({
            target: input.target,
            snapshot: preflight,
            expectedProposal: 'PRESENT',
        });
        if (
            stableStringify([...preflightTargets.entries()]) !==
            stableStringify([...discoveredById.entries()])
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'DB_CANONICAL_TARGET_CHANGED'
            );
        }
        assertReadOnlySnapshotsStable(discovery, preflight);
        validateProposal({
            target: input.target,
            snapshot: preflight,
            discoveredById,
        });
        proposalPreflightVerified = true;
        targetDigest =
            computeDevelopmentApiLdaregExecutionTargetDigest({
                target: input.target,
                scopeDigest: preflight.scope.digest,
                propertyUnitDigest:
                    preflight.propertyTargets.digest,
                proposedValuesDigest:
                    preflight.proposal!.digest,
                prestateTupleDigest:
                    preflight.currentState.prestateTupleDigest,
                prestateTargetRightsDigest:
                    preflight.currentState.targetRightsDigest,
                evidenceDigest:
                    official.evidence.evidenceDigest,
                sourceReleaseSha: input.sourceReleaseSha,
            });
        const now = (input.now ?? (() => new Date()))();
        approvalRequest =
            createDevelopmentApiLdaregApprovalRequest({
                target: input.target,
                sourceReleaseSha: input.sourceReleaseSha,
                official,
                preflight,
                targetDigest,
                now,
            });
        validateDevelopmentApiLdaregApprovalRequest({
            target: input.target,
            expectedSourceReleaseSha: input.sourceReleaseSha,
            request: approvalRequest,
            now,
        });
        approvalRequestVerified = true;
    } catch (error) {
        failureCodes.add(failureCode(error));
    }
    if (
        !discoveryVerified ||
        !proposalPreflightVerified ||
        !approvalRequestVerified ||
        discovery === null ||
        preflight === null ||
        official === null ||
        approvalRequest === null ||
        targetDigest === null
    ) {
        failureCodes.add(
            'DEVELOPMENT_API_LDAREG_PREPARE_INCOMPLETE'
        );
    }
    const sortedFailures = [...failureCodes].sort();
    const artifact: DevelopmentApiLdaregPrepareArtifact = {
        version:
            DEVELOPMENT_API_LDAREG_PREPARE_ARTIFACT_VERSION,
        mode: 'prepare',
        databaseTarget: 'development',
        manifestDigest: input.target.manifestDigest,
        targetDigest,
        sourceReleaseSha: input.sourceReleaseSha,
        phase0: input.target.phase0,
        officialScan: official?.evidence ?? null,
        proposal: {
            digest: preflight?.proposal?.digest ?? null,
            itemCount: preflight?.proposal?.itemCount ?? null,
            componentCount:
                preflight?.proposal?.componentCount ?? null,
            source: 'LDAREG',
        },
        stateDigests: {
            prestateTupleDigest:
                preflight?.currentState.prestateTupleDigest ??
                discovery?.currentState.prestateTupleDigest ??
                null,
            targetRightsDigest:
                preflight?.currentState.targetRightsDigest ??
                discovery?.currentState.targetRightsDigest ??
                null,
        },
        invariantDigests:
            preflight?.canonicalInvariantDigests ??
            discovery?.canonicalInvariantDigests ??
            null,
        relationPrerequisite: {
            required:
                preflight?.relationPrerequisite.required ??
                discovery?.relationPrerequisite.required ??
                null,
            satisfied:
                preflight?.relationPrerequisite.satisfied ??
                discovery?.relationPrerequisite.satisfied ??
                null,
            count:
                preflight?.relationPrerequisite.count ??
                discovery?.relationPrerequisite.count ??
                null,
            linkedCount:
                preflight?.relationPrerequisite.linkedCount ??
                discovery?.relationPrerequisite.linkedCount ??
                null,
        },
        approvalRequest: {
            requestDigest:
                approvalRequest?.requestDigest ?? null,
            expiresAt: approvalRequest?.expiresAt ?? null,
        },
        verification: {
            discoveryVerified,
            proposalPreflightVerified,
            approvalRequestVerified,
            exactCanonicalTargetCount:
                discoveredById?.size ?? 0,
        },
        executionBoundary: {
            inspectCallCount,
            applyRpcCallCount: 0,
            approvalRpcCallCount: 0,
            syncJobWriteCount: 0,
            propertyWriteCount: 0,
            propertyRightWriteCount: 0,
            verificationBoundary:
                'READ_ONLY_OFFICIAL_SCAN_AND_DATABASE_INSPECT_ONLY',
        },
        productionWrites: {
            observedWriteCount: 0,
            verificationBoundary:
                'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED',
        },
        manualDecisionCounters: {
            ...ZERO_MANUAL_COUNTERS,
        },
        gate: {
            status:
                sortedFailures.length === 0 ? 'PASS' : 'FAIL',
            failureCodes: sortedFailures,
        },
    };
    return { artifact, approvalRequest };
}

export async function runDevelopmentApiLdaregBackfill(
    input: RunDevelopmentApiLdaregBackfillInput
): Promise<DevelopmentApiLdaregRunArtifact> {
    if (
        !HEX40_RE.test(input.sourceReleaseSha) ||
        !input.buildingHubServiceKey.trim() ||
        input.buildingHubServiceKey.length > 4096 ||
        !input.vworldKey.trim() ||
        input.vworldKey.length > 4096 ||
        !input.vworldDomain.trim() ||
        input.vworldDomain.length > 253
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'RUN_ENVIRONMENT_INVALID'
        );
    }
    const syncJobId = (input.randomUuid ?? randomUUID)().toLowerCase();
    if (!UUID_RE.test(syncJobId)) {
        throw new ControlledDevelopmentApiLdaregError(
            'SYNC_JOB_ID_INVALID'
        );
    }
    let discovery: DevelopmentApiLdaregSnapshot | null = null;
    let preflight: DevelopmentApiLdaregSnapshot | null = null;
    let postflight: DevelopmentApiLdaregSnapshot | null = null;
    let official: OfficialScanResult | null = null;
    let receipt: DevelopmentApiLdaregApplyReceipt | null = null;
    let discoveredById:
        | Map<string, DevelopmentApiLdaregInspectorTarget>
        | null = null;
    let targetDigest: string | null = null;
    let discoveryVerified = false;
    let proposalPreflightVerified = false;
    let postflightVerified = false;
    let preinstalledApprovalVerified = false;
    let consumedApprovalVerified = false;
    let applyAttempts = 0;
    let receiptVerified = false;
    const failureCodes = new Set<string>();

    try {
        discovery = await input.database.inspect({
            target: input.target,
            items: null,
            syncJobId: null,
        });
        discoveredById = validateDiscoveryTarget({
            target: input.target,
            snapshot: discovery,
            expectedProposal: 'NULL',
        });
        discoveryVerified = true;
        official = await scanDevelopmentApiLdaregOfficialSource({
            target: input.target,
            discoveredById,
            adapter: input.adapter,
            buildingHubServiceKey: input.buildingHubServiceKey,
            vworldKey: input.vworldKey,
            vworldDomain: input.vworldDomain,
        });
        preflight = await input.database.inspect({
            target: input.target,
            items: official.items,
            syncJobId: null,
        });
        const preflightTargets = validateDiscoveryTarget({
            target: input.target,
            snapshot: preflight,
            expectedProposal: 'PRESENT',
        });
        if (
            stableStringify([...preflightTargets.entries()]) !==
            stableStringify([...discoveredById.entries()])
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'DB_CANONICAL_TARGET_CHANGED'
            );
        }
        assertReadOnlySnapshotsStable(discovery, preflight);
        validateProposal({
            target: input.target,
            snapshot: preflight,
            discoveredById,
        });
        proposalPreflightVerified = true;
        targetDigest =
            computeDevelopmentApiLdaregExecutionTargetDigest({
                target: input.target,
                scopeDigest: preflight.scope.digest,
                propertyUnitDigest:
                    preflight.propertyTargets.digest,
                proposedValuesDigest:
                    preflight.proposal!.digest,
                prestateTupleDigest:
                    preflight.currentState.prestateTupleDigest,
                prestateTargetRightsDigest:
                    preflight.currentState.targetRightsDigest,
                evidenceDigest:
                    official.evidence.evidenceDigest,
                sourceReleaseSha: input.sourceReleaseSha,
            });
        validatePreinstalledApproval({
            snapshot: preflight,
            targetDigest,
        });
        preinstalledApprovalVerified = true;
        receipt = await applyWithRetry({
            database: input.database,
            preflight,
            request: {
                target: input.target,
                items: official.items,
                expectedScopeDigest: preflight.scope.digest,
                expectedPropertyUnitDigest:
                    preflight.propertyTargets.digest,
                expectedProposedValuesDigest:
                    preflight.proposal!.digest,
                expectedPrestateTupleDigest:
                    preflight.currentState.prestateTupleDigest,
                expectedPrestateTargetRightsDigest:
                    preflight.currentState.targetRightsDigest,
                evidenceDigest:
                    official.evidence.evidenceDigest,
                sourceReleaseSha: input.sourceReleaseSha,
                targetDigest,
                syncJobId,
            },
            onAttempt: (attempt) => {
                applyAttempts = attempt;
            },
        });
        receiptVerified = true;
        postflight = await input.database.inspect({
            target: input.target,
            items: official.items,
            syncJobId,
        });
        const postflightTargets = validateDiscoveryTarget({
            target: input.target,
            snapshot: postflight,
            expectedProposal: 'PRESENT',
        });
        if (
            stableStringify([...postflightTargets.entries()]) !==
            stableStringify([...discoveredById.entries()]) ||
            postflight.scope.digest !== preflight.scope.digest ||
            postflight.propertyTargets.digest !==
                preflight.propertyTargets.digest ||
            postflight.proposal!.digest !==
                preflight.proposal!.digest ||
            postflight.currentState.prestateTupleDigest !==
                receipt.poststateTupleDigest ||
            postflight.currentState.targetRightsDigest !==
                receipt.poststateTargetRightsDigest ||
            !invariantDigestsEqual(
                postflight.canonicalInvariantDigests,
                preflight.canonicalInvariantDigests
            ) ||
            stableStringify(postflight.relationPrerequisite) !==
                stableStringify(
                    preflight.relationPrerequisite
                ) ||
            !manualCountersAreZero(
                postflight.manualDecisionCounters
            )
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'DB_POSTFLIGHT_INVALID'
            );
        }
        validateConsumedApproval({
            snapshot: postflight,
            targetDigest,
            syncJobId,
            receiptDigest: receipt.replay.receiptDigest,
        });
        consumedApprovalVerified = true;
        postflightVerified = true;
    } catch (error) {
        failureCodes.add(failureCode(error));
    }

    if (
        !discoveryVerified ||
        !proposalPreflightVerified ||
        !postflightVerified ||
        !preinstalledApprovalVerified ||
        !consumedApprovalVerified ||
        !receiptVerified ||
        official === null ||
        discovery === null ||
        preflight === null ||
        postflight === null ||
        receipt === null
    ) {
        failureCodes.add(
            'DEVELOPMENT_API_LDAREG_BACKFILL_INCOMPLETE'
        );
    }
    const sortedFailures = [...failureCodes].sort();
    return {
        version: DEVELOPMENT_API_LDAREG_ARTIFACT_VERSION,
        databaseTarget: 'development',
        manifestDigest: input.target.manifestDigest,
        targetDigest,
        sourceReleaseSha: input.sourceReleaseSha,
        syncJobIdHash: sha256(`SYNC_JOB_ID\u0000${syncJobId}`),
        phase0: input.target.phase0,
        officialScan: official?.evidence ?? null,
        proposal: {
            digest: preflight?.proposal?.digest ?? null,
            itemCount: preflight?.proposal?.itemCount ?? null,
            componentCount:
                preflight?.proposal?.componentCount ?? null,
            source: 'LDAREG',
        },
        stateDigests: {
            prestateTupleDigest:
                preflight?.currentState.prestateTupleDigest ??
                discovery?.currentState.prestateTupleDigest ??
                null,
            poststateTupleDigest:
                receipt?.poststateTupleDigest ?? null,
            targetRightsBeforeDigest:
                preflight?.currentState.targetRightsDigest ??
                discovery?.currentState.targetRightsDigest ??
                null,
            targetRightsAfterDigest:
                postflight?.currentState.targetRightsDigest ??
                null,
        },
        invariantDigests: {
            before:
                preflight?.canonicalInvariantDigests ??
                discovery?.canonicalInvariantDigests ??
                null,
            after:
                postflight?.canonicalInvariantDigests ?? null,
            stable:
                preflight !== null &&
                postflight !== null &&
                invariantDigestsEqual(
                    preflight.canonicalInvariantDigests,
                    postflight.canonicalInvariantDigests
                ),
        },
        relationPrerequisite: {
            required:
                preflight?.relationPrerequisite.required ??
                discovery?.relationPrerequisite.required ??
                null,
            beforeSatisfied:
                preflight?.relationPrerequisite.satisfied ??
                discovery?.relationPrerequisite.satisfied ??
                null,
            afterSatisfied:
                postflight?.relationPrerequisite.satisfied ??
                null,
            beforeCount:
                preflight?.relationPrerequisite.count ??
                discovery?.relationPrerequisite.count ??
                null,
            afterCount:
                postflight?.relationPrerequisite.count ?? null,
            beforeLinkedCount:
                preflight?.relationPrerequisite.linkedCount ??
                discovery?.relationPrerequisite.linkedCount ??
                null,
            afterLinkedCount:
                postflight?.relationPrerequisite.linkedCount ??
                null,
        },
        dbApproval: {
            preinstalledVerified:
                preinstalledApprovalVerified,
            consumedVerified: consumedApprovalVerified,
        },
        applyCall: {
            attempts: applyAttempts,
            maxAttempts:
                DEVELOPMENT_API_LDAREG_MAX_APPLY_ATTEMPTS,
            receiptVerified,
            recoveredAfterAmbiguousError:
                receiptVerified && applyAttempts > 1,
            status: receipt?.status ?? null,
            updatedPropertyUnitCount:
                receipt?.updatedPropertyUnitCount ?? null,
            rightsRowCount: receipt?.rightsRowCount ?? null,
            receiptDigest:
                receipt?.replay.receiptDigest ?? null,
        },
        verification: {
            discoveryVerified,
            proposalPreflightVerified,
            postflightVerified,
            exactCanonicalTargetCount:
                discoveredById?.size ?? 0,
        },
        productionWrites: {
            observedWriteCount: 0,
            verificationBoundary:
                'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED',
        },
        manualDecisionCounters: {
            ...ZERO_MANUAL_COUNTERS,
        },
        gate: {
            status:
                sortedFailures.length === 0 ? 'PASS' : 'FAIL',
            failureCodes: sortedFailures,
        },
    };
}

function validateNullableHex64(
    value: unknown,
    code: string
): void {
    if (value !== null && (typeof value !== 'string' || !HEX64_RE.test(value))) {
        throw new ControlledDevelopmentApiLdaregError(code);
    }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
    );
}

function isNullableBoolean(value: unknown): value is boolean | null {
    return value === null || typeof value === 'boolean';
}

function isNullableNonNegativeInteger(
    value: unknown
): value is number | null {
    return value === null || isNonNegativeSafeInteger(value);
}

function validateArtifactInvariantDigests(
    value: unknown
): DevelopmentApiLdaregInvariantDigests {
    const record = asRecord(value, 'ARTIFACT_INVALID');
    const keys = [
        'nonTargetPropertyUnits',
        'propertyOwnerships',
        'buildings',
        'buildingUnits',
        'buildingLandLots',
        'buildingExternalRefs',
        'landLots',
        'nonTargetPropertyUnitLandRights',
    ] as const;
    if (
        !hasExactKeys(record, keys) ||
        keys.some(
            (key) =>
                typeof record[key] !== 'string' ||
                !HEX64_RE.test(record[key])
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    return record as unknown as DevelopmentApiLdaregInvariantDigests;
}

function validateOfficialArtifactEvidence(input: {
    target: DevelopmentApiLdaregTarget;
    value: unknown;
}): DevelopmentApiLdaregOfficialEvidence {
    const evidence = asRecord(input.value, 'ARTIFACT_INVALID');
    const expectedBylotCount =
        input.target.scopePnus.length - 1;
    const keys = [
        'version',
        'endpointScans',
        'managementPkHash',
        'scopePnuHashes',
        'pairsDigest',
        'totalPairs',
        'totalRejectedPairs',
        'bylotCount',
        'landParcelCount',
        'landAreaTotal',
        'exposUnitCount',
        'ldaregRowCount',
        'ignoredOfficialUnitCount',
        'ignoredPlaceholderCount',
        'currentTargetCount',
        'componentCount',
        'proposalAreas',
        'ldaregRowMultisetDigest',
        'evidenceDigest',
    ] as const;
    if (
        !hasExactKeys(evidence, keys) ||
        evidence.version !==
            'development-api-authoritative-ldareg-evidence@1' ||
        evidence.managementPkHash !==
            input.target.officialHashes.managementPkHash ||
        evidence.pairsDigest !==
            input.target.officialHashes.pairsDigest ||
        evidence.totalPairs !== expectedBylotCount ||
        evidence.totalRejectedPairs !== 0 ||
        evidence.bylotCount !== expectedBylotCount ||
        evidence.landParcelCount !==
            input.target.landParcels.length ||
        evidence.landAreaTotal !==
            input.target.expectedDenominator ||
        evidence.exposUnitCount !==
            input.target.propertyTargets.length +
                input.target.ignoredOfficialUnits.length ||
        evidence.ldaregRowCount !==
            input.target.expectedLdaregRowCount ||
        evidence.ignoredOfficialUnitCount !==
            input.target.ignoredOfficialUnits.length ||
        evidence.ignoredPlaceholderCount !==
            input.target.expectedIgnoredPlaceholderCount ||
        evidence.currentTargetCount !==
            input.target.propertyTargets.length ||
        evidence.componentCount !==
            input.target.propertyTargets.length *
                input.target.scopePnus.length ||
        evidence.ldaregRowMultisetDigest !==
            input.target.officialHashes
                .ldaregRowMultisetDigest ||
        typeof evidence.evidenceDigest !== 'string' ||
        !HEX64_RE.test(evidence.evidenceDigest)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const scopePnuHashes = evidence.scopePnuHashes;
    if (
        !Array.isArray(scopePnuHashes) ||
        stableStringify(scopePnuHashes) !==
            stableStringify(
                input.target.scopePnus
                    .map((pnu) => sha256(`PNU\u0000${pnu}`))
                    .sort()
            )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const endpointNames = [
        'getBrTitleInfo',
        'getBrBasisOulnInfo',
        'getBrAtchJibunInfo',
        'getBrExposInfo',
        'ladfrlList',
        'ldaregList',
    ] as const;
    const endpointScans = evidence.endpointScans;
    if (!Array.isArray(endpointScans)) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    const expectedEndpointKeys = [
        `getBrTitleInfo\u0000${sha256(
            `PNU\u0000${input.target.basePnu}`
        )}`,
        `getBrAtchJibunInfo\u0000${sha256(
            `PNU\u0000${input.target.basePnu}`
        )}`,
        ...input.target.scopePnus.flatMap((pnu) => {
            const pnuHash = sha256(`PNU\u0000${pnu}`);
            return [
                `getBrBasisOulnInfo\u0000${pnuHash}`,
                `getBrExposInfo\u0000${pnuHash}`,
                `ladfrlList\u0000${pnuHash}`,
                `ldaregList\u0000${pnuHash}`,
            ];
        }),
    ].sort();
    const observedEndpointKeys: string[] = [];
    for (const value of endpointScans) {
        const scan = asRecord(value, 'ARTIFACT_INVALID');
        if (
            !hasExactKeys(scan, [
                'endpoint',
                'queryPnuHash',
                'state',
                'totalCount',
                'pagesFetched',
                'schemaHash',
            ]) ||
            typeof scan.endpoint !== 'string' ||
            !endpointNames.includes(
                scan.endpoint as (typeof endpointNames)[number]
            ) ||
            typeof scan.queryPnuHash !== 'string' ||
            !HEX64_RE.test(scan.queryPnuHash) ||
            (scan.state !== 'COMPLETE' &&
                scan.state !== 'COMPLETE_ZERO') ||
            !isNonNegativeSafeInteger(scan.totalCount) ||
            !isNonNegativeSafeInteger(scan.pagesFetched) ||
            scan.pagesFetched < 1 ||
            typeof scan.schemaHash !== 'string' ||
            !HEX64_RE.test(scan.schemaHash) ||
            (scan.state === 'COMPLETE' &&
                scan.totalCount < 1) ||
            (scan.state === 'COMPLETE_ZERO' &&
                scan.totalCount !== 0) ||
            (scan.endpoint === 'getBrAtchJibunInfo' &&
                (scan.state !==
                    (expectedBylotCount === 0
                        ? 'COMPLETE_ZERO'
                        : 'COMPLETE') ||
                    scan.schemaHash !==
                        input.target.officialHashes
                            .attachedSchemaHash))
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'ARTIFACT_INVALID'
            );
        }
        observedEndpointKeys.push(
            `${scan.endpoint}\u0000${scan.queryPnuHash}`
        );
    }
    if (
        stableStringify(observedEndpointKeys) !==
            stableStringify([...observedEndpointKeys].sort()) ||
        stableStringify(observedEndpointKeys) !==
            stableStringify(expectedEndpointKeys)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const proposalAreas = evidence.proposalAreas;
    if (
        !Array.isArray(proposalAreas) ||
        proposalAreas.length !==
            input.target.propertyTargets.length
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    for (
        let index = 0;
        index < proposalAreas.length;
        index += 1
    ) {
        const area = asRecord(
            proposalAreas[index],
            'ARTIFACT_INVALID'
        );
        const target = input.target.propertyTargets[index];
        if (
            !hasExactKeys(area, [
                'propertyUnitIdHash',
                'matchedBuildingUnitIdHash',
                'roomHash',
                'landArea',
                'sourceIdentityHash',
            ]) ||
            area.propertyUnitIdHash !==
                sha256(
                    `PROPERTY_UNIT_ID\u0000${target.propertyUnitId}`
                ) ||
            area.matchedBuildingUnitIdHash !==
                sha256(
                    `BUILDING_UNIT_ID\u0000${target.expectedBuildingUnitId}`
                ) ||
            area.roomHash !==
                sha256(`ROOM\u0000${target.normalizedHo}`) ||
            area.landArea !== target.expectedNumerator ||
            typeof area.sourceIdentityHash !== 'string' ||
            !HEX64_RE.test(area.sourceIdentityHash)
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'ARTIFACT_INVALID'
            );
        }
    }

    const { evidenceDigest, ...evidenceCore } = evidence;
    if (
        evidenceDigest !==
        sha256(stableStringify(evidenceCore))
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    return evidence as unknown as DevelopmentApiLdaregOfficialEvidence;
}

function containsRawTargetIdentifier(
    target: DevelopmentApiLdaregTarget,
    artifact: unknown
): boolean {
    const serialized = JSON.stringify(artifact);
    return [
        target.unionId,
        target.basePnu,
        target.managementPk,
        target.canonicalBuildingId,
        ...target.scopePnus,
        ...target.propertyTargets.flatMap((property) => [
            property.propertyUnitId,
            property.expectedBuildingUnitId,
        ]),
    ].some((identifier) => serialized.includes(identifier));
}

export function validateDevelopmentApiLdaregArtifact(input: {
    target: DevelopmentApiLdaregTarget;
    expectedSourceReleaseSha: string;
    artifact: unknown;
}): DevelopmentApiLdaregRunArtifact {
    const expectedRelation =
        expectedRelationPrerequisite(input.target);
    const artifact = asRecord(
        input.artifact,
        'ARTIFACT_INVALID'
    );
    const topKeys = [
        'version',
        'databaseTarget',
        'manifestDigest',
        'targetDigest',
        'sourceReleaseSha',
        'syncJobIdHash',
        'phase0',
        'officialScan',
        'proposal',
        'stateDigests',
        'invariantDigests',
        'relationPrerequisite',
        'dbApproval',
        'applyCall',
        'verification',
        'productionWrites',
        'manualDecisionCounters',
        'gate',
    ] as const;
    if (
        !hasExactKeys(artifact, topKeys) ||
        artifact.version !==
            DEVELOPMENT_API_LDAREG_ARTIFACT_VERSION ||
        artifact.databaseTarget !== 'development' ||
        artifact.manifestDigest !== input.target.manifestDigest ||
        artifact.sourceReleaseSha !==
            input.expectedSourceReleaseSha ||
        !HEX40_RE.test(input.expectedSourceReleaseSha) ||
        typeof artifact.syncJobIdHash !== 'string' ||
        !HEX64_RE.test(artifact.syncJobIdHash) ||
        containsRawTargetIdentifier(input.target, artifact)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(artifact.targetDigest, 'ARTIFACT_INVALID');
    const phase0 = asRecord(artifact.phase0, 'ARTIFACT_INVALID');
    if (
        !hasExactKeys(phase0, [
            'runId',
            'artifactVersion',
            'artifactSha256',
            'schemaHash',
        ]) ||
        stableStringify(phase0) !==
            stableStringify(input.target.phase0)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    const gate = asRecord(artifact.gate, 'ARTIFACT_INVALID');
    if (
        !hasExactKeys(gate, ['status', 'failureCodes']) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        !Array.isArray(gate.failureCodes) ||
        !gate.failureCodes.every(
            (code) =>
                typeof code === 'string' &&
                /^[A-Z0-9_]{1,100}$/.test(code)
        ) ||
        !exactSortedUnique(gate.failureCodes) ||
        (gate.status === 'PASS'
            ? gate.failureCodes.length !== 0
            : gate.failureCodes.length === 0)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const officialScan =
        artifact.officialScan === null
            ? null
            : validateOfficialArtifactEvidence({
                  target: input.target,
                  value: artifact.officialScan,
              });
    const proposal = asRecord(
        artifact.proposal,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(proposal, [
            'digest',
            'itemCount',
            'componentCount',
            'source',
        ]) ||
        proposal.source !== 'LDAREG' ||
        !isNullableNonNegativeInteger(proposal.itemCount) ||
        !isNullableNonNegativeInteger(
            proposal.componentCount
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(proposal.digest, 'ARTIFACT_INVALID');
    if (
        (proposal.digest === null) !==
            (proposal.itemCount === null) ||
        (proposal.digest === null) !==
            (proposal.componentCount === null)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const stateDigests = asRecord(
        artifact.stateDigests,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(stateDigests, [
            'prestateTupleDigest',
            'poststateTupleDigest',
            'targetRightsBeforeDigest',
            'targetRightsAfterDigest',
        ])
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    for (const key of Object.keys(stateDigests)) {
        validateNullableHex64(
            stateDigests[key],
            'ARTIFACT_INVALID'
        );
    }

    const invariantDigests = asRecord(
        artifact.invariantDigests,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(invariantDigests, [
            'before',
            'after',
            'stable',
        ]) ||
        typeof invariantDigests.stable !== 'boolean' ||
        (invariantDigests.before === null &&
            invariantDigests.after !== null)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    const invariantBefore =
        invariantDigests.before === null
            ? null
            : validateArtifactInvariantDigests(
                  invariantDigests.before
              );
    const invariantAfter =
        invariantDigests.after === null
            ? null
            : validateArtifactInvariantDigests(
                  invariantDigests.after
              );
    if (
        invariantDigests.stable !==
        (invariantBefore !== null &&
            invariantAfter !== null &&
            invariantDigestsEqual(
                invariantBefore,
                invariantAfter
            ))
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const relation = asRecord(
        artifact.relationPrerequisite,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(relation, [
            'required',
            'beforeSatisfied',
            'afterSatisfied',
            'beforeCount',
            'afterCount',
            'beforeLinkedCount',
            'afterLinkedCount',
        ]) ||
        !isNullableBoolean(relation.required) ||
        !isNullableBoolean(relation.beforeSatisfied) ||
        !isNullableBoolean(relation.afterSatisfied) ||
        !isNullableNonNegativeInteger(relation.beforeCount) ||
        !isNullableNonNegativeInteger(relation.afterCount) ||
        !isNullableNonNegativeInteger(
            relation.beforeLinkedCount
        ) ||
        !isNullableNonNegativeInteger(
            relation.afterLinkedCount
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const approval = asRecord(
        artifact.dbApproval,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(approval, [
            'preinstalledVerified',
            'consumedVerified',
        ]) ||
        typeof approval.preinstalledVerified !== 'boolean' ||
        typeof approval.consumedVerified !== 'boolean'
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const applyCall = asRecord(
        artifact.applyCall,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(applyCall, [
            'attempts',
            'maxAttempts',
            'receiptVerified',
            'recoveredAfterAmbiguousError',
            'status',
            'updatedPropertyUnitCount',
            'rightsRowCount',
            'receiptDigest',
        ]) ||
        !isNonNegativeSafeInteger(applyCall.attempts) ||
        applyCall.attempts >
            DEVELOPMENT_API_LDAREG_MAX_APPLY_ATTEMPTS ||
        applyCall.maxAttempts !==
            DEVELOPMENT_API_LDAREG_MAX_APPLY_ATTEMPTS ||
        typeof applyCall.receiptVerified !== 'boolean' ||
        typeof applyCall.recoveredAfterAmbiguousError !==
            'boolean' ||
        (applyCall.status !== null &&
            applyCall.status !== 'APPLIED' &&
            applyCall.status !== 'REUSED') ||
        !isNullableNonNegativeInteger(
            applyCall.updatedPropertyUnitCount
        ) ||
        !isNullableNonNegativeInteger(
            applyCall.rightsRowCount
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(
        applyCall.receiptDigest,
        'ARTIFACT_INVALID'
    );

    const verification = asRecord(
        artifact.verification,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(verification, [
            'discoveryVerified',
            'proposalPreflightVerified',
            'postflightVerified',
            'exactCanonicalTargetCount',
        ]) ||
        typeof verification.discoveryVerified !== 'boolean' ||
        typeof verification.proposalPreflightVerified !==
            'boolean' ||
        typeof verification.postflightVerified !== 'boolean' ||
        !isNonNegativeSafeInteger(
            verification.exactCanonicalTargetCount
        ) ||
        verification.exactCanonicalTargetCount >
            input.target.propertyTargets.length
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    const manual = asRecord(
        artifact.manualDecisionCounters,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(manual, [
            'sourceReads',
            'resolverReads',
            'blockerReads',
            'fallbackReads',
            'selectionReads',
        ]) ||
        !manualCountersAreZero(
            manual as unknown as DevelopmentApiLdaregManualDecisionCounters
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }
    const production = asRecord(
        artifact.productionWrites,
        'ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(production, [
            'observedWriteCount',
            'verificationBoundary',
        ]) ||
        production.observedWriteCount !== 0 ||
        production.verificationBoundary !==
            'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED'
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_INVALID'
        );
    }

    if (gate.status === 'PASS') {
        const expectedRights =
            input.target.propertyTargets.length *
            input.target.scopePnus.length;
        if (
            artifact.targetDigest === null ||
            officialScan === null ||
            proposal.digest === null ||
            proposal.itemCount !==
                input.target.propertyTargets.length ||
            proposal.componentCount !== expectedRights ||
            stateDigests.prestateTupleDigest === null ||
            stateDigests.poststateTupleDigest === null ||
            stateDigests.prestateTupleDigest ===
                stateDigests.poststateTupleDigest ||
            stateDigests.targetRightsBeforeDigest === null ||
            stateDigests.targetRightsAfterDigest === null ||
            stateDigests.targetRightsBeforeDigest ===
                stateDigests.targetRightsAfterDigest ||
            invariantBefore === null ||
            invariantAfter === null ||
            invariantDigests.stable !== true ||
            relation.required !== expectedRelation.required ||
            relation.beforeSatisfied !== true ||
            relation.afterSatisfied !== true ||
            relation.beforeCount !== expectedRelation.count ||
            relation.afterCount !== expectedRelation.count ||
            relation.beforeLinkedCount !==
                expectedRelation.linkedCount ||
            relation.afterLinkedCount !==
                expectedRelation.linkedCount ||
            approval.preinstalledVerified !== true ||
            approval.consumedVerified !== true ||
            applyCall.attempts < 1 ||
            applyCall.receiptVerified !== true ||
            applyCall.status === null ||
            applyCall.updatedPropertyUnitCount !==
                input.target.propertyTargets.length ||
            applyCall.rightsRowCount !== expectedRights ||
            applyCall.receiptDigest === null ||
            applyCall.recoveredAfterAmbiguousError !==
                (applyCall.attempts > 1) ||
            (applyCall.status === 'REUSED') !==
                applyCall.recoveredAfterAmbiguousError ||
            verification.discoveryVerified !== true ||
            verification.proposalPreflightVerified !== true ||
            verification.postflightVerified !== true ||
            verification.exactCanonicalTargetCount !==
                input.target.propertyTargets.length
        ) {
            throw new ControlledDevelopmentApiLdaregError(
                'ARTIFACT_INVALID'
            );
        }
    }

    const serialized = stableStringify(artifact);
    if (
        /"(?:landArea|land_area|source)"\s*:\s*"MANUAL"/i.test(
            serialized
        ) ||
        /service[_-]?role|api[_-]?key|authorization|bearer/i.test(
            serialized
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'ARTIFACT_REDACTION_INVALID'
        );
    }
    return artifact as unknown as DevelopmentApiLdaregRunArtifact;
}

export function validateDevelopmentApiLdaregPrepareArtifact(input: {
    target: DevelopmentApiLdaregTarget;
    expectedSourceReleaseSha: string;
    artifact: unknown;
}): DevelopmentApiLdaregPrepareArtifact {
    const expectedRelation =
        expectedRelationPrerequisite(input.target);
    const artifact = asRecord(
        input.artifact,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(artifact, [
            'version',
            'mode',
            'databaseTarget',
            'manifestDigest',
            'targetDigest',
            'sourceReleaseSha',
            'phase0',
            'officialScan',
            'proposal',
            'stateDigests',
            'invariantDigests',
            'relationPrerequisite',
            'approvalRequest',
            'verification',
            'executionBoundary',
            'productionWrites',
            'manualDecisionCounters',
            'gate',
        ]) ||
        artifact.version !==
            DEVELOPMENT_API_LDAREG_PREPARE_ARTIFACT_VERSION ||
        artifact.mode !== 'prepare' ||
        artifact.databaseTarget !== 'development' ||
        artifact.manifestDigest !== input.target.manifestDigest ||
        artifact.sourceReleaseSha !==
            input.expectedSourceReleaseSha ||
        !HEX40_RE.test(input.expectedSourceReleaseSha) ||
        containsRawTargetIdentifier(input.target, artifact)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(
        artifact.targetDigest,
        'PREPARE_ARTIFACT_INVALID'
    );
    const phase0 = asRecord(
        artifact.phase0,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        stableStringify(phase0) !==
        stableStringify(input.target.phase0)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const official =
        artifact.officialScan === null
            ? null
            : validateOfficialArtifactEvidence({
                  target: input.target,
                  value: artifact.officialScan,
              });
    const proposal = asRecord(
        artifact.proposal,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(proposal, [
            'digest',
            'itemCount',
            'componentCount',
            'source',
        ]) ||
        proposal.source !== 'LDAREG' ||
        !isNullableNonNegativeInteger(proposal.itemCount) ||
        !isNullableNonNegativeInteger(
            proposal.componentCount
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(
        proposal.digest,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        (proposal.digest === null) !==
            (proposal.itemCount === null) ||
        (proposal.digest === null) !==
            (proposal.componentCount === null)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const state = asRecord(
        artifact.stateDigests,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(state, [
            'prestateTupleDigest',
            'targetRightsDigest',
        ])
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(
        state.prestateTupleDigest,
        'PREPARE_ARTIFACT_INVALID'
    );
    validateNullableHex64(
        state.targetRightsDigest,
        'PREPARE_ARTIFACT_INVALID'
    );
    const invariants =
        artifact.invariantDigests === null
            ? null
            : validateArtifactInvariantDigests(
                  artifact.invariantDigests
              );
    const relation = asRecord(
        artifact.relationPrerequisite,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(relation, [
            'required',
            'satisfied',
            'count',
            'linkedCount',
        ]) ||
        !isNullableBoolean(relation.required) ||
        !isNullableBoolean(relation.satisfied) ||
        !isNullableNonNegativeInteger(relation.count) ||
        !isNullableNonNegativeInteger(relation.linkedCount)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const approvalRequest = asRecord(
        artifact.approvalRequest,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(approvalRequest, [
            'requestDigest',
            'expiresAt',
        ]) ||
        (approvalRequest.requestDigest === null) !==
            (approvalRequest.expiresAt === null)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    validateNullableHex64(
        approvalRequest.requestDigest,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        approvalRequest.expiresAt !== null &&
        !exactIsoTimestamp(approvalRequest.expiresAt)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const verification = asRecord(
        artifact.verification,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(verification, [
            'discoveryVerified',
            'proposalPreflightVerified',
            'approvalRequestVerified',
            'exactCanonicalTargetCount',
        ]) ||
        typeof verification.discoveryVerified !== 'boolean' ||
        typeof verification.proposalPreflightVerified !==
            'boolean' ||
        typeof verification.approvalRequestVerified !==
            'boolean' ||
        !isNonNegativeSafeInteger(
            verification.exactCanonicalTargetCount
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const execution = asRecord(
        artifact.executionBoundary,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(execution, [
            'inspectCallCount',
            'applyRpcCallCount',
            'approvalRpcCallCount',
            'syncJobWriteCount',
            'propertyWriteCount',
            'propertyRightWriteCount',
            'verificationBoundary',
        ]) ||
        !isNonNegativeSafeInteger(execution.inspectCallCount) ||
        execution.inspectCallCount > 2 ||
        execution.applyRpcCallCount !== 0 ||
        execution.approvalRpcCallCount !== 0 ||
        execution.syncJobWriteCount !== 0 ||
        execution.propertyWriteCount !== 0 ||
        execution.propertyRightWriteCount !== 0 ||
        execution.verificationBoundary !==
            'READ_ONLY_OFFICIAL_SCAN_AND_DATABASE_INSPECT_ONLY'
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const manual = asRecord(
        artifact.manualDecisionCounters,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(manual, [
            'sourceReads',
            'resolverReads',
            'blockerReads',
            'fallbackReads',
            'selectionReads',
        ]) ||
        !manualCountersAreZero(
            manual as unknown as DevelopmentApiLdaregManualDecisionCounters
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const production = asRecord(
        artifact.productionWrites,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(production, [
            'observedWriteCount',
            'verificationBoundary',
        ]) ||
        production.observedWriteCount !== 0 ||
        production.verificationBoundary !==
            'NO_PRODUCTION_CLIENT_CONSTRUCTED_DEVELOPMENT_PROJECT_REF_PINNED'
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const gate = asRecord(
        artifact.gate,
        'PREPARE_ARTIFACT_INVALID'
    );
    if (
        !hasExactKeys(gate, ['status', 'failureCodes']) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        !Array.isArray(gate.failureCodes) ||
        !gate.failureCodes.every(
            (code) =>
                typeof code === 'string' &&
                /^[A-Z0-9_]{1,100}$/.test(code)
        ) ||
        !exactSortedUnique(gate.failureCodes) ||
        (gate.status === 'PASS'
            ? gate.failureCodes.length !== 0
            : gate.failureCodes.length === 0)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    if (
        gate.status === 'PASS' &&
        (artifact.targetDigest === null ||
            official === null ||
            proposal.digest === null ||
            proposal.itemCount !==
                input.target.propertyTargets.length ||
            proposal.componentCount !==
                input.target.propertyTargets.length *
                    input.target.scopePnus.length ||
            state.prestateTupleDigest === null ||
            state.targetRightsDigest === null ||
            invariants === null ||
            relation.required !== expectedRelation.required ||
            relation.satisfied !== true ||
            relation.count !== expectedRelation.count ||
            relation.linkedCount !==
                expectedRelation.linkedCount ||
            approvalRequest.requestDigest === null ||
            approvalRequest.expiresAt === null ||
            verification.discoveryVerified !== true ||
            verification.proposalPreflightVerified !== true ||
            verification.approvalRequestVerified !== true ||
            verification.exactCanonicalTargetCount !==
                input.target.propertyTargets.length ||
            execution.inspectCallCount !== 2)
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_INVALID'
        );
    }
    const serialized = stableStringify(artifact);
    if (
        /"(?:landArea|land_area|source)"\s*:\s*"MANUAL"/i.test(
            serialized
        ) ||
        /service[_-]?role|api[_-]?key|authorization|bearer/i.test(
            serialized
        )
    ) {
        throw new ControlledDevelopmentApiLdaregError(
            'PREPARE_ARTIFACT_REDACTION_INVALID'
        );
    }
    return artifact as unknown as DevelopmentApiLdaregPrepareArtifact;
}

export function controlledDevelopmentApiLdaregFailureCode(
    error: unknown
): string {
    return failureCode(error);
}
