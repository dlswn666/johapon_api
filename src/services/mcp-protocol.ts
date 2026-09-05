/**
 * 운영 정본과 현재 Codex가 협상하는 revision만 허용한다.
 *
 * 2025-era 요청은 route의 SDK stateless fallback에서 처리하고,
 * 2026-era 요청은 per-request envelope 경로를 그대로 사용한다.
 */
export const TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
    '2026-07-28',
    '2025-06-18',
] as const;
