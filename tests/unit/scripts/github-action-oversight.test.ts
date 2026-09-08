import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	cleanupTempRoots,
	fakeBunBody,
	fakeGhBody,
	installFakeBinary,
	installTraceOpenCode,
	makeRemoteFixture,
	makeTempRoot,
	prependPath,
	runGit,
	withEnvironment,
} from './github-action-test-helpers';

afterEach(cleanupTempRoots);

const ACTION_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const ACTION_REF = runGit(ACTION_ROOT, 'rev-parse', 'HEAD');

test('registered publish path refuses mutation without protected oversight', async () => {
	const root = makeTempRoot();
	const fixture = makeRemoteFixture(root);
	fs.writeFileSync(path.join(fixture.fresh, 'prepared.txt'), 'prepared\n');
	const trace = installTraceOpenCode(root);
	installFakeBinary(root, 'fake-bun', fakeBunBody());
	installFakeBinary(root, 'gh', fakeGhBody());
	const runAction = await loadEnvironmentRunner();
	const prepare = await withEnvironment(
		{
			GITHUB_WORKSPACE: fixture.fresh,
			GITHUB_REPOSITORY: 'owner/repository',
			GITHUB_OUTPUT: path.join(root, 'prepare-output'),
			SWARM_ACTION_MODE: 'prepare',
			SWARM_ACTION_REPOSITORY: 'owner/repository',
			SWARM_ACTION_ISSUE_NUMBER: '2498',
			SWARM_ACTION_ISSUE_TITLE: 'Issue title',
			SWARM_ACTION_ISSUE_BODY: 'untrusted issue body',
			SWARM_ACTION_DELIVERY_ID: 'delivery-2498',
			SWARM_ACTION_LABEL: 'swarm-auto',
			SWARM_ACTION_LABELER: 'trusted-maintainer',
			SWARM_ACTION_BASE_SHA: fixture.baseSha,
			SWARM_ACTION_BASE_BRANCH: 'main',
			SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
			SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
			SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
			SWARM_ACTION_BUN_VERSION: '1.3.14',
			SWARM_ACTION_PLUGIN_REF: ACTION_REF,
			GITHUB_ACTION_PATH: ACTION_ROOT,
			GITHUB_ACTION_REF: ACTION_REF,
			SWARM_ACTION_OPENCODE_BIN: trace.binary,
			SWARM_ACTION_BUN_BIN: path.join(
				trace.binDir,
				process.platform === 'win32' ? 'fake-bun.cmd' : 'fake-bun',
			),
			SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
			SWARM_ACTION_DEADLINE_MS: '120000',
			SWARM_ACTION_MAX_ATTEMPTS: '1',
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
	expect(prepare).toBe(0);

	const publish = await withEnvironment(
		{
			GITHUB_WORKSPACE: fixture.fresh,
			GITHUB_REPOSITORY: 'owner/repository',
			GITHUB_OUTPUT: path.join(root, 'publish-output'),
			SWARM_ACTION_MODE: 'publish',
			SWARM_ACTION_REPOSITORY: 'owner/repository',
			SWARM_ACTION_ISSUE_NUMBER: '2498',
			SWARM_ACTION_DELIVERY_ID: 'delivery-2498',
			SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
			SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
			SWARM_ACTION_BASE_SHA: fixture.baseSha,
			SWARM_ACTION_BASE_BRANCH: 'main',
			SWARM_ACTION_EXPECTED_BASE_SHA: fixture.baseSha,
			SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
			SWARM_ACTION_BUN_VERSION: '1.3.14',
			SWARM_ACTION_PLUGIN_REF: ACTION_REF,
			GITHUB_ACTION_PATH: ACTION_ROOT,
			GITHUB_ACTION_REF: ACTION_REF,
			SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
			SWARM_ACTION_PUBLICATION_TOKEN: 'PUBLISH_TOKEN_2498',
			SWARM_ACTION_OVERSIGHT_STATUS: 'denied',
			SWARM_ACTION_OPENCODE_BIN: trace.binary,
			FAKE_OPENCODE_VERSION: '1.18.26',
			FAKE_NODE: process.execPath,
			FAKE_SCRIPT: trace.script,
			FAKE_ARGS_LOG: trace.argsLog,
			FAKE_ENV_LOG: trace.envLog,
			FAKE_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
			FAKE_GH_LOG: path.join(root, 'gh.log'),
			FAKE_GH_PR_URL: 'https://github.com/owner/repository/pull/2498',
			FAKE_GH_PR_LIST: '',
			FAKE_GH_PR_JSON: '',
			PATH: prependPath(trace.binDir),
		},
		runAction,
	);
	expect(publish).not.toBe(0);
	expect(runGit(fixture.fresh, 'rev-parse', 'HEAD')).toBe(fixture.baseSha);
	expect(
		runGit(
			fixture.fresh,
			'ls-remote',
			fixture.origin,
			'refs/heads/swarm/issue-2498',
		),
	).toBe('');
});
