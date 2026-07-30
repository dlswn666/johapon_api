import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveParcelScopeCompleteness,
    resolveSameRunOfficialDevelopmentFullRefreshComponent,
    resolveSameRunOfficialDevelopmentParcelSingleton,
    resolveSameRunOfficialReadOnlyComponent,
    createSameRunOfficialDevelopmentParcelSingletonEffectiveScope,
    createSameRunOfficialReadOnlyEffectiveScope,
    computeScopeHash,
    verifySinglePnuConfirmation,
    parseDbScopeResolution,
    callParcelScopeResolver,
    SCOPE_HASH_VERSION,
    type DbScopeResolution,
    type BasePnuScan,
    type ParcelScopeInput,
} from '../src/services/land-area-sync/scope';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type { BrTitleRow, BrAtchJibunRow, StrictScan, ProviderIssue } from '../src/types/land-area-sync.types';

const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;

const ANCHOR = '1168010100107360024';
const OTHER_PNU = '1168010100107360025';
const THIRD_PNU = '1168010100107360026';
const PK = '1002003004005';

// ── scan 빌더 ─────────────────────────────────────────────────────

function titleComplete(rows: BrTitleRow[]): StrictScan<BrTitleRow> {
    return { state: 'COMPLETE', rows, totalCount: rows.length, pagesFetched: 1 };
}
function attachedComplete(rows: BrAtchJibunRow[]): StrictScan<BrAtchJibunRow> {
    return { state: 'COMPLETE', rows, totalCount: rows.length, pagesFetched: 1 };
}
function zero<T>(): StrictScan<T> {
    return { state: 'COMPLETE_ZERO', rows: [], totalCount: 0, pagesFetched: 1 };
}
function failed<T>(): StrictScan<T> {
    const issue: ProviderIssue = { kind: 'HTTP_ERROR', endpoint: 'getBrTitleInfo', message: 'x', httpStatus: 500 };
    return { state: 'FAILED', issue };
}
function incomplete<T>(): StrictScan<T> {
    const issue: ProviderIssue = { kind: 'PAGINATION_MISMATCH', endpoint: 'getBrAtchJibunInfo', message: 'x' };
    return { state: 'INCOMPLETE', issue };
}

function titleRow(pk: string, bylotCnt: string, pair = DETACHED): BrTitleRow {
    return {
        mgmBldrgstPk: pk,
        bylotCnt,
        regstrGbCd: pair.regstrGbCd,
        mainPurpsCd: pair.mainPurpsCd,
        mainPurpsCdNm: pair.mainPurpsCdNm,
    };
}

/** 19자리 base/attached PNU 쌍을 getBrAtchJibunInfo row로 분해한다. */
function attachedRow(basePnu: string, attachedPnu: string, pk: string): BrAtchJibunRow {
    const dec = (p: string) => ({
        sigunguCd: p.slice(0, 5),
        bjdongCd: p.slice(5, 10),
        platGbCd: p.slice(10, 11) === '2' ? '1' : '0',
        bun: p.slice(11, 15),
        ji: p.slice(15, 19),
    });
    const b = dec(basePnu);
    const a = dec(attachedPnu);
    return {
        mgmBldrgstPk: pk,
        sigunguCd: b.sigunguCd,
        bjdongCd: b.bjdongCd,
        platGbCd: b.platGbCd,
        bun: b.bun,
        ji: b.ji,
        atchSigunguCd: a.sigunguCd,
        atchBjdongCd: a.bjdongCd,
        atchPlatGbCd: a.platGbCd,
        atchBun: a.bun,
        atchJi: a.ji,
    };
}

function db(over: Partial<DbScopeResolution> = {}): DbScopeResolution {
    return {
        dbState: 'NO_EVIDENCE',
        rootBuildingIdentities: [PK],
        componentPnus: [ANCHOR],
        linkedBasePnus: [],
        linkedPnus: [],
        linkedEvidenceKeys: [],
        pendingEvidenceKeys: [],
        blockingEvidence: [],
        openUnresolvedEvidenceKeys: [],
        componentTruncated: false,
        propertyMembership: [],
        dbScopeHash: 'db-hash-abc',
        ...over,
    };
}

function base(over: Partial<BasePnuScan> = {}): BasePnuScan {
    return {
        pnu: ANCHOR,
        title: titleComplete([titleRow(PK, '0')]),
        attached: zero<BrAtchJibunRow>(),
        ...over,
    };
}

function gate(over: Partial<ParcelScopeInput> = {}): ParcelScopeInput {
    return { dbScope: db(), baseScans: [base()], policy: 'TITLE_ONLY', ...over };
}

// ── FAILED 우선순위 ───────────────────────────────────────────────

test('title FAILED → FAILED (basis로 대체하지 않음)', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: failed<BrTitleRow>() })], dbScope: db({ dbState: 'BLOCKING_EVIDENCE', blockingEvidence: [{ sourceKind: 'API_RELATION', sourceId: 'u', state: 'CONFLICT' }] }) })
    );
    assert.equal(r.state, 'FAILED');
    assert.ok(r.issues.includes('PROVIDER_PROTOCOL_ERROR'));
});

test('attached INCOMPLETE → FAILED / ATTACHED_SCAN_INCOMPLETE', () => {
    const r = resolveParcelScopeCompleteness(gate({ baseScans: [base({ attached: incomplete<BrAtchJibunRow>() })] }));
    assert.equal(r.state, 'FAILED');
    assert.ok(r.issues.includes('ATTACHED_SCAN_INCOMPLETE'));
});

// ── 부속-only anchor → SINGLE_SCOPE_CONFIRMATION_REQUIRED ──────────

test('부속-only anchor(자체 title + bylot0 + ATTACHED_COMPLETE_ZERO)는 SINGLE_SCOPE_CONFIRMATION_REQUIRED', () => {
    const r = resolveParcelScopeCompleteness(gate());
    assert.equal(r.state, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
    assert.deepEqual(r.issues, []);
    assert.equal(r.scannedPnus.length, 1);
});

test('자동 single 승격 금지 — gate는 SINGLE_PNU_CONFIRMED를 스스로 반환하지 않는다', () => {
    const r = resolveParcelScopeCompleteness(gate());
    assert.notEqual(r.state, 'SINGLE_PNU_CONFIRMED');
});

// ── no-cache + attached row → conflict ────────────────────────────

test('cache 없음 + attached row → REVIEW (관계 생성·승격 없음)', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: titleComplete([titleRow(PK, '1')]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) })] })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_CACHE_SCAN_CONFLICT'));
});

