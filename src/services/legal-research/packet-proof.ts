import { createHmac, timingSafeEqual } from 'node:crypto';

const PROOF_PREFIX = 'hmac-sha256:';

function hexToBuffer(hex: string): Buffer {
    const bytes = Buffer.alloc(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function canonicalizeJson(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('패킷에 유한하지 않은 숫자가 있습니다.');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const objectValue = value as Record<string, unknown>;
        const entries = Object.keys(objectValue)
            .filter((key) => objectValue[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(objectValue[key])}`);
        return `{${entries.join(',')}}`;
    }
    throw new Error('패킷은 JSON 값만 포함해야 합니다.');
}

function requireSigningKey(signingKey: string): Buffer {
    const normalized = signingKey.trim();
    if (!/^(?:[0-9a-f]{2}){32,}$/i.test(normalized)) {
        throw new Error('LEGAL_MCP_PACKET_SIGNING_KEY는 256-bit 이상의 hex 값이어야 합니다.');
    }
    return hexToBuffer(normalized);
}

function payload(packet: unknown, subject: string): string {
    return canonicalizeJson({ packet, subject });
}

/** MCP host가 다음 호출에서 패킷을 변경하지 않았음을 확인하기 위한 서버 HMAC입니다. */
export function createLegalPacketProofV1(
    packet: unknown,
    subject: string,
    signingKey: string
): string {
    const hmac = createHmac('sha256', requireSigningKey(signingKey));
    hmac.write(payload(packet, subject));
    const digest = hmac.digest('hex');
    return `${PROOF_PREFIX}${digest}`;
}

export function verifyLegalPacketProofV1(
    packet: unknown,
    proof: string,
    subject: string,
    signingKey: string
): boolean {
    if (!proof.startsWith(PROOF_PREFIX)) return false;
    const suppliedHex = proof.slice(PROOF_PREFIX.length);
    if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) return false;

    const expected = createLegalPacketProofV1(packet, subject, signingKey).slice(
        PROOF_PREFIX.length
    );
    const suppliedBuffer = hexToBuffer(suppliedHex);
    const expectedBuffer = hexToBuffer(expected);
    return suppliedBuffer.length === expectedBuffer.length
        && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function packetProofSubjectV1(clientId: string, tokenId?: string): string {
    return tokenId ? `${clientId}:${tokenId}` : clientId;
}
