/**
 * Phase 0 대지권 최초 관찰 artifact의 strict, fail-closed validator.
 *
 * 원문 PNU나 provider 응답을 출력하지 않고, manifest와 비식별 artifact의 구조 및
 * 상호 commitment만 검증한다.
 */

import { createHash } from 'node:crypto';
import {
    LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH,
    LAND_AREA_PHASE0_ARTIFACT_VERSION,
    LAND_AREA_PHASE0_ENDPOINTS,
    LAND_AREA_PHASE0_MAX_ARTIFACT_BYTES,
    expectedLandAreaPhase0Family,
    parseLandAreaPhase0Manifest,
    type LandAreaPhase0CaptureArtifact,
    type LandAreaPhase0CaptureManifest,
    type LandAreaPhase0ExpectedFamily,
} from './land-area-phase0-capture';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SAFE_DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;
const MAX_INVENTORY_RECORDS = 200;

type JsonRecord = Record<string, unknown>;

function reject(message: string): never {
    throw new Error(`Phase 0 artifact validation failed: ${message}`);
}

function assertRecord(value: unknown, path: string): asserts value is JsonRecord {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length > 0
    ) {
        reject(`${path} must be a plain object`);
    }
}

function assertExactKeys(
    value: JsonRecord,
    required: readonly string[],
    optional: readonly string[],
    path: string
): void {
    const requiredSet = new Set(required);
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) reject(`${path} contains an unknown key`);
    }
    for (const key of requiredSet) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            reject(`${path} is missing a required key`);
        }
    }
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
    if (!Array.isArray(value)) reject(`${path} must be an array`);
}

function assertString(value: unknown, path: string, maxLength = 256): asserts value is string {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(value)
    ) {
        reject(`${path} must be a bounded string`);
    }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
    if (typeof value !== 'boolean') reject(`${path} must be boolean`);
}

function assertNonNegativeInteger(
    value: unknown,
    path: string
): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        reject(`${path} must be a non-negative safe integer`);
    }
}

function assertNullableNonNegativeInteger(value: unknown, path: string): void {
    if (value !== null) assertNonNegativeInteger(value, path);
}

function assertHash(value: unknown, path: string): asserts value is string {
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
        reject(`${path} must be a lowercase SHA-256`);
    }
}

function assertNullableHash(value: unknown, path: string): void {
    if (value !== null) assertHash(value, path);
}

function assertDecimal(value: unknown, path: string): asserts value is string {
    if (typeof value !== 'string' || !SAFE_DECIMAL_PATTERN.test(value)) {
        reject(`${path} must be a safe decimal`);
    }
}

function assertNullableDecimal(value: unknown, path: string): void {
    if (value !== null) assertDecimal(value, path);
}

function assertEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    path: string
): asserts value is T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        reject(`${path} has an unsupported value`);
    }
}

function assertSortedUniqueCodes(value: unknown, path: string): asserts value is string[] {
    assertArray(value, path);
    const codes = value.map((candidate, index) => {
        if (typeof candidate !== 'string' || !CODE_PATTERN.test(candidate)) {
            reject(`${path}[${index}] is not a safe code`);
        }
        return candidate;
    });
    const canonical = [...new Set(codes)].sort();
    if (
        canonical.length !== codes.length ||
        canonical.some((code, index) => code !== codes[index])
    ) {
        reject(`${path} must be sorted and unique`);
    }
}

function assertHashArray(value: unknown, path: string): asserts value is string[] {
    assertArray(value, path);
    value.forEach((candidate, index) => assertHash(candidate, `${path}[${index}]`));
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const nested = (value as Record<string, unknown>)[key];
            if (nested !== undefined) result[key] = canonicalize(nested);
        }
        return result;
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function sanitizedDigest(value: unknown): string {
    return createHash('sha256')
        .update(stableStringify(value), 'utf8')
        .digest('hex');
}

function assertCanonicalOrder(values: unknown[], path: string): void {
    const sorted = [...values].sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right))
    );
    if (
        sorted.some(
            (candidate, index) =>
                stableStringify(candidate) !== stableStringify(values[index])
        )
    ) {
        reject(`${path} must use canonical producer ordering`);
    }
}

function validateBoundedRecordEnvelope(
    value: JsonRecord,
    records: unknown[],
    path: string
): void {
    assertNonNegativeInteger(value.totalRecords, `${path}.totalRecords`);
    assertBoolean(value.truncated, `${path}.truncated`);
    assertHash(value.sanitizedDigest, `${path}.sanitizedDigest`);
    if (records.length > MAX_INVENTORY_RECORDS) {
        reject(`${path}.records exceeds the sanitized bound`);
    }
    if (
        (!value.truncated && value.totalRecords !== records.length) ||
        (value.truncated && value.totalRecords <= records.length)
    ) {
        reject(`${path} record count metadata is inconsistent`);
    }
}

function validateBylot(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(
        value,
        ['presence', 'jsonType', 'parseState'],
        ['rawValue', 'count'],
        path
    );
    assertEnum(value.presence, ['ABSENT', 'NULL', 'PRESENT'], `${path}.presence`);
    assertEnum(
        value.jsonType,
        ['undefined', 'null', 'string', 'number', 'boolean', 'object', 'array'],
        `${path}.jsonType`
    );
    assertEnum(value.parseState, ['VALID', 'INVALID'], `${path}.parseState`);
    if (value.rawValue !== undefined) {
        const validRaw =
            (typeof value.rawValue === 'string' &&
                value.rawValue.length <= 32 &&
                /^\s*\d+\s*$/.test(value.rawValue)) ||
            (typeof value.rawValue === 'number' &&
                Number.isSafeInteger(value.rawValue));
        if (!validRaw) reject(`${path}.rawValue is invalid`);
    }
    if (value.count !== undefined) {
        assertNonNegativeInteger(value.count, `${path}.count`);
        if (value.count > 10_000) reject(`${path}.count exceeds its bound`);
    }
    if (
        (value.parseState === 'VALID') !==
        Object.prototype.hasOwnProperty.call(value, 'count')
    ) {
        reject(`${path} parse metadata is inconsistent`);
    }
}

function validateIssue(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(
        value,
        ['kind'],
        [
            'schemaErrorCode',
            'httpStatus',
            'pagesFetched',
            'expectedTotalCount',
            'receivedRows',
            'attempts',
        ],
        path
    );
    if (value.schemaErrorCode !== undefined) {
        assertEnum(
            value.schemaErrorCode,
            [
                'RESPONSE_CONTAINER_MISSING',
                'RESULT_CODE_MISSING',
                'BODY_MISSING',
                'ENDPOINT_RESPONSE_NON_OBJECT',
                'ENDPOINT_CONTAINER_MISSING_EMPTY_OBJECT',
                'ENDPOINT_CONTAINER_MISSING_RESPONSE',
                'ENDPOINT_CONTAINER_MISSING_OTHER',
                'ENDPOINT_CONTAINER_INVALID',
                'TOTAL_COUNT_INVALID',
                'INPUT_PNU_INVALID',
            ],
            `${path}.schemaErrorCode`
        );
        if (value.kind !== 'SCHEMA_ERROR') {
            reject(`${path}.schemaErrorCode requires SCHEMA_ERROR`);
        }
    }
    assertEnum(
        value.kind,
        [
            'HTTP_ERROR',
            'TRANSPORT_ERROR',
            'TIMEOUT',
            'PROVIDER_ERROR_ENVELOPE',
            'SCHEMA_ERROR',
            'PAGINATION_MISMATCH',
            'ABORTED',
        ],
        `${path}.kind`
    );
    if (
        value.kind === 'SCHEMA_ERROR' &&
        value.schemaErrorCode === undefined
    ) {
        reject(`${path}.SCHEMA_ERROR requires schemaErrorCode`);
    }
    for (const key of [
        'httpStatus',
        'pagesFetched',
        'expectedTotalCount',
        'receivedRows',
        'attempts',
    ] as const) {
        if (value[key] !== undefined) {
            assertNonNegativeInteger(value[key], `${path}.${key}`);
        }
    }
}

function validateOptionalHashFields(
    value: JsonRecord,
    fields: readonly string[],
    path: string
): void {
    for (const field of fields) {
        if (value[field] !== undefined) {
            assertHash(value[field], `${path}.${field}`);
        }
    }
}

function validateOptionalStringFields(
    value: JsonRecord,
    fields: readonly string[],
    path: string,
    maxLength = 80
): void {
    for (const field of fields) {
        if (value[field] !== undefined) {
            assertString(value[field], `${path}.${field}`, maxLength);
        }
    }
}