test('READ_ONLY same-run official closure는 1→2/1→3 LDAREG component를 결정적으로 해소한다', () => {
    const oneAttachedInput = gate({
        baseScans: [
            base({
                title: titleComplete([
                    titleRow(PK, '1', MULTIPLEX),
                ]),
                attached: attachedComplete([
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                ]),
            }),
        ],
    });
    const one = resolveSameRunOfficialReadOnlyComponent({
        ...oneAttachedInput,
        anchorPnu: ANCHOR,
    });
    assert.ok(one);
    assert.deepEqual(one.memberPnus, [ANCHOR, OTHER_PNU]);
    assert.equal(one.pairCount, 1);
    assert.match(one.officialComponentDigest, /^[0-9a-f]{64}$/);

    const twoAttachedInput = gate({
        baseScans: [
            base({
                title: titleComplete([
                    titleRow(PK, '2', MULTIPLEX),
                ]),
                attached: attachedComplete([
                    attachedRow(ANCHOR, THIRD_PNU, PK),
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                ]),
            }),
        ],
    });
    const two = resolveSameRunOfficialReadOnlyComponent({
        ...twoAttachedInput,
        anchorPnu: ANCHOR,
    });
    const repeated = resolveSameRunOfficialReadOnlyComponent({
        ...twoAttachedInput,
        anchorPnu: ANCHOR,
    });
    assert.ok(two);
    assert.deepEqual(two.memberPnus, [
        ANCHOR,
        OTHER_PNU,
        THIRD_PNU,
    ]);
    assert.equal(two.pairCount, 2);
    assert.equal(
        two.officialComponentDigest,
        repeated?.officialComponentDigest
    );

    const effective =
        createSameRunOfficialReadOnlyEffectiveScope({
            dbScope: db(),
            component: two,
            propertyMembership: [
                {
                    propertyUnitId: 'p2',
                    pnu: THIRD_PNU,
                },
                {
                    propertyUnitId: 'p1',
                    pnu: ANCHOR,
                },
            ],
        });
    assert.equal(effective.dbState, 'LINKED');
    assert.deepEqual(effective.linkedBasePnus, [ANCHOR]);
    assert.deepEqual(effective.linkedPnus, [
        ANCHOR,
        OTHER_PNU,
        THIRD_PNU,
    ]);
    assert.deepEqual(
        (
            effective.propertyMembership as Array<{
                propertyUnitId: string;
            }>
        ).map((row) => row.propertyUnitId),
        ['p1', 'p2']
    );
});

test('DEV 전체 갱신은 classification conflict와 분리해 1→2/1→3 official component scope만 exact 확정한다', () => {
    const conflictTitles = (bylotCnt: string): BrTitleRow[] => [
        titleRow(PK, bylotCnt, MULTIPLEX),
        {
            mgmBldrgstPk: PK,
            bylotCnt,
            regstrGbCd: '1',
            mainPurpsCd: '03000',
            mainPurpsCdNm: '제1종근린생활시설',
        },
    ];
    const resolve = (attachedPnus: string[]) =>
        resolveSameRunOfficialDevelopmentFullRefreshComponent({
            ...gate({
                baseScans: [
                    base({
                        title: titleComplete([
                            ...conflictTitles(
                                String(attachedPnus.length)
                            ),
                        ]),
                        attached: attachedComplete(
                            attachedPnus.map((pnu) =>
                                attachedRow(ANCHOR, pnu, PK)
                            )
                        ),
                    }),
                ],
            }),
            anchorPnu: ANCHOR,
        });

    const one = resolve([OTHER_PNU]);
    assert.ok(one);
    assert.deepEqual(one.memberPnus, [ANCHOR, OTHER_PNU]);
    assert.equal(one.pairCount, 1);

    const two = resolve([THIRD_PNU, OTHER_PNU]);
    assert.ok(two);
    assert.deepEqual(two.memberPnus, [
        ANCHOR,
        OTHER_PNU,
        THIRD_PNU,
    ]);
    assert.equal(two.pairCount, 2);

    const singleton =
        resolveSameRunOfficialDevelopmentFullRefreshComponent({
            ...gate({
                baseScans: [
                    base({
                        title: titleComplete(
                            conflictTitles('0')
                        ),
                        attached:
                            zero<BrAtchJibunRow>(),
                    }),
                ],
            }),
            anchorPnu: ANCHOR,
        });
    assert.ok(singleton);
    assert.deepEqual(singleton.memberPnus, [ANCHOR]);
    assert.equal(singleton.pairCount, 0);
    assert.equal(singleton.managementPk, PK);
});

test('DEV 전체 갱신만 공식 LADFRL multi-PNU title/attached/bylot component를 확정한다', () => {
    const input = gate({
        baseScans: [
            base({
                title: titleComplete([
                    titleRow(PK, '2', DETACHED),
                ]),
                attached: attachedComplete([
                    attachedRow(ANCHOR, THIRD_PNU, PK),
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                ]),
            }),
        ],
    });
    assert.equal(
        resolveSameRunOfficialReadOnlyComponent({
            ...input,
            anchorPnu: ANCHOR,
        }),
        null,
        '일반 read-only LDAREG closure에는 LADFRL multi component를 전파하지 않는다'
    );
    const component =
        resolveSameRunOfficialDevelopmentFullRefreshComponent({
            ...input,
            anchorPnu: ANCHOR,
        });
    assert.ok(component);
    assert.deepEqual(component.memberPnus, [
        ANCHOR,
        OTHER_PNU,
        THIRD_PNU,
    ]);
    assert.equal(component.pairCount, 2);
    assert.match(
        component.officialComponentDigest,
        /^[0-9a-f]{64}$/
    );
});

