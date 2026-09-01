import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    createLegalPacketProofV1,
    verifyLegalPacketProofV1,
} from '../src/services/legal-research/packet-proof';

const signingKey = 'a'.repeat(64);

describe('법률 근거 패킷 HMAC', () => {
    it('객체 key 순서와 무관하게 같은 proof를 만든다', () => {
        const first = createLegalPacketProofV1(
            { packetId: 'packet-1', nested: { b: 2, a: 1 } },
            'client-1',
            signingKey
        );
        const second = createLegalPacketProofV1(
            { nested: { a: 1, b: 2 }, packetId: 'packet-1' },
            'client-1',
            signingKey
        );

        assert.equal(first, second);
    });

    it('패킷이나 인증 주체가 변경되면 검증을 거부한다', () => {
        const packet = { packetId: 'packet-1', cases: [] };
        const proof = createLegalPacketProofV1(packet, 'client-1', signingKey);

        assert.equal(verifyLegalPacketProofV1(packet, proof, 'client-1', signingKey), true);
        assert.equal(
            verifyLegalPacketProofV1(
                { packetId: 'packet-1', cases: [{ caseSerialId: 'invented' }] },
                proof,
                'client-1',
                signingKey
            ),
            false
        );
        assert.equal(verifyLegalPacketProofV1(packet, proof, 'client-2', signingKey), false);
    });

    it('약한 signing key를 거부한다', () => {
        for (const invalidKey of ['too-short', 'a'.repeat(65), 'g'.repeat(64)]) {
            assert.throws(
                () => createLegalPacketProofV1({}, 'client-1', invalidKey),
                /256-bit/
            );
        }
    });
});
