import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { queueService } from '../services/queue.service';
import { createBuildInfo } from '../utils/build-info';
import {
    getLegalMcpRuntimeConfigurationStateV1,
    type LegalMcpConfigurationStateV1,
} from '../services/legal-research/mcp-config';
import {
    getGisMcpRuntimeConfigurationStateV1,
    type GisMcpConfigurationStateV1,
} from '../services/public-data-mcp/mcp-config';
import type { LegalMcpTokenRegistryFileProviderV1 } from '../middleware/legal-mcp-token-registry-file';
import type { GisMcpTokenRegistryFileProviderV1 } from '../middleware/gis-mcp-token-registry-file';

const router = Router();
let legalMcpTokenRegistryFileProvider:
    LegalMcpTokenRegistryFileProviderV1 | undefined;
let legalMcpStartupConfiguration:
    LegalMcpConfigurationStateV1 | undefined;
let gisMcpTokenRegistryFileProvider:
    GisMcpTokenRegistryFileProviderV1 | undefined;
let gisMcpStartupConfiguration:
    GisMcpConfigurationStateV1 | undefined;

/** index가 auth와 동일한 provider를 health에 연결한다. */
export function setLegalMcpHealthTokenRegistryFileProviderV1(
    provider: LegalMcpTokenRegistryFileProviderV1 | undefined,
    startupConfiguration?: LegalMcpConfigurationStateV1
): void {
    legalMcpTokenRegistryFileProvider = provider;
    legalMcpStartupConfiguration = startupConfiguration;
}

/** index가 auth와 동일한 provider를 GIS health에 연결한다. */
export function setGisMcpHealthTokenRegistryFileProviderV1(
    provider: GisMcpTokenRegistryFileProviderV1 | undefined,
    startupConfiguration?: GisMcpConfigurationStateV1
): void {
    gisMcpTokenRegistryFileProvider = provider;
    gisMcpStartupConfiguration = startupConfiguration;
}

function landAreaSyncHealthFeatures() {
    const enabled = env.LAND_AREA_SYNC_ENABLED;
    return {
        landAreaSyncEnabled: enabled,
        landAreaSyncAllowedTargetCount: enabled
            ? env.LAND_AREA_SYNC_ALLOWED_TARGETS_MANIFEST.count
            : 0,
        landAreaSyncAllowedTargetsDigest: enabled
            ? env.LAND_AREA_SYNC_ALLOWED_TARGETS_MANIFEST.digest
            : '',
    };
}

async function legalMcpHealthFeatures() {
    const configuration = await getLegalMcpRuntimeConfigurationStateV1({
        lawApiOc: env.LAW_API_OC,
        tokenSha256: env.LEGAL_MCP_TOKEN_SHA256,
        tokenRegistryJson: env.LEGAL_MCP_TOKEN_REGISTRY_JSON,
        tokenRegistryFile: env.LEGAL_MCP_TOKEN_REGISTRY_FILE,
        proxyTokenSha256: env.LEGAL_MCP_PROXY_TOKEN_SHA256,
        packetSigningKey: env.LEGAL_MCP_PACKET_SIGNING_KEY,
        allowedHosts: env.LEGAL_MCP_ALLOWED_HOSTS,
    }, legalMcpTokenRegistryFileProvider, legalMcpStartupConfiguration);
    return {
        // provider reachability가 아니라 startup 설정의 존재·형식만 나타낸다.
        legalMcpConfigurationValid: configuration.configured,
        legalMcpAuthMode: configuration.authMode,
        legalMcpAuthSource: configuration.authSource,
        legalMcpRegisteredClientCount: configuration.registeredClientCount,
        legalMcpRegisteredTokenCount: configuration.registeredTokenCount,
    };
}