test('DEV classification-independent component scope는 root conflict·duplicate·count mismatch·provider incomplete를 승격하지 않는다', () => {
    const conflictTitle = (bylotCnt: string): BrTitleRow[] => [
        titleRow(PK, bylotCnt, MULTIPLEX),
        {
            mgmBldrgstPk: PK,
            bylotCnt,
            regstrGbCd: '1',
            mainPurpsCd: '03000',
            mainPurpsCdNm: '제1종근린생활시설',
        },
    ];
    const resolve = (baseScan: BasePnuScan) =>
        resolveSameRunOfficialDevelopmentFullRefreshComponent({
            ...gate({ baseScans: [baseScan] }),
            anchorPnu: ANCHOR,
        });

    assert.equal(
        resolve(
            base({
                title: titleComplete(
                    conflictTitle('1').map((row, index) => ({
                        ...row,
                        mgmUpBldrgstPk:
                            index === 0
                                ? '1002003004006'
                                : '1002003004007',
                    }))
                ),
                attached: attachedComplete([
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                ]),
            })
        ),
        null
    );
    assert.equal(
        resolve(
            base({
                title: titleComplete(conflictTitle('2')),
                attached: attachedComplete([
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                ]),
            })
        ),
        null
    );
    assert.equal(
        resolve(
            base({
                title: titleComplete(conflictTitle('2')),
                attached: attachedComplete([
                    attachedRow(ANCHOR, OTHER_PNU, PK),
                ]),
            })
        ),
        null
    );
    assert.equal(
        resolve(
            base({
                title: titleComplete(conflictTitle('1')),
                attached: incomplete<BrAtchJibunRow>(),
            })
        ),
        null
    );
});

test('DEV 전체 갱신은 LADFRL과 LDAREG singleton을 모두 pairCount=0 공식 component로 고정한다', () => {
    const relationPnu = OTHER_PNU;
    const ladfrlComponent =
        resolveSameRunOfficialDevelopmentFullRefreshComponent({
            ...gate({
                dbScope: db({
                    dbState: 'LINKED',
                    componentPnus: [relationPnu],
                    linkedBasePnus: [relationPnu],
                    linkedPnus: [relationPnu],
                    linkedEvidenceKeys: ['relation-evidence'],
                    dbScopeHash: 'relation-derived-concurrency-hash',
                }),
            }),
            anchorPnu: ANCHOR,
        });
    assert.ok(ladfrlComponent);
    assert.deepEqual(ladfrlComponent, {
        source:
            'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
        canonicalBasePnu: ANCHOR,
        memberPnus: [ANCHOR],
        managementPk: PK,
        pairCount: 0,
        officialComponentDigest:
            ladfrlComponent.officialComponentDigest,
    });
    assert.match(
        ladfrlComponent.officialComponentDigest,
        /^[0-9a-f]{64}$/
    );

    const ldaregComponent =
        resolveSameRunOfficialDevelopmentFullRefreshComponent({
            ...gate({
                dbScope: db({
                    dbState: 'LINKED',
                    componentPnus: [relationPnu],
                    linkedBasePnus: [relationPnu],
                    linkedPnus: [relationPnu],
                    linkedEvidenceKeys: ['relation-evidence'],
                    dbScopeHash:
                        'relation-derived-concurrency-hash',
                }),
                baseScans: [
                    base({
                        title: titleComplete([
                            titleRow(PK, '0', MULTIPLEX),
                        ]),
                    }),
                ],
            }),
            anchorPnu: ANCHOR,
        });
    assert.ok(ldaregComponent);
    assert.equal(ldaregComponent.pairCount, 0);
    assert.deepEqual(ldaregComponent.memberPnus, [ANCHOR]);
    assert.match(
        ldaregComponent.officialComponentDigest,
        /^[0-9a-f]{64}$/
    );
});

test('DEV 전체 갱신 parcel singleton은 공식 분류 conflict와 strict title zero를 별도 필지 근거로 만든다', () => {
    const classificationConflict =
        resolveSameRunOfficialDevelopmentParcelSingleton(
            {
                ...gate({
                    dbScope: db({
                        dbState: 'LINKED',
                        componentPnus: [ANCHOR],
                        linkedBasePnus: [ANCHOR],
                        linkedPnus: [ANCHOR],
                        linkedEvidenceKeys: [
                            'relation-evidence',
                        ],
                    }),
                    baseScans: [
                        base({
                            title: titleComplete([
                                {
                                    mgmBldrgstPk: PK,
                                    bylotCnt: '0',
                                    regstrGbCd: '1',
                                    mainPurpsCd: '03000',
                                    mainPurpsCdNm:
                                        '제1종근린생활시설',
                                },
                            ]),
                        }),
                    ],
                }),
                anchorPnu: ANCHOR,
                parcelSingletonBasis:
                    'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON',
            }
        );
    assert.ok(classificationConflict);
    assert.deepEqual(classificationConflict, {
        source:
            'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
        canonicalPnu: ANCHOR,
        memberPnus: [ANCHOR],
        officialParcelDigest:
            classificationConflict.officialParcelDigest,
    });
    assert.equal('managementPk' in classificationConflict, false);
    assert.equal('pairCount' in classificationConflict, false);
    assert.match(
        classificationConflict.officialParcelDigest,
        /^[0-9a-f]{64}$/
    );

    const titleZero =
        resolveSameRunOfficialDevelopmentParcelSingleton(
            {
                ...gate({
                    baseScans: [
                        base({
                            title: zero<BrTitleRow>(),
                        }),
                    ],
                }),
                anchorPnu: ANCHOR,
                parcelSingletonBasis:
                    'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON',
            }
        );
    assert.ok(titleZero);
    assert.deepEqual(titleZero, {
        source:
            'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
        canonicalPnu: ANCHOR,
        memberPnus: [ANCHOR],
        officialParcelDigest:
            titleZero.officialParcelDigest,
    });

    const effective =
        createSameRunOfficialDevelopmentParcelSingletonEffectiveScope(
            {
                dbScope: db(),
                parcelResolution: titleZero,
                propertyMembership: [
                    {
                        propertyUnitId: 'p2',
                        pnu: ANCHOR,
                    },
                    {
                        propertyUnitId: 'p1',
                        pnu: ANCHOR,
                    },
                ],
            }
        );
    assert.equal(effective.dbState, 'LINKED');
    assert.deepEqual(effective.linkedBasePnus, [ANCHOR]);
    assert.deepEqual(effective.linkedPnus, [ANCHOR]);
    assert.match(effective.dbScopeHash, /^[0-9a-f]{64}$/);
    const changedDigest =
        createSameRunOfficialDevelopmentParcelSingletonEffectiveScope(
            {
                dbScope: db(),
                parcelResolution: {
                    ...titleZero,
                    officialParcelDigest: 'f'.repeat(64),
                },
                propertyMembership: [
                    {
                        propertyUnitId: 'p1',
                        pnu: ANCHOR,
                    },
                    {
                        propertyUnitId: 'p2',
                        pnu: ANCHOR,
                    },
                ],
            }
        );
    assert.notEqual(
        effective.dbScopeHash,
        changedDigest.dbScopeHash
    );
});

