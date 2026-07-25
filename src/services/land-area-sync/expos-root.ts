/**
 * Building HUB 전유부(EXPOS)의 root 관리번호를 title/basis closure 안에서 해소한다.
 *
 * raw `mgmUpBldrgstPk`가 없다는 이유로 child self-PK를 root로 간주하지 않는다.
 * title root self 또는 basis의 exact self -> unique title root 관계만 허용하며,
 * 명시된 raw up이 basis 관계와 충돌하면 보강하지 않고 실패한다.
 */

import type {
    BrBasisOulnRow,
    BrExposRow,
} from '../../types/land-area-sync.types';
import {
    isOptionalRegistryManagementPkValid,
    normalizeRegistryManagementPk,
} from './registry-pk';

export type ExposRootIdentitySource =
    | 'SELF'
    | 'RAW_UP'
    | 'BASIS_UNIQUE';

export interface BasisRootIndex {
    acceptedRoots: ReadonlySet<string>;
    parentBySelf: ReadonlyMap<string, string>;
}

export type BasisRootIndexResult =
    | { ok: true; index: BasisRootIndex }
    | { ok: false };

export interface ResolvedExposRootIdentity {
    selfIdentity: string;
    rootIdentity: string;
    rawUpIdentity: string | null;
    source: ExposRootIdentitySource;
}

export type ExposRootIdentityResult =
    | { ok: true; evidence: ResolvedExposRootIdentity }
    | { ok: false };

/**
 * basis child self-PK별 title-bound parent를 만든다.
 *
 * - title root와 self가 같은 basis row의 별도 up-PK는 상위 집계 lineage일 수 있어
 *   child mapping으로 사용하지 않는다.
 * - child는 valid up-PK가 정확히 한 accepted title root를 가리켜야 한다.
 * - 동일 pair 반복은 허용하지만 한 child의 복수 parent, 외부 root, invalid PK는 거부한다.
 */
export function buildBasisRootIndex(
    basisRows: readonly BrBasisOulnRow[],
    acceptedRootIdentities: readonly string[]
): BasisRootIndexResult {
    const normalizedRoots = acceptedRootIdentities.map(
        normalizeRegistryManagementPk
    );
    if (
        normalizedRoots.length === 0 ||
        normalizedRoots.some((root) => root === null)
    ) {
        return { ok: false };
    }
    const acceptedRoots = new Set(
        normalizedRoots.filter((root): root is string => root !== null)
    );
    if (acceptedRoots.size !== normalizedRoots.length) {
        return { ok: false };
    }

    const parentsBySelf = new Map<string, Set<string>>();
    for (const row of basisRows) {
        const self = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        if (
            self === null ||
            !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)
        ) {
            return { ok: false };
        }
        if (acceptedRoots.has(self)) {
            continue;
        }
        const parent = normalizeRegistryManagementPk(
            row.mgmUpBldrgstPk
        );
        if (parent === null || !acceptedRoots.has(parent)) {
            return { ok: false };
        }
        const parents = parentsBySelf.get(self) ?? new Set<string>();
        parents.add(parent);
        parentsBySelf.set(self, parents);
    }

    const parentBySelf = new Map<string, string>();
    for (const [self, parents] of parentsBySelf) {
        if (parents.size !== 1) return { ok: false };
        parentBySelf.set(self, [...parents][0]);
    }
    return {
        ok: true,
        index: {
            acceptedRoots,
            parentBySelf,
        },
    };
}

/**
 * EXPOS row의 root를 raw/self/basis 근거 중 하나로 해소한다.
 *
 * child의 raw up이 있더라도 basis closure에 같은 self -> root 관계가 있어야 하며,
 * raw up 누락일 때만 BASIS_UNIQUE 보강을 허용한다.
 */
export function resolveExposRootIdentity(
    row: BrExposRow,
    index: BasisRootIndex
): ExposRootIdentityResult {
    const self = normalizeRegistryManagementPk(row.mgmBldrgstPk);
    if (
        self === null ||
        !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)
    ) {
        return { ok: false };
    }
    const rawUp = normalizeRegistryManagementPk(row.mgmUpBldrgstPk);

    if (index.acceptedRoots.has(self)) {
        if (rawUp !== null && rawUp !== self) {
            return { ok: false };
        }
        return {
            ok: true,
            evidence: {
                selfIdentity: self,
                rootIdentity: self,
                rawUpIdentity: rawUp,
                source: rawUp === null ? 'SELF' : 'RAW_UP',
            },
        };
    }

    const expectedRoot = index.parentBySelf.get(self);
    if (expectedRoot === undefined) return { ok: false };
    if (rawUp !== null && rawUp !== expectedRoot) {
        return { ok: false };
    }
    return {
        ok: true,
        evidence: {
            selfIdentity: self,
            rootIdentity: expectedRoot,
            rawUpIdentity: rawUp,
            source: rawUp === null ? 'BASIS_UNIQUE' : 'RAW_UP',
        },
    };
}
