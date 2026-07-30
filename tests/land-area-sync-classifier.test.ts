import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHousingType, type HousingClassifierInput } from '../src/services/land-area-sync/classifier';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';

const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
const MULTIFAMILY = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIFAMILY')!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;
const LIVE_MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find(
    (p) => p.requiredOtherPurposeSignal === 'MULTIPLEX_HOUSE'
)!;

function row(p: {
    regstrGbCd: string;
    mainPurpsCd: string;
    mainPurpsCdNm: string;
    etcPurps?: string;
}) {
    return {
        regstrGbCd: p.regstrGbCd,
        mainPurpsCd: p.mainPurpsCd,
        mainPurpsCdNm: p.mainPurpsCdNm,
        etcPurps: p.etcPurps,
    };
}

function input(over: Partial<HousingClassifierInput> = {}): HousingClassifierInput {
    return { titleRows: [], rootIdentities: ['ROOT-1'], ...over };
}

// ── 공식 pair (§9.2 결정표 상단) ──────────────────────────────────

test('단독주택 exact pair → LADFRL/DETACHED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED)] }));
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LADFRL');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'DETACHED');
    assert.equal(r.kind === 'CLASSIFIED' && r.regstrGbCd, '1');
});

test('다가구주택 exact pair → LADFRL/MULTIFAMILY', () => {
    const r = classifyHousingType(input({ titleRows: [row(MULTIFAMILY), row(MULTIFAMILY)] }));
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LADFRL');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIFAMILY');
});

test('다세대주택 exact pair → LDAREG/MULTIPLEX', () => {
    const r = classifyHousingType(input({ titleRows: [row(MULTIPLEX)] }));
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
    assert.equal(r.kind === 'CLASSIFIED' && r.regstrGbCd, '2');
});

test('집합/공동주택 + 기타용도 다세대주택 exact token → LDAREG/MULTIPLEX', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                row({
                    ...LIVE_MULTIPLEX,
                    etcPurps: '공동주택(다세대주택)',
                }),
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIPLEX');
});

test('기타용도 lookalike substring은 다세대주택 신호로 분류하지 않는다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                row({
                    ...LIVE_MULTIPLEX,
                    etcPurps: '비다세대주택형',
                }),
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    // 02000 pair는 규모 기준 대체 경로를 가지므로, 토큰 lookalike + 규모 값 부재는
    // 규모 근거 부재 사유로 닫힌다. issue code는 BUILDING_CLASSIFICATION_CONFLICT 그대로다.
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EVIDENCE_MISSING'
    );
});

test('다세대주택과 아파트·근린생활시설 co-signal은 혼재 분류로 차단한다', () => {
    for (const etcPurps of [
        '공동주택(다세대주택,아파트)',
        '공동주택(다세대주택,근린생활시설)',
    ]) {
        const r = classifyHousingType(
            input({
                titleRows: [
                    row({
                        ...LIVE_MULTIPLEX,
                        etcPurps,
                    }),
                ],
            })
        );
        assert.equal(r.kind, 'REVIEW_REQUIRED');
        assert.equal(
            r.kind === 'REVIEW_REQUIRED' && r.reason,
            'CONTRADICTORY_OTHER_PURPOSE_SIGNAL'
        );
    }
});

// ── 미지원·비주거 (§9.2) ─────────────────────────────────────────

test('아파트·연립·다중은 REVIEW_REQUIRED / UNSUPPORTED_HOUSING_TYPE', () => {
    for (const name of ['아파트', '연립주택', '다중주택']) {
        const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '2', mainPurpsCd: '09999', mainPurpsCdNm: name })] }));
        assert.equal(r.kind, 'REVIEW_REQUIRED');
        assert.equal(r.kind === 'REVIEW_REQUIRED' && r.issue, 'UNSUPPORTED_HOUSING_TYPE');
    }
});

test('비주거·복합용도(allowlist·unsupported 어디에도 없음)는 CLASSIFICATION_CONFLICT', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: '03000', mainPurpsCdNm: '제1종근린생활시설' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.issue, 'BUILDING_CLASSIFICATION_CONFLICT');
});

// ── 혼재·불일치 차단 (§9.2) ──────────────────────────────────────

test('일반·집합 혼재(regstrGbCd 다름)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED), row(MULTIPLEX)] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'MIXED_REGISTER_GB');
});

test('purpose pair 혼재(단독+다가구)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED), row(MULTIFAMILY)] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'MIXED_PURPOSE_PAIR');
});

test('code/name 불일치(코드는 단독인데 명칭 다름)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: DETACHED.mainPurpsCd, mainPurpsCdNm: '창고' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
});

test('regstrGbCd가 용도와 불일치(다세대인데 일반)는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: MULTIPLEX.mainPurpsCd, mainPurpsCdNm: MULTIPLEX.mainPurpsCdNm })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
});

test('빈 코드·명칭은 REVIEW_REQUIRED / EMPTY', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: '', mainPurpsCdNm: '단독주택' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'EMPTY_PURPOSE_CODE_OR_NAME');
});

