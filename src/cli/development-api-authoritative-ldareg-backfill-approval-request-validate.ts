import path from 'node:path';
import {
    parseDevelopmentApiLdaregTarget,
    validateDevelopmentApiLdaregApprovalRequest,
    validateDevelopmentApiLdaregPrepareArtifact,
} from '../operations/development-api-authoritative-ldareg-backfill';
import { readPinnedPrivateJson } from './development-api-authoritative-ldareg-private-file';

const PRIVATE_DIRECTORY =
    '.development-api-authoritative-ldareg-backfill';
const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const HEX40_RE = /^[0-9a-f]{40}$/;
export const DEVELOPMENT_API_LDAREG_APPROVAL_VALIDATION_SENTINEL =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_APPROVAL_REQUEST_VALIDATED';

interface Arguments {
    targetPath: string;
    artifactPath: string;
    requestPath: string;
    sourceReleaseSha: string;
}

function parseArguments(argv: string[]): Arguments {
    if (argv.length !== 8) {
        throw new Error('APPROVAL_VALIDATOR_ARGUMENT_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            ![
                '--target',
                '--artifact',
                '--request',
                '--source-release-sha',
            ].includes(flag) ||
            values.has(flag)
        ) {
            throw new Error(
                'APPROVAL_VALIDATOR_ARGUMENT_INVALID'
            );
        }
        values.set(flag, value);
    }
    const targetPath = values.get('--target');
    const artifactPath = values.get('--artifact');
    const requestPath = values.get('--request');
    const sourceReleaseSha = values.get('--source-release-sha');
    if (
        !targetPath ||
        !artifactPath ||
        !requestPath ||
        !sourceReleaseSha ||
        !HEX40_RE.test(sourceReleaseSha)
    ) {
        throw new Error(
            'APPROVAL_VALIDATOR_ARGUMENT_INVALID'
        );
    }
    return {
        targetPath,
        artifactPath,
        requestPath,
        sourceReleaseSha,
    };
}

function resolvePrivateJsonPath(
    cwd: string,
    candidate: string
): string {
    const root = path.resolve(cwd, PRIVATE_DIRECTORY);
    const target = path.resolve(cwd, candidate);
    if (
        path.dirname(target) !== root ||
        !target.startsWith(`${root}${path.sep}`)
    ) {
        throw new Error('APPROVAL_VALIDATOR_PATH_INVALID');
    }
    return target;
}

export async function runDevelopmentApiLdaregApprovalValidatorCli(
    argv: string[],
    dependencies: {
        cwd?: string;
        now?: Date;
        stdout?: (message: string) => void;
        stderr?: (message: string) => void;
    } = {}
): Promise<number> {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    try {
        const args = parseArguments(argv);
        const [targetInput, artifactInput, requestInput] =
            await Promise.all([
                readPinnedPrivateJson({
                    path: resolvePrivateJsonPath(
                        cwd,
                        args.targetPath
                    ),
                    maxBytes: MAX_INPUT_BYTES,
                }),
                readPinnedPrivateJson({
                    path: resolvePrivateJsonPath(
                        cwd,
                        args.artifactPath
                    ),
                    maxBytes: MAX_INPUT_BYTES,
                }),
                readPinnedPrivateJson({
                    path: resolvePrivateJsonPath(
                        cwd,
                        args.requestPath
                    ),
                    maxBytes: MAX_INPUT_BYTES,
                }),
            ]);
        const target =
            parseDevelopmentApiLdaregTarget(targetInput);
        const artifact =
            validateDevelopmentApiLdaregPrepareArtifact({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                artifact: artifactInput,
            });
        const request =
            validateDevelopmentApiLdaregApprovalRequest({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                request: requestInput,
                now: dependencies.now,
            });
        if (
            artifact.gate.status !== 'PASS' ||
            artifact.targetDigest !==
                request.ownerApproval.args.p_target_digest ||
            artifact.proposal.digest !==
                request.ownerApproval.args
                    .p_expected_proposed_values_digest ||
            artifact.stateDigests.prestateTupleDigest !==
                request.ownerApproval.args
                    .p_expected_prestate_tuple_digest ||
            artifact.stateDigests.targetRightsDigest !==
                request.ownerApproval.args
                    .p_expected_prestate_rights_digest ||
            artifact.officialScan?.evidenceDigest !==
                request.ownerApproval.args.p_evidence_digest ||
            artifact.approvalRequest.requestDigest !==
                request.requestDigest ||
            artifact.approvalRequest.expiresAt !==
                request.expiresAt
        ) {
            throw new Error(
                'APPROVAL_VALIDATOR_ARTIFACT_BINDING_INVALID'
            );
        }
        stdout(
            DEVELOPMENT_API_LDAREG_APPROVAL_VALIDATION_SENTINEL
        );
        return 0;
    } catch {
        stderr(
            'Development API-authoritative LDAREG approval request rejected.'
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregApprovalValidatorCli(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregApprovalValidatorCli(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregApprovalValidatorCli();
}
