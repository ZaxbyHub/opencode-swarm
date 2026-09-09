import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	cleanupTempRoots,
	commitAll,
	fakeBunBody,
	fakeGhBody,
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
	return path.join(binDir, process.platform === 'win32' ? name + '.cmd' : name);
}

function copyArtifact(seed: string, workspace: string): void {
	const source = path.join(seed, '.swarm', 'github-action', 'artifact.json');
	const target = path.join(
		workspace,
		'.swarm',
		'github-action',
		'artifact.json',
	);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target);
}

async function preparedFixture() {
	const root = makeTempRoot();
	const fixture = makeRemoteFixture(root);
	makePatch(fixture.seed, fixture.baseSha);
	runGit(fixture.seed, 'reset', '-q');
	const trace = installTraceOpenCode(root);
	installFakeBinary(root, 'fake-bun', fakeBunBody());
	installFakeBinary(root, 'gh', fakeGhBody());
	const runAction = await loadEnvironmentRunner();
	const prepareOutput = path.join(root, 'prepare-output');
	const prepared = await withEnvironment(
		{
			GITHUB_WORKSPACE: fixture.seed,
			GITHUB_REPOSITORY: 'owner/repository',
			GITHUB_OUTPUT: prepareOutput,
			SWARM_ACTION_MODE: 'prepare',
			SWARM_ACTION_REPOSITORY: 'owner/repository',
			SWARM_ACTION_ISSUE_NUMBER: '2498',
			SWARM_ACTION_ISSUE_TITLE: 'regression fixture',
			SWARM_ACTION_ISSUE_BODY: 'untrusted issue body',
			SWARM_ACTION_DELIVERY_ID: 'delivery-regression',
			SWARM_ACTION_LABEL: 'swarm-auto',
			SWARM_ACTION_LABELER: 'trusted-maintainer',
			SWARM_ACTION_BASE_SHA: fixture.baseSha,
			SWARM_ACTION_BASE_BRANCH: 'main',
			SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
			SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
			SWARM_ACTION_DEADLINE_MS: '120000',
			SWARM_ACTION_MAX_ATTEMPTS: '1',
			SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
			SWARM_ACTION_BUN_VERSION: '1.3.14',
			SWARM_ACTION_PLUGIN_REF: ACTION_REF,
			GITHUB_ACTION_PATH: ACTION_ROOT,
			GITHUB_ACTION_REF: ACTION_REF,
			SWARM_ACTION_OPENCODE_BIN: trace.binary,
			SWARM_ACTION_BUN_BIN: binary(trace.binDir, 'fake-bun'),
			SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
			FAKE_ARGS_LOG: trace.argsLog,
			FAKE_ENV_LOG: trace.envLog,
			FAKE_NODE: process.execPath,
			FAKE_SCRIPT: trace.script,
			FAKE_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
			FAKE_OPENCODE_VERSION: '1.18.26',
			FAKE_BUN_VERSION: '1.3.14',
			FAKE_ISSUE_TRACE: '2498-publish-gated-action',
			PATH: prependPath(trace.binDir),
		},
		runAction,
	);
	expect(prepared).toBe(0);
	return { root, fixture, trace, runAction };
}

function publishEnvironment(
	workspace: string,
	baseSha: string,
	root: string,
	binDir: string,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		GITHUB_WORKSPACE: workspace,
		GITHUB_REPOSITORY: 'owner/repository',
		GITHUB_OUTPUT: path.join(root, 'publish-output'),
		GITHUB_STEP_SUMMARY: path.join(root, 'step-summary.md'),
		GITHUB_RUN_ID: 'local-run',
		GITHUB_RUN_ATTEMPT: '1',
		SWARM_ACTION_MODE: 'publish',
		SWARM_ACTION_REPOSITORY: 'owner/repository',
		SWARM_ACTION_ISSUE_NUMBER: '2498',
		SWARM_ACTION_DELIVERY_ID: 'delivery-regression',
		SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
		SWARM_ACTION_BASE_SHA: baseSha,
		SWARM_ACTION_BASE_BRANCH: 'main',
		SWARM_ACTION_EXPECTED_BASE_SHA: baseSha,
		SWARM_ACTION_EXPECTED_RUN_ID: 'local-run',
		SWARM_ACTION_OVERSIGHT_STATUS: 'approved',
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
		FAKE_GH_LOG: path.join(root, 'gh.log'),
		FAKE_GH_PR_URL: 'https://github.com/owner/repository/pull/52',
		FAKE_GH_PR_LIST: '',
		FAKE_GH_PR_JSON: '',
		PATH: prependPath(binDir),
		...overrides,
	};
}

