import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	cleanupTempRoots,
	fakeBunBody,
	fakeGhBody,
	installFakeBinary,
	installTraceOpenCode,
	makePatch,
	makeRemoteFixture,
	makeTempRoot,
	prependPath,
	refreshArtifactDigest,
	runGit,
	withEnvironment,
} from './github-action-test-helpers';

afterAll(cleanupTempRoots);
const ACTION_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const ACTION_REF = runGit(ACTION_ROOT, 'rev-parse', 'HEAD');

function binary(binDir: string, name: string): string {
	return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

async function createPreparedFixture() {
	const root = makeTempRoot();
	const fixture = makeRemoteFixture(root);
	makePatch(fixture.seed, fixture.baseSha);
	runGit(fixture.seed, 'reset', '-q');
	const trace = installTraceOpenCode(root);
	const binDir = trace.binDir;
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
			SWARM_ACTION_ISSUE_TITLE: 'integrity fixture',
			SWARM_ACTION_ISSUE_BODY: 'untrusted body',
			SWARM_ACTION_DELIVERY_ID: 'delivery-integrity',
			SWARM_ACTION_LABEL: 'swarm-auto',
			SWARM_ACTION_LABELER: 'trusted-maintainer',
			SWARM_ACTION_BASE_SHA: fixture.baseSha,
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
			SWARM_ACTION_OPENCODE_BIN: trace.binary,
			SWARM_ACTION_BUN_BIN: binary(binDir, 'fake-bun'),
			SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
			FAKE_ARGS_LOG: path.join(root, 'prepare.args'),
			FAKE_ENV_LOG: path.join(root, 'prepare.env'),
			FAKE_AGENT_OUTPUT: JSON.stringify({ sessionID: 'integrity-session' }),
			FAKE_OPENCODE_VERSION: '1.18.26',
			FAKE_BUN_VERSION: '1.3.14',
			FAKE_BUN_ARGS_LOG: path.join(root, 'prepare-bun.args'),
			FAKE_NODE: process.execPath,
			FAKE_SCRIPT: trace.script,
			FAKE_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
			PATH: prependPath(binDir),
		},
		async () => runAction(),
	);
	expect(prepared).toBe(0);
	const artifactFile = path.join(
		fixture.seed,
		'.swarm',
		'github-action',
		'artifact.json',
	);
	const payload = JSON.parse(fs.readFileSync(artifactFile, 'utf8')) as Record<
		string,
		unknown
	>;
	const target = path.join(
		fixture.fresh,
		'.swarm',
		'github-action',
		'artifact.json',
	);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(artifactFile, target);
	fs.writeFileSync(
		path.join(fixture.fresh, 'modified.txt'),
		'attacker mutation\n',
	);
	return {
		root,
		fixture,
		binDir,
		runAction,
		payload,
		ghLog: path.join(root, 'gh.log'),
	};
}

describe('issue #2498 — artifact integrity gates before workspace mutation', () => {
	test.each([
		[
			'patch digest mismatch',
			(payload: Record<string, unknown>) => {
				const transport = payload.transport as Record<string, unknown>;
				transport.patchBase64 =
					Buffer.from('attacker patch').toString('base64');
			},
		],
		[
			'run identity mismatch',
			(payload: Record<string, unknown>) => {
				(payload.bindings as Record<string, unknown>).runId = 'attacker-run';
			},
		],
		[
			'base binding mismatch',
			(payload: Record<string, unknown>) => {
				(payload.bindings as Record<string, unknown>).baseSha = 'stale-base';
			},
		],
		[
			'OpenCode pin mismatch',
			(payload: Record<string, unknown>) => {
				(payload.bindings as Record<string, unknown>).opencodeVersion =
					'attacker-tool';
			},
		],
	])(
		'%s blocks before mutating a fresh checkout',
		{ timeout: 120_000 },
		async (_name, mutate) => {
			const prepared = await createPreparedFixture();
			mutate(prepared.payload);
			refreshArtifactDigest(prepared.payload);
			fs.writeFileSync(
				path.join(
					prepared.fixture.fresh,
					'.swarm',
					'github-action',
					'artifact.json',
				),
				`${JSON.stringify(prepared.payload, null, 2)}\n`,
			);
			const output = path.join(prepared.root, 'publish-output');
			const code = await withEnvironment(
				{
					GITHUB_WORKSPACE: prepared.fixture.fresh,
					GITHUB_REPOSITORY: 'owner/repository',
					GITHUB_OUTPUT: output,
					GITHUB_RUN_ID: 'local-run',
					GITHUB_RUN_ATTEMPT: '1',
					SWARM_ACTION_MODE: 'publish',
					SWARM_ACTION_REPOSITORY: 'owner/repository',
					SWARM_ACTION_ISSUE_NUMBER: '2498',
					SWARM_ACTION_DELIVERY_ID: 'delivery-integrity',
					SWARM_ACTION_ISSUE_URL:
						'https://github.com/owner/repository/issues/2498',
					SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
					SWARM_ACTION_BASE_SHA: prepared.fixture.baseSha,
					SWARM_ACTION_BASE_BRANCH: 'main',
					SWARM_ACTION_EXPECTED_BASE_SHA: prepared.fixture.baseSha,
					SWARM_ACTION_EXPECTED_RUN_ID: 'local-run',
					SWARM_ACTION_OVERSIGHT_STATUS: 'approved',
					SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
					SWARM_ACTION_BUN_VERSION: '1.3.14',
					SWARM_ACTION_PLUGIN_REF: ACTION_REF,
					GITHUB_ACTION_PATH: ACTION_ROOT,
					GITHUB_ACTION_REF: ACTION_REF,
					SWARM_ACTION_OPENCODE_BIN: binary(
						prepared.binDir,
						'fake-opencode-trace',
					),
					SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
					SWARM_ACTION_PUBLICATION_TOKEN: 'PUBLISH_TOKEN_2498',
					FAKE_OPENCODE_VERSION: '1.18.26',
					FAKE_NODE: process.execPath,
					FAKE_SCRIPT: path.join(prepared.root, 'fake-opencode-trace.mjs'),
					FAKE_ARGS_LOG: path.join(prepared.root, 'publish.args'),
					FAKE_ENV_LOG: path.join(prepared.root, 'publish.env'),
					FAKE_GH_LOG: prepared.ghLog,
					FAKE_GH_PR_URL: 'https://github.com/owner/repository/pull/43',
					FAKE_GH_PR_LIST: '',
					PATH: prependPath(prepared.binDir),
				},
				prepared.runAction,
			);
			expect(code).not.toBe(0);
			expect(runGit(prepared.fixture.fresh, 'rev-parse', 'HEAD')).toBe(
				prepared.fixture.baseSha,
			);
			if (fs.existsSync(prepared.ghLog))
				expect(fs.readFileSync(prepared.ghLog, 'utf8')).toBe('');
		},
	);
});
