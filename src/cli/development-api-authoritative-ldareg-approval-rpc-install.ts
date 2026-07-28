import path from 'node:path';
import {
    parseDevelopmentApiLdaregTarget,
    validateDevelopmentApiLdaregApprovalRequest,
    validateDevelopmentApiLdaregPrepareArtifact,
} from '../operations/development-api-authoritative-ldareg-backfill';
import { readPinnedPrivateJson } from './development-api-authoritative-ldareg-private-files';

const HEX40_RE = /^[0-9a-f]{40}$/;
const MAX_JSON_BYTES = 3 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const CREDENTIAL_ENV =
    'LDAREG_OWNER_SUPABASE_SERVICE_ROLE_KEY';
const APPROVAL_RPC =
    'replace_development_api_authoritative_ldareg_backfill_approval_v1';
export const DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL =
    'https://yxypndgipnxrdfyctmvh.supabase.co' as const;
export const DEVELOPMENT_API_LDAREG_APPROVAL_INSTALL_SENTINEL =
    'DEVELOPMENT_API_AUTHORITATIVE_LDAREG_OWNER_APPROVAL_INSTALLED';

interface Arguments {
    privateRoot: string;
    targetFile: string;
    artifactFile: string;
    requestFile: string;
    sourceReleaseSha: string;
    projectUrl: string;
}

interface Dependencies {
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    now?: Date;
    env?: NodeJS.ProcessEnv;
    readCredential?: () => Promise<string>;
    fetchImpl?: typeof fetch;
}

function parseArguments(argv: string[]): Arguments {
    if (argv.length !== 12) {
        throw new Error('APPROVAL_INSTALL_ARGUMENT_INVALID');
    }
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !flag ||
            !value ||
            ![
                '--private-root',
                '--target',
                '--artifact',
                '--request',
                '--source-release-sha',
                '--project-url',
            ].includes(flag) ||
            values.has(flag)
        ) {
            throw new Error('APPROVAL_INSTALL_ARGUMENT_INVALID');
        }
        values.set(flag, value);
    }
    const privateRoot = values.get('--private-root');
    const targetFile = values.get('--target');
    const artifactFile = values.get('--artifact');
    const requestFile = values.get('--request');
    const sourceReleaseSha = values.get('--source-release-sha');
    const projectUrl = values.get('--project-url');
    if (
        !privateRoot ||
        !targetFile ||
        !artifactFile ||
        !requestFile ||
        !sourceReleaseSha ||
        !HEX40_RE.test(sourceReleaseSha) ||
        !projectUrl ||
        new Set([targetFile, artifactFile, requestFile]).size !==
            3
    ) {
        throw new Error('APPROVAL_INSTALL_ARGUMENT_INVALID');
    }
    return {
        privateRoot: path.resolve(privateRoot),
        targetFile,
        artifactFile,
        requestFile,
        sourceReleaseSha,
        projectUrl,
    };
}

async function readCredentialFromStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        if (!Buffer.isBuffer(chunk)) {
            throw new Error('APPROVAL_CREDENTIAL_INVALID');
        }
        const buffer = chunk;
        size += buffer.byteLength;
        if (size > MAX_CREDENTIAL_BYTES) {
            throw new Error('APPROVAL_CREDENTIAL_INVALID');
        }
        chunks.push(buffer);
    }
    const combined = Buffer.concat(chunks);
    chunks.forEach((chunk) => chunk.fill(0));
    try {
        return combined.toString('utf8').trim();
    } finally {
        combined.fill(0);
    }
}

function validateCredential(value: string): string {
    if (
        value.length < 20 ||
        value.length > MAX_CREDENTIAL_BYTES ||
        /[\s\u0000-\u001f\u007f]/u.test(value)
    ) {
        throw new Error('APPROVAL_CREDENTIAL_INVALID');
    }
    return value;
}

export async function invokePinnedDevelopmentApiLdaregApprovalRpc(
    input: {
        projectUrl: string;
        approvalName: string;
        approvalArgs: Record<string, unknown>;
        credential: string;
    },
    dependencies: {
        fetchImpl?: typeof fetch;
        signal?: AbortSignal;
    } = {}
): Promise<void> {
    if (
        input.projectUrl !==
            DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL ||
        input.approvalName !== APPROVAL_RPC
    ) {
        throw new Error('APPROVAL_RPC_TARGET_REJECTED');
    }
    const credential = validateCredential(input.credential);
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const response = await fetchImpl(
        `${DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL}/rest/v1/rpc/${APPROVAL_RPC}`,
        {
            method: 'POST',
            redirect: 'error',
            headers: {
                apikey: credential,
                Authorization: `Bearer ${credential}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify(input.approvalArgs),
            signal:
                dependencies.signal ??
                AbortSignal.timeout(15_000),
        }
    );
    if (!response.ok) {
        throw new Error('APPROVAL_RPC_REJECTED');
    }
}

export async function runDevelopmentApiLdaregApprovalRpcInstaller(
    argv: string[],
    dependencies: Dependencies = {}
): Promise<number> {
    const stdout =
        dependencies.stdout ??
        ((message: string) => process.stdout.write(`${message}\n`));
    const stderr =
        dependencies.stderr ??
        ((message: string) => process.stderr.write(`${message}\n`));
    try {
        const args = parseArguments(argv);
        if (
            args.projectUrl !==
            DEVELOPMENT_API_LDAREG_DEV_PROJECT_URL
        ) {
            throw new Error('APPROVAL_PROJECT_URL_REJECTED');
        }
        const [targetRead, artifactRead, requestRead] =
            await Promise.all([
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: args.targetFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: args.artifactFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
                readPinnedPrivateJson({
                    privateRoot: args.privateRoot,
                    filename: args.requestFile,
                    maxBytes: MAX_JSON_BYTES,
                }),
            ]);
        const target =
            parseDevelopmentApiLdaregTarget(targetRead.value);
        const artifact =
            validateDevelopmentApiLdaregPrepareArtifact({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                artifact: artifactRead.value,
            });
        const request =
            validateDevelopmentApiLdaregApprovalRequest({
                target,
                expectedSourceReleaseSha:
                    args.sourceReleaseSha,
                request: requestRead.value,
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
                request.expiresAt ||
            request.ownerApproval.name !== APPROVAL_RPC
        ) {
            throw new Error(
                'APPROVAL_INSTALL_BINDING_INVALID'
            );
        }
        const env = dependencies.env ?? process.env;
        const credential = validateCredential(
            env[CREDENTIAL_ENV] ??
                (await (
                    dependencies.readCredential ??
                    readCredentialFromStdin
                )())
        );
        await invokePinnedDevelopmentApiLdaregApprovalRpc(
            {
                projectUrl: args.projectUrl,
                approvalName: request.ownerApproval.name,
                approvalArgs:
                    request.ownerApproval.args as unknown as Record<
                        string,
                        unknown
                    >,
                credential,
            },
            { fetchImpl: dependencies.fetchImpl }
        );
        stdout(
            DEVELOPMENT_API_LDAREG_APPROVAL_INSTALL_SENTINEL
        );
        return 0;
    } catch {
        stderr(
            'Development API-authoritative LDAREG owner approval installation rejected.'
        );
        return 2;
    }
}

export async function mainDevelopmentApiLdaregApprovalRpcInstaller(): Promise<void> {
    process.exitCode =
        await runDevelopmentApiLdaregApprovalRpcInstaller(
            process.argv.slice(2)
        );
}

if (require.main === module) {
    void mainDevelopmentApiLdaregApprovalRpcInstaller();
}