function runSeparateProcess(environment: Record<string, string>): number {
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
	if (
		result.exitCode !== 0 &&
		environment.SWARM_ACTION_DELIVERY_ID === 'delivery-regression'
	) {
		console.error(new TextDecoder().decode(result.stderr));
	}
	return result.exitCode;
}

function createOrphan(prepared: Awaited<ReturnType<typeof preparedFixture>>) {
	const { root, fixture } = prepared;
	const orphan = path.join(root, 'orphan');
	runGit(root, 'clone', '-q', '-b', 'main', fixture.origin, orphan);
	runGit(orphan, 'switch', '-c', 'swarm/issue-2498');
	const payload = JSON.parse(
		fs.readFileSync(
			path.join(fixture.seed, '.swarm', 'github-action', 'artifact.json'),
			'utf8',
		),
	) as { transport: { patchBase64: string } };
	const patchFile = path.join(root, 'orphan.patch');
	fs.writeFileSync(
		patchFile,
		Buffer.from(payload.transport.patchBase64, 'base64'),
	);
	runGit(orphan, 'apply', '--binary', patchFile);
	runGit(orphan, 'add', '--all');
	runGit(orphan, 'commit', '-q', '-m', 'verified candidate');
	runGit(orphan, 'push', '-q', 'origin', 'HEAD:refs/heads/swarm/issue-2498');
	return { orphan, sha: runGit(orphan, 'rev-parse', 'HEAD') };
}