async function gisMcpHealthFeatures() {
    const configuration = await getGisMcpRuntimeConfigurationStateV1({
        vworldApiKey: env.VWORLD_API_KEY,
        vworldApiDomain: env.VWORLD_API_DOMAIN,
        dataPortalApiKey: env.DATA_PORTAL_API_KEY,
        tokenSha256: env.GIS_MCP_TOKEN_SHA256,
        tokenRegistryJson: env.GIS_MCP_TOKEN_REGISTRY_JSON,
        tokenRegistryFile: env.GIS_MCP_TOKEN_REGISTRY_FILE,
        proxyTokenSha256: env.GIS_MCP_PROXY_TOKEN_SHA256,
        allowedHosts: env.GIS_MCP_ALLOWED_HOSTS,
        allowedOrigins: env.GIS_MCP_ALLOWED_ORIGINS,
        requestsPerMinute: env.GIS_MCP_REQUESTS_PER_MINUTE,
        globalRequestsPerMinute: env.GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE,
        requestDeadlineMs: env.GIS_MCP_REQUEST_DEADLINE_MS,
        maxConcurrency: env.GIS_MCP_MAX_CONCURRENCY,
        maxQueue: env.GIS_MCP_MAX_QUEUE,
    }, gisMcpTokenRegistryFileProvider, gisMcpStartupConfiguration);
    return {
        // provider 실호출 성공이 아니라 startup 설정의 존재·형식만 나타낸다.
        gisMcpConfigurationValid: configuration.configured,
        gisMcpAuthMode: configuration.authMode,
        gisMcpAuthSource: configuration.authSource,
        gisMcpRegisteredClientCount: configuration.registeredClientCount,
        gisMcpRegisteredTokenCount: configuration.registeredTokenCount,
        gisMcpProviderMode: configuration.providerMode,
    };
}

/**
 * 메모리 사용량을 바이트에서 MB로 변환
 */
function formatMemoryUsage(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/**
 * 헬스체크 엔드포인트
 * GET /health
 */
router.get('/', async (req: Request, res: Response) => {
    const memoryUsage = process.memoryUsage();
    const queueStatus = queueService.getQueueStatus();
    const buildInfo = createBuildInfo();

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        ...buildInfo,
        features: {
            ...landAreaSyncHealthFeatures(),
            ...await legalMcpHealthFeatures(),
            ...await gisMcpHealthFeatures(),
        },
        uptime: process.uptime(),
        memory: {
            heapUsed: formatMemoryUsage(memoryUsage.heapUsed),
            heapTotal: formatMemoryUsage(memoryUsage.heapTotal),
            rss: formatMemoryUsage(memoryUsage.rss),
            external: formatMemoryUsage(memoryUsage.external),
            unit: 'MB',
        },
        queue: {
            pending: queueStatus.pending,
            running: queueStatus.running,
            concurrency: queueStatus.concurrency,
            maxSize: queueStatus.maxSize,
            isFull: queueStatus.isFull,
        },
    });
});

/**
 * 상세 헬스체크 엔드포인트 (모니터링용)
 * GET /health/detailed
 */
router.get('/detailed', async (req: Request, res: Response) => {
    const memoryUsage = process.memoryUsage();
    const queueStatus = queueService.getQueueStatus();
    const cpuUsage = process.cpuUsage();
    const buildInfo = createBuildInfo();

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        ...buildInfo,
        features: {
            ...landAreaSyncHealthFeatures(),
            ...await legalMcpHealthFeatures(),
            ...await gisMcpHealthFeatures(),
        },
        node: {
            version: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        process: {
            pid: process.pid,
            uptime: process.uptime(),
            uptimeFormatted: formatUptime(process.uptime()),
        },
        memory: {
            heapUsed: formatMemoryUsage(memoryUsage.heapUsed),
            heapTotal: formatMemoryUsage(memoryUsage.heapTotal),
            rss: formatMemoryUsage(memoryUsage.rss),
            external: formatMemoryUsage(memoryUsage.external),
            arrayBuffers: formatMemoryUsage(memoryUsage.arrayBuffers || 0),
            unit: 'MB',
        },
        cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system,
        },
        queue: {
            pending: queueStatus.pending,
            running: queueStatus.running,
            concurrency: queueStatus.concurrency,
            maxSize: queueStatus.maxSize,
            isFull: queueStatus.isFull,
            available: queueStatus.maxSize - queueStatus.pending - queueStatus.running,
        },
        environment: {
            nodeEnv: process.env.NODE_ENV || 'development',
            port: process.env.PORT || 3100,
        },
    });
});

/**
 * 업타임을 사람이 읽기 쉬운 형식으로 변환
 */
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
}

export default router;
