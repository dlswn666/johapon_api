import {
    formatLocalhostProbeSummary,
    probeLocalhostLandAreaSyncApi,
} from '../operations/land-area-sync-localhost-probe';

/**
 * localhost land-area-sync API 왕복 진단 CLI.
 *
 * 컨테이너 안에서 fresh process로 실행해 무인증 /health와 인증 admissions
 * 조회의 응답 수신 여부를 exit code로 인코딩한다(0/20/30/31/40 —
 * land-area-sync-localhost-probe.ts 참조). runner 프로세스 내부 프로브와
 * 비교하면 문제 범위(프로세스 한정/서버측)를 판별할 수 있다.
 * 출력은 고정 토큰·상태코드·소요시간뿐 — 식별자를 내보내지 않는다.
 */
async function main(): Promise<void> {
    const summary = await probeLocalhostLandAreaSyncApi({
        secret: process.env.DEV_API_JWT_SECRET,
        actorAuthUserId:
            process.env.LAND_AREA_SYNC_PROBE_ACTOR_AUTH_USER_ID,
    });
    process.stdout.write(`${formatLocalhostProbeSummary(summary)}\n`);
    process.exitCode = summary.exitCode;
}

main().catch(() => {
    process.stdout.write('LAND_AREA_SYNC_PROBE_SUMMARY exit=99\n');
    process.exitCode = 99;
});