test('DEV parcel singleton의 classified 복수 title PK digest는 순서에 무관하고 synthetic identity가 없다', () => {
    const secondPk = '1002003004006';
    const rows: BrTitleRow[] = [
        titleRow(PK, '0', DETACHED),
        titleRow(secondPk, '0', DETACHED),
    ];
    const resolve = (titleRows: BrTitleRow[]) =>
        resolveSameRunOfficialDevelopmentParcelSingleton(
            {
                ...gate({
                    baseScans: [
                        base({
                            title: titleComplete(titleRows),
                        }),
                    ],
                }),
                anchorPnu: ANCHOR,
                parcelSingletonBasis:
                    'CLASSIFIED_DB_PARCEL_SINGLETON',
            }
        );
    const forward = resolve(rows);
    const reverse = resolve([...rows].reverse());
    assert.ok(forward);
    assert.ok(reverse);
    assert.equal(
        forward.officialParcelDigest,
        reverse.officialParcelDigest
    );
    assert.equal('managementPk' in forward, false);
    assert.equal('pairCount' in forward, false);
});

test('DEV 전체 갱신 parcel singleton은 provider 미완료·bylot 상충·attached 행·DB blocker를 공식 근거로 승격하지 않는다', () => {
    const classificationConflictScan = base({
        title: titleComplete([
            {
                mgmBldrgstPk: PK,
                bylotCnt: '0',
                regstrGbCd: '1',
                mainPurpsCd: '03000',
                mainPurpsCdNm: '제1종근린생활시설',
            },
        ]),
    });
    const resolve = (
        over: Partial<ParcelScopeInput>,
        parcelSingletonBasis:
            | 'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON'
            | 'CLASSIFIED_DB_PARCEL_SINGLETON' =
            'CLASSIFICATION_CONFLICT_DB_PARCEL_SINGLETON'
    ) =>
        resolveSameRunOfficialDevelopmentParcelSingleton(
            {
                ...gate({
                    baseScans: [classificationConflictScan],
                    ...over,
                }),
                anchorPnu: ANCHOR,
                parcelSingletonBasis,
            }
        );

    assert.equal(
        resolve({
            baseScans: [
                base({ title: failed<BrTitleRow>() }),
            ],
        }),
        null
    );
    assert.equal(
        resolve({
            baseScans: [
                base({
                    attached:
                        incomplete<BrAtchJibunRow>(),
                }),
            ],
        }),
        null
    );
    assert.equal(
        resolve({
            baseScans: [
                base({
                    title: titleComplete([
                        {
                            mgmBldrgstPk: PK,
                            bylotCnt: '1',
                            regstrGbCd: '1',
                            mainPurpsCd: '03000',
                            mainPurpsCdNm:
                                '제1종근린생활시설',
                        },
                    ]),
                }),
            ],
        }),
        null
    );
    assert.equal(
        resolve({
            baseScans: [
                base({
                    title: titleComplete([
                        {
                            mgmBldrgstPk: PK,
                            bylotCnt: '0',
                            regstrGbCd: '1',
                            mainPurpsCd: '03000',
                            mainPurpsCdNm:
                                '제1종근린생활시설',
                        },
                    ]),
                    attached: attachedComplete([
                        attachedRow(
                            ANCHOR,
                            OTHER_PNU,
                            PK
                        ),
                    ]),
                }),
            ],
        }),
        null
    );
    assert.equal(
        resolve({
            dbScope: db({
                dbState: 'BLOCKING_EVIDENCE',
                blockingEvidence: [
                    {
                        sourceKind: 'API_RELATION',
                        sourceId: 'blocked',
                        state: 'CONFLICT',
                    },
                ],
            }),
        }),
        null
    );
    assert.equal(
        resolve(
            {
                baseScans: [
                    base({
                        title: zero<BrTitleRow>(),
                    }),
                ],
            },
            'CLASSIFIED_DB_PARCEL_SINGLETON'
        ),
        null
    );
});

test('READ_ONLY same-run official closure는 기존 blocker·bylot 불일치·중복 pair를 fail-closed한다', () => {
    const scans = [
        base({
            title: titleComplete([
                titleRow(PK, '1', MULTIPLEX),
            ]),
            attached: attachedComplete([
                attachedRow(ANCHOR, OTHER_PNU, PK),
            ]),
        }),
    ];
    assert.equal(
        resolveSameRunOfficialReadOnlyComponent({
            ...gate({
                dbScope: db({
                    dbState: 'BLOCKING_EVIDENCE',
                    blockingEvidence: [
                        {
                            sourceKind: 'API_RELATION',
                            sourceId: 'x',
                            state: 'CONFLICT',
                        },
                    ],
                }),
                baseScans: scans,
            }),
            anchorPnu: ANCHOR,
        }),
        null
    );
    assert.equal(
        resolveSameRunOfficialReadOnlyComponent({
            ...gate({
                baseScans: [
                    base({
                        title: titleComplete([
                            titleRow(PK, '0', MULTIPLEX),
                        ]),
                        attached: attachedComplete([
                            attachedRow(
                                ANCHOR,
                                OTHER_PNU,
                                PK
                            ),
                        ]),
                    }),
                ],
            }),
            anchorPnu: ANCHOR,
        }),
        null
    );
    assert.equal(
        resolveSameRunOfficialReadOnlyComponent({
            ...gate({
                baseScans: [
                    base({
                        title: titleComplete([
                            titleRow(PK, '2', MULTIPLEX),
                        ]),
                        attached: attachedComplete([
                            attachedRow(
                                ANCHOR,
                                OTHER_PNU,
                                PK
                            ),
                            attachedRow(
                                ANCHOR,
                                OTHER_PNU,
                                PK
                            ),
                        ]),
                    }),
                ],
            }),
            anchorPnu: ANCHOR,
        }),
        null
    );
});

test('bylot0 + attached row → REVIEW / BYLOT_ATTACHED_COUNT_MISMATCH', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: titleComplete([titleRow(PK, '0')]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) })] })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('BYLOT_ATTACHED_COUNT_MISMATCH'));
});