function validateInventory(value: unknown, endpoint: string, path: string): void {
    assertRecord(value, path);
    assertString(value.kind, `${path}.kind`, 16);
    const expectedKindByEndpoint: Record<string, string> = {
        getBrTitleInfo: 'TITLE',
        getBrBasisOulnInfo: 'BASIS',
        getBrAtchJibunInfo: 'ATTACHED',
        getBrExposInfo: 'EXPOS',
        ladfrlList: 'LADFRL',
        ldaregList: 'LDAREG',
    };
    if (value.kind !== expectedKindByEndpoint[endpoint]) {
        reject(`${path}.kind does not match endpoint`);
    }

    if (value.kind === 'TITLE') {
        assertExactKeys(
            value,
            ['kind', 'records', 'totalRecords', 'truncated', 'sanitizedDigest'],
            [],
            path
        );
        assertArray(value.records, `${path}.records`);
        value.records.forEach((record, index) => {
            const recordPath = `${path}.records[${index}]`;
            assertRecord(record, recordPath);
            assertExactKeys(
                record,
                ['bylot', 'otherPurposePresent', 'otherPurposeSignals'],
                [
                    'managementPkHash',
                    'upManagementPkHash',
                    'registryTypeCode',
                    'registryTypeLabel',
                    'mainPurposeCode',
                    'mainPurposeLabel',
                    'otherPurposeHash',
                ],
                recordPath
            );
            validateOptionalHashFields(
                record,
                ['managementPkHash', 'upManagementPkHash', 'otherPurposeHash'],
                recordPath
            );
            validateOptionalStringFields(
                record,
                [
                    'registryTypeCode',
                    'registryTypeLabel',
                    'mainPurposeCode',
                    'mainPurposeLabel',
                ],
                recordPath
            );
            validateBylot(record.bylot, `${recordPath}.bylot`);
            assertBoolean(
                record.otherPurposePresent,
                `${recordPath}.otherPurposePresent`
            );
            assertArray(record.otherPurposeSignals, `${recordPath}.otherPurposeSignals`);
            const signals = record.otherPurposeSignals;
            signals.forEach((signal, signalIndex) =>
                assertEnum(
                    signal,
                    [
                        'DETACHED_HOUSE',
                        'MULTI_UNIT_HOUSE',
                        'MULTIPLEX_HOUSE',
                        'ROW_HOUSE',
                        'APARTMENT',
                        'NEIGHBORHOOD_LIVING',
                    ],
                    `${recordPath}.otherPurposeSignals[${signalIndex}]`
                )
            );
            if (new Set(signals).size !== signals.length) {
                reject(`${recordPath}.otherPurposeSignals contains duplicates`);
            }
        });
        validateBoundedRecordEnvelope(value, value.records, path);
        return;
    }

    if (value.kind === 'BASIS') {
        assertExactKeys(
            value,
            ['kind', 'records', 'totalRecords', 'truncated', 'sanitizedDigest'],
            [],
            path
        );
        assertArray(value.records, `${path}.records`);
        value.records.forEach((record, index) => {
            const recordPath = `${path}.records[${index}]`;
            assertRecord(record, recordPath);
            assertExactKeys(
                record,
                ['bylot'],
                ['managementPkHash', 'upManagementPkHash'],
                recordPath
            );
            validateOptionalHashFields(
                record,
                ['managementPkHash', 'upManagementPkHash'],
                recordPath
            );
            validateBylot(record.bylot, `${recordPath}.bylot`);
        });
        validateBoundedRecordEnvelope(value, value.records, path);
        return;
    }

    if (value.kind === 'ATTACHED') {
        assertExactKeys(
            value,
            [
                'kind',
                'pairs',
                'rejected',
                'totalPairs',
                'pairsTruncated',
                'pairsDigest',
                'totalRejected',
                'rejectedDigest',
            ],
            [],
            path
        );
        assertArray(value.pairs, `${path}.pairs`);
        assertArray(value.rejected, `${path}.rejected`);
        if (value.pairs.length > MAX_INVENTORY_RECORDS) {
            reject(`${path}.pairs exceeds the sanitized bound`);
        }
        value.pairs.forEach((pair, index) => {
            const pairPath = `${path}.pairs[${index}]`;
            assertRecord(pair, pairPath);
            assertExactKeys(
                pair,
                ['basePnuHash', 'attachedPnuHash'],
                ['managementPkHash'],
                pairPath
            );
            validateOptionalHashFields(
                pair,
                ['managementPkHash', 'basePnuHash', 'attachedPnuHash'],
                pairPath
            );
        });
        assertCanonicalOrder(value.pairs, `${path}.pairs`);
        value.rejected.forEach((record, index) => {
            const recordPath = `${path}.rejected[${index}]`;
            assertRecord(record, recordPath);
            assertExactKeys(record, ['side', 'reason', 'count'], [], recordPath);
            assertEnum(record.side, ['BASE', 'ATTACHED', 'PAIR'], `${recordPath}.side`);
            if (record.side === 'PAIR') {
                assertEnum(
                    record.reason,
                    ['SELF_RELATION', 'DUPLICATE_PAIR'],
                    `${recordPath}.reason`
                );
            } else {
                assertEnum(
                    record.reason,
                    [
                        'MISSING_FIELD',
                        'INVALID_REGION_CODE',
                        'INVALID_PLAT_GB_CD',
                        'BLOCK_OR_NON_NUMERIC_JIBUN',
                    ],
                    `${recordPath}.reason`
                );
            }
            assertNonNegativeInteger(record.count, `${recordPath}.count`);
            if (record.count === 0) reject(`${recordPath}.count must be positive`);
        });
        assertCanonicalOrder(value.rejected, `${path}.rejected`);
        const rejectedKeys = value.rejected.map(
            (record) => `${String((record as JsonRecord).side)}|${String((record as JsonRecord).reason)}`
        );
        if (new Set(rejectedKeys).size !== rejectedKeys.length) {
            reject(`${path}.rejected contains duplicate producer reasons`);
        }
        assertNonNegativeInteger(value.totalPairs, `${path}.totalPairs`);
        assertBoolean(value.pairsTruncated, `${path}.pairsTruncated`);
        assertHash(value.pairsDigest, `${path}.pairsDigest`);
        assertNonNegativeInteger(value.totalRejected, `${path}.totalRejected`);
        assertHash(value.rejectedDigest, `${path}.rejectedDigest`);
        if (
            (!value.pairsTruncated && value.totalPairs !== value.pairs.length) ||
            (value.pairsTruncated && value.totalPairs <= value.pairs.length)
        ) {
            reject(`${path} pair count metadata is inconsistent`);
        }
        const rejectedTotal = value.rejected.reduce<number>(
            (sum, record) => sum + ((record as JsonRecord).count as number),
            0
        );
        if (value.totalRejected !== rejectedTotal) {
            reject(`${path}.totalRejected does not equal rejected count sum`);
        }
        if (value.rejectedDigest !== sanitizedDigest(value.rejected)) {
            reject(`${path}.rejectedDigest does not match producer contract`);
        }
        if (
            !value.pairsTruncated &&
            value.pairsDigest !== sanitizedDigest(value.pairs)
        ) {
            reject(`${path}.pairsDigest does not match producer contract`);
        }
        return;
    }

    const recordFieldsByKind: Record<
        string,
        { required: string[]; optional: string[]; hash: string[]; decimal: string[] }
    > = {
        EXPOS: {
            required: ['unitIdentityShape'],
            optional: [
                'managementPkHash',
                'upManagementPkHash',
                'unitIdentityHash',
                'floorHoIdentityHash',
                'dongIdentityHash',
                'mainAttachedTypeCode',
                'floorTypeCode',
                'floorShape',
                'area',
            ],
            hash: [
                'managementPkHash',
                'upManagementPkHash',
                'unitIdentityHash',
                'floorHoIdentityHash',
                'dongIdentityHash',
            ],
            decimal: ['area'],
        },
        LADFRL: {
            required: [],
            optional: ['pnuHash', 'landArea', 'landCategoryCode'],
            hash: ['pnuHash'],
            decimal: ['landArea'],
        },
        LDAREG: {
            required: [
                'unitIdentityShape',
                'quotaRatioState',
                'quotaRatioInput',
            ],
            optional: [
                'pnuHash',
                'aggregateBuildingSerialHash',
                'buildingNameHash',
                'unitIdentityHash',
                'floorHoIdentityHash',
                'dongIdentityHash',
                'quotaRatio',
                'classificationCode',
                'classificationLabel',
                'floorShape',
            ],
            hash: [
                'pnuHash',
                'aggregateBuildingSerialHash',
                'buildingNameHash',
                'unitIdentityHash',
                'floorHoIdentityHash',
                'dongIdentityHash',
            ],
            decimal: [],
        },
    };
    const shape = recordFieldsByKind[value.kind as string];
    if (!shape) reject(`${path}.kind is unsupported`);
    assertExactKeys(
        value,
        ['kind', 'records', 'totalRecords', 'truncated', 'sanitizedDigest'],
        [],
        path
    );
    assertArray(value.records, `${path}.records`);
    value.records.forEach((record, index) => {
        const recordPath = `${path}.records[${index}]`;
        assertRecord(record, recordPath);
        assertExactKeys(record, shape.required, shape.optional, recordPath);
        validateOptionalHashFields(record, shape.hash, recordPath);
        validateOptionalStringFields(
            record,
            shape.optional.filter(
                (field) => !shape.hash.includes(field) && !shape.decimal.includes(field)
            ),
            recordPath
        );
        for (const field of shape.decimal) {
            if (record[field] !== undefined) {
                assertDecimal(record[field], `${recordPath}.${field}`);
            }
        }
        if (value.kind === 'LDAREG' && record.quotaRatio !== undefined) {
            assertString(record.quotaRatio, `${recordPath}.quotaRatio`, 64);
            if (
                !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?\/(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(
                    record.quotaRatio
                )
            ) {
                reject(`${recordPath}.quotaRatio is invalid`);
            }
        }
        if (value.kind === 'LDAREG') {
            assertEnum(
                record.unitIdentityShape,
                ['DONG_FLOOR_HO', 'FLOOR_HO', 'INCOMPLETE'],
                `${recordPath}.unitIdentityShape`
            );
            assertEnum(
                record.quotaRatioState,
                ['VALID', 'MISSING', 'INVALID'],
                `${recordPath}.quotaRatioState`
            );
            if (
                (record.quotaRatioState === 'VALID') !==
                (record.quotaRatio !== undefined)
            ) {
                reject(`${recordPath}.quotaRatioState conflicts with quotaRatio`);
            }
            assertRecord(record.quotaRatioInput, `${recordPath}.quotaRatioInput`);
            assertExactKeys(
                record.quotaRatioInput,
                ['presence', 'jsonType', 'parseState', 'stringShape'],
                [],
                `${recordPath}.quotaRatioInput`
            );
            assertEnum(
                record.quotaRatioInput.presence,
                ['ABSENT', 'NULL', 'PRESENT'],
                `${recordPath}.quotaRatioInput.presence`
            );
            assertEnum(
                record.quotaRatioInput.jsonType,
                [
                    'undefined',
                    'null',
                    'string',
                    'number',
                    'boolean',
                    'object',
                    'array',
                ],
                `${recordPath}.quotaRatioInput.jsonType`
            );
            assertEnum(
                record.quotaRatioInput.parseState,
                ['VALID', 'MISSING', 'INVALID'],
                `${recordPath}.quotaRatioInput.parseState`
            );
            assertEnum(
                record.quotaRatioInput.stringShape,
                [
                    'NOT_APPLICABLE',
                    'EMPTY',
                    'NON_EMPTY',
                    'NOT_STRING',
                ],
                `${recordPath}.quotaRatioInput.stringShape`
            );
            const presenceTypeMatches =
                (record.quotaRatioInput.presence === 'ABSENT' &&
                    record.quotaRatioInput.jsonType === 'undefined') ||
                (record.quotaRatioInput.presence === 'NULL' &&
                    record.quotaRatioInput.jsonType === 'null') ||
                (record.quotaRatioInput.presence === 'PRESENT' &&
                    record.quotaRatioInput.jsonType !== 'undefined' &&
                    record.quotaRatioInput.jsonType !== 'null');
            const stringShapeMatches =
                ((record.quotaRatioInput.presence === 'ABSENT' ||
                    record.quotaRatioInput.presence === 'NULL') &&
                    record.quotaRatioInput.stringShape ===
                        'NOT_APPLICABLE' &&
                    record.quotaRatioInput.parseState === 'MISSING') ||
                (record.quotaRatioInput.presence === 'PRESENT' &&
                    record.quotaRatioInput.jsonType === 'string' &&
                    record.quotaRatioInput.parseState === 'MISSING' &&
                    record.quotaRatioInput.stringShape === 'EMPTY') ||
                (record.quotaRatioInput.presence === 'PRESENT' &&
                    record.quotaRatioInput.jsonType === 'string' &&
                    record.quotaRatioInput.parseState !== 'MISSING' &&
                    record.quotaRatioInput.stringShape === 'NON_EMPTY') ||
                (record.quotaRatioInput.presence === 'PRESENT' &&
                    record.quotaRatioInput.jsonType !== 'string' &&
                    record.quotaRatioInput.stringShape === 'NOT_STRING' &&
                    record.quotaRatioInput.parseState === 'INVALID');
            if (
                !presenceTypeMatches ||
                !stringShapeMatches ||
                record.quotaRatioInput.parseState !==
                    record.quotaRatioState ||
                (record.quotaRatioInput.parseState === 'MISSING' &&
                    record.quotaRatioInput.jsonType !== 'undefined' &&
                    record.quotaRatioInput.jsonType !== 'null' &&
                    record.quotaRatioInput.jsonType !== 'string')
            ) {
                reject(`${recordPath}.quotaRatioInput is inconsistent`);
            }
        } else if (value.kind === 'EXPOS') {
            assertEnum(
                record.unitIdentityShape,
                ['DONG_FLOOR_HO', 'FLOOR_HO', 'INCOMPLETE'],
                `${recordPath}.unitIdentityShape`
            );
        }
        if (
            (value.kind === 'EXPOS' || value.kind === 'LDAREG') &&
            ((record.unitIdentityShape !== 'INCOMPLETE') !==
                (record.unitIdentityHash !== undefined) ||
                (record.unitIdentityShape !== 'INCOMPLETE') !==
                    (record.floorHoIdentityHash !== undefined) ||
                (record.unitIdentityShape === 'DONG_FLOOR_HO') !==
                    (record.dongIdentityHash !== undefined))
        ) {
            reject(`${recordPath}.unitIdentityShape conflicts with hash`);
        }
    });
    validateBoundedRecordEnvelope(value, value.records, path);
}

function validateEndpoint(value: unknown, path: string): string {
    assertRecord(value, path);
    assertEnum(value.state, ['COMPLETE', 'COMPLETE_ZERO', 'FAILED', 'INCOMPLETE'], `${path}.state`);
    if (value.state === 'COMPLETE' || value.state === 'COMPLETE_ZERO') {
        assertExactKeys(
            value,
            ['endpoint', 'state', 'schemaHash', 'totalCount', 'pagesFetched', 'inventory'],
            [],
            path
        );
        assertNonNegativeInteger(value.totalCount, `${path}.totalCount`);
        assertNonNegativeInteger(value.pagesFetched, `${path}.pagesFetched`);
        if (value.state === 'COMPLETE_ZERO' && value.totalCount !== 0) {
            reject(`${path}.totalCount conflicts with COMPLETE_ZERO`);
        }
        if (value.state === 'COMPLETE' && value.totalCount === 0) {
            reject(`${path}.totalCount conflicts with COMPLETE`);
        }
    } else {
        assertExactKeys(
            value,
            ['endpoint', 'state', 'schemaHash', 'issue', 'inventory'],
            [],
            path
        );
        validateIssue(value.issue, `${path}.issue`);
    }
    assertEnum(value.endpoint, LAND_AREA_PHASE0_ENDPOINTS, `${path}.endpoint`);
    assertHash(value.schemaHash, `${path}.schemaHash`);
    validateInventory(value.inventory, value.endpoint, `${path}.inventory`);
    if (value.state === 'COMPLETE' || value.state === 'COMPLETE_ZERO') {
        const inventory = value.inventory as JsonRecord;
        const observedCount =
            inventory.kind === 'ATTACHED'
                ? (inventory.totalPairs as number) +
                  (inventory.totalRejected as number)
                : (inventory.totalRecords as number);
        if (value.totalCount !== observedCount) {
            reject(`${path}.totalCount does not match sanitized inventory`);
        }
    }
    return value.endpoint;
}

function validateBylotEvidence(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(
        value,
        ['records', 'totalRecords', 'truncated', 'sanitizedDigest'],
        [],
        path
    );
    assertArray(value.records, `${path}.records`);
    value.records.forEach((record, index) => {
        const recordPath = `${path}.records[${index}]`;
        assertRecord(record, recordPath);
        assertExactKeys(
            record,
            [
                'managementPkHash',
                'titleState',
                'basisState',
                'titleCount',
                'basisCount',
                'effectiveCount',
                'attachedPairCount',
                'titleBasisRelation',
            ],
            [],
            recordPath
        );
        assertHash(record.managementPkHash, `${recordPath}.managementPkHash`);
        assertEnum(
            record.titleState,
            ['RESOLVED', 'NO_VALID', 'CONFLICT', 'MISSING'],
            `${recordPath}.titleState`
        );
        assertEnum(
            record.basisState,
            ['RESOLVED', 'NO_VALID', 'CONFLICT', 'MISSING'],
            `${recordPath}.basisState`
        );
        assertNullableNonNegativeInteger(record.titleCount, `${recordPath}.titleCount`);
        assertNullableNonNegativeInteger(record.basisCount, `${recordPath}.basisCount`);
        assertNullableNonNegativeInteger(
            record.effectiveCount,
            `${recordPath}.effectiveCount`
        );
        assertNonNegativeInteger(
            record.attachedPairCount,
            `${recordPath}.attachedPairCount`
        );
        assertEnum(
            record.titleBasisRelation,
            ['MATCH', 'FALLBACK_AVAILABLE', 'MISMATCH', 'MISSING'],
            `${recordPath}.titleBasisRelation`
        );
    });
    validateBoundedRecordEnvelope(value, value.records, path);
}

function validateScopeBasisEvidence(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(
        value,
        [
            'status',
            'queries',
            'records',
            'totalRecords',
            'truncated',
            'sanitizedDigest',
        ],
        [],
        path
    );
    assertEnum(value.status, ['PASS', 'FAIL'], `${path}.status`);
    assertArray(value.queries, `${path}.queries`);
    if (
        value.queries.length === 0 ||
        value.queries.length > MAX_INVENTORY_RECORDS + 1
    ) {
        reject(`${path}.queries is outside the approved bound`);
    }
    const queryStates = new Map<
        string,
        {
            state:
                | 'COMPLETE'
                | 'COMPLETE_ZERO'
                | 'FAILED'
                | 'INCOMPLETE';
            totalCount: number;
        }
    >();
    value.queries.forEach((query, index) => {
        const queryPath = `${path}.queries[${index}]`;
        assertRecord(query, queryPath);
        assertEnum(
            query.state,
            ['COMPLETE', 'COMPLETE_ZERO', 'FAILED', 'INCOMPLETE'],
            `${queryPath}.state`
        );
        if (
            query.state === 'COMPLETE' ||
            query.state === 'COMPLETE_ZERO'
        ) {
            assertExactKeys(
                query,
                ['pnuHash', 'state', 'totalCount', 'pagesFetched'],
                [],
                queryPath
            );
            assertNonNegativeInteger(
                query.totalCount,
                `${queryPath}.totalCount`
            );
            assertNonNegativeInteger(
                query.pagesFetched,
                `${queryPath}.pagesFetched`
            );
            if (
                query.pagesFetched === 0 ||
                (query.state === 'COMPLETE_ZERO') !==
                    (query.totalCount === 0)
            ) {
                reject(`${queryPath} successful state is inconsistent`);
            }
        } else {
            assertExactKeys(
                query,
                ['pnuHash', 'state', 'issue'],
                [],
                queryPath
            );
            validateIssue(query.issue, `${queryPath}.issue`);
        }
        assertHash(query.pnuHash, `${queryPath}.pnuHash`);
        if (queryStates.has(query.pnuHash)) {
            reject(`${path}.queries contains duplicate PNU hashes`);
        }
        queryStates.set(query.pnuHash, {
            state: query.state as
                | 'COMPLETE'
                | 'COMPLETE_ZERO'
                | 'FAILED'
                | 'INCOMPLETE',
            totalCount:
                typeof query.totalCount === 'number'
                    ? query.totalCount
                    : 0,
        });
    });
    assertCanonicalOrder(value.queries, `${path}.queries`);

    assertArray(value.records, `${path}.records`);
    const observedCounts = new Map<string, number>();
    let exactIdentifiers = true;
    value.records.forEach((record, index) => {
        const recordPath = `${path}.records[${index}]`;
        assertRecord(record, recordPath);
        assertExactKeys(
            record,
            ['queryPnuHash', 'upIdentityState'],
            [
                'rowPnuHash',
                'selfManagementPkHash',
                'upManagementPkHash',
            ],
            recordPath
        );
        assertEnum(
            record.upIdentityState,
            ['ABSENT', 'VALID', 'INVALID'],
            `${recordPath}.upIdentityState`
        );
        for (const field of [
            'queryPnuHash',
            'rowPnuHash',
            'selfManagementPkHash',
            'upManagementPkHash',
        ] as const) {
            if (record[field] !== undefined) {
                assertHash(record[field], `${recordPath}.${field}`);
            }
        }
        if (
            (record.upIdentityState === 'VALID') !==
            (record.upManagementPkHash !== undefined)
        ) {
            reject(
                `${recordPath}.upIdentityState conflicts with up hash`
            );
        }
        const query = queryStates.get(record.queryPnuHash as string);
        if (
            !query ||
            (query.state !== 'COMPLETE' &&
                query.state !== 'COMPLETE_ZERO')
        ) {
            reject(`${recordPath} is not bound to a successful query`);
        }
        observedCounts.set(
            record.queryPnuHash as string,
            (observedCounts.get(record.queryPnuHash as string) ?? 0) +
                1
        );
        if (
            record.rowPnuHash !== record.queryPnuHash ||
            typeof record.selfManagementPkHash !== 'string' ||
            record.upIdentityState === 'INVALID'
        ) {
            exactIdentifiers = false;
        }
    });
    assertCanonicalOrder(value.records, `${path}.records`);
    validateBoundedRecordEnvelope(value, value.records, path);
    if (
        value.totalRecords !==
        [...queryStates.values()].reduce(
            (sum, query) => sum + query.totalCount,
            0
        )
    ) {
        reject(`${path}.totalRecords does not match query totals`);
    }
    if (
        !value.truncated &&
        value.sanitizedDigest !== sanitizedDigest(value.records)
    ) {
        reject(
            `${path}.sanitizedDigest does not match producer contract`
        );
    }
    const allQueriesSuccessful = [...queryStates.values()].every(
        (query) =>
            query.state === 'COMPLETE' ||
            query.state === 'COMPLETE_ZERO'
    );
    const countsExact =
        !value.truncated &&
        [...queryStates].every(
            ([pnuHash, query]) =>
                (observedCounts.get(pnuHash) ?? 0) ===
                query.totalCount
        );
    const shouldPass =
        allQueriesSuccessful &&
        countsExact &&
        exactIdentifiers &&
        value.truncated === false;
    if ((value.status === 'PASS') !== shouldPass) {
        reject(`${path}.status is inconsistent`);
    }
}

function validateScopeExposEvidence(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(
        value,
        [
            'status',
            'queries',
            'records',
            'totalRecords',
            'truncated',
            'sanitizedDigest',
        ],
        [],
        path
    );
    assertEnum(value.status, ['PASS', 'FAIL'], `${path}.status`);
    assertArray(value.queries, `${path}.queries`);
    if (
        value.queries.length === 0 ||
        value.queries.length > MAX_INVENTORY_RECORDS + 1
    ) {
        reject(`${path}.queries is outside the approved bound`);
    }
    const queryStates = new Map<
        string,
        {
            state: 'COMPLETE' | 'COMPLETE_ZERO' | 'FAILED' | 'INCOMPLETE';
            totalCount: number;
        }
    >();
    value.queries.forEach((query, index) => {
        const queryPath = `${path}.queries[${index}]`;
        assertRecord(query, queryPath);
        assertEnum(
            query.state,
            ['COMPLETE', 'COMPLETE_ZERO', 'FAILED', 'INCOMPLETE'],
            `${queryPath}.state`
        );
        if (query.state === 'COMPLETE' || query.state === 'COMPLETE_ZERO') {
            assertExactKeys(
                query,
                ['pnuHash', 'state', 'totalCount', 'pagesFetched'],
                [],
                queryPath
            );
            assertNonNegativeInteger(
                query.totalCount,
                `${queryPath}.totalCount`
            );
            assertNonNegativeInteger(
                query.pagesFetched,
                `${queryPath}.pagesFetched`
            );
            if (
                query.pagesFetched === 0 ||
                (query.state === 'COMPLETE_ZERO') !==
                    (query.totalCount === 0)
            ) {
                reject(`${queryPath} successful state is inconsistent`);
            }
        } else {
            assertExactKeys(
                query,
                ['pnuHash', 'state', 'issue'],
                [],
                queryPath
            );
            validateIssue(query.issue, `${queryPath}.issue`);
        }
        assertHash(query.pnuHash, `${queryPath}.pnuHash`);
        if (queryStates.has(query.pnuHash)) {
            reject(`${path}.queries contains duplicate PNU hashes`);
        }
        queryStates.set(query.pnuHash, {
            state: query.state as
                | 'COMPLETE'
                | 'COMPLETE_ZERO'
                | 'FAILED'
                | 'INCOMPLETE',
            totalCount:
                typeof query.totalCount === 'number'
                    ? query.totalCount
                    : 0,
        });
    });
    assertCanonicalOrder(value.queries, `${path}.queries`);

    assertArray(value.records, `${path}.records`);
    const observedCounts = new Map<string, number>();
    let exactIdentifiers = true;
    value.records.forEach((record, index) => {
        const recordPath = `${path}.records[${index}]`;
        assertRecord(record, recordPath);
        assertExactKeys(
            record,
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
            ],
            recordPath
        );
        for (const field of [
            'queryPnuHash',
            'rowPnuHash',
            'selfManagementPkHash',
            'rootManagementPkHash',
            'rawUpManagementPkHash',
            'unitIdentityHash',
            'floorHoIdentityHash',
            'dongIdentityHash',
        ] as const) {
            if (record[field] !== undefined) {
                assertHash(record[field], `${recordPath}.${field}`);
            }
        }
        assertEnum(
            record.unitIdentityShape,
            ['DONG_FLOOR_HO', 'FLOOR_HO', 'INCOMPLETE'],
            `${recordPath}.unitIdentityShape`
        );
        if (record.rootIdentitySource !== undefined) {
            assertEnum(
                record.rootIdentitySource,
                ['SELF', 'RAW_UP', 'BASIS_UNIQUE'],
                `${recordPath}.rootIdentitySource`
            );
        }
        if (
            (record.unitIdentityShape !== 'INCOMPLETE') !==
                (record.unitIdentityHash !== undefined) ||
            (record.unitIdentityShape !== 'INCOMPLETE') !==
                (record.floorHoIdentityHash !== undefined) ||
            (record.unitIdentityShape === 'DONG_FLOOR_HO') !==
                (record.dongIdentityHash !== undefined)
        ) {
            reject(`${recordPath}.unitIdentityShape conflicts with hash`);
        }
        const hasResolvedRoot =
            typeof record.rootManagementPkHash === 'string';
        if (
            hasResolvedRoot !==
                (typeof record.rootIdentitySource === 'string') ||
            (record.rootIdentitySource === 'SELF' &&
                (record.rootManagementPkHash !==
                    record.selfManagementPkHash ||
                    record.rawUpManagementPkHash !== undefined)) ||
            (record.rootIdentitySource === 'RAW_UP' &&
                (typeof record.rawUpManagementPkHash !== 'string' ||
                    record.rootManagementPkHash !==
                        record.rawUpManagementPkHash)) ||
            (record.rootIdentitySource === 'BASIS_UNIQUE' &&
                record.rawUpManagementPkHash !== undefined)
        ) {
            reject(`${recordPath}.root identity provenance is inconsistent`);
        }
        const query = queryStates.get(record.queryPnuHash as string);
        if (
            !query ||
            (query.state !== 'COMPLETE' &&
                query.state !== 'COMPLETE_ZERO')
        ) {
            reject(`${recordPath} is not bound to a successful query`);
        }
        observedCounts.set(
            record.queryPnuHash as string,
            (observedCounts.get(record.queryPnuHash as string) ?? 0) + 1
        );
        if (
            record.rowPnuHash !== record.queryPnuHash ||
            typeof record.selfManagementPkHash !== 'string' ||
            typeof record.rootManagementPkHash !== 'string' ||
            typeof record.rootIdentitySource !== 'string'
        ) {
            exactIdentifiers = false;
        }
    });
    assertCanonicalOrder(value.records, `${path}.records`);
    validateBoundedRecordEnvelope(value, value.records, path);
    if (
        value.totalRecords !==
        [...queryStates.values()].reduce(
            (sum, query) => sum + query.totalCount,
            0
        )
    ) {
        reject(`${path}.totalRecords does not match query totals`);
    }
    if (
        !value.truncated &&
        value.sanitizedDigest !== sanitizedDigest(value.records)
    ) {
        reject(`${path}.sanitizedDigest does not match producer contract`);
    }
    const allQueriesSuccessful = [...queryStates.values()].every(
        (query) =>
            query.state === 'COMPLETE' ||
            query.state === 'COMPLETE_ZERO'
    );
    const countsExact =
        !value.truncated &&
        [...queryStates].every(
            ([pnuHash, query]) =>
                (observedCounts.get(pnuHash) ?? 0) === query.totalCount
        );
    const shouldPass =
        allQueriesSuccessful &&
        countsExact &&
        exactIdentifiers &&
        value.truncated === false;
    if ((value.status === 'PASS') !== shouldPass) {
        reject(`${path}.status is inconsistent`);
    }
}