describe('issue #2498 — reviewer regressions (F3/F4/F5/F6)', () => {
	test(
		'F3: a competitor branch created at base is never fast-forwarded by a losing publisher',
		{ timeout: 60_000 },
		async () => {
			const prepared = await preparedFixture();
			copyArtifact(prepared.fixture.seed, prepared.fixture.fresh);
			const competitor = path.join(prepared.root, 'competitor');
			runGit(
				prepared.root,
				'clone',
				'-q',
				'-b',
				'main',
				prepared.fixture.origin,
				competitor,
			);
			runGit(competitor, 'switch', '-c', 'swarm/issue-2498');
			runGit(
				competitor,
				'push',
				'-q',
				'origin',
				'HEAD:refs/heads/swarm/issue-2498',
			);
			const code = runSeparateProcess(
				publishEnvironment(
					prepared.fixture.fresh,
					prepared.fixture.baseSha,
					prepared.root,
					prepared.trace.binDir,
				),
			);
			expect(code).not.toBe(0);
			expect(runGit(prepared.fixture.fresh, 'rev-parse', 'HEAD')).toBe(
				prepared.fixture.baseSha,
			);
			expect(
				runGit(
					prepared.root,
					'ls-remote',
					prepared.fixture.origin,
					'refs/heads/swarm/issue-2498',
				),
			).toContain(prepared.fixture.baseSha);
		},
	);

	test(
		'F4: an existing PR targeting the wrong base branch is never reused',
		{ timeout: 60_000 },
		async () => {
			const prepared = await preparedFixture();
			copyArtifact(prepared.fixture.seed, prepared.fixture.fresh);
			const orphan = createOrphan(prepared);
			const code = runSeparateProcess(
				publishEnvironment(
					prepared.fixture.fresh,
					prepared.fixture.baseSha,
					prepared.root,
					prepared.trace.binDir,
					{
						FAKE_GH_PR_JSON: JSON.stringify([
							{
								number: 52,
								url: 'https://github.com/owner/repository/pull/52',
								headRefName: 'swarm/issue-2498',
								headRefOid: orphan.sha,
								baseRefName: 'release',
								baseRefOid: prepared.fixture.baseSha,
							},
						]),
					},
				),
			);
			expect(code).not.toBe(0);
			expect(runGit(orphan.orphan, 'rev-parse', 'HEAD')).toBe(orphan.sha);
			expect(
				readOutputFile(path.join(prepared.root, 'publish-output')).status,
			).not.toBe('reused');
		},
	);

	test(
		'F5: a live remote base drift blocks publication before creating a branch',
		{ timeout: 60_000 },
		async () => {
			const prepared = await preparedFixture();
			copyArtifact(prepared.fixture.seed, prepared.fixture.fresh);
			const drift = path.join(prepared.root, 'drift');
			runGit(
				prepared.root,
				'clone',
				'-q',
				'-b',
				'main',
				prepared.fixture.origin,
				drift,
			);
			fs.writeFileSync(path.join(drift, 'remote-drift.txt'), 'remote drift\n');
			commitAll(drift, 'remote base drift');
			runGit(drift, 'push', '-q', 'origin', 'main');
			const code = runSeparateProcess(
				publishEnvironment(
					prepared.fixture.fresh,
					prepared.fixture.baseSha,
					prepared.root,
					prepared.trace.binDir,
				),
			);
			expect(code).not.toBe(0);
			expect(
				runGit(
					prepared.root,
					'ls-remote',
					prepared.fixture.origin,
					'refs/heads/swarm/issue-2498',
				),
			).toBe('');
		},
	);

	test(
		'F6: path substitution on a verified target is rejected',
		{ timeout: 60_000 },
		async () => {
			const prepared = await preparedFixture();
			copyArtifact(prepared.fixture.seed, prepared.fixture.fresh);
			const orphan = createOrphan(prepared);
			fs.writeFileSync(
				path.join(orphan.orphan, 'unexpected.txt'),
				'unbound path\n',
			);
			runGit(orphan.orphan, 'add', '--all');
			runGit(orphan.orphan, 'commit', '-q', '-m', 'path substitution');
			runGit(
				orphan.orphan,
				'push',
				'-q',
				'--force',
				'origin',
				'HEAD:refs/heads/swarm/issue-2498',
			);
			const code = runSeparateProcess(
				publishEnvironment(
					prepared.fixture.fresh,
					prepared.fixture.baseSha,
					prepared.root,
					prepared.trace.binDir,
				),
			);
			expect(code).not.toBe(0);
			const substitutedSha = runGit(orphan.orphan, 'rev-parse', 'HEAD');
			expect(substitutedSha).not.toBe(orphan.sha);
			expect(
				runGit(
					prepared.root,
					'ls-remote',
					prepared.fixture.origin,
					'refs/heads/swarm/issue-2498',
				),
			).toContain(substitutedSha);
		},
	);

	test(
		'F7: publication succeeds when the optional step summary path is absent',
		{ timeout: 60_000 },
		async () => {
			const prepared = await preparedFixture();
			copyArtifact(prepared.fixture.seed, prepared.fixture.fresh);
			const environment = publishEnvironment(
				prepared.fixture.fresh,
				prepared.fixture.baseSha,
				prepared.root,
				prepared.trace.binDir,
				{
					FAKE_GH_STATE: path.join(prepared.root, 'f7-gh-state'),
					FAKE_GH_PR_AFTER_CREATE_JSON: JSON.stringify([
						{
							number: 52,
							url: 'https://github.com/owner/repository/pull/52',
							headRefName: 'swarm/issue-2498',
							headRefOid: '',
							baseRefName: 'main',
							baseRefOid: prepared.fixture.baseSha,
						},
					]),
				},
			);
			environment.GITHUB_STEP_SUMMARY = '';
			const code = runSeparateProcess(environment);
			expect(code).toBe(0);
		},
	);
});