// ── expected PK coverage / unavailable ────────────────────────────

test('orphan attached PK(coverage 누락)는 REVIEW / BYLOT_COUNT_UNAVAILABLE', () => {
    // title은 PK만, attached는 PK+ORPHAN. 부속 row가 있으니 no-cache면 cache-scan conflict도 뜬다.
    const orphanPk = '9001002003006';
    const r = resolveParcelScopeCompleteness(
        gate({
            dbScope: db({
                dbState: 'LINKED',
                linkedBasePnus: [ANCHOR],
                linkedPnus: [ANCHOR, OTHER_PNU],
            }),
            baseScans: [base({ title: titleComplete([titleRow(PK, '1')]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, orphanPk)]) })],
        })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('BYLOT_COUNT_UNAVAILABLE'));
    assert.ok(r.expectedPks.includes(orphanPk));
});

// ── component too large ───────────────────────────────────────────

test('component 50 초과(truncated) → REVIEW / SCOPE_COMPONENT_TOO_LARGE', () => {
    const r = resolveParcelScopeCompleteness(gate({ dbScope: db({ componentTruncated: true }) }));
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_COMPONENT_TOO_LARGE'));
});

// ── PENDING / blocking ────────────────────────────────────────────

test('PENDING evidence → REVIEW / SCOPE_PENDING', () => {
    const r = resolveParcelScopeCompleteness(gate({ dbScope: db({ dbState: 'PENDING', pendingEvidenceKeys: ['API_RELATION:u1'] }) }));
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_PENDING'));
});

test('blocking evidence → REVIEW / SCOPE_BLOCKING_EVIDENCE', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ dbScope: db({ dbState: 'BLOCKING_EVIDENCE', blockingEvidence: [{ sourceKind: 'API_RELATION', sourceId: 'u', state: 'CONFLICT' }] }) })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_BLOCKING_EVIDENCE'));
});

// ── LINKED exact match ────────────────────────────────────────────

test('LINKED PNU와 complete attached scan이 exact 일치 → LINKED_SCOPE_RESOLVED (다세대)', () => {
    const r = resolveParcelScopeCompleteness({
        dbScope: db({ dbState: 'LINKED', linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR, OTHER_PNU], componentPnus: [ANCHOR, OTHER_PNU] }),
        baseScans: [
            base({ pnu: ANCHOR, title: titleComplete([titleRow(PK, '1', MULTIPLEX)]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) }),
        ],
        policy: 'TITLE_ONLY',
    });
    assert.equal(r.state, 'LINKED_SCOPE_RESOLVED');
    assert.deepEqual(r.issues, []);
});

test('LINKED PNU와 attached 불일치 → REVIEW / SCOPE_NOT_LINKED', () => {
    const r = resolveParcelScopeCompleteness({
        dbScope: db({ dbState: 'LINKED', linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR, OTHER_PNU], componentPnus: [ANCHOR, OTHER_PNU] }),
        baseScans: [base({ pnu: ANCHOR, title: titleComplete([titleRow(PK, '0', MULTIPLEX)]), attached: zero<BrAtchJibunRow>() })],
        policy: 'TITLE_ONLY',
    });
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_NOT_LINKED'));
});

// ── 일반건축물 multi-PNU 금지 ─────────────────────────────────────

test('일반건축물(단독/다가구) LINKED 다중 PNU → REVIEW / MULTI_PNU_GENERAL_BUILDING', () => {
    const r = resolveParcelScopeCompleteness({
        dbScope: db({ dbState: 'LINKED', linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR, OTHER_PNU], componentPnus: [ANCHOR, OTHER_PNU] }),
        baseScans: [
            base({ pnu: ANCHOR, title: titleComplete([titleRow(PK, '1', DETACHED)]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) }),
        ],
        policy: 'TITLE_ONLY',
    });
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('MULTI_PNU_GENERAL_BUILDING'));
});

// ── 분류 혼재 차단 ────────────────────────────────────────────────

test('아파트 등 미지원 유형 → REVIEW / UNSUPPORTED_HOUSING_TYPE', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: titleComplete([{ mgmBldrgstPk: PK, bylotCnt: '0', regstrGbCd: '2', mainPurpsCd: '09999', mainPurpsCdNm: '아파트' }]) })] })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('UNSUPPORTED_HOUSING_TYPE'));
});

// ── 3층 hash ──────────────────────────────────────────────────────

test('dbScopeHash는 DB resolver 값을 그대로 통과시킨다', () => {
    const r = resolveParcelScopeCompleteness(gate({ dbScope: db({ dbScopeHash: 'passthrough-xyz' }) }));
    assert.equal(r.dbScopeHash, 'passthrough-xyz');
});

test('externalScopeDigest는 결정론적 sha256 hex이며 정책·scan에 반응', () => {
    const a = resolveParcelScopeCompleteness(gate());
    const b = resolveParcelScopeCompleteness(gate());
    assert.match(a.externalScopeDigest, /^[0-9a-f]{64}$/);
    assert.equal(a.externalScopeDigest, b.externalScopeDigest);
    const c = resolveParcelScopeCompleteness(gate({ baseScans: [base({ title: titleComplete([titleRow(PK, '7')]) })] }));
    assert.notEqual(a.externalScopeDigest, c.externalScopeDigest);
    const d = resolveParcelScopeCompleteness(
        gate({
            baseScans: [
                base({
                    title: titleComplete([
                        {
                            ...titleRow(PK, '0', DETACHED),
                            etcPurps: '단독주택',
                        },
                    ]),
                }),
            ],
        })
    );
    assert.notEqual(a.externalScopeDigest, d.externalScopeDigest);
});

test('computeScopeHash: 결정론 + 키순서 무관 + dbScopeHash/externalScopeDigest 반영', () => {
    const inputBase = {
        strategy: 'LADFRL',
        candidatePropertyIds: ['p2', 'p1'],
        propertyMembership: [{ b: 2, a: 1 }],
        currentLandTuples: [{ pnu: ANCHOR, area: 100 }],
        proposedAreas: [{ pnu: ANCHOR, area: 100 }],
        componentMatchDigest: [],
        dbScopeHash: 'db-1',
        externalScopeDigest: 'ext-1',
    };
    const h1 = computeScopeHash(inputBase);
    // candidatePropertyIds 순서만 바꿈 → 동일 해시 (내부 정렬)
    const h2 = computeScopeHash({ ...inputBase, candidatePropertyIds: ['p1', 'p2'] });
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, h2);
    // dbScopeHash 변경 → 해시 변경
    assert.notEqual(h1, computeScopeHash({ ...inputBase, dbScopeHash: 'db-2' }));
    // externalScopeDigest 변경 → 해시 변경
    assert.notEqual(h1, computeScopeHash({ ...inputBase, externalScopeDigest: 'ext-2' }));
    assert.ok(SCOPE_HASH_VERSION.length > 0);
});

