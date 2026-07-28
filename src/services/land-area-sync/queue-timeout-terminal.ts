/**
 * LAND_AREA_SYNC queue wall-timeout 뒤 durable terminal 보장.
 *
 * env/queue singleton과 분리한 순수 adapter라서 running worker가 drain된 뒤
 * PROCESSING 잔존만 FAILED 처리하는 동작을 독립 검증할 수 있다.
 */

import {
    readLandAreaSync,
    type LandAreaSyncJobRow,
} from './repository';

export interface TimedOutJobTerminalizer {
    readJob: () => Promise<LandAreaSyncJobRow | null>;
    markFailed: () => Promise<boolean>;
}

/**
 * 이미 commit된 terminal/APPLIED는 보존하고 PROCESSING 잔존만 조건부 FAILED로 닫는다.
 */
export async function ensureTimedOutJobHasDurableTerminal(
    terminalizer: TimedOutJobTerminalizer
): Promise<boolean> {
    const row = await terminalizer.readJob();
    const land = row ? readLandAreaSync(row) : null;
    const hasTerminal =
        row !== null &&
        (row.status !== 'PROCESSING' ||
            land?.workerFinalization?.version === 1);
    return hasTerminal ? false : terminalizer.markFailed();
}
