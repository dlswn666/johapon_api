import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import {
    formatLegalMcpRegistryCliResultV1,
    legalMcpRegistryCliExitCodeV1,
    runLegalMcpRegistryCliV1,
} from '../src/cli/legal-mcp-registry';
import { parseLegalMcpTokenRegistryJson } from '../src/middleware/legal-mcp-token-registry';
import {
    LegalMcpRegistryCommitStateUnknownError,
} from '../src/services/legal-research/mcp-token-registry-operator';

const cleanupRoots: string[] = [];

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function registryFile(): { root: string; filePath: string } {
    const root = realpathSync.native(
        mkdtempSync(path.join(tmpdir(), 'legal-mcp-registry-cli-'))
    );
    chmodSync(root, 0o700);
    cleanupRoots.push(root);
    const filePath = path.join(root, 'clients.json');
    writeFileSync(filePath, JSON.stringify({
        version: 1,
        clients: [{ clientId: 'client-one', tokenSha256: digest('one') }],
    }), { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
    return { root, filePath };
}

afterEach(() => {
    while (cleanupRoots.length > 0) {
        rmSync(cleanupRoots.pop() as string, { recursive: true, force: true });
    }
});

describe('법률 MCP file registry CLI', { concurrency: false }, () => {
    it('validate stdout은 workflow가 파싱할 단일 clientCount 행이다', async () => {
        const { filePath } = registryFile();
        assert.equal(
            await runLegalMcpRegistryCliV1(['validate', '--path', filePath]),
            'clientCount=1'
        );
        assert.equal(formatLegalMcpRegistryCliResultV1({
            action: 'validate',
            clientCount: 12,
        }), 'clientCount=12');
    });

    it('matches-env stdout도 workflow가 파싱할 단일 clientCount 행이다', async () => {
        const { filePath } = registryFile();
        const previous = process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON;
        process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{ clientId: 'client-one', tokenSha256: digest('one') }],
        });
        try {
            assert.equal(
                await runLegalMcpRegistryCliV1(['matches-env', '--path', filePath]),
                'clientCount=1'
            );
        } finally {
            if (previous === undefined) delete process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON;
            else process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('list는 count와 clientId만 출력하고 digest는 출력하지 않는다', async () => {
        const { filePath } = registryFile();
        const output = await runLegalMcpRegistryCliV1(['list', '--path', filePath]);
        assert.equal(output, 'action=list clientCount=1\nclientId=client-one');
        assert.equal(output.includes(digest('one')), false);
        assert.equal(output.includes('tokenSha256'), false);
    });

    it('add는 tokenSha256를 stdin 한 줄로만 받고 민감값을 출력하지 않는다', () => {
        const { filePath } = registryFile();
        const addedDigest = digest('two');
        const cliPath = path.resolve('src/cli/legal-mcp-registry.ts');
        const invocation = spawnSync(process.execPath, [
            '--import',
            'tsx',
            cliPath,
            'add',
            '--path',
            filePath,
            '--client-id',
            'client-two',
        ], {
            cwd: process.cwd(),
            encoding: 'utf8',
            input: `${addedDigest}\n`,
            env: { ...process.env },
        });

        assert.equal(invocation.status, 0, invocation.stderr);
        assert.equal(invocation.stdout.trim(), 'action=add clientId=client-two clientCount=2');
        assert.equal(invocation.stdout.includes(addedDigest), false);
        assert.equal(invocation.stderr.includes(addedDigest), false);
        const parsed = parseLegalMcpTokenRegistryJson(readFileSync(filePath, 'utf8'));
        assert.equal(parsed.clients[1].tokenSha256, addedDigest);
    });

    it('argv의 digest option과 relative path를 거부한다', async () => {
        const { filePath } = registryFile();
        const sensitiveDigest = digest('must-not-be-an-argument');
        await assert.rejects(runLegalMcpRegistryCliV1([
            'add',
            '--path',
            filePath,
            '--client-id',
            'client-two',
            '--token-sha256',
            sensitiveDigest,
        ]), (error: unknown) => {
            assert.equal(String(error).includes(sensitiveDigest), false);
            return true;
        });
        await assert.rejects(
            runLegalMcpRegistryCliV1(['validate', '--path', 'clients.json']),
            /absolute/
        );
    });

    it('init-from-env는 digest/JSON 없이 action과 count만 출력한다', async () => {
        const root = realpathSync.native(
            mkdtempSync(path.join(tmpdir(), 'legal-mcp-registry-init-cli-'))
        );
        chmodSync(root, 0o700);
        cleanupRoots.push(root);
        const filePath = path.join(root, 'clients.json');
        const secretDigest = digest('migration-entry');
        const previous = process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON;
        process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON = JSON.stringify({
            version: 1,
            clients: [{ clientId: 'migration-one', tokenSha256: secretDigest }],
        });
        try {
            const output = await runLegalMcpRegistryCliV1([
                'init-from-env',
                '--path',
                filePath,
            ]);
            assert.equal(output, 'action=init-from-env clientCount=1');
            assert.equal(output.includes(secretDigest), false);
            assert.equal(output.includes('tokenSha256'), false);
        } finally {
            if (previous === undefined) delete process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON;
            else process.env.LEGAL_MCP_TOKEN_REGISTRY_JSON = previous;
        }
    });

    it('commit-state unknown은 CLI exit 75로 blind retry와 구분한다', async () => {
        assert.equal(
            legalMcpRegistryCliExitCodeV1(
                new LegalMcpRegistryCommitStateUnknownError()
            ),
            75
        );
        assert.equal(legalMcpRegistryCliExitCodeV1(new Error('precommit')), 1);

        const { filePath } = registryFile();
        const addedDigest = digest('commit-state-cli');
        const cliPath = path.resolve('src/cli/legal-mcp-registry.ts');
        const child = spawn(process.execPath, [
            '--import',
            'tsx',
            cliPath,
            'add',
            '--path',
            filePath,
            '--client-id',
            'client-two',
        ], {
            cwd: process.cwd(),
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end(`${addedDigest}\n`);
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const exit = new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });

        const observationDeadline = Date.now() + 5_000;
        let lockObserved = false;
        while (Date.now() < observationDeadline) {
            if (existsSync(`${filePath}.lock`)) {
                writeFileSync(path.join(`${filePath}.lock`, 'keep'), 'cli-check');
                lockObserved = true;
                break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(lockObserved, true, 'CLI operation lock을 관찰해야 한다');
        const exitCode = await exit;
        assert.equal(exitCode, 75);
        assert.equal(stdout, '');
        assert.match(stderr, /재시도하지 말고 validate\/list/);
        assert.equal(stderr.includes(addedDigest), false);
        assert.equal(readFileSync(filePath, 'utf8').includes(addedDigest), true);
    });
});
