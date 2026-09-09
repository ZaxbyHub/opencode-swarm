import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	cleanupTempRoots,
	fakeBunBody,
	fakeGhBody,
	fakeOpenCodeBody,
	installFakeBinary,
	installTraceOpenCode,
	makePatch,
	makeRemoteFixture,
	makeTempRoot,
	prependPath,
	readOutputFile,
	runGit,
	withEnvironment,
} from './github-action-test-helpers';

afterEach(cleanupTempRoots);
const ACTION_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const ACTION_REF = runGit(ACTION_ROOT, 'rev-parse', 'HEAD');

function binary(binDir: string, name: string): string {
	return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

function normalizeText(value: string): string {
	return value.replace(/\r\n/g, '\n');
}

function prepareEnvironment(
	workspace: string,
	baseSha: string,
	binDir: string,
	output: string,
	root: string,
	trace?: { binary: string; script: string },
) {
	return {
		GITHUB_WORKSPACE: workspace,
		GITHUB_REPOSITORY: 'owner/repository',
		GITHUB_OUTPUT: output,
		SWARM_ACTION_MODE: 'prepare',
		SWARM_ACTION_REPOSITORY: 'owner/repository',
		SWARM_ACTION_ISSUE_NUMBER: '2498',
		SWARM_ACTION_ISSUE_TITLE: 'transport fixture',
		SWARM_ACTION_ISSUE_BODY: 'untrusted issue body',
		SWARM_ACTION_DELIVERY_ID: 'delivery-transport',
		SWARM_ACTION_LABEL: 'swarm-auto',
		SWARM_ACTION_LABELER: 'trusted-maintainer',
		SWARM_ACTION_BASE_SHA: baseSha,
		SWARM_ACTION_BASE_BRANCH: 'main',
		SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
		SWARM_ACTION_MAX_ATTEMPTS: '1',
		SWARM_ACTION_DEADLINE_MS: '120000',
		SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
		SWARM_ACTION_BUN_VERSION: '1.3.14',
		SWARM_ACTION_PLUGIN_REF: ACTION_REF,
		GITHUB_ACTION_PATH: ACTION_ROOT,
		GITHUB_ACTION_REF: ACTION_REF,
		SWARM_ACTION_OPENCODE_BIN: trace?.binary ?? binary(binDir, 'fake-opencode'),
		SWARM_ACTION_BUN_BIN: binary(binDir, 'fake-bun'),
		SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
		FAKE_ARGS_LOG: path.join(root, 'prepare.args'),
		FAKE_ENV_LOG: path.join(root, 'prepare.env'),
		FAKE_AGENT_OUTPUT: JSON.stringify({
			sessionID: 'transport-session',
			stages: ['all'],
		}),
		FAKE_OPENCODE_VERSION: '1.18.26',
		FAKE_BUN_VERSION: '1.3.14',
		FAKE_NODE: process.execPath,
		FAKE_SCRIPT: trace?.script ?? '',
		FAKE_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		PATH: prependPath(binDir),
	};
}

function publishEnvironment(
	workspace: string,
	baseSha: string,
	binDir: string,
	output: string,
	root: string,
) {
	const emptyGitConfig = path.join(root, 'empty-gitconfig');
	if (!fs.existsSync(emptyGitConfig)) fs.writeFileSync(emptyGitConfig, '');
	return {
		GITHUB_WORKSPACE: workspace,
		GITHUB_REPOSITORY: 'owner/repository',
		GITHUB_OUTPUT: output,
		GITHUB_STEP_SUMMARY: path.join(root, 'step-summary.md'),
		GITHUB_RUN_ID: 'local-run',
		GITHUB_RUN_ATTEMPT: '1',
		SWARM_ACTION_MODE: 'publish',
		SWARM_ACTION_REPOSITORY: 'owner/repository',
		SWARM_ACTION_ISSUE_NUMBER: '2498',
		SWARM_ACTION_DELIVERY_ID: 'delivery-transport',
		SWARM_ACTION_BASE_SHA: baseSha,
		SWARM_ACTION_BASE_BRANCH: 'main',
		SWARM_ACTION_EXPECTED_BASE_SHA: baseSha,
		SWARM_ACTION_EXPECTED_RUN_ID: 'local-run',
		SWARM_ACTION_OVERSIGHT_STATUS: 'approved',
		SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
		SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
		SWARM_ACTION_BUN_VERSION: '1.3.14',
		SWARM_ACTION_PLUGIN_REF: ACTION_REF,
		GITHUB_ACTION_PATH: ACTION_ROOT,
		GITHUB_ACTION_REF: ACTION_REF,
		SWARM_ACTION_OPENCODE_BIN: binary(binDir, 'fake-opencode-trace'),
		FAKE_OPENCODE_VERSION: '1.18.26',
		FAKE_NODE: process.execPath,
		FAKE_SCRIPT: path.join(root, 'fake-opencode-trace.mjs'),
		FAKE_ARGS_LOG: path.join(root, 'publish.args'),
		FAKE_ENV_LOG: path.join(root, 'publish.env'),
		SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
		SWARM_ACTION_PUBLICATION_TOKEN: 'PUBLISH_TOKEN_2498',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: emptyGitConfig,
		GIT_CONFIG_SYSTEM: path.join(root, 'missing-gitconfig'),
		FAKE_GH_LOG: path.join(root, 'gh.log'),
		FAKE_GH_PR_URL: 'https://github.com/owner/repository/pull/42',
		FAKE_GH_PR_LIST: '',
		FAKE_GH_PR_JSON: '',
		FAKE_GH_PR_AFTER_CREATE_JSON: JSON.stringify([
			{
				number: 42,
				url: 'https://github.com/owner/repository/pull/42',
				headRefName: 'swarm/issue-2498',
				headRefOid: '',
				baseRefName: 'main',
				baseRefOid: baseSha,
			},
		]),
		FAKE_GH_STATE: path.join(root, 'gh-state'),
		PATH: prependPath(binDir),
	};
}

function runRunnerProcess(environment: Record<string, string>): {
	code: number;
	stdout: string;
	stderr: string;
} {
	const runner = path.resolve(
		import.meta.dir,
		'..',
		'..',
		'..',
		'scripts',
		'github-action',
		'runner.mjs',
	);
	const result = Bun.spawnSync({
		cmd: [process.execPath, runner],
		cwd: environment.GITHUB_WORKSPACE,
		env: { ...process.env, ...environment },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 60_000,
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe('issue #2498 — canonical patch transport through registered modes', () => {
	test(
		'applies new, modified, deleted, renamed, binary, and mode changes in a fresh checkout',
		{ timeout: 120_000 },
		async () => {
			const root = makeTempRoot();
			const fixture = makeRemoteFixture(root);
			runGit(fixture.fresh, 'config', 'core.autocrlf', 'false');
			runGit(fixture.fresh, 'config', 'core.filemode', 'true');
			runGit(fixture.fresh, 'reset', '--hard', '-q', fixture.baseSha);
			runGit(fixture.seed, 'config', 'core.filemode', 'true');
			makePatch(fixture.seed, fixture.baseSha);
			runGit(fixture.seed, 'reset', '-q');
			runGit(fixture.seed, 'update-index', '--chmod=+x', 'mode.sh');
			const trace = installTraceOpenCode(root);
			const binDir = trace.binDir;
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			installFakeBinary(root, 'gh', fakeGhBody());
			const runAction = await loadEnvironmentRunner();
			const prepareOutput = path.join(root, 'prepare-output');
			const prepareCode = await withEnvironment(
				prepareEnvironment(
					fixture.seed,
					fixture.baseSha,
					binDir,
					prepareOutput,
					root,
					trace,
				),
				runAction,
			);
			expect(prepareCode).toBe(0);
			const artifact = path.join(
				fixture.seed,
				'.swarm',
				'github-action',
				'artifact.json',
			);
			expect(fs.existsSync(artifact)).toBe(true);
			fs.mkdirSync(
				path.dirname(
					path.join(fixture.fresh, '.swarm', 'github-action', 'artifact.json'),
				),
				{ recursive: true },
			);
			fs.copyFileSync(
				artifact,
				path.join(fixture.fresh, '.swarm', 'github-action', 'artifact.json'),
			);
			const publishOutput = path.join(root, 'publish-output');
			const publishCode = await withEnvironment(
				publishEnvironment(
					fixture.fresh,
					fixture.baseSha,
					binDir,
					publishOutput,
					root,
				),
				runAction,
			);
			expect(publishCode).toBe(0);
			expect(
				normalizeText(
					fs.readFileSync(path.join(fixture.fresh, 'modified.txt'), 'utf8'),
				),
			).toBe('modified\n');
			expect(
				normalizeText(
					fs.readFileSync(path.join(fixture.fresh, 'new.txt'), 'utf8'),
				),
			).toBe('new file\n');
			expect(fs.existsSync(path.join(fixture.fresh, 'deleted.txt'))).toBe(
				false,
			);
			expect(fs.existsSync(path.join(fixture.fresh, 'rename-before.txt'))).toBe(
				false,
			);
			expect(
				normalizeText(
					fs.readFileSync(path.join(fixture.fresh, 'rename-after.txt'), 'utf8'),
				),
			).toBe('rename me\n');
			expect([
				...fs.readFileSync(path.join(fixture.fresh, 'binary.dat')),
			]).toEqual([0, 9, 8, 7, 255]);
			if (process.platform !== 'win32') {
				const transportPatch = Buffer.from(
					(
						JSON.parse(fs.readFileSync(artifact, 'utf8')) as {
							transport: { patchBase64: string };
						}
					).transport.patchBase64,
					'base64',
				).toString('utf8');
				expect(transportPatch).toContain('old mode 100644');
				expect(transportPatch).toContain('new mode 100755');
			}
			expect(
				runGit(fixture.fresh, 'status', '--porcelain', '--untracked-files=no'),
			).toBe('');
			const output = readOutputFile(publishOutput);
			expect(output.status).toBe('published');
			expect(output['pr-url']).toBe(
				'https://github.com/owner/repository/pull/42',
			);
			expect(output['pr-number']).toBe('42');
			expect(output.summary).toContain('gated publication');
			expect(
				fs.readFileSync(path.join(root, 'step-summary.md'), 'utf8'),
			).toContain('42');
			expect(fs.readFileSync(path.join(root, 'gh.log'), 'utf8')).not.toContain(
				'PUBLISH_TOKEN_2498',
			);
			expect(fs.existsSync(path.join(root, 'publish.env'))).toBe(false);
		},
	);

	test(
		'a second process reuses a remote branch and PR without re-pushing it',
		{ timeout: 120_000 },
		async () => {
			const root = makeTempRoot();
			const fixture = makeRemoteFixture(root);
			runGit(fixture.fresh, 'config', 'core.autocrlf', 'false');
			runGit(fixture.fresh, 'config', 'core.filemode', 'true');
			runGit(fixture.fresh, 'reset', '--hard', '-q', fixture.baseSha);
			runGit(fixture.seed, 'config', 'core.filemode', 'true');
			makePatch(fixture.seed, fixture.baseSha);
			runGit(fixture.seed, 'reset', '-q');
			runGit(fixture.seed, 'update-index', '--chmod=+x', 'mode.sh');
			const trace = installTraceOpenCode(root);
			const binDir = trace.binDir;
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			installFakeBinary(root, 'gh', fakeGhBody());
			const runAction = await loadEnvironmentRunner();
			const prepared = await withEnvironment(
				prepareEnvironment(
					fixture.seed,
					fixture.baseSha,
					binDir,
					path.join(root, 'prepare'),
					root,
					trace,
				),
				runAction,
			);
			expect(prepared).toBe(0);
			const artifact = path.join(
				fixture.seed,
				'.swarm',
				'github-action',
				'artifact.json',
			);
			const firstArtifact = path.join(
				fixture.fresh,
				'.swarm',
				'github-action',
				'artifact.json',
			);
			fs.mkdirSync(path.dirname(firstArtifact), { recursive: true });
			fs.copyFileSync(artifact, firstArtifact);
			const first = await withEnvironment(
				publishEnvironment(
					fixture.fresh,
					fixture.baseSha,
					binDir,
					path.join(root, 'first'),
					root,
				),
				runAction,
			);
			expect(first).toBe(0);
			const duplicate = path.join(root, 'duplicate');
			runGit(root, 'clone', '-q', '-b', 'main', fixture.origin, duplicate);
			const duplicateArtifact = path.join(
				duplicate,
				'.swarm',
				'github-action',
				'artifact.json',
			);
			fs.mkdirSync(path.dirname(duplicateArtifact), { recursive: true });
			fs.copyFileSync(artifact, duplicateArtifact);
			const duplicateResult = runRunnerProcess({
				...publishEnvironment(
					duplicate,
					fixture.baseSha,
					binDir,
					path.join(root, 'duplicate-output'),
					root,
				),
				FAKE_GH_PR_JSON: JSON.stringify([
					{
						number: 42,
						url: 'https://github.com/owner/repository/pull/42',
						headRefName: 'swarm/issue-2498',
						headRefOid: runGit(
							duplicate,
							'ls-remote',
							'origin',
							'refs/heads/swarm/issue-2498',
						).split(/\s+/)[0],
						baseRefName: 'main',
						baseRefOid: fixture.baseSha,
					},
				]),
				FAKE_GH_LOG: path.join(root, 'duplicate-gh.log'),
			});
			expect(duplicateResult.code).toBe(0);
			expect(readOutputFile(path.join(root, 'duplicate-output')).status).toBe(
				'reused',
			);
			expect(runGit(duplicate, 'rev-parse', 'HEAD')).toBe(fixture.baseSha);
		},
	);

	test(
		'recovers an orphaned verified branch by creating its missing PR without rewriting it',
		{ timeout: 120_000 },
		async () => {
			const root = makeTempRoot();
			const fixture = makeRemoteFixture(root);
			runGit(fixture.fresh, 'config', 'core.autocrlf', 'false');
			runGit(fixture.fresh, 'config', 'core.filemode', 'true');
			runGit(fixture.fresh, 'reset', '--hard', '-q', fixture.baseSha);
			runGit(fixture.seed, 'config', 'core.filemode', 'true');
			makePatch(fixture.seed, fixture.baseSha);
			runGit(fixture.seed, 'reset', '-q');
			runGit(fixture.seed, 'update-index', '--chmod=+x', 'mode.sh');
			const trace = installTraceOpenCode(root);
			const binDir = trace.binDir;
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			installFakeBinary(root, 'gh', fakeGhBody());
			const runAction = await loadEnvironmentRunner();
			const prepared = await withEnvironment(
				prepareEnvironment(
					fixture.seed,
					fixture.baseSha,
					binDir,
					path.join(root, 'prepare'),
					root,
					trace,
				),
				runAction,
			);
			expect(prepared).toBe(0);
			const artifact = path.join(
				fixture.seed,
				'.swarm',
				'github-action',
				'artifact.json',
			);
			const payload = JSON.parse(fs.readFileSync(artifact, 'utf8')) as {
				transport: { patchBase64: string };
			};
			const orphan = path.join(root, 'orphan');
			runGit(root, 'clone', '-q', '-b', 'main', fixture.origin, orphan);
			runGit(orphan, 'switch', '-c', 'swarm/issue-2498');
			const patchFile = path.join(root, 'orphan.patch');
			fs.writeFileSync(
				patchFile,
				Buffer.from(payload.transport.patchBase64, 'base64'),
			);
			runGit(orphan, 'apply', '--binary', patchFile);
			if (process.platform !== 'win32') {
				fs.chmodSync(path.join(orphan, 'mode.sh'), 0o755);
				runGit(orphan, 'update-index', '--chmod=+x', 'mode.sh');
			}
			runGit(orphan, 'add', '--all');
			runGit(orphan, 'commit', '-q', '-m', 'orphaned verified branch');
			runGit(
				orphan,
				'push',
				'-q',
				'origin',
				'HEAD:refs/heads/swarm/issue-2498',
			);
			const orphanSha = runGit(orphan, 'rev-parse', 'HEAD');
			const recovery = path.join(root, 'recovery');
			runGit(root, 'clone', '-q', '-b', 'main', fixture.origin, recovery);
			const recoveryArtifact = path.join(
				recovery,
				'.swarm',
				'github-action',
				'artifact.json',
			);
			fs.mkdirSync(path.dirname(recoveryArtifact), { recursive: true });
			fs.copyFileSync(artifact, recoveryArtifact);
			const recovered = runRunnerProcess({
				...publishEnvironment(
					recovery,
					fixture.baseSha,
					binDir,
					path.join(root, 'recovery-output'),
					root,
				),
				FAKE_GH_PR_LIST: '',
				FAKE_GH_PR_URL: 'https://github.com/owner/repository/pull/44',
				FAKE_GH_PR_AFTER_CREATE_JSON: JSON.stringify([
					{
						number: 44,
						url: 'https://github.com/owner/repository/pull/44',
						headRefName: 'swarm/issue-2498',
						headRefOid: orphanSha,
						baseRefName: 'main',
						baseRefOid: fixture.baseSha,
					},
				]),
			});
			expect(recovered.code).toBe(0);
			expect(readOutputFile(path.join(root, 'recovery-output'))['pr-url']).toBe(
				'https://github.com/owner/repository/pull/44',
			);
			expect(runGit(orphan, 'rev-parse', 'HEAD')).toBe(orphanSha);
		},
	);
});