// ── SINGLE_PNU_CONFIRMED 확인 (재실행 일치 시에만) ────────────────

test('verifySinglePnuConfirmation: property membership+scopeHash 일치 → SINGLE_PNU_CONFIRMED', () => {
    const prior = { scopeHash: 'h1', propertyMembership: [{ id: 'p1' }] };
    const current = { scopeHash: 'h1', propertyMembership: [{ id: 'p1' }] };
    assert.equal(verifySinglePnuConfirmation(prior, current).state, 'SINGLE_PNU_CONFIRMED');
});

test('verifySinglePnuConfirmation: 불일치 → REVIEW / LAND_SCOPE_CONFIRMATION_MISMATCH', () => {
    const prior = { scopeHash: 'h1', propertyMembership: [{ id: 'p1' }] };
    const r = verifySinglePnuConfirmation(prior, { scopeHash: 'h2', propertyMembership: [{ id: 'p1' }] });
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.equal(r.state === 'REVIEW_REQUIRED' && r.issue, 'LAND_SCOPE_CONFIRMATION_MISMATCH');
});

// ── DB resolver 파싱·호출 ────────────────────────────────────────

test('parseDbScopeResolution: 누락 필드는 안전한 기본값', () => {
    const r = parseDbScopeResolution({ dbState: 'LINKED', dbScopeHash: 'x' });
    assert.equal(r.dbState, 'LINKED');
    assert.deepEqual(r.componentPnus, []);
    assert.deepEqual(r.blockingEvidence, []);
    assert.equal(r.componentTruncated, false);
});

test('parseDbScopeResolution: 알 수 없는 dbState는 REVIEW쪽으로 안전하게 BLOCKING_EVIDENCE 처리', () => {
    const r = parseDbScopeResolution({ dbState: 'WAT', dbScopeHash: 'x' });
    assert.equal(r.dbState, 'BLOCKING_EVIDENCE');
});

test('callParcelScopeResolver: 주입 caller로 호출하고 파싱된 결과 반환', async () => {
    const calls: unknown[] = [];
    const callResolver = async (params: unknown) => {
        calls.push(params);
        return { data: { dbState: 'NO_EVIDENCE', dbScopeHash: 'ok', componentPnus: [ANCHOR] }, error: null };
    };
    const res = await callParcelScopeResolver({ unionId: 'u1', anchorPnu: ANCHOR, rootMgmBldrgstPks: [PK] }, { callResolver });
    assert.equal(res.dbScopeHash, 'ok');
    assert.deepEqual(calls, [{ p_union_id: 'u1', p_anchor_pnu: ANCHOR, p_root_mgm_bldrgst_pks: [PK] }]);
});

test('callParcelScopeResolver: RPC error는 throw', async () => {
    const callResolver = async () => ({ data: null, error: { message: 'denied' } });
    await assert.rejects(() => callParcelScopeResolver({ unionId: 'u1', anchorPnu: ANCHOR, rootMgmBldrgstPks: [] }, { callResolver }));
});

// ── §9.1 개정: 선택된 대지권 대상 root 기준 분류 partition ──────────────

const GENERAL_ROOT = '1010111086';
const AGGREGATE_ROOT = '1010114204';
const MIA_ANCHOR = '1130510300107912282';

function completeScan<T>(rows: T[]) {
    return {
        state: 'COMPLETE' as const,
        rows,
        totalCount: rows.length,
        pagesFetched: 1,
    };
}

function zeroScan() {
    return {
        state: 'COMPLETE_ZERO' as const,
        rows: [] as never[],
        totalCount: 0 as const,
        pagesFetched: 1,
    };
}

/** 미아7 791-2282 실측 형상: 일반건축물 1행 + 집합건물 1행, 부속지번 0. */
function multiRootBaseScans() {
    return [
        {
            pnu: MIA_ANCHOR,
            title: completeScan([
                {
                    mgmBldrgstPk: GENERAL_ROOT,
                    bylotCnt: '0',
                    regstrGbCd: '1',
                    mainPurpsCd: '01000',
                    mainPurpsCdNm: '단독주택',
                    etcPurps: '단독주택',
                    grndFlrCnt: '1',
                    totArea: '88.8',
                },
                {
                    mgmBldrgstPk: AGGREGATE_ROOT,
                    bylotCnt: '0',
                    regstrGbCd: '2',
                    mainPurpsCd: '02000',
                    mainPurpsCdNm: '공동주택',
                    etcPurps: '공동주택',
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
            ]),
            attached: zeroScan(),
        },
    ];
}

function multiRootDbScope() {
    return parseDbScopeResolution({
        dbState: 'LINKED',
        rootBuildingIdentities: [GENERAL_ROOT, AGGREGATE_ROOT],
        componentPnus: [MIA_ANCHOR],
        linkedBasePnus: [MIA_ANCHOR],
        linkedPnus: [MIA_ANCHOR],
        linkedEvidenceKeys: [],
        pendingEvidenceKeys: [],
        blockingEvidence: [],
        openUnresolvedEvidenceKeys: [],
        componentTruncated: false,
        propertyMembership: [],
        dbScopeHash: 'db-scope-hash',
    });
}

test('선택 root 없으면 복수 root는 기존대로 REVIEW_REQUIRED다', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
    });
    assert.equal(res.state, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BUILDING_CLASSIFICATION_CONFLICT'));
    assert.equal(res.classification.kind, 'REVIEW_REQUIRED');
    assert.equal(
        res.classification.kind === 'REVIEW_REQUIRED' &&
            res.classification.reason,
        'MULTIPLE_ROOT_IDENTITIES'
    );
    assert.equal(res.landRightRootIdentity, null);
    assert.deepEqual(res.excludedLandRightRootIdentities, []);
});