test('root 관리번호 여러 개는 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [row(DETACHED)], rootIdentities: ['ROOT-1', 'ROOT-2'] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'MULTIPLE_ROOT_IDENTITIES');
});

test('title row 없음(TITLE_COMPLETE_ZERO)은 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(input({ titleRows: [] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(r.kind === 'REVIEW_REQUIRED' && r.reason, 'NO_TITLE_ROWS');
});

test('substring 분류 금지: mainPurpsCdNm에 "주택" 포함되어도 allowlist 아니면 미분류', () => {
    const r = classifyHousingType(input({ titleRows: [row({ regstrGbCd: '1', mainPurpsCd: '01000', mainPurpsCdNm: '단독주택형 기타' })] }));
    assert.equal(r.kind, 'REVIEW_REQUIRED');
});

// ── §6 법정 규모 기준 (건축법 시행령 별표1) ────────────────────────────

test('02000 공동주택 pair는 토큰이 없어도 지상 4층·연면적 660㎡ 이하면 다세대로 인정한다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIPLEX');
    assert.equal(r.kind === 'CLASSIFIED' && r.regstrGbCd, '2');
});

test('02000 공동주택 pair는 지상 5층 이상이면 아파트 배제로 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '5',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    );
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.issue,
        'BUILDING_CLASSIFICATION_CONFLICT'
    );
});

test('02000 공동주택 pair는 연면적 660㎡ 초과면 연립주택 배제로 REVIEW_REQUIRED', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '4',
                    totArea: '660.01',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    );
});

test('02000 공동주택 pair는 규모 경계값(4층·정확히 660㎡)을 이하로 인정한다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: 4,
                    totArea: 660,
                },
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
});

test('02000 공동주택 pair는 규모 값 누락·비숫자·음수를 0으로 보정하지 않고 REVIEW_REQUIRED', () => {
    const cases: Array<Record<string, unknown>> = [
        {},
        { grndFlrCnt: '4' },
        { totArea: '513.06' },
        { grndFlrCnt: '', totArea: '513.06' },
        { grndFlrCnt: '4', totArea: '' },
        { grndFlrCnt: '4층', totArea: '513.06' },
        { grndFlrCnt: '4', totArea: '513.06㎡' },
        { grndFlrCnt: '-1', totArea: '513.06' },
        { grndFlrCnt: '4', totArea: '-1' },
        { grndFlrCnt: '4', totArea: '0' },
        { grndFlrCnt: '4.5', totArea: '513.06' },
        { grndFlrCnt: null, totArea: null },
    ];
    for (const scale of cases) {
        const r = classifyHousingType(
            input({
                titleRows: [
                    {
                        ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                        ...scale,
                    },
                ],
            })
        );
        assert.equal(
            r.kind,
            'REVIEW_REQUIRED',
            `규모 값 ${JSON.stringify(scale)} 은 인정하지 않는다`
        );
        assert.equal(
            r.kind === 'REVIEW_REQUIRED' && r.reason,
            'HOUSING_SCALE_EVIDENCE_MISSING',
            `규모 값 ${JSON.stringify(scale)} 사유`
        );
    }
});

test('규모 기준은 모순 신호를 덮지 않는다 — 아파트 토큰은 규모가 맞아도 차단', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({
                        ...LIVE_MULTIPLEX,
                        etcPurps: '공동주택(아파트)',
                    }),
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'CONTRADICTORY_OTHER_PURPOSE_SIGNAL'
    );
});

test('부속용도 다세대주택 토큰 경로는 규모 값이 없어도 그대로 인정한다(§6.5)', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                row({
                    ...LIVE_MULTIPLEX,
                    etcPurps: '공동주택(다세대주택)',
                }),
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LDAREG');
});

test('02003 다세대주택 pair는 규모 검사 없이 통과한다(§6.4)', () => {
    const r = classifyHousingType(
        input({ titleRows: [row(MULTIPLEX)] })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.category, 'MULTIPLEX');
});

test('규모 기준은 02000 pair 외 다른 pair 판정에 관여하지 않는다(§6.4)', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row(DETACHED),
                    grndFlrCnt: '99',
                    totArea: '99999',
                },
            ],
        })
    );
    assert.equal(r.kind, 'CLASSIFIED');
    assert.equal(r.kind === 'CLASSIFIED' && r.family, 'LADFRL');
});

test('여러 표제부 행 중 하나라도 규모 상한을 넘으면 인정하지 않는다', () => {
    const r = classifyHousingType(
        input({
            titleRows: [
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '4',
                    totArea: '513.06',
                },
                {
                    ...row({ ...LIVE_MULTIPLEX, etcPurps: '공동주택' }),
                    grndFlrCnt: '6',
                    totArea: '513.06',
                },
            ],
        })
    );
    assert.equal(r.kind, 'REVIEW_REQUIRED');
    assert.equal(
        r.kind === 'REVIEW_REQUIRED' && r.reason,
        'HOUSING_SCALE_EXCEEDS_MULTIPLEX_LIMIT'
    );
});
