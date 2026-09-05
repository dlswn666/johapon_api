import {
    hostHeaderValidation,
    originValidation,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
    Router,
    json,
    type ErrorRequestHandler,
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import {
    createLegalMcpAuthMiddleware,
    type LegalMcpTokenVerifierOptions,
} from '../middleware/legal-mcp-auth';
import { createLegalMcpProxyGuardMiddleware } from '../middleware/legal-mcp-proxy-guard';
import { createLegalMcpResearchRateLimitMiddleware } from '../middleware/legal-mcp-rate-limit';
import {
    createLegalMcpServer,
    type LegalMcpServerDependencies,
} from '../services/legal-research/mcp-server';

export const LEGAL_MCP_JSON_BODY_LIMIT = '256kb' as const;

type AllowlistInput = string | readonly string[];

export class LegalMcpRouteConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LegalMcpRouteConfigurationError';
    }
}

export type LegalMcpRuntimeDependencies = Omit<
    LegalMcpServerDependencies,
    'packetSigningKey'
>;

export interface CreateLegalMcpRouteOptions
    extends LegalMcpTokenVerifierOptions {
    dependencies: LegalMcpRuntimeDependencies;
    /** 생략하면 LEGAL_MCP_ALLOWED_HOSTS의 쉼표 구분 hostname을 읽는다. */
    allowedHosts?: AllowlistInput;
    /** 서버 간 client가 Origin header를 보낼 때의 hostname. 브라우저 CORS를 활성화하지 않는다. */
    allowedOrigins?: AllowlistInput;
    /** 생략하면 LEGAL_MCP_PACKET_SIGNING_KEY를 읽는다. 누락 시 도구가 fail-closed 한다. */
    packetSigningKey?: string;
    /** 공식 법령 API를 호출하는 research tool의 bearer 세대별 분당 상한. */
    researchRequestsPerMinute?: number;
    /** 모든 bearer가 공유하는 공식 법령 API research tool의 분당 상한. */
    globalResearchRequestsPerMinute?: number;
    /** 생략하면 LEGAL_MCP_PROXY_TOKEN_SHA256을 읽는다. */
    proxyTokenSha256?: string;
    onError?: (error: Error) => void;
}

export interface LegalMcpRouteHandle {
    router: Router;
    close(): Promise<void>;
}

function splitAllowlist(input: AllowlistInput | undefined): string[] {
    const values = typeof input === 'string' ? input.split(',') : input ?? [];
    return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeHostname(value: string, settingName: string): string {
    if (value === '*' || /[\s/?#@]/.test(value) || value.includes('://')) {
        throw new LegalMcpRouteConfigurationError(
            `${settingName}에는 scheme, port, path 또는 wildcard 없이 hostname만 설정해야 합니다.`
        );
    }

    try {
        const parsed = new URL(`http://${value}`);
        if (
            parsed.port
            || parsed.username
            || parsed.password
            || parsed.hostname.toLowerCase() !== value.toLowerCase()
        ) {
            throw new Error('not a bare hostname');
        }
        return parsed.hostname.toLowerCase();
    } catch {
        throw new LegalMcpRouteConfigurationError(
            `${settingName}에는 유효한 hostname만 설정해야 합니다.`
        );
    }
}

export function parseLegalMcpHostnameAllowlist(
    input: AllowlistInput | undefined,
    settingName: string,
    allowEmpty = false
): string[] {
    const normalized = splitAllowlist(input).map((value) =>
        normalizeHostname(value, settingName)
    );
    const unique = [...new Set(normalized)];

    if (unique.length === 0 && !allowEmpty) {
        throw new LegalMcpRouteConfigurationError(
            `${settingName}에는 한 개 이상의 hostname이 필요합니다.`
        );
    }
    return unique;
}

function bodyParserErrorResponse(
    error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction
): void {
    if (response.headersSent) {
        next(error);
        return;
    }

    const errorType = typeof error === 'object' && error !== null
        ? (error as { type?: unknown }).type
        : undefined;
    const isTooLarge = errorType === 'entity.too.large';
    const isInvalidJson = errorType === 'entity.parse.failed';

    if (!isTooLarge && !isInvalidJson) {
        next(error);
        return;
    }

    response.status(isTooLarge ? 413 : 400).json({
        jsonrpc: '2.0',
        id: null,
        error: {
            code: -32600,
            message: isTooLarge
                ? 'MCP request body exceeds 256kb.'
                : 'MCP request body must be valid JSON.',
        },
    });
}

/**
 * `/mcp`에 mount할 dual-revision Streamable HTTP Router와 종료 hook을 함께 만든다.
 *
 * 예: `const legalMcp = createLegalMcpRoute(options); app.use('/mcp', legalMcp.router)`
 */
export function createLegalMcpRoute(
    options: CreateLegalMcpRouteOptions
): LegalMcpRouteHandle {
    const allowedHosts = parseLegalMcpHostnameAllowlist(
        options.allowedHosts ?? process.env.LEGAL_MCP_ALLOWED_HOSTS,
        'LEGAL_MCP_ALLOWED_HOSTS'
    );
    const allowedOrigins = parseLegalMcpHostnameAllowlist(
        options.allowedOrigins ?? process.env.LEGAL_MCP_ALLOWED_ORIGINS,
        'LEGAL_MCP_ALLOWED_ORIGINS',
        true
    );
    const packetSigningKey = options.packetSigningKey
        ?? process.env.LEGAL_MCP_PACKET_SIGNING_KEY
        ?? '';
    if (!/^(?:[0-9a-f]{2}){32,}$/i.test(packetSigningKey.trim())) {
        throw new LegalMcpRouteConfigurationError(
            'LEGAL_MCP_PACKET_SIGNING_KEY에는 256-bit 이상의 hex 값을 설정해야 합니다.'
        );
    }

    const handler = createMcpHandler(
        () => createLegalMcpServer({
            ...options.dependencies,
            packetSigningKey,
        }),
        {
            legacy: 'stateless',
            ...(options.onError ? { onerror: options.onError } : {}),
        }
    );
    const nodeHandler = toNodeHandler(
        handler,
        options.onError ? { onerror: options.onError } : undefined
    );
    const router = Router();

    // expensive parsing/auth 이전에 DNS rebinding 및 허용하지 않은 Origin header를 차단한다.
    router.use(hostHeaderValidation(allowedHosts));
    router.use(originValidation(allowedOrigins));
    router.use(createLegalMcpProxyGuardMiddleware({
        proxyTokenSha256: options.proxyTokenSha256,
    }));
    router.use(createLegalMcpAuthMiddleware({
        tokenSha256: options.tokenSha256,
        tokenRegistryJson: options.tokenRegistryJson,
        tokenRegistryFile: options.tokenRegistryFile,
        tokenRegistryFileProvider: options.tokenRegistryFileProvider,
        now: options.now,
    }));
    router.use(json({ limit: LEGAL_MCP_JSON_BODY_LIMIT, strict: true }));
    router.use(createLegalMcpResearchRateLimitMiddleware({
        perTokenRequestsPerMinute: options.researchRequestsPerMinute,
        globalRequestsPerMinute: options.globalResearchRequestsPerMinute,
    }));
    router.all('/', (request, response, next) => {
        void nodeHandler(request, response, request.body).catch(next);
    });
    router.use(bodyParserErrorResponse as ErrorRequestHandler);

    return {
        router,
        close: () => handler.close(),
    };
}
