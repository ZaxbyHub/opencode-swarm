import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	cleanupTempRoots,
	fakeBunBody,
	installFakeBinary,
	installTraceOpenCode,
	makeRemoteFixture,
	makeTempRoot,
	prependPath,
	runGit,
	withEnvironment,
} from './github-action-test-helpers';

afterAll(cleanupTempRoots);
const ACTION_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const ACTION_REF = runGit(ACTION_ROOT, 'rev-parse', 'HEAD');

function binary(binDir: string, name: string): string {
	return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

function env(
	root: string,
	baseSha: string,
	output: string,
	trace: ReturnType<typeof installTraceOpenCode>,
): Record<string, string> {
	return {
		GITHUB_WORKSPACE: root,
		GITHUB_REPOSITORY: 'owner/repository',
		GITHUB_OUTPUT: output,
		SWARM_ACTION_MODE: 'prepare',
		SWARM_ACTION_REPOSITORY: 'owner/repository',
		SWARM_ACTION_ISSUE_NUMBER: '2498',
		SWARM_ACTION_ISSUE_TITLE: 'receipt fixture',
		SWARM_ACTION_ISSUE_BODY: 'untrusted issue body',
		SWARM_ACTION_DELIVERY_ID: 'delivery-receipt',
		SWARM_ACTION_LABEL: 'swarm-auto',
		SWARM_ACTION_LABELER: 'trusted-maintainer',
		SWARM_ACTION_BASE_SHA: baseSha,
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
		SWARM_ACTION_SESSION_ID: 'session-2498',
		SWARM_ACTION_PROVIDER_SECRET: 'PROVIDER_SECRET_2498',
		SWARM_ACTION_PUBLICATION_TOKEN: 'PUBLISH_TOKEN_2498',
		SWARM_ACTION_OPENCODE_BIN: trace.binary,
		SWARM_ACTION_BUN_BIN: binary(trace.binDir, 'fake-bun'),
		SWARM_ACTION_ARTIFACT_PATH: '.swarm/github-action/artifact.json',
		FAKE_ARGS_LOG: trace.argsLog,
		FAKE_ENV_LOG: trace.envLog,
		FAKE_BUN_ARGS_LOG: path.join(path.dirname(root), 'bun.args'),
		FAKE_OPENCODE_VERSION: '1.18.26',
		FAKE_BUN_VERSION: '1.3.14',
		FAKE_NODE: process.execPath,
		FAKE_SCRIPT: trace.script,
		FAKE_ISSUE_URL: 'https://github.com/owner/repository/issues/2498',
		PATH: prependPath(trace.binDir),
	};
}

async function setup() {
	const root = makeTempRoot();
	const fixture = makeRemoteFixture(root);
	fs.writeFileSync(path.join(fixture.fresh, 'prepared.txt'), 'prepared\n');
	const trace = installTraceOpenCode(root);
	installFakeBinary(root, 'fake-bun', fakeBunBody());
	const runAction = await loadEnvironmentRunner();
	return { root, fixture, trace, runAction };
}

describe('issue #2498 — durable registered trace receipts', () => {
	test(
		'records fresh reviewer and critic proofs bound to the candidate tree',
		{ timeout: 120_000 },
		async () => {
			const prepared = await setup();
			const output = path.join(prepared.root, 'output');
			const code = await withEnvironment(
				env(
					prepared.fixture.fresh,
					prepared.fixture.baseSha,
					output,
					prepared.trace,
				),
				prepared.runAction,
			);
			expect(code).toBe(0);
			const args = fs
				.readFileSync(prepared.trace.argsLog, 'utf8')
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line) as string[]);
			const nested = args.filter((argv) =>
				argv.some((arg) => arg.startsWith('Independently ')),
			);
			expect(nested).toHaveLength(2);
			expect(nested.every((argv) => !argv.includes('--session'))).toBe(true);
			expect(nested.map((argv) => argv[argv.indexOf('--agent') + 1])).toEqual([
				'reviewer',
				'critic',
			]);
			const authoritative = args.find((argv) =>
				argv.some((arg) => arg.includes('authoritative implementation-review')),
			);
			expect(authoritative?.includes('--session')).toBe(true);
			const swarm = path.join(prepared.fixture.fresh, '.swarm');
			const review = JSON.parse(
				fs.readFileSync(path.join(swarm, 'implementation-review.json'), 'utf8'),
			) as Record<string, unknown>;
			const recurrence = JSON.parse(
				fs.readFileSync(path.join(swarm, 'recurrence-sweep.json'), 'utf8'),
			) as Record<string, unknown>;
			const transcript = JSON.parse(
				fs.readFileSync(
					path.join(swarm, 'github-action', 'review-transcript.json'),
					'utf8',
				),
			) as Record<string, unknown>;
			expect(review.issueNumber).toBe(2498);
			expect(review.reviewerVerdict).toBe('APPROVE');
			expect(review.criticVerdict).toBe('APPROVE');
			expect(review.diffBase).toBe(prepared.fixture.baseSha);
			expect(review.diffHead).toMatch(/^[0-9a-f]{40}$/);
			expect(review.sessionId).toBe('trace-session-2498');
			expect(review.notes).toBe('fresh reviewer and critic both approved');
			expect(review.timestamp).toBe('2026-09-08T00:00:00.000Z');
			expect(recurrence.sessionId).toBe(review.sessionId);
			expect(recurrence.defectClass).toBe('no defect class');
			expect(recurrence.justification).toBeTruthy();
			expect(transcript.version).toBe(1);
			expect(transcript.issueNumber).toBe(2498);
			expect(transcript.issueUrl).toBe(
				'https://github.com/owner/repository/issues/2498',
			);
			expect(transcript.baseSha).toBe(prepared.fixture.baseSha);
			expect(transcript.targetTreeSha).toBe(review.diffHead);
			expect(transcript.parentSession).toBe(review.sessionId);
			expect(transcript.traceTranscriptSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(transcript.nested).toEqual([
				expect.objectContaining({
					agent: 'reviewer',
					sessionId: 'review-session-2498',
				}),
				expect.objectContaining({
					agent: 'critic',
					sessionId: 'critic-session-2498',
				}),
			]);
		},
	);

	test(
		'rejects a trace marker that does not match the expected issue binding',
		{ timeout: 120_000 },
		async () => {
			const prepared = await setup();
			const output = path.join(prepared.root, 'output');
			const code = await withEnvironment(
				{
					...env(
						prepared.fixture.fresh,
						prepared.fixture.baseSha,
						output,
						prepared.trace,
					),
					FAKE_ISSUE_TRACE: 'wrong-trace',
				},
				prepared.runAction,
			);
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(
						prepared.fixture.fresh,
						'.swarm',
						'github-action',
						'artifact.json',
					),
				),
			).toBe(false);
		},
	);

	test(
		'rejects missing or malformed authoritative receipts instead of trusting the writer',
		{ timeout: 120_000 },
		async () => {
			for (const mode of ['missing-review', 'malformed-recurrence']) {
				const prepared = await setup();
				const output = path.join(prepared.root, `${mode}.output`);
				const code = await withEnvironment(
					{
						...env(
							prepared.fixture.fresh,
							prepared.fixture.baseSha,
							output,
							prepared.trace,
						),
						FAKE_RECEIPT_MODE: mode,
					},
					prepared.runAction,
				);
				expect(code).not.toBe(0);
				expect(
					fs.existsSync(
						path.join(
							prepared.fixture.fresh,
							'.swarm',
							'github-action',
							'artifact.json',
						),
					),
				).toBe(false);
			}
		},
	);

	test(
		'runs CI through the immutable Action-bound CLI without floating registry resolution',
		{ timeout: 120_000 },
		async () => {
			const prepared = await setup();
			const output = path.join(prepared.root, 'output');
			const code = await withEnvironment(
				env(
					prepared.fixture.fresh,
					prepared.fixture.baseSha,
					output,
					prepared.trace,
				),
				prepared.runAction,
			);
			expect(code).toBe(0);
			const bunArgs = fs.readFileSync(
				path.join(prepared.root, 'bun.args'),
				'utf8',
			);
			expect(bunArgs).toContain(
				path.join(ACTION_ROOT, 'dist', 'cli', 'index.js'),
			);
			expect(bunArgs).not.toContain('x --package');
		},
	);
});