function resolvedScopeExposRecords(
    value: JsonRecord
): JsonRecord[] | null {
    if (value.status !== 'PASS' || value.truncated !== false) {
        return null;
    }
    const records = value.records as JsonRecord[];
    const representativeByKey = new Map<string, JsonRecord>();
    const maxMultiplicityByKey = new Map<string, number>();
    const localMultiplicityByPnu = new Map<
        string,
        Map<string, number>
    >();

    for (const record of records) {
        if (
            record.rowPnuHash !== record.queryPnuHash ||
            typeof record.selfManagementPkHash !== 'string' ||
            typeof record.rootManagementPkHash !== 'string' ||
            typeof record.rootIdentitySource !== 'string' ||
            record.unitIdentityShape === 'INCOMPLETE' ||
            typeof record.unitIdentityHash !== 'string' ||
            typeof record.floorHoIdentityHash !== 'string'
        ) {
            return null;
        }
        const key = stableStringify({
            rootManagementPkHash: record.rootManagementPkHash,
            selfManagementPkHash: record.selfManagementPkHash,
            unitIdentityShape: record.unitIdentityShape,
            unitIdentityHash: record.unitIdentityHash,
            floorHoIdentityHash: record.floorHoIdentityHash,
            dongIdentityHash: record.dongIdentityHash ?? null,
        });
        representativeByKey.set(
            key,
            representativeByKey.get(key) ?? record
        );
        const queryPnuHash = record.queryPnuHash as string;
        const local =
            localMultiplicityByPnu.get(queryPnuHash) ??
            new Map<string, number>();
        local.set(key, (local.get(key) ?? 0) + 1);
        localMultiplicityByPnu.set(queryPnuHash, local);
    }
    for (const local of localMultiplicityByPnu.values()) {
        for (const [key, count] of local) {
            maxMultiplicityByKey.set(
                key,
                Math.max(maxMultiplicityByKey.get(key) ?? 0, count)
            );
        }
    }
    return [...representativeByKey.keys()]
        .sort()
        .flatMap((key) =>
            Array.from(
                { length: maxMultiplicityByKey.get(key) ?? 0 },
                () => representativeByKey.get(key)!
            )
        );
}

