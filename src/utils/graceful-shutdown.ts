import type { Server } from 'node:http';

export interface GracefulShutdownResultV1 {
    forced: boolean;
    results: [PromiseSettledResult<void>, PromiseSettledResult<void>] | null;
}

/**
 * HTTP listener와 MCP transport를 함께 닫되, 어느 한쪽도 무기한 종료를 막지 못하게 한다.
 */
export function closeServerAndMcpWithHardTimeoutV1(options: {
    server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;
    closeMcp: () => Promise<void>;
    timeoutMs: number;
    onForceClose?: () => void;
}): Promise<GracefulShutdownResultV1> {
    const httpClose = new Promise<void>((resolve, reject) => {
        options.server.close((error?: Error) => error ? reject(error) : resolve());
    });
    options.server.closeIdleConnections();
    const mcpClose = options.closeMcp();
    const settled = Promise.allSettled([httpClose, mcpClose]) as Promise<[
        PromiseSettledResult<void>,
        PromiseSettledResult<void>,
    ]>;

    return new Promise((resolve) => {
        let finished = false;
        const hardTimeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            options.onForceClose?.();
            options.server.closeAllConnections();
            resolve({ forced: true, results: null });
        }, options.timeoutMs);

        void settled.then((results) => {
            if (finished) return;
            finished = true;
            clearTimeout(hardTimeout);
            resolve({ forced: false, results });
        });
    });
}