test('선택 root를 주면 그 root의 표제부 행만으로 분류하고 나머지는 제외 기록한다', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(res.classification.kind, 'CLASSIFIED');
    assert.equal(
        res.classification.kind === 'CLASSIFIED' &&
            res.classification.family,
        'LDAREG'
    );
    assert.equal(res.landRightRootIdentity, AGGREGATE_ROOT);
    assert.deepEqual(res.excludedLandRightRootIdentities, [GENERAL_ROOT]);
    assert.equal(res.state, 'LINKED_SCOPE_RESOLVED');
    assert.deepEqual(res.issues, []);
});

test('선택 root partition은 bylot·attached 축을 좁히지 않는다 — expectedPks는 전체 root', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.deepEqual(res.expectedPks, [GENERAL_ROOT, AGGREGATE_ROOT].sort());
    assert.equal(res.bylot.evidence.length, 2);
});

test('선택 root가 표제부에 없으면 partition하지 않고 복수 root REVIEW를 유지한다', () => {
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: '9999999999',
    });
    assert.equal(res.state, 'REVIEW_REQUIRED');
    assert.equal(
        res.classification.kind === 'REVIEW_REQUIRED' &&
            res.classification.reason,
        'MULTIPLE_ROOT_IDENTITIES'
    );
    assert.equal(res.landRightRootIdentity, null);
});

test('선택 root가 상위 up-PK를 가진 child면 root로 인정하지 않는다', () => {
    const scans = multiRootBaseScans();
    scans[0].title.rows[1] = {
        ...scans[0].title.rows[1],
        mgmUpBldrgstPk: '1010119999',
    } as never;
    const res = resolveParcelScopeCompleteness({
        dbScope: multiRootDbScope(),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(res.state, 'REVIEW_REQUIRED');
    assert.equal(res.landRightRootIdentity, null);
});

test('단일 root anchor에 선택 root를 주면 partition 없이 기존 경로를 유지한다', () => {
    const scans = multiRootBaseScans();
    scans[0].title.rows = [scans[0].title.rows[1]] as never;
    const res = resolveParcelScopeCompleteness({
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            rootBuildingIdentities: [AGGREGATE_ROOT],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(res.classification.kind, 'CLASSIFIED');
    assert.equal(res.landRightRootIdentity, null);
    assert.deepEqual(res.excludedLandRightRootIdentities, []);
});

// ── §9.1 개정: component 단일성 가드를 선택 root 기준으로 좁힌다 ──────────

test('DEV 전체 갱신 singleton component는 선택 root가 있으면 복수 표제부 root를 허용한다', () => {
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.notEqual(component, null);
    assert.equal(component?.managementPk, AGGREGATE_ROOT);
    assert.deepEqual(component?.memberPnus, [MIA_ANCHOR]);
    assert.equal(component?.pairCount, 0);
});

test('DEV 전체 갱신 singleton component는 선택 root가 없으면 복수 root를 승격하지 않는다', () => {
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
    });
    assert.equal(component, null);
});

test('DEV 전체 갱신 singleton component는 제외 root의 bylotCnt가 0이 아니면 공통 gate가 승격 검토 전에 걸러낸다', () => {
    // 주의: 이 테스트는 `allBylotCountsZero` helper의 reject 분기를 검증하지 않는다.
    // singleton tail은 항상 attached.state === 'COMPLETE_ZERO'(distinct attached count 0 고정)를
    // 요구하므로, 제외 root(GENERAL_ROOT)의 bylotCnt를 0이 아닌 값으로 바꾸면
    // `resolveParcelScopeCompleteness`가 evidence.count(1) !== distinct attached(0) 불일치로
    // BYLOT_ATTACHED_COUNT_MISMATCH를 issues에 먼저 채운다. 그 결과 REVIEW_REQUIRED 상태의
    // issues가 classifiedSingleton/classificationConflictSingleton이 허용하는 issue 집합
    // ({}, {BUILDING_CLASSIFICATION_CONFLICT}, {BUILDING_CLASSIFICATION_CONFLICT,SCOPE_NOT_LINKED})
    // 중 어느 것과도 일치하지 않아 두 판정이 모두 false가 되고, 함수는 `allBylotCountsZero`를
    // 호출하는 코드에 도달하기도 전에 null을 반환한다(`scope.ts`의 `allBylotCountsZero` 위
    // docblock 참고). 즉 여기서 검증하는 것은 "제외 root의 bylotCnt 불일치가 승격을 막는다"는 관찰 가능한
    // 동작이며, 그 메커니즘은 이 공통 gate이지 `allBylotCountsZero`가 아니다.
    const scans = multiRootBaseScans();
    scans[0].title.rows[0] = {
        ...scans[0].title.rows[0],
        bylotCnt: '1',
    } as never;
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(component, null);
});

test('선택 root 귀속 표제부 행이 0건이면 승격하지 않는다', () => {
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: multiRootBaseScans() as never,
        policy: 'TITLE_ONLY',
        // 표제부에 없는 root
        landRightRootIdentity: '9999999999',
    });
    assert.equal(component, null);
});

test('선택 root의 표제부 행이 여러 개라도 같은 self PK면 dedup 후 승격한다', () => {
    const scans = multiRootBaseScans();
    // 집합 root 표제부 행을 한 번 더 반복한다(같은 self PK).
    scans[0].title.rows.push({ ...scans[0].title.rows[1] } as never);
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.notEqual(component, null);
    assert.equal(component?.managementPk, AGGREGATE_ROOT);
});

test('표제부에 invalid 관리 PK가 있으면 선택 root와 무관하게 승격하지 않는다', () => {
    // 주의: 이 테스트는 `selectedTitleSelfPks`의 `self === null` reject 분기를 단독으로
    // 검증하지 않는다. 이 fixture는 attached.state가 'COMPLETE_ZERO'라 singleton tail로
    // 빠지고, 거기서도 `selectedTitleSelfPks`를 호출하기 전에 같은 title 행으로
    // `resolveParcelScopeCompleteness`(singletonGate)를 먼저 돌린다. invalid PK는
    // `hasInvalidRequiredPk(titleRows)`에 걸려 scanFailure = 'PROVIDER_PROTOCOL_ERROR' →
    // FAILED가 되고, classifiedSingleton/classificationConflictSingleton 둘 다 FAILED가 아닌
    // 상태를 요구하므로 `selectedTitleSelfPks` 호출 자체에 도달하기 전에 null을 반환한다
    // (`scope.ts`의 `selectedTitleSelfPks` 위 docblock 참고). 즉 여기서 검증하는 것은
    // "invalid PK가 승격을 막는다"는 관찰 가능한 동작이며, 그 메커니즘은 이 공통 gate이지
    // `selectedTitleSelfPks`의 null 분기가 아니다.
    const scans = multiRootBaseScans();
    scans[0].title.rows[0] = {
        ...scans[0].title.rows[0],
        mgmBldrgstPk: '',
    } as never;
    const component = resolveSameRunOfficialDevelopmentFullRefreshComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(component, null);
});