function hasExactUniqueSetMatch(
    left: string[],
    right: string[]
): boolean {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return (
        left.length > 0 &&
        leftSet.size === left.length &&
        rightSet.size === right.length &&
        leftSet.size === rightSet.size &&
        [...leftSet].every((value) => rightSet.has(value))
    );
}

function hasLdaregExposUnitCorrelation(
    exposRecords: JsonRecord[] | null,
    validLdaregRecords: JsonRecord[],
    missingLdaregRecords: JsonRecord[]
): boolean {
    if (exposRecords === null) return false;
    const correlatedLdaregRecords = [
        ...validLdaregRecords,
        ...missingLdaregRecords,
    ];
    const allUnitComplete =
        exposRecords.every(
            (record) =>
                record.unitIdentityShape !== 'INCOMPLETE' &&
                typeof record.unitIdentityHash === 'string' &&
                typeof record.floorHoIdentityHash === 'string'
        ) &&
        correlatedLdaregRecords.every(
            (record) =>
                record.unitIdentityShape !== 'INCOMPLETE' &&
                typeof record.unitIdentityHash === 'string' &&
                typeof record.floorHoIdentityHash === 'string'
        );
    if (!allUnitComplete) return false;

    const exposFullHashes = exposRecords.map(
        (record) => record.unitIdentityHash as string
    );
    const validFullHashes = validLdaregRecords.map(
        (record) => record.unitIdentityHash as string
    );
    const missingFullHashes = missingLdaregRecords.map(
        (record) => record.unitIdentityHash as string
    );
    const exposFullSet = new Set(exposFullHashes);
    if (
        hasExactUniqueSetMatch(exposFullHashes, validFullHashes) &&
        new Set(missingFullHashes).size === missingFullHashes.length &&
        missingFullHashes.every((hash) => !exposFullSet.has(hash))
    ) {
        return true;
    }

    const roots = new Set(
        exposRecords.map((record) => record.rootManagementPkHash)
    );
    if (
        roots.size !== 1 ||
        roots.has(undefined) ||
        correlatedLdaregRecords.length === 0
    ) {
        return false;
    }
    const exposFloorHoHashes = exposRecords.map(
        (record) => record.floorHoIdentityHash as string
    );
    const validFloorHoHashes = validLdaregRecords.map(
        (record) => record.floorHoIdentityHash as string
    );
    const missingFloorHoHashes = missingLdaregRecords.map(
        (record) => record.floorHoIdentityHash as string
    );
    const exposFloorHoSet = new Set(exposFloorHoHashes);
    if (
        !hasExactUniqueSetMatch(
            exposFloorHoHashes,
            validFloorHoHashes
        ) ||
        new Set(missingFloorHoHashes).size !==
            missingFloorHoHashes.length ||
        missingFloorHoHashes.some((hash) =>
            exposFloorHoSet.has(hash)
        )
    ) {
        return false;
    }

    const exposHasDong = exposRecords.every(
        (record) => record.unitIdentityShape === 'DONG_FLOOR_HO'
    );
    const exposOmitsDong = exposRecords.every(
        (record) => record.unitIdentityShape === 'FLOOR_HO'
    );
    const ldaregHasDong = correlatedLdaregRecords.every(
        (record) => record.unitIdentityShape === 'DONG_FLOOR_HO'
    );
    const ldaregOmitsDong = correlatedLdaregRecords.every(
        (record) => record.unitIdentityShape === 'FLOOR_HO'
    );
    if (
        !(
            (exposHasDong && ldaregOmitsDong) ||
            (exposOmitsDong && ldaregHasDong)
        )
    ) {
        return false;
    }
    const dongSide = exposHasDong
        ? exposRecords
        : correlatedLdaregRecords;
    const dongHashes = dongSide
        .map((record) => record.dongIdentityHash)
        .filter((hash): hash is string => typeof hash === 'string');
    if (
        dongHashes.length !== dongSide.length ||
        new Set(dongHashes).size !== 1
    ) {
        return false;
    }

    const aggregateHashes = correlatedLdaregRecords
        .map((record) => record.aggregateBuildingSerialHash)
        .filter((hash): hash is string => typeof hash === 'string');
    const buildingNameHashes = correlatedLdaregRecords
        .map((record) => record.buildingNameHash)
        .filter((hash): hash is string => typeof hash === 'string');
    return (
        aggregateHashes.length === correlatedLdaregRecords.length &&
        new Set(aggregateHashes).size === 1 &&
        buildingNameHashes.length === correlatedLdaregRecords.length &&
        new Set(buildingNameHashes).size === 1
    );
}

function validateEvidence(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(
        value,
        [
            'bylotByManagementPk',
            'scopeLadfrl',
            'scopeBasis',
            'scopeExpos',
            'ldaregReplication',
        ],
        [],
        path
    );
    validateBylotEvidence(
        value.bylotByManagementPk,
        `${path}.bylotByManagementPk`
    );

    assertRecord(value.scopeLadfrl, `${path}.scopeLadfrl`);
    assertExactKeys(
        value.scopeLadfrl,
        ['status', 'records', 'totalArea'],
        [],
        `${path}.scopeLadfrl`
    );
    assertEnum(
        value.scopeLadfrl.status,
        ['PASS', 'FAIL'],
        `${path}.scopeLadfrl.status`
    );
    assertArray(value.scopeLadfrl.records, `${path}.scopeLadfrl.records`);
    value.scopeLadfrl.records.forEach((record, index) => {
        const recordPath = `${path}.scopeLadfrl.records[${index}]`;
        assertRecord(record, recordPath);
        assertExactKeys(record, ['pnuHash', 'area'], [], recordPath);
        assertHash(record.pnuHash, `${recordPath}.pnuHash`);
        assertDecimal(record.area, `${recordPath}.area`);
    });
    assertNullableDecimal(
        value.scopeLadfrl.totalArea,
        `${path}.scopeLadfrl.totalArea`
    );
    if (
        (value.scopeLadfrl.status === 'PASS') !==
        (value.scopeLadfrl.totalArea !== null)
    ) {
        reject(`${path}.scopeLadfrl status is inconsistent`);
    }

    validateScopeBasisEvidence(
        value.scopeBasis,
        `${path}.scopeBasis`
    );
    validateScopeExposEvidence(
        value.scopeExpos,
        `${path}.scopeExpos`
    );

    assertRecord(value.ldaregReplication, `${path}.ldaregReplication`);
    assertExactKeys(
        value.ldaregReplication,
        [
            'status',
            'canonicalSourcePnuHash',
            'comparedPnuHashes',
            'rowCount',
            'rowMultisetDigest',
        ],
        [],
        `${path}.ldaregReplication`
    );
    assertEnum(
        value.ldaregReplication.status,
        ['PASS', 'FAIL', 'NOT_APPLICABLE'],
        `${path}.ldaregReplication.status`
    );
    assertHash(
        value.ldaregReplication.canonicalSourcePnuHash,
        `${path}.ldaregReplication.canonicalSourcePnuHash`
    );
    assertHashArray(
        value.ldaregReplication.comparedPnuHashes,
        `${path}.ldaregReplication.comparedPnuHashes`
    );
    assertNullableNonNegativeInteger(
        value.ldaregReplication.rowCount,
        `${path}.ldaregReplication.rowCount`
    );
    assertNullableHash(
        value.ldaregReplication.rowMultisetDigest,
        `${path}.ldaregReplication.rowMultisetDigest`
    );
    const replicationHasResult =
        value.ldaregReplication.rowCount !== null &&
        value.ldaregReplication.rowMultisetDigest !== null;
    if (
        (value.ldaregReplication.status === 'PASS') !== replicationHasResult ||
        (value.ldaregReplication.status === 'NOT_APPLICABLE' &&
            replicationHasResult)
    ) {
        reject(`${path}.ldaregReplication status is inconsistent`);
    }
}

