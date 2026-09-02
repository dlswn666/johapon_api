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
    createGisMcpAuthMiddleware,
    type GisMcpTokenVerifierOptions,
} from '../middleware/gis-mcp-auth';
import { createGisMcpProxyGuardMiddleware } from '../middleware/gis-mcp-proxy-guard';
import { createGisMcpRateLimitMiddleware } from '../middleware/gis-mcp-rate-limit';
import {
    createPublicDataMcpServer,
    type PublicDataMcpServerDependencies,
} from '../services/public-data-mcp/server';

export const GIS_MCP_JSON_BODY_LIMIT = '256kb' as const;

type AllowlistInput = string | readonly string[];

export class GisMcpRouteConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GisMcpRouteConfigurationError';
    }
}

export interface CreateGisMcpRouteOptions extends GisMcpTokenVerifierOptions {
    dependencies: PublicDataMcpServerDependencies;
    allowedHosts?: AllowlistInput;
    allowedOrigins?: AllowlistInput;
    requestsPerMinute?: number;
    globalRequestsPerMinute?: number;
    proxyTokenSha256?: string;
    onError?: (error: Error) => void;
}

export interface GisMcpRouteHandle {
    router: Router;
    close(): Promise<void>;
}

function splitAllowlist(input: AllowlistInput | undefined): string[] {
    const values = typeof input === 'string' ? input.split(',') : input ?? [];
    return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeHostname(value: string, settingName: string): string {
    if (value === '*' || /[\s/?#@]/.test(value) || value.includes('://')) {
        throw new GisMcpRouteConfigurationError(
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
        throw new GisMcpRouteConfigurationError(
            `${settingName}에는 유효한 hostname만 설정해야 합니다.`
        );
    }
}

export function parseGisMcpHostnameAllowlist(
    input: AllowlistInput | undefined,
    settingName: string,
    allowEmpty = false
): string[] {
    const normalized = splitAllowlist(input).map((value) =>
        normalizeHostname(value, settingName)
    );
    const unique = [...new Set(normalized)];

    if (unique.length === 0 && !allowEmpty) {
        throw new GisMcpRouteConfigurationError(
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

/** `/gis-mcp`에 mount할 modern Streamable HTTP router와 종료 hook을 만든다. */
export function createGisMcpRoute(
    options: CreateGisMcpRouteOptions
): GisMcpRouteHandle {
    const allowedHosts = parseGisMcpHostnameAllowlist(
        options.allowedHosts ?? process.env.GIS_MCP_ALLOWED_HOSTS,
        'GIS_MCP_ALLOWED_HOSTS'
    );
    const allowedOrigins = parseGisMcpHostnameAllowlist(
        options.allowedOrigins ?? process.env.GIS_MCP_ALLOWED_ORIGINS,
        'GIS_MCP_ALLOWED_ORIGINS',
        true
    );

    const handler = createMcpHandler(
        () => createPublicDataMcpServer(options.dependencies),
        {
            legacy: 'reject',
            ...(options.onError ? { onerror: options.onError } : {}),
        }
    );
    const nodeHandler = toNodeHandler(
        handler,
        options.onError ? { onerror: options.onError } : undefined
    );
    const router = Router();

    // expensive parsing/auth 이전에 DNS rebinding과 허용하지 않은 Origin을 차단한다.
    router.use(hostHeaderValidation(allowedHosts));
    router.use(originValidation(allowedOrigins));
    router.use(createGisMcpProxyGuardMiddleware({
        proxyTokenSha256: options.proxyTokenSha256,
    }));
    router.use(createGisMcpAuthMiddleware({
        tokenSha256: options.tokenSha256,
        tokenRegistryJson: options.tokenRegistryJson,
        now: options.now,
    }));
    router.use(json({ limit: GIS_MCP_JSON_BODY_LIMIT, strict: true }));
    router.use(createGisMcpRateLimitMiddleware({
        perTokenRequestsPerMinute: options.requestsPerMinute,
        globalRequestsPerMinute: options.globalRequestsPerMinute,
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
