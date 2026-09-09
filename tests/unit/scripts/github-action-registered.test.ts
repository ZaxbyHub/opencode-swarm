import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	ACTION_REF,
	ACTION_ROOT,
	environment,
	stageTranscript,
} from './github-action-registered-fixtures';
import {
	cleanupTempRoots,
	commitAll,
	fakeBunBody,
	fakeOpenCodeBody,
	initRepository,
	installFakeBinary,
	installTraceOpenCode,
	makeRemoteFixture,
	makeTempRoot,
	readOutputFile,
	withEnvironment,
} from './github-action-test-helpers';

afterEach(cleanupTempRoots);

describe('issue #2498 — registered prepare entrypoint', () => {
	test(
		'uses one same-session issue-trace transcript and strips every provider token from child env',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const fixture = makeRemoteFixture(root);
			fs.writeFileSync(
				path.join(fixture.fresh, 'prepared.txt'),
				'prepared by gated run\n',
			);
			const argsLog = path.join(root, 'opencode.args');
			const envLog = path.join(root, 'opencode.env');
			const output = path.join(root, 'github-output');
			const bunEnvLog = path.join(root, 'bun.env');
			const trace = installTraceOpenCode(root);
			const binDir = trace.binDir;
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const runAction = await loadEnvironmentRunner();
			const code = await withEnvironment(
				{
					...environment(
						fixture.fresh,
						binDir,
						fixture.baseSha,
						output,
						argsLog,
						envLog,
						stageTranscript(),
						trace.binary,
						trace.script,
					),
					SWARM_ACTION_PROVIDER_ENV_KEYS: 'OPENAI_API_KEY',
					OPENAI_API_KEY: 'OPENAI_SECRET_2498',
					FAKE_BUN_ENV_LOG: bunEnvLog,
				},
				runAction,
			);
			expect(code).toBe(0);
			const args = fs.readFileSync(argsLog, 'utf8');
			const argvLines = args
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line) as string[]);
			const issueTraceArgs = argvLines.find((argv) =>
				argv.includes('--command'),
			);
			expect(issueTraceArgs).toEqual([
				'run',
				'--format',
				'json',
				'--model',
				'opencode/big-pickle',
				'--agent',
				'architect',
				'--command',
				'swarm',
				'--dir',
				fixture.fresh,
				'--',
				'issue',
				'https://github.com/owner/repository/issues/2498',
				'--trace',
			]);
			const childEnv = fs.readFileSync(envLog, 'utf8');
			expect(
				argvLines.filter((argv) => argv.includes('--session')).length,
			).toBe(4);
			expect(childEnv).toContain(
				'publication= gh= github= provider= openai=OPENAI_SECRET_2498',
			);
			expect(childEnv).not.toContain('WRITE_TOKEN_MUST_NOT_REACH_PREPARE');
			expect(childEnv).not.toContain('PROVIDER_SECRET_2498');
			expect(fs.readFileSync(bunEnvLog, 'utf8')).toMatch(/openai=\r?\n/);
			const result = readOutputFile(output);
			expect(result.status).toBe('prepared');
			expect(result['evidence-path']).toContain('.swarm');
			const artifact = JSON.parse(
				fs.readFileSync(
					path.join(fixture.fresh, '.swarm', 'github-action', 'artifact.json'),
					'utf8',
				),
			) as { evidence: string; transport: { paths: string[] } };
			expect(
				fs.readFileSync(
					path.join(fixture.fresh, '.swarm', 'github-action', 'artifact.json'),
					'utf8',
				),
			).not.toContain('OPENAI_SECRET_2498');
			const evidence = JSON.parse(artifact.evidence) as {
				stages: Array<{ stage: string; status: string }>;
				gate: string;
			};
			expect(evidence.stages).toEqual([
				{ stage: 'issue-ingestion', status: 'passed' },
				{ stage: 'specification', status: 'passed' },
				{ stage: 'planning', status: 'passed' },
				{ stage: 'gated-implementation', status: 'passed' },
				{ stage: 'independent-review', status: 'passed' },
				{ stage: 'tests', status: 'passed' },
				{ stage: 'swarm-ci', status: 'passed' },
			]);
			expect(evidence.gate).toBe('approved');
			expect(artifact.transport.paths).toContain('prepared.txt');
			expect(
				fs.existsSync(
					path.join(fixture.fresh, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(true);
		},
	);

	test(
		'rejects a configured provider key leaked through agent evidence before writing an artifact',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const fixture = makeRemoteFixture(root);
			const trace = installTraceOpenCode(root);
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const output = path.join(root, 'github-output');
			const secret = 'OPENAI_EVIDENCE_SECRET_2498';
			const runAction = await loadEnvironmentRunner();
			let code = 3;
			try {
				code = await withEnvironment(
					{
						...environment(
							fixture.fresh,
							trace.binDir,
							fixture.baseSha,
							output,
							trace.argsLog,
							trace.envLog,
							stageTranscript(),
							trace.binary,
							trace.script,
						),
						SWARM_ACTION_PROVIDER_ENV_KEYS: 'OPENAI_API_KEY',
						OPENAI_API_KEY: secret,
						FAKE_EVIDENCE: secret,
					},
					runAction,
				);
			} catch {
				// Secret-surface rejection is intentionally fail-closed.
			}
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(fixture.fresh, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
			expect(readOutputFile(output).status).not.toBe('prepared');
		},
	);

	test(
		'rejects a no-op or incomplete production stage transcript before writing an artifact',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const repo = initRepository(root, 'workspace');
			fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
			const baseSha = commitAll(repo, 'base');
			fs.writeFileSync(
				path.join(repo, 'README.md'),
				'untrusted candidate change\n',
			);
			const argsLog = path.join(root, 'opencode.args');
			const envLog = path.join(root, 'opencode.env');
			const output = path.join(root, 'github-output');
			const trace = installTraceOpenCode(root);
			const binDir = trace.binDir;
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const runAction = await loadEnvironmentRunner();
			const code = await withEnvironment(
				environment(
					repo,
					binDir,
					baseSha,
					output,
					argsLog,
					envLog,
					JSON.stringify({ sessionID: 'session-2498' }),
				),
				runAction,
			);
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(repo, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
			expect(readOutputFile(output).status).not.toBe('prepared');
		},
	);

	test(
		'blocks publication when oversight is denied or a runner-owned gate fails',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const repo = initRepository(root, 'workspace-gate');
			fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
			const baseSha = commitAll(repo, 'base');
			fs.writeFileSync(path.join(repo, 'README.md'), 'candidate\n');
			const argsLog = path.join(root, 'opencode.args');
			const envLog = path.join(root, 'opencode.env');
			const output = path.join(root, 'github-output');
			const trace = installTraceOpenCode(root);
			installFakeBinary(
				root,
				'fake-bun',
				process.platform === 'win32' ? 'exit /b 1' : 'exit 1',
			);
			const runAction = await loadEnvironmentRunner();
			const code = await withEnvironment(
				{
					...environment(
						repo,
						trace.binDir,
						baseSha,
						output,
						argsLog,
						envLog,
						stageTranscript(),
						trace.binary,
						trace.script,
					),
					SWARM_ACTION_TEST_COMMANDS: '[]',
				},
				runAction,
			);
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(repo, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
			expect(readOutputFile(output).status).not.toBe('prepared');
		},
	);

	test(
		'fails closed when the candidate patch contains a provider-secret sentinel',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const repo = initRepository(root, 'secret-workspace');
			fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
			const baseSha = commitAll(repo, 'base');
			fs.writeFileSync(path.join(repo, 'leak.txt'), 'PROVIDER_SECRET_2498\n');
			const argsLog = path.join(root, 'opencode.args');
			const envLog = path.join(root, 'opencode.env');
			const output = path.join(root, 'github-output');
			const binDir = installFakeBinary(
				root,
				'fake-opencode',
				fakeOpenCodeBody(),
			);
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const runAction = await loadEnvironmentRunner();
			let code = 3;
			try {
				code = await withEnvironment(
					{
						...environment(
							repo,
							binDir,
							baseSha,
							output,
							argsLog,
							envLog,
							stageTranscript(),
						),
						SWARM_ACTION_PROVIDER_SECRET: 'PROVIDER_SECRET_2498',
					},
					runAction,
				);
			} catch {
				// The registered function exposes the fail-closed error; the CLI maps it to 3.
			}
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(repo, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
			expect(readOutputFile(output).status).not.toBe('prepared');
		},
	);

	test(
		'fails closed when a binary candidate blob contains the configured provider secret',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const repo = initRepository(root, 'binary-secret-workspace');
			fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
			const baseSha = commitAll(repo, 'base');
			fs.writeFileSync(
				path.join(repo, 'payload.bin'),
				Buffer.concat([
					Buffer.from([0, 255, 17, 3]),
					Buffer.from('PROVIDER_SECRET_2498', 'utf8'),
					Buffer.from([0, 9, 8]),
				]),
			);
			const trace = installTraceOpenCode(root);
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const output = path.join(root, 'github-output');
			const runAction = await loadEnvironmentRunner();
			let code = 3;
			try {
				code = await withEnvironment(
					{
						...environment(
							repo,
							trace.binDir,
							baseSha,
							output,
							trace.argsLog,
							trace.envLog,
							stageTranscript(),
							trace.binary,
							trace.script,
						),
						SWARM_ACTION_PROVIDER_SECRET: 'PROVIDER_SECRET_2498',
					},
					runAction,
				);
			} catch {
				// The registered function exposes the fail-closed error; the CLI maps it to 3.
			}
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(repo, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
		},
	);
});