function validateChecks(value: unknown, path: string): void {
    assertRecord(value, path);
    assertExactKeys(value, ['titleBasis', 'bylotAttached'], [], path);
    assertRecord(value.titleBasis, `${path}.titleBasis`);
    assertExactKeys(value.titleBasis, ['status'], [], `${path}.titleBasis`);
    assertEnum(
        value.titleBasis.status,
        ['PASS', 'FAIL'],
        `${path}.titleBasis.status`
    );
    assertRecord(value.bylotAttached, `${path}.bylotAttached`);
    assertExactKeys(
        value.bylotAttached,
        ['status', 'matchedManagementPkHashes'],
        [],
        `${path}.bylotAttached`
    );
    assertEnum(
        value.bylotAttached.status,
        ['PASS', 'FAIL'],
        `${path}.bylotAttached.status`
    );
    const hashes = value.bylotAttached.matchedManagementPkHashes;
    assertRecord(hashes, `${path}.bylotAttached.matchedManagementPkHashes`);
    assertExactKeys(
        hashes,
        ['records', 'totalRecords', 'truncated', 'sanitizedDigest'],
        [],
        `${path}.bylotAttached.matchedManagementPkHashes`
    );
    assertHashArray(
        hashes.records,
        `${path}.bylotAttached.matchedManagementPkHashes.records`
    );
    validateBoundedRecordEnvelope(
        hashes,
        hashes.records,
        `${path}.bylotAttached.matchedManagementPkHashes`
    );
}

function exactHousingFamily(
    titleRecords: JsonRecord[]
): 'LADFRL' | 'LDAREG' | null {
    if (titleRecords.length === 0) return null;
    const sameExactPair = (
        registryTypeCode: string,
        mainPurposeCode: string,
        mainPurposeLabel: string,
        expectedSignal: string,
        requiredSignal: boolean
    ): boolean =>
        titleRecords.every(
            (record) =>
                record.registryTypeCode === registryTypeCode &&
                record.mainPurposeCode === mainPurposeCode &&
                record.mainPurposeLabel === mainPurposeLabel &&
                Array.isArray(record.otherPurposeSignals) &&
                record.otherPurposeSignals.every(
                    (signal) => signal === expectedSignal
                ) &&
                (!requiredSignal ||
                    record.otherPurposeSignals.includes(expectedSignal))
        );
    if (
        sameExactPair(
            '1',
            '01000',
            '단독주택',
            'DETACHED_HOUSE',
            false
        ) ||
        sameExactPair(
            '1',
            '01002',
            '다가구주택',
            'MULTI_UNIT_HOUSE',
            false
        )
    ) {
        return 'LADFRL';
    }
    if (
        sameExactPair(
            '2',
            '02003',
            '다세대주택',
            'MULTIPLEX_HOUSE',
            false
        ) ||
        sameExactPair(
            '2',
            '02000',
            '공동주택',
            'MULTIPLEX_HOUSE',
            true
        )
    ) {
        return 'LDAREG';
    }
    return null;
}

function requireExpectedHousingFamily(
    sample: JsonRecord,
    expectedFamily: LandAreaPhase0ExpectedFamily,
    path: string
): void {
    const endpoints = sample.endpoints as JsonRecord[];
    const titleEndpoint = endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrTitleInfo'
    )!;
    const titleInventory = titleEndpoint.inventory as JsonRecord;
    const titleRecords = titleInventory.records as JsonRecord[];
    const titleRootHashes = new Set(
        titleRecords
            .map((record) => record.managementPkHash)
            .filter((hash): hash is string => typeof hash === 'string')
    );
    const actualFamily =
        titleRootHashes.size === 1
            ? exactHousingFamily(titleRecords)
            : null;
    const hasMismatchCode = (
        sample.failureCodes as string[]
    ).includes('HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH');
    if (
        hasMismatchCode !==
        (actualFamily === null || actualFamily !== expectedFamily)
    ) {
        reject(
            `${path}.failureCodes conflicts with manifest housing family`
        );
    }
}

function deriveScopeBasisParentMap(
    titleRecords: JsonRecord[],
    basisRecords: JsonRecord[]
): {
    valid: boolean;
    titleHashes: Set<string>;
    parentByChild: Map<string, string>;
} {
    const titleHashes = new Set(
        titleRecords
            .map((record) => record.managementPkHash)
            .filter((hash): hash is string => typeof hash === 'string')
    );
    const parentsByChild = new Map<string, Set<string>>();
    let valid = titleHashes.size > 0;
    for (const record of basisRecords) {
        const self = record.selfManagementPkHash;
        const parent = record.upManagementPkHash;
        if (typeof self !== 'string') {
            valid = false;
            continue;
        }
        if (record.upIdentityState === 'INVALID') {
            valid = false;
            continue;
        }
        // 설계 §10.4: title self row의 higher-up lineage는 child root가 아니다.
        if (titleHashes.has(self)) continue;
        if (
            typeof parent !== 'string' ||
            !titleHashes.has(parent)
        ) {
            valid = false;
            continue;
        }
        const parents = parentsByChild.get(self) ?? new Set<string>();
        parents.add(parent);
        parentsByChild.set(self, parents);
    }
    const parentByChild = new Map<string, string>();
    for (const [child, parents] of parentsByChild) {
        if (parents.size !== 1) {
            valid = false;
            continue;
        }
        parentByChild.set(child, [...parents][0]);
    }
    return { valid, titleHashes, parentByChild };
}

function validateScopeExposRootProvenance(
    titleRecords: JsonRecord[],
    basisRecords: JsonRecord[],
    scopeRecords: JsonRecord[],
    path: string
): void {
    const closure = deriveScopeBasisParentMap(
        titleRecords,
        basisRecords
    );

    scopeRecords.forEach((record, index) => {
        if (record.rootIdentitySource === undefined) return;
        const recordPath = `${path}[${index}]`;
        const self = record.selfManagementPkHash;
        const source = record.rootIdentitySource;
        if (typeof self !== 'string') {
            reject(`${recordPath} root provenance lacks self identity`);
        }
        const isTitleRoot = closure.titleHashes.has(self);
        const expectedRoot = isTitleRoot
            ? self
            : closure.parentByChild.get(self);
        const expectedSource =
            isTitleRoot
                ? record.rawUpManagementPkHash === undefined
                    ? 'SELF'
                    : 'RAW_UP'
                : record.rawUpManagementPkHash === undefined
                  ? 'BASIS_UNIQUE'
                  : 'RAW_UP';
        if (
            typeof expectedRoot !== 'string' ||
            record.rootManagementPkHash !== expectedRoot ||
            source !== expectedSource ||
            (source === 'RAW_UP' &&
                record.rawUpManagementPkHash !== expectedRoot)
        ) {
            reject(
                `${recordPath} root provenance is outside exact title/basis closure`
            );
        }
    });
}

function validateBaseExposScopeBinding(
    samplePnuHash: string,
    exposInventory: JsonRecord,
    scopeRecords: JsonRecord[],
    path: string
): void {
    if (exposInventory.truncated === true) return;
    const inventoryRecords = exposInventory.records as JsonRecord[];
    const baseScopeRecords = scopeRecords.filter(
        (record) =>
            record.queryPnuHash === samplePnuHash &&
            record.rowPnuHash === samplePnuHash
    );
    const inventoryKeys = inventoryRecords.map((record) =>
        stableStringify({
            selfManagementPkHash: record.managementPkHash ?? null,
            rawUpManagementPkHash:
                record.upManagementPkHash ?? null,
            unitIdentityShape: record.unitIdentityShape,
            unitIdentityHash: record.unitIdentityHash ?? null,
            floorHoIdentityHash:
                record.floorHoIdentityHash ?? null,
            dongIdentityHash: record.dongIdentityHash ?? null,
        })
    );
    const scopeKeys = baseScopeRecords.map((record) =>
        stableStringify({
            selfManagementPkHash:
                record.selfManagementPkHash ?? null,
            rawUpManagementPkHash:
                record.rawUpManagementPkHash ?? null,
            unitIdentityShape: record.unitIdentityShape,
            unitIdentityHash: record.unitIdentityHash ?? null,
            floorHoIdentityHash:
                record.floorHoIdentityHash ?? null,
            dongIdentityHash: record.dongIdentityHash ?? null,
        })
    );
    inventoryKeys.sort();
    scopeKeys.sort();
    if (
        inventoryKeys.length !== scopeKeys.length ||
        inventoryKeys.some(
            (key, index) => key !== scopeKeys[index]
        )
    ) {
        reject(`${path} is not exactly bound to base EXPOS inventory`);
    }
}

function validateBaseBasisScopeBinding(
    samplePnuHash: string,
    basisInventory: JsonRecord,
    scopeRecords: JsonRecord[],
    path: string
): void {
    if (basisInventory.truncated === true) return;
    const inventoryRecords = basisInventory.records as JsonRecord[];
    const baseScopeRecords = scopeRecords.filter(
        (record) =>
            record.queryPnuHash === samplePnuHash &&
            record.rowPnuHash === samplePnuHash
    );
    const inventoryKeys = inventoryRecords.map((record) =>
        stableStringify({
            selfManagementPkHash:
                record.managementPkHash ?? null,
            upManagementPkHash:
                record.upManagementPkHash ?? null,
        })
    );
    const scopeKeys = baseScopeRecords.map((record) =>
        stableStringify({
            selfManagementPkHash:
                record.selfManagementPkHash ?? null,
            upManagementPkHash:
                record.upManagementPkHash ?? null,
        })
    );
    inventoryKeys.sort();
    scopeKeys.sort();
    if (
        inventoryKeys.length !== scopeKeys.length ||
        inventoryKeys.some(
            (key, index) => key !== scopeKeys[index]
        )
    ) {
        reject(`${path} is not exactly bound to base BASIS inventory`);
    }
}

