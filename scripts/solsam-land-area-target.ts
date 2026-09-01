/**
 * 삼양동(solsam) 운영 대지권 Phase 0 캡처용 target manifest 생성기.
 *
 * digest 는 손으로 쓰지 않는다 — 러너의 canonical 생성 함수만 호출한다.
 * 읽기 전용: 운영 DB 에 SELECT 만 날린다.
 */
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

import {
    computeDevelopmentActivePnuDigest,
    computeDevelopmentTargetDigest,
    computeDevelopmentTargetV3ManifestDigest,
} from '../src/operations/development-land-area-sync-runner';

const UNION_ID = '7c35ee21-34fc-4597-84db-ee63e5b0d351';
const PNU_RE = /^[0-9]{19}$/;
const PRIVATE_DIRECTORY = '.development-land-area-evidence-capture';

async function main(): Promise<void> {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new Error('MISSING_PRODUCTION_SUPABASE_ENV');

    const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const rows: { id: string; pnu: string | null }[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await client
            .from('property_units')
            .select('id, pnu')
            .eq('union_id', UNION_ID)
            .eq('is_deleted', false)
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw new Error(`READ_FAILED: ${error.message}`);
        if (!data || data.length === 0) break;
        rows.push(...(data as { id: string; pnu: string | null }[]));
        if (data.length < pageSize) break;
    }

    const invalid = rows.filter((row) => !row.pnu || !PNU_RE.test(row.pnu));
    const activePnus = [
        ...new Set(
            rows
                .filter((row) => row.pnu && PNU_RE.test(row.pnu))
                .map((row) => row.pnu as string)
        ),
    ].sort();

    const anchors = activePnus;
    const allowedScopePnus = activePnus;
    const expectedUnionActivePropertyUnitCount = rows.length;
    const expectedPropertyUnitCount = rows.length;
    const expectedUnionActivePnuCount = activePnus.length;

    const expectedUnionActivePnuDigest = computeDevelopmentActivePnuDigest(
        'production',
        UNION_ID,
        activePnus
    );
    const scopeDigest = computeDevelopmentTargetDigest(
        'production',
        UNION_ID,
        allowedScopePnus
    );
    const manifestDigest = computeDevelopmentTargetV3ManifestDigest({
        databaseTarget: 'production',
        unionId: UNION_ID,
        anchors,
        allowedScopePnus,
        expectedUnionActivePnus: activePnus,
        expectedUnionActivePnuDigest,
        targetCount: anchors.length,
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount,
        expectedUnionActivePnuCount,
        allowManualOverwrite: true,
    });

    const manifest = {
        version: 'land-area-development-target-manifest@3',
        databaseTarget: 'production',
        unionId: UNION_ID,
        anchors,
        allowedScopePnus,
        expectedUnionActivePnus: activePnus,
        expectedUnionActivePnuDigest,
        targetCount: anchors.length,
        scopeDigest,
        manifestDigest,
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount,
        expectedUnionActivePnuCount,
        allowManualOverwrite: true,
    };

    const root = path.resolve(process.cwd(), PRIVATE_DIRECTORY);
    await mkdir(root, { mode: 0o700, recursive: true });
    await chmod(root, 0o700);
    const out = path.join(root, 'solsam-target-1-1.json');
    const handle = await open(out, 'w', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await handle.chmod(0o600);
    } finally {
        await handle.close();
    }

    console.log(
        JSON.stringify(
            {
                activeRows: rows.length,
                invalidPnuRows: invalid.length,
                invalidPnuRowIds: invalid.map((row) => row.id),
                activePnuCount: activePnus.length,
                anchorCount: anchors.length,
                scopeDigest,
                manifestDigest,
                expectedUnionActivePnuDigest,
                out,
            },
            null,
            2
        )
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