// ── §9.1 개정: 부속지번-bearing strict attached component 경로
//    (resolveStrictSameRunOfficialAttachedComponent, resolveSameRunOfficialReadOnlyComponent 경유) ──
//
// 미아7 실측처럼 표제부 root가 두 개(일반건축물 GENERAL_ROOT + 집합건물 AGGREGATE_ROOT)이고
// 부속지번이 실제로 존재하는 형상. 위 singleton 테스트들과 달리 attached.state는 항상
// 'COMPLETE'다(부속지번 0건인 singleton 경로와 다른 축).

/** 미아7 791-2282의 인접 부속지번(791-2283)으로 가정한 19자리 PNU. */
const MIA_ATTACHED_PNU = '1130510300107912283';

test('부속지번-bearing 경로: 선택 root에만 부속지번이 걸리고 제외 root의 bylotCnt가 0이면 승격한다', () => {
    const scans = multiRootBaseScans();
    // 선택 root(AGGREGATE_ROOT)의 bylotCnt를 아래 부속지번 1건과 일치시킨다.
    // 제외 root(GENERAL_ROOT)는 fixture 기본값 그대로 bylotCnt '0', 부속지번 없음.
    scans[0].title.rows[1] = {
        ...scans[0].title.rows[1],
        bylotCnt: '1',
    } as never;
    scans[0].attached = completeScan([
        attachedRow(MIA_ANCHOR, MIA_ATTACHED_PNU, AGGREGATE_ROOT),
    ]) as never;
    const component = resolveSameRunOfficialReadOnlyComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.notEqual(component, null);
    assert.equal(component?.managementPk, AGGREGATE_ROOT);
    assert.deepEqual(component?.memberPnus, [MIA_ANCHOR, MIA_ATTACHED_PNU].sort());
    assert.equal(component?.pairCount, 1);
});

test('부속지번-bearing 경로: 부속지번이 선택 root가 아닌 root에 걸리면 승격하지 않는다', () => {
    const scans = multiRootBaseScans();
    // 제외 root(GENERAL_ROOT)의 bylotCnt를 아래 부속지번 1건과 일치시켜
    // BYLOT_ATTACHED_COUNT_MISMATCH를 피하고, "부속지번이 선택 root가 아닌 root에 걸린다"는
    // 조건만 남긴다. 이 조건을 실제로 결정하는 것은 §9.1 이전부터 있던 cross-root pair 검사
    // `attached.pairs.some(pair => normalizeRegistryManagementPk(pair.mgmBldrgstPk) !==
    // managementPk)`다 — 아래 bylot `some(...)` 검사(§9.1 신규)에는 도달하지 않는다.
    scans[0].title.rows[0] = {
        ...scans[0].title.rows[0],
        bylotCnt: '1',
    } as never;
    scans[0].attached = completeScan([
        attachedRow(MIA_ANCHOR, MIA_ATTACHED_PNU, GENERAL_ROOT),
    ]) as never;
    const component = resolveSameRunOfficialReadOnlyComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(component, null);
});

test('부속지번-bearing 경로: 제외 root의 bylotCnt가 0이 아니면 승격하지 않는다', () => {
    // 주의: 이 테스트는 §9.1이 추가한
    // `normalGate.bylot.evidence.some(row => row.mgmBldrgstPk !== managementPk && row.count !== 0)`
    // 체크의 reject 분기를 단독으로 검증하지 않는다. 이 진입점(resolveSameRunOfficialReadOnlyComponent)
    // 에서는 제외 root(GENERAL_ROOT)에 부속지번이 없는 채로 bylotCnt만 0이 아니면, 그 PK의
    // distinct attached count(d)가 항상 0이므로 공통 gate(`resolveParcelScopeCompleteness`)가
    // 이미 BYLOT_ATTACHED_COUNT_MISMATCH를 issues에 채워 normalGate 검사
    // (정확히 SCOPE_CACHE_SCAN_CONFLICT 하나만 허용)에서 먼저 null로 걸러진다. 반대로 제외 root에
    // 부속지번을 실제로 붙이면(바로 위 테스트) 기존 `attached.pairs.some(...)` 체크가 먼저 걸린다 —
    // 이 경로에서는 §9.1 신규 체크 라인이 유일한 판단 근거가 되는 입력을 구성할 수 없었다(§9.1
    // singleton tail의 `allBylotCountsZero`와 같은 이유: attached count와 bylotCnt 불일치를 잡는
    // 공통 gate가 먼저 걸린다). 그럼에도 "제외 root의 bylotCnt 불일치가 승격을 막는다"는 관찰
    // 가능한 동작 자체는 유효하므로 회귀 테스트로 남긴다.
    const scans = multiRootBaseScans();
    scans[0].title.rows[0] = {
        ...scans[0].title.rows[0],
        bylotCnt: '1', // 제외 root(GENERAL_ROOT), 부속지번은 없음 → d=0 vs count=1 불일치
    } as never;
    scans[0].title.rows[1] = {
        ...scans[0].title.rows[1],
        bylotCnt: '1', // 선택 root(AGGREGATE_ROOT), 아래 부속지번 1건과 일치
    } as never;
    scans[0].attached = completeScan([
        attachedRow(MIA_ANCHOR, MIA_ATTACHED_PNU, AGGREGATE_ROOT),
    ]) as never;
    const component = resolveSameRunOfficialReadOnlyComponent({
        anchorPnu: MIA_ANCHOR,
        dbScope: parseDbScopeResolution({
            ...multiRootDbScope(),
            dbState: 'NO_EVIDENCE',
            linkedBasePnus: [],
            linkedPnus: [],
        }),
        baseScans: scans as never,
        policy: 'TITLE_ONLY',
        landRightRootIdentity: AGGREGATE_ROOT,
    });
    assert.equal(component, null);
});