function requireSemanticFailureCodes(sample: JsonRecord, path: string): void {
    const required = new Set<string>();
    const requiredReview = new Set<string>();
    const endpoints = sample.endpoints as JsonRecord[];
    const endpointByName = (name: string): JsonRecord =>
        endpoints.find((endpoint) => endpoint.endpoint === name)!;
    const titleInventory = endpointByName('getBrTitleInfo')
        .inventory as JsonRecord;
    const titleInventoryRecords = titleInventory.records as JsonRecord[];
    const titleRootHashes = new Set(
        titleInventoryRecords
            .map((record) => record.managementPkHash)
            .filter((hash): hash is string => typeof hash === 'string')
    );
    const ldaregApplicable =
        titleRootHashes.size === 1 &&
        exactHousingFamily(titleInventoryRecords) === 'LDAREG';
    for (const endpoint of endpoints) {
        const isNonApplicableLdareg =
            !ldaregApplicable &&
            endpoint.endpoint === 'ldaregList';
        if (!isNonApplicableLdareg && endpoint.state === 'FAILED')
            required.add('SCAN_FAILED');
        if (!isNonApplicableLdareg && endpoint.state === 'INCOMPLETE')
            required.add('SCAN_INCOMPLETE');
        const inventory = endpoint.inventory as JsonRecord;
        if (
            inventory.truncated === true ||
            inventory.pairsTruncated === true
        ) {
            required.add('CAPTURE_INVENTORY_TRUNCATED');
        }
        if (
            inventory.kind === 'ATTACHED' &&
            (inventory.totalRejected as number) > 0
        ) {
            required.add('ATTACHED_ROWS_REJECTED');
        }
    }

    const evidence = sample.evidence as JsonRecord;
    const bylotEvidence = evidence.bylotByManagementPk as JsonRecord;
    const scopeLadfrl = evidence.scopeLadfrl as JsonRecord;
    const scopeBasis = evidence.scopeBasis as JsonRecord;
    const scopeExpos = evidence.scopeExpos as JsonRecord;
    const ldaregReplication = evidence.ldaregReplication as JsonRecord;
    const checks = sample.checks as JsonRecord;
    const titleBasis = checks.titleBasis as JsonRecord;
    const bylotAttached = checks.bylotAttached as JsonRecord;
    const matchedHashes =
        bylotAttached.matchedManagementPkHashes as JsonRecord;

    if (
        (ldaregApplicable &&
            ldaregReplication.status === 'NOT_APPLICABLE') ||
        (!ldaregApplicable &&
            ldaregReplication.status !== 'NOT_APPLICABLE')
    ) {
        reject(`${path}.ldaregReplication applicability is inconsistent`);
    }
    const scopeExposQueryHashes = (
        scopeExpos.queries as JsonRecord[]
    ).map((query) => query.pnuHash as string);
    const scopeBasisQueryHashes = (
        scopeBasis.queries as JsonRecord[]
    ).map((query) => query.pnuHash as string);
    const comparedPnuHashes =
        ldaregReplication.comparedPnuHashes as string[];
    if (
        new Set(scopeExposQueryHashes).size !==
            scopeExposQueryHashes.length ||
        scopeExposQueryHashes.length !== comparedPnuHashes.length ||
        scopeExposQueryHashes.some(
            (hash) => !comparedPnuHashes.includes(hash)
        )
    ) {
        reject(`${path}.scopeExpos does not bind to the LDAREG scope`);
    }
    if (
        new Set(scopeBasisQueryHashes).size !==
            scopeBasisQueryHashes.length ||
        scopeBasisQueryHashes.length !== scopeExposQueryHashes.length ||
        scopeBasisQueryHashes.some(
            (hash) => !scopeExposQueryHashes.includes(hash)
        )
    ) {
        reject(
            `${path}.scopeBasis does not bind to the captured parcel scope`
        );
    }
    const attachedInventory = endpointByName(
        'getBrAtchJibunInfo'
    ).inventory as JsonRecord;
    if (attachedInventory.pairsTruncated === false) {
        const expectedScopeHashes = new Set<string>([
            sample.pnuHash as string,
        ]);
        for (const pair of attachedInventory.pairs as JsonRecord[]) {
            if (pair.basePnuHash === sample.pnuHash) {
                expectedScopeHashes.add(
                    pair.attachedPnuHash as string
                );
            }
        }
        if (
            scopeBasisQueryHashes.length !==
                expectedScopeHashes.size ||
            scopeBasisQueryHashes.some(
                (hash) => !expectedScopeHashes.has(hash)
            )
        ) {
            reject(
                `${path}.scopeBasis does not cover the exact base/attached parcel scope`
            );
        }
    }

    if (bylotEvidence.truncated === true || matchedHashes.truncated === true) {
        required.add('CAPTURE_INVENTORY_TRUNCATED');
    }
    if (scopeExpos.truncated === true) {
        required.add('CAPTURE_INVENTORY_TRUNCATED');
    }
    if (scopeBasis.truncated === true) {
        required.add('CAPTURE_INVENTORY_TRUNCATED');
    }
    for (const query of scopeBasis.queries as JsonRecord[]) {
        if (query.state === 'FAILED') required.add('SCAN_FAILED');
        if (query.state === 'INCOMPLETE')
            required.add('SCAN_INCOMPLETE');
    }
    for (const query of scopeExpos.queries as JsonRecord[]) {
        if (query.state === 'FAILED') required.add('SCAN_FAILED');
        if (query.state === 'INCOMPLETE')
            required.add('SCAN_INCOMPLETE');
    }
    const scopeExposRecords = scopeExpos.records as JsonRecord[];
    const scopeBasisRecords = scopeBasis.records as JsonRecord[];
    if (
        scopeBasisRecords.some(
            (record) =>
                typeof record.selfManagementPkHash !== 'string' ||
                record.upIdentityState === 'INVALID'
        )
    ) {
        required.add('BASIS_PK_INVALID');
    }
    if (
        scopeBasisRecords.some(
            (record) =>
                record.rowPnuHash !== record.queryPnuHash
        )
    ) {
        required.add('BASIS_PNU_EXACT_MISMATCH');
    }
    const scopeBasisClosure = deriveScopeBasisParentMap(
        titleInventoryRecords,
        scopeBasisRecords
    );
    validateBaseBasisScopeBinding(
        sample.pnuHash as string,
        endpointByName('getBrBasisOulnInfo').inventory as JsonRecord,
        scopeBasisRecords,
        `${path}.evidence.scopeBasis`
    );
    validateScopeExposRootProvenance(
        titleInventoryRecords,
        scopeBasisRecords,
        scopeExposRecords,
        `${path}.evidence.scopeExpos.records`
    );
    validateBaseExposScopeBinding(
        sample.pnuHash as string,
        endpointByName('getBrExposInfo').inventory as JsonRecord,
        scopeExposRecords,
        `${path}.evidence.scopeExpos`
    );
    if (
        scopeExposRecords.some(
            (record) =>
                typeof record.selfManagementPkHash !== 'string' ||
                typeof record.rootManagementPkHash !== 'string' ||
                typeof record.rootIdentitySource !== 'string'
        )
    ) {
        required.add('EXPOS_PK_INVALID');
    }
    if (
        scopeExposRecords.some(
            (record) =>
                record.rowPnuHash !== record.queryPnuHash
        )
    ) {
        required.add('EXPOS_PNU_EXACT_MISMATCH');
    }
    if (scopeLadfrl.status === 'FAIL') {
        required.add('LADFRL_SCOPE_AREA_INVALID');
    }
    if (
        ldaregApplicable &&
        ldaregReplication.status === 'FAIL'
    ) {
        required.add('LDAREG_SCOPE_REPLICA_INVALID');
    }

    if (
        titleRootHashes.size !== 1 ||
        exactHousingFamily(titleInventoryRecords) === null
    ) {
        required.add('HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH');
    }
    const ldaregInventory = endpointByName('ldaregList')
        .inventory as JsonRecord;
    const ldaregRecords = ldaregInventory.records as JsonRecord[];
    const scopeTotal =
        scopeLadfrl.status === 'PASS' &&
        typeof scopeLadfrl.totalArea === 'string'
            ? Number(scopeLadfrl.totalArea)
            : null;
    if (
        ldaregRecords.some(
            (record) => record.quotaRatioState === 'INVALID'
        )
    ) {
        required.add('LDAREG_RATIO_INVALID');
    }
    if (
        ldaregRecords.some(
            (record) => record.quotaRatioState === 'MISSING'
        )
    ) {
        requiredReview.add('LDAREG_RATIO_MISSING_OBSERVED');
    }
    if (
        scopeTotal !== null &&
        ldaregRecords.some(
            (record) =>
                record.quotaRatioState === 'VALID' &&
                !validQuotaRatio(record.quotaRatio, scopeTotal)
        )
    ) {
        required.add('LDAREG_DENOMINATOR_MISMATCH');
    }

    if (ldaregApplicable) {
        const validLdaregRecords = ldaregRecords.filter(
            (record) => record.quotaRatioState === 'VALID'
        );
        const missingLdaregRecords = ldaregRecords.filter(
            (record) => record.quotaRatioState === 'MISSING'
        );
        if (
            !hasLdaregExposUnitCorrelation(
                resolvedScopeExposRecords(scopeExpos),
                validLdaregRecords,
                missingLdaregRecords
            )
        ) {
            required.add('LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH');
        }
    }

    const evidenceRecords = bylotEvidence.records as JsonRecord[];
    const titleBasisShouldPass =
        sample.policyCandidate !== null &&
        scopeBasis.status === 'PASS' &&
        scopeBasisClosure.valid &&
        scopeExpos.status === 'PASS' &&
        evidenceRecords.some(
            (record) =>
                record.titleState !== 'MISSING' &&
                record.basisState !== 'MISSING'
        );
    if (
        (titleBasis.status === 'PASS') !== titleBasisShouldPass
    ) {
        reject(`${path}.checks.titleBasis conflicts with sanitized evidence`);
    }
    if (!titleBasisShouldPass) {
        required.add('TITLE_BASIS_PK_CLOSURE_MISMATCH');
        required.add('BYLOT_POLICY_UNRESOLVED');
    }

    const titleRecords = evidenceRecords.filter(
        (record) => record.titleState !== 'MISSING'
    );
    const expectedBylot = sample.expectedBylot;
    const countMatchesExpectation = (count: unknown): boolean =>
        expectedBylot === 'ZERO'
            ? count === 0
            : typeof count === 'number' && count > 0;
    const matchingTitleRecords = titleRecords.filter(
        (record) =>
            countMatchesExpectation(record.effectiveCount) &&
            record.effectiveCount === record.attachedPairCount
    );
    const attachedOutsideTitle = evidenceRecords.some(
        (record) =>
            record.titleState === 'MISSING' &&
            (record.attachedPairCount as number) > 0
    );
    const bylotAttachedShouldPass =
        titleBasisShouldPass &&
        titleRecords.length > 0 &&
        matchingTitleRecords.length === titleRecords.length &&
        !attachedOutsideTitle;
    if (
        (bylotAttached.status === 'PASS') !== bylotAttachedShouldPass
    ) {
        reject(`${path}.checks.bylotAttached conflicts with sanitized evidence`);
    }
    if (!bylotAttachedShouldPass) {
        required.add('BYLOT_ATTACHED_EXPECTATION_MISMATCH');
    }
    if (
        bylotEvidence.truncated === false &&
        matchedHashes.truncated === false
    ) {
        const expectedMatchedHashes = matchingTitleRecords
            .map((record) => record.managementPkHash as string)
            .sort();
        const actualMatchedHashes = [
            ...(matchedHashes.records as string[]),
        ].sort();
        if (
            expectedMatchedHashes.length !== actualMatchedHashes.length ||
            expectedMatchedHashes.some(
                (hash, index) => hash !== actualMatchedHashes[index]
            )
        ) {
            reject(`${path}.matchedManagementPkHashes conflicts with evidence`);
        }
    }

    if (
        scopeLadfrl.status === 'PASS' &&
        ((scopeLadfrl.records as unknown[]).length === 0 ||
            typeof scopeLadfrl.totalArea !== 'string' ||
            Number(scopeLadfrl.totalArea) <= 0)
    ) {
        reject(`${path}.scopeLadfrl PASS lacks positive evidence`);
    }
    if (
        ldaregReplication.status === 'PASS' &&
        (!(ldaregReplication.comparedPnuHashes as string[]).includes(
            ldaregReplication.canonicalSourcePnuHash as string
        ) ||
            (ldaregReplication.comparedPnuHashes as string[]).length === 0)
    ) {
        reject(`${path}.ldaregReplication PASS lacks canonical scope`);
    }

    const failureCodes = sample.failureCodes as string[];
    for (const code of required) {
        if (!failureCodes.includes(code)) {
            reject(`${path}.failureCodes omits a required semantic failure`);
        }
    }
    const reviewCodes = sample.reviewCodes as string[];
    for (const code of requiredReview) {
        if (!reviewCodes.includes(code)) {
            reject(`${path}.reviewCodes omits a required semantic review`);
        }
    }
}

function decimalToMicrounits(value: unknown, path: string): bigint {
    if (typeof value !== 'string' || !SAFE_DECIMAL_PATTERN.test(value)) {
        reject(`${path} must be a safe decimal`);
    }
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function requireExactUniqueHashSet(
    actual: string[],
    expected: Set<string>,
    path: string
): void {
    if (
        new Set(actual).size !== actual.length ||
        actual.length !== expected.size ||
        actual.some((hash) => !expected.has(hash))
    ) {
        reject(`${path} does not exactly bind to title inventory`);
    }
}

function validQuotaRatio(
    value: unknown,
    expectedDenominator: number
): boolean {
    if (
        typeof value !== 'string' ||
        !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?\/(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(
            value
        )
    ) {
        return false;
    }
    const [numeratorText, denominatorText] = value.split('/');
    const numerator = Number(numeratorText);
    const denominator = Number(denominatorText);
    const tolerance = Math.max(0.1, expectedDenominator * 0.00001);
    return (
        Number.isFinite(numerator) &&
        Number.isFinite(denominator) &&
        numerator > 0 &&
        denominator > 0 &&
        numerator <= denominator &&
        Math.abs(denominator - expectedDenominator) <= tolerance
    );
}

/**
 * failureCodes=[]만으로는 PASS가 아니다. PASS artifact는 producer가 관찰한
 * 양성 증거를 endpoint inventory와 상호 결속해 제시해야 한다.
 *
 * FAIL artifact는 최초 관찰 근거로 보존해야 하므로 이 검증은 root gate가
 * PASS인 경우에만 호출한다.
 */
function requirePassWitnesses(sample: JsonRecord, path: string): void {
    const endpoints = sample.endpoints as JsonRecord[];
    if (endpoints.every((endpoint) => endpoint.state === 'COMPLETE_ZERO')) {
        reject(`${path} cannot PASS with every endpoint COMPLETE_ZERO`);
    }
    const endpoint = (name: string): JsonRecord =>
        endpoints.find((candidate) => candidate.endpoint === name)!;

    const titleEndpoint = endpoint('getBrTitleInfo');
    const titleInventory = titleEndpoint.inventory as JsonRecord;
    const titleRecords = titleInventory.records as JsonRecord[];
    if (
        titleEndpoint.state !== 'COMPLETE' ||
        (titleEndpoint.totalCount as number) <= 0 ||
        titleRecords.length === 0
    ) {
        reject(`${path} PASS title endpoint lacks nonzero COMPLETE evidence`);
    }
    if (
        !titleRecords.some(
            (record) =>
                typeof record.registryTypeCode === 'string' &&
                typeof record.registryTypeLabel === 'string' &&
                typeof record.mainPurposeCode === 'string' &&
                typeof record.mainPurposeLabel === 'string'
        )
    ) {
        reject(`${path} PASS title endpoint lacks codebook evidence`);
    }
    const housingFamily = exactHousingFamily(titleRecords);
    if (housingFamily === null) {
        reject(`${path} PASS lacks an exact approved housing classification`);
    }
    const ldaregApplicable = housingFamily === 'LDAREG';

    const titleHashes = new Set<string>();
    for (const [index, record] of titleRecords.entries()) {
        if (typeof record.managementPkHash !== 'string') {
            reject(
                `${path}.titleInventory.records[${index}] lacks management hash`
            );
        }
        titleHashes.add(record.managementPkHash);
    }
    if (titleHashes.size === 0 || sample.policyCandidate === null) {
        reject(`${path} PASS lacks a title-bound policy candidate`);
    }

    const evidence = sample.evidence as JsonRecord;
    const scopeBasis = evidence.scopeBasis as JsonRecord;
    const scopeExpos = evidence.scopeExpos as JsonRecord;
    const bylotEnvelope = evidence.bylotByManagementPk as JsonRecord;
    const bylotRecords = bylotEnvelope.records as JsonRecord[];
    const titleEvidence = bylotRecords.filter(
        (record) => record.titleState !== 'MISSING'
    );
    requireExactUniqueHashSet(
        titleEvidence.map((record) => record.managementPkHash as string),
        titleHashes,
        `${path}.evidence.bylotByManagementPk`
    );
    const expectedPositive = sample.expectedBylot === 'POSITIVE';
    const passReplication = evidence.ldaregReplication as JsonRecord;
    if (
        (ldaregApplicable && passReplication.status !== 'PASS') ||
        (!ldaregApplicable &&
            passReplication.status !== 'NOT_APPLICABLE')
    ) {
        reject(`${path} PASS lacks the expected LDAREG applicability witness`);
    }
    const evidenceByHash = new Map(
        titleEvidence.map((record) => [
            record.managementPkHash as string,
            record,
        ])
    );

    const basisEndpoint = endpoint('getBrBasisOulnInfo');
    const basisInventory = basisEndpoint.inventory as JsonRecord;
    const basisRecords = basisInventory.records as JsonRecord[];
    const scopeBasisRecords = scopeBasis.records as JsonRecord[];
    const scopeBasisClosure = deriveScopeBasisParentMap(
        titleRecords,
        scopeBasisRecords
    );
    if (
        basisEndpoint.state !== 'COMPLETE' ||
        basisRecords.length === 0 ||
        scopeBasis.status !== 'PASS' ||
        scopeBasis.truncated !== false ||
        !scopeBasisClosure.valid
    ) {
        reject(
            `${path} PASS basis scope lacks exact nonzero closure evidence`
        );
    }
    const titleBoundBasisHashes = new Set<string>();
    const basisChildHashes = new Set(
        scopeBasisClosure.parentByChild.keys()
    );
    const basisParentByChildHash =
        scopeBasisClosure.parentByChild;
    basisRecords.forEach((record, index) => {
        if (typeof record.managementPkHash !== 'string') {
            reject(
                `${path}.basisInventory.records[${index}] lacks management hash`
            );
        }
        const managementHash = record.managementPkHash;
        const isTitleRoot = titleHashes.has(managementHash);
        const rootHash = isTitleRoot
            ? managementHash
            : basisParentByChildHash.get(managementHash);
        if (
            typeof rootHash !== 'string' ||
            !titleHashes.has(rootHash)
        ) {
            reject(
                `${path}.basisInventory.records[${index}] is outside title PK closure`
            );
        }
        if (managementHash === rootHash) {
            titleBoundBasisHashes.add(managementHash);
        }
        const rootEvidence = evidenceByHash.get(rootHash);
        const bylot = record.bylot as JsonRecord;
        if (
            !rootEvidence ||
            bylot.parseState !== 'VALID' ||
            bylot.count !== rootEvidence.effectiveCount
        ) {
            reject(
                `${path}.basisInventory.records[${index}] conflicts with root bylot evidence`
            );
        }
    });
    requireExactUniqueHashSet(
        [...titleBoundBasisHashes],
        titleHashes,
        `${path}.basisInventory`
    );
    for (const [hash, record] of evidenceByHash) {
        const effectiveCount = record.effectiveCount;
        const countMatches =
            expectedPositive
                ? typeof effectiveCount === 'number' && effectiveCount > 0
                : effectiveCount === 0;
        if (
            !countMatches ||
            record.basisState !== 'RESOLVED' ||
            record.basisCount !== effectiveCount ||
            record.attachedPairCount !== effectiveCount
        ) {
            reject(`${path} PASS bylot evidence lacks an exact count witness`);
        }
        if (
            record.titleState === 'RESOLVED'
                ? record.titleCount !== effectiveCount ||
                  record.titleBasisRelation !== 'MATCH'
                : sample.policyCandidate !== 'TITLE_WITH_BASIS_FALLBACK' ||
                  record.titleState !== 'NO_VALID' ||
                  record.titleCount !== null ||
                  record.titleBasisRelation !== 'FALLBACK_AVAILABLE'
        ) {
            reject(`${path} PASS policy conflicts with title evidence`);
        }

        const matchingTitleRows = titleRecords.filter(
            (candidate) => candidate.managementPkHash === hash
        );
        if (
            record.titleState === 'RESOLVED'
                ? matchingTitleRows.some((candidate) => {
                      const bylot = candidate.bylot as JsonRecord;
                      return (
                          bylot.parseState !== 'VALID' ||
                          bylot.count !== effectiveCount
                      );
                  })
                : matchingTitleRows.some((candidate) => {
                      const bylot = candidate.bylot as JsonRecord;
                      return (
                          bylot.parseState !== 'INVALID' ||
                          (bylot.presence !== 'ABSENT' &&
                              bylot.presence !== 'NULL')
                      );
                  })
        ) {
            reject(`${path} PASS title inventory conflicts with bylot evidence`);
        }
        if (
            basisRecords
                .filter((candidate) => candidate.managementPkHash === hash)
                .some((candidate) => {
                    const bylot = candidate.bylot as JsonRecord;
                    return (
                        bylot.parseState !== 'VALID' ||
                        bylot.count !== effectiveCount
                    );
                })
        ) {
            reject(`${path} PASS basis inventory conflicts with bylot evidence`);
        }
    }

    const exposEndpoint = endpoint('getBrExposInfo');
    const exposInventory = exposEndpoint.inventory as JsonRecord;
    const exposRecords = exposInventory.records as JsonRecord[];
    const scopeExposRecords = scopeExpos.records as JsonRecord[];
    const scopeExposManagementHashes = new Set<string>();
    for (const [index, record] of scopeExposRecords.entries()) {
        const selfHash = record.selfManagementPkHash;
        const expectedRoot =
            typeof selfHash === 'string' && titleHashes.has(selfHash)
                ? selfHash
                : typeof selfHash === 'string'
                  ? basisParentByChildHash.get(selfHash)
                  : undefined;
        if (
            typeof selfHash !== 'string' ||
            typeof expectedRoot !== 'string' ||
            record.rootManagementPkHash !== expectedRoot
        ) {
            reject(
                `${path}.evidence.scopeExpos.records[${index}] is outside title/basis PK closure`
            );
        }
        scopeExposManagementHashes.add(selfHash);
    }
    for (const [index, record] of exposRecords.entries()) {
        if (typeof record.managementPkHash !== 'string') {
            reject(
                `${path}.exposInventory.records[${index}] lacks management hash`
            );
        }
        const expectedRoot = titleHashes.has(record.managementPkHash)
            ? record.managementPkHash
            : basisParentByChildHash.get(record.managementPkHash);
        if (
            typeof expectedRoot !== 'string' ||
            (record.upManagementPkHash !== undefined &&
                record.upManagementPkHash !== expectedRoot)
        ) {
            reject(
                `${path}.exposInventory.records[${index}] is outside basis PK closure`
            );
        }
        const unitHash =
            typeof record.unitIdentityHash === 'string'
                ? record.unitIdentityHash
                : undefined;
        const floorHoHash =
            typeof record.floorHoIdentityHash === 'string'
                ? record.floorHoIdentityHash
                : undefined;
        const dongHash =
            typeof record.dongIdentityHash === 'string'
                ? record.dongIdentityHash
                : undefined;
        if (
            !scopeExposRecords.some(
                (scopeRecord) =>
                    scopeRecord.queryPnuHash === sample.pnuHash &&
                    scopeRecord.rowPnuHash === sample.pnuHash &&
                    scopeRecord.selfManagementPkHash ===
                        record.managementPkHash &&
                    scopeRecord.rootManagementPkHash === expectedRoot &&
                    scopeRecord.rawUpManagementPkHash ===
                        record.upManagementPkHash &&
                    scopeRecord.unitIdentityShape ===
                        record.unitIdentityShape &&
                    scopeRecord.unitIdentityHash === unitHash &&
                    scopeRecord.floorHoIdentityHash === floorHoHash &&
                    scopeRecord.dongIdentityHash === dongHash
            )
        ) {
            reject(
                `${path}.exposInventory.records[${index}] is not bound to base scope evidence`
            );
        }
    }
    if (
        [...basisChildHashes].some(
            (hash) => !scopeExposManagementHashes.has(hash)
        )
    ) {
        reject(
            `${path}.evidence.scopeExpos does not cover every basis child PK`
        );
    }

    const scope = evidence.scopeLadfrl as JsonRecord;
    const scopeRecords = scope.records as JsonRecord[];
    const scopeHashes = scopeRecords.map(
        (record) => record.pnuHash as string
    );
    const scopeExposQueryHashes = (
        scopeExpos.queries as JsonRecord[]
    ).map((query) => query.pnuHash as string);
    const scopeBasisQueryHashes = (
        scopeBasis.queries as JsonRecord[]
    ).map((query) => query.pnuHash as string);
    const totalMicrounits =
        typeof scope.totalArea === 'string'
            ? decimalToMicrounits(scope.totalArea, `${path}.scopeLadfrl.totalArea`)
            : 0n;
    const areaSum = scopeRecords.reduce(
        (sum, record, index) =>
            sum +
            decimalToMicrounits(
                record.area,
                `${path}.scopeLadfrl.records[${index}].area`
            ),
        0n
    );
    if (
        scope.status !== 'PASS' ||
        scopeBasis.status !== 'PASS' ||
        scopeExpos.status !== 'PASS' ||
        scopeRecords.length === 0 ||
        new Set(scopeHashes).size !== scopeHashes.length ||
        new Set(scopeBasisQueryHashes).size !==
            scopeBasisQueryHashes.length ||
        new Set(scopeExposQueryHashes).size !==
            scopeExposQueryHashes.length ||
        scopeHashes.length !== scopeBasisQueryHashes.length ||
        scopeHashes.some(
            (hash) => !scopeBasisQueryHashes.includes(hash)
        ) ||
        scopeHashes.length !== scopeExposQueryHashes.length ||
        scopeHashes.some(
            (hash) => !scopeExposQueryHashes.includes(hash)
        ) ||
        scopeRecords.some(
            (record, index) =>
                decimalToMicrounits(
                    record.area,
                    `${path}.scopeLadfrl.records[${index}].area`
                ) <= 0n
        ) ||
        totalMicrounits <= 0n ||
        areaSum !== totalMicrounits
    ) {
        reject(`${path} PASS scopeLadfrl lacks an exact positive area witness`);
    }

    const attachedEndpoint = endpoint('getBrAtchJibunInfo');
    const attached = attachedEndpoint.inventory as JsonRecord;
    const attachedPairs = attached.pairs as JsonRecord[];
    const attachedCounts = new Map<string, number>();
    const expectedParcelScopeHashes = new Set<string>([
        sample.pnuHash as string,
    ]);
    for (const [index, pair] of attachedPairs.entries()) {
        if (
            pair.basePnuHash !== sample.pnuHash ||
            pair.attachedPnuHash === sample.pnuHash
        ) {
            reject(
                `${path}.attachedInventory.pairs[${index}] is not bound to the sample base PNU`
            );
        }
        expectedParcelScopeHashes.add(pair.attachedPnuHash as string);
        if (
            typeof pair.managementPkHash !== 'string' ||
            !titleHashes.has(pair.managementPkHash)
        ) {
            reject(
                `${path}.attachedInventory.pairs[${index}] is not title-bound`
            );
        }
        attachedCounts.set(
            pair.managementPkHash,
            (attachedCounts.get(pair.managementPkHash) ?? 0) + 1
        );
    }
    if (
        scopeHashes.length !== expectedParcelScopeHashes.size ||
        scopeHashes.some(
            (hash) => !expectedParcelScopeHashes.has(hash)
        ) ||
        scopeBasisQueryHashes.length !==
            expectedParcelScopeHashes.size ||
        scopeBasisQueryHashes.some(
            (hash) => !expectedParcelScopeHashes.has(hash)
        )
    ) {
        reject(
            `${path}.attachedInventory does not exactly bind the captured parcel scope`
        );
    }
    for (const [hash, record] of evidenceByHash) {
        if (
            (attachedCounts.get(hash) ?? 0) !== record.attachedPairCount
        ) {
            reject(`${path} PASS attached inventory conflicts with bylot evidence`);
        }
    }
    if (
        attached.totalRejected !== 0 ||
        attached.pairsTruncated !== false ||
        (expectedPositive
            ? attachedEndpoint.state !== 'COMPLETE' ||
              (attached.totalPairs as number) <= 0
            : attachedEndpoint.state !== 'COMPLETE_ZERO' ||
              attached.totalPairs !== 0)
    ) {
        reject(`${path} PASS attached endpoint lacks the expected exact witness`);
    }

    const checks = sample.checks as JsonRecord;
    const bylotAttached = checks.bylotAttached as JsonRecord;
    const matched = bylotAttached.matchedManagementPkHashes as JsonRecord;
    requireExactUniqueHashSet(
        matched.records as string[],
        titleHashes,
        `${path}.checks.bylotAttached.matchedManagementPkHashes`
    );

    if (ldaregApplicable) {
        const ldaregEndpoint = endpoint('ldaregList');
        const ldaregInventory = ldaregEndpoint.inventory as JsonRecord;
        const ldaregRecords = ldaregInventory.records as JsonRecord[];
        const expectedDenominator = Number(scope.totalArea);
        const validLdaregRecords = ldaregRecords.filter(
            (record) => record.quotaRatioState === 'VALID'
        );
        const missingLdaregRecords = ldaregRecords.filter(
            (record) => record.quotaRatioState === 'MISSING'
        );
        const resolvedExposRecords =
            resolvedScopeExposRecords(scopeExpos);
        if (resolvedExposRecords === null) {
            reject(
                `${path}.evidence.scopeExpos lacks exact unit identities`
            );
        }
        validLdaregRecords.forEach(
            (record, index) => {
                if (
                    record.unitIdentityShape === 'INCOMPLETE' ||
                    typeof record.unitIdentityHash !== 'string' ||
                    !validQuotaRatio(
                        record.quotaRatio,
                        expectedDenominator
                    )
                ) {
                    reject(
                        `${path}.ldaregInventory.validRecords[${index}] lacks a valid unit ratio witness`
                    );
                }
            }
        );
        if (
            !hasLdaregExposUnitCorrelation(
                resolvedExposRecords,
                validLdaregRecords,
                missingLdaregRecords
            )
        ) {
            reject(`${path} POSITIVE PASS lacks approved EXPOS/LDAREG unit correlation`);
        }
        if (
            missingLdaregRecords.length > 0 &&
            !(sample.reviewCodes as string[]).includes(
                'LDAREG_RATIO_MISSING_OBSERVED'
            )
        ) {
            reject(`${path} omits the missing LDAREG ratio review code`);
        }
        if (
            ldaregEndpoint.state !== 'COMPLETE' ||
            (ldaregEndpoint.totalCount as number) <= 0 ||
            validLdaregRecords.length === 0 ||
            validLdaregRecords.some(
                (record) => record.pnuHash !== sample.pnuHash
            )
        ) {
            reject(`${path} POSITIVE PASS lacks valid LDAREG quota evidence`);
        }
    }
}

function hashIdentity(kind: 'ALIAS' | 'PNU', value: string): string {
    return createHash('sha256')
        .update(`${kind}\u0000${value}`, 'utf8')
        .digest('hex');
}

function sampleCommitment(
    aliasHash: string,
    pnuHash: string,
    expectedBylot: string
): string {
    return `${aliasHash}:${pnuHash}:${expectedBylot}`;
}

function validateSample(value: unknown, path: string): {
    commitment: string;
    failureCodes: string[];
    reviewCodes: string[];
} {
    assertRecord(value, path);
    assertExactKeys(
        value,
        [
            'aliasHash',
            'expectedBylot',
            'pnuHash',
            'endpoints',
            'evidence',
            'policyCandidate',
            'checks',
            'failureCodes',
            'reviewCodes',
        ],
        [],
        path
    );
    assertHash(value.aliasHash, `${path}.aliasHash`);
    assertEnum(value.expectedBylot, ['ZERO', 'POSITIVE'], `${path}.expectedBylot`);
    assertHash(value.pnuHash, `${path}.pnuHash`);
    assertArray(value.endpoints, `${path}.endpoints`);
    const endpoints = value.endpoints.map((endpoint, index) =>
        validateEndpoint(endpoint, `${path}.endpoints[${index}]`)
    );
    const endpointSet = new Set(endpoints);
    if (
        endpoints.length !== LAND_AREA_PHASE0_ENDPOINTS.length ||
        endpointSet.size !== LAND_AREA_PHASE0_ENDPOINTS.length ||
        LAND_AREA_PHASE0_ENDPOINTS.some((endpoint) => !endpointSet.has(endpoint))
    ) {
        reject(`${path}.endpoints must be the exact approved endpoint set`);
    }
    validateEvidence(value.evidence, `${path}.evidence`);
    if (value.policyCandidate !== null) {
        assertEnum(
            value.policyCandidate,
            ['TITLE_ONLY', 'TITLE_WITH_BASIS_FALLBACK'],
            `${path}.policyCandidate`
        );
    }
    validateChecks(value.checks, `${path}.checks`);
    assertSortedUniqueCodes(value.failureCodes, `${path}.failureCodes`);
    assertSortedUniqueCodes(value.reviewCodes, `${path}.reviewCodes`);
    requireSemanticFailureCodes(value, path);
    return {
        commitment: sampleCommitment(
            value.aliasHash,
            value.pnuHash,
            value.expectedBylot
        ),
        failureCodes: value.failureCodes,
        reviewCodes: value.reviewCodes,
    };
}

function assertSerializedSize(artifact: unknown): void {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(artifact);
    } catch {
        reject('artifact is not serializable JSON');
    }
    if (
        serialized === undefined ||
        Buffer.byteLength(serialized, 'utf8') <= 0 ||
        Buffer.byteLength(serialized, 'utf8') > LAND_AREA_PHASE0_MAX_ARTIFACT_BYTES
    ) {
        reject('artifact size is outside the approved bound');
    }
}

function exactSortedUnion(codeLists: string[][]): string[] {
    return [...new Set(codeLists.flat())].sort();
}

/**
 * Manifest의 raw alias/PNU를 출력하지 않은 채 비식별 artifact 전체를 검증한다.
 * 유효한 FAIL artifact도 관찰 근거이므로 반환하며, PASS/FAIL 여부는 gate에 보존한다.
 */
export function validateLandAreaPhase0CaptureArtifact(
    manifestInput: LandAreaPhase0CaptureManifest | unknown,
    artifactInput: unknown
): LandAreaPhase0CaptureArtifact {
    const manifest = parseLandAreaPhase0Manifest(manifestInput);
    assertSerializedSize(artifactInput);
    assertRecord(artifactInput, 'artifact');
    assertExactKeys(
        artifactInput,
        ['version', 'schemaHash', 'gate', 'samples'],
        [],
        'artifact'
    );
    if (artifactInput.version !== LAND_AREA_PHASE0_ARTIFACT_VERSION) {
        reject('artifact version is not approved');
    }
    if (artifactInput.schemaHash !== LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH) {
        reject('artifact schema hash is not approved');
    }

    assertRecord(artifactInput.gate, 'artifact.gate');
    assertExactKeys(
        artifactInput.gate,
        ['status', 'failureCodes', 'reviewCodes'],
        [],
        'artifact.gate'
    );
    assertEnum(
        artifactInput.gate.status,
        ['PASS', 'FAIL'],
        'artifact.gate.status'
    );
    assertSortedUniqueCodes(
        artifactInput.gate.failureCodes,
        'artifact.gate.failureCodes'
    );
    assertSortedUniqueCodes(
        artifactInput.gate.reviewCodes,
        'artifact.gate.reviewCodes'
    );
    const gateFailureCodes = artifactInput.gate.failureCodes as string[];
    const gateReviewCodes = artifactInput.gate.reviewCodes as string[];
    if (
        (artifactInput.gate.status === 'PASS') !==
        (gateFailureCodes.length === 0)
    ) {
        reject('PASS is allowed iff failureCodes is empty');
    }

    assertArray(artifactInput.samples, 'artifact.samples');
    const validatedSamples = artifactInput.samples.map((sample, index) =>
        validateSample(sample, `artifact.samples[${index}]`)
    );
    const expectedCommitments = manifest.samples
        .map((sample) =>
            sampleCommitment(
                hashIdentity('ALIAS', sample.alias),
                hashIdentity('PNU', sample.pnu),
                sample.expectedBylot
            )
        )
        .sort();
    const actualCommitments = validatedSamples
        .map((sample) => sample.commitment)
        .sort();
    if (
        expectedCommitments.length !== actualCommitments.length ||
        expectedCommitments.some(
            (commitment, index) => commitment !== actualCommitments[index]
        )
    ) {
        reject('artifact samples do not exactly match the approved manifest');
    }
    if (new Set(actualCommitments).size !== actualCommitments.length) {
        reject('artifact samples contain duplicate commitments');
    }
    const expectedFamilyByCommitment = new Map(
        manifest.samples.map((sample) => [
            sampleCommitment(
                hashIdentity('ALIAS', sample.alias),
                hashIdentity('PNU', sample.pnu),
                sample.expectedBylot
            ),
            expectedLandAreaPhase0Family(sample),
        ])
    );
    artifactInput.samples.forEach((sample, index) => {
        const commitment = validatedSamples[index].commitment;
        const expectedFamily = expectedFamilyByCommitment.get(
            commitment
        );
        if (expectedFamily === undefined) {
            reject(
                `artifact.samples[${index}] lacks an approved manifest family`
            );
        }
        requireExpectedHousingFamily(
            sample as JsonRecord,
            expectedFamily,
            `artifact.samples[${index}]`
        );
    });
    if (artifactInput.gate.status === 'PASS') {
        artifactInput.samples.forEach((sample, index) =>
            requirePassWitnesses(
                sample as JsonRecord,
                `artifact.samples[${index}]`
            )
        );
    }

    const failureUnion = exactSortedUnion(
        validatedSamples.map((sample) => sample.failureCodes)
    );
    const reviewUnion = exactSortedUnion(
        validatedSamples.map((sample) => sample.reviewCodes)
    );
    if (
        failureUnion.length !== gateFailureCodes.length ||
        failureUnion.some(
            (code, index) => code !== gateFailureCodes[index]
        )
    ) {
        reject('gate failureCodes do not equal the sample failure union');
    }
    if (
        reviewUnion.length !== gateReviewCodes.length ||
        reviewUnion.some(
            (code, index) => code !== gateReviewCodes[index]
        )
    ) {
        reject('gate reviewCodes do not equal the sample review union');
    }

    return artifactInput as unknown as LandAreaPhase0CaptureArtifact;
}
