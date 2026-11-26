import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	type RendererFinding,
	renderPrReviewSubmissionBody,
} from '../../../src/pr-review/render-review-body.js';
import {
	executePrReviewSubmission,
	_internals as submissionInternals,
} from '../../../src/tools/pr-review-submission.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const RUN_ID = 'tool-transport-run';
const REPO_SLUG = 'example/example-repo';
const PR_NUMBER = 909;

interface ExternalToolCall {
	executable: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
}

interface ExternalToolRunResult {
	status: 'completed' | 'timeout' | 'cancelled' | 'spawn-error';
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	message?: string;
}

let directory = '';
let calls: ExternalToolCall[];
let getCalls: ExternalToolCall[];
const originalResolveGhBinary = submissionInternals.resolveGhBinary;
const originalRunExternalTool = submissionInternals.runExternalTool;

function record(
	id: string,
	severity: string,
	fileLine: string,
): Record<string, unknown> {
	return {
		finding_id: id,
		status: 'CONFIRMED',
		file_line: fileLine,
		evidence: `settled evidence for ${id}`,
		next_action: 'report',
		severity,
		boundary: 'post_critic',
		pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		recorded_at: '2026-10-06T01:00:00.000Z',
	};
}

async function seedRun(
	root: string,
	records: Record<string, unknown>[],
	options: { coverageDisclosure?: boolean; degradations?: unknown[] } = {},
): Promise<void> {
	const runDir = join(root, '.swarm', 'pr-review', RUN_ID);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		join(runDir, 'trigger-eval.json'),
		JSON.stringify({
			run_id: RUN_ID,
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			...(options.degradations
				? { coverage_degradations: options.degradations }
				: {}),
		}),
		'utf-8',
	);
	await fs.writeFile(
		join(runDir, 'findings.jsonl'),
		records.map((item) => JSON.stringify(item)).join('\n'),
		'utf-8',
	);
	if (options.coverageDisclosure) {
		await fs.writeFile(
			join(runDir, 'coverage-disclosure.json'),
			JSON.stringify({
				schemaVersion: 2,
				runId: RUN_ID,
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: 'rev-1',
				unresolvedDimensions: [
					{
						dimension: 'security-trust',
						terminalState: 'FAILED',
						reasonKind: 'lane_failure',
					},
				],
				admittedAt: '2026-10-06T01:00:00.000Z',
			}),
			'utf-8',
		);
	}
}

function validArgs(): Record<string, unknown> {
	return {
		pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		pr_number: PR_NUMBER,
		repo: REPO_SLUG,
		run_id: RUN_ID,
	};
}

async function execute(args: unknown): Promise<string> {
	return executePrReviewSubmission(args, directory, {
		sessionID: PR_ARTIFACT_SESSION_ID,
	});
}

/** GET endpoints return arrays by default; POST returns a review object. */
function defaultRunResult(call: ExternalToolCall): ExternalToolRunResult {
	const isGet = !call.args.includes('POST');
	const endpoint = call.args[1] ?? '';
	if (isGet) {
		return {
			status: 'completed',
			exitCode: 0,
			stdout: '[]',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	}
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '{"id":7,"html_url":"https://example.com/review/7"}',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
	};
}

async function readPayload(
	call: ExternalToolCall,
): Promise<Record<string, unknown>> {
	const inputIndex = call.args.indexOf('--input');
	expect(inputIndex).toBeGreaterThan(-1);
	const raw = await fs.readFile(call.args[inputIndex + 1], 'utf-8');
	return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-submission-transport-');
	calls = [];
	getCalls = [];
	submissionInternals.resolveGhBinary = () => '/fake/gh';
	submissionInternals.runExternalTool = async (options) => {
		calls.push(options);
		if (!options.args.includes('POST')) getCalls.push(options);
		return defaultRunResult(options);
	};
});

afterEach(async () => {
	submissionInternals.resolveGhBinary = originalResolveGhBinary;
	submissionInternals.runExternalTool = originalRunExternalTool;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('pr_review_submission transport (AC1)', () => {
	test('submits with GETs before the POST and commit_id pinned to the head', async () => {
		await seedRun(directory, [
			record('T-1', 'HIGH', 'src/t1.ts:3'),
			record('T-2', 'LOW', 'src/t2.ts:9'),
		]);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; review_url: string };
		expect(parsed.success).toBe(true);
		expect(parsed.review_url).toBe('https://example.com/review/7');

		// The LAST transport call is the POST (frozen C1 ordering).
		const last = calls[calls.length - 1];
		expect(last.args).toContain('api');
		expect(last.args).toContain(
			`repos/${REPO_SLUG}/pulls/${PR_NUMBER}/reviews`,
		);
		expect(last.args).toContain('POST');
		expect(getCalls).toHaveLength(2);
		expect(getCalls[0].args[1]).toBe(
			`repos/${REPO_SLUG}/pulls/${PR_NUMBER}/comments?per_page=100`,
		);
		expect(getCalls[1].args[1]).toBe(
			`repos/${REPO_SLUG}/pulls/${PR_NUMBER}/reviews?per_page=100`,
		);
		const payload = await readPayload(last);
		expect(payload.commit_id).toBe(PR_ARTIFACT_HEAD_SHA);
	});

	test('submitted body and comments equal renderPrReviewSubmissionBody output', async () => {
		const records = [
			record('EQ-1', 'HIGH', 'src/eq1.ts:3'),
			record('EQ-2', 'LOW', 'src/eq2.ts:9'),
		];
		await seedRun(directory, records);
		await execute(validArgs());
		const payload = (await readPayload(calls[calls.length - 1])) as unknown as {
			body: string;
			event: string;
			comments: Array<{ path: string; line: number; body: string }>;
		};
		const expected = renderPrReviewSubmissionBody({
			run_id: RUN_ID,
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			verdict: 'REQUEST_CHANGES',
			coverage: { kind: 'FULL', unresolved_dimensions: [] },
			findings: records as unknown as RendererFinding[],
			existingComments: [],
		});
		expect(payload.body).toBe(expected.body);
		expect(payload.comments).toEqual(
			expected.inlineComments.map((comment) => ({
				path: comment.path,
				line: comment.line,
				body: comment.body,
			})),
		);
	});

	test('a REAL deep path survives the live submission payload (round 10)', async () => {
		// The artifact writer persists a real repository path verbatim
		// (the path-aware rule); the submission renderer must NOT re-mangle
		// it with the plain redactor — the round-9 renderer pins exercise
		// renderPrReviewSubmissionBody directly, this leg exercises the
		// production submission caller end to end (seeded rows -> POST
		// payload -> inline comments).
		const DEEP =
			'src/main/java/org/springframework/security/oauth2/server/authorization/OAuth2AuthorizationCodeRequestAuthenticationProvider.java';
		await fs.mkdir(join(directory, DEEP, '..'), { recursive: true });
		await fs.writeFile(join(directory, DEEP), 'class X {}\\n', 'utf-8');
		await seedRun(directory, [record('DP-1', 'HIGH', `${DEEP}:42`)]);
		await execute(validArgs());
		const payload = (await readPayload(calls[calls.length - 1])) as unknown as {
			body: string;
			comments: Array<{ path: string; line: number; body: string }>;
		};
		expect(payload.body).toContain(`${DEEP}:42`);
		expect(payload.body).not.toContain('[REDACTED');
		expect(payload.comments).toHaveLength(1);
		expect(payload.comments[0]!.path).toBe(DEEP);
		expect(payload.comments[0]!.line).toBe(42);
	});

	test('event is REQUEST_CHANGES for CRITICAL/HIGH findings, COMMENT otherwise', async () => {
		await seedRun(directory, [record('E-1', 'HIGH', 'src/e1.ts:1')]);
		await execute(validArgs());
		let payload = await readPayload(calls[calls.length - 1]);
		expect(payload.event).toBe('REQUEST_CHANGES');

		calls = [];
		getCalls = [];
		await seedRun(directory, [record('E-2', 'LOW', 'src/e2.ts:2')]);
		await execute(validArgs());
		payload = await readPayload(calls[calls.length - 1]);
		expect(payload.event).toBe('COMMENT');
	});

	test('coverage maps from coverage-disclosure.json, degradations, then FULL', async () => {
		await seedRun(directory, [record('C-1', 'LOW', 'src/c1.ts:1')], {
			coverageDisclosure: true,
		});
		await execute(validArgs());
		let payload = await readPayload(calls[calls.length - 1]);
		expect(payload.body as string).toContain('PARTIAL');
		expect(payload.body as string).toContain('security-trust');

		calls = [];
		getCalls = [];
		await fs.rm(
			join(
				directory,
				'.swarm',
				'pr-review',
				RUN_ID,
				'coverage-disclosure.json',
			),
		);
		await seedRun(directory, [record('C-2', 'LOW', 'src/c2.ts:2')], {
			degradations: [{ trigger_id: 'trig-1', reason: 'lane output lost' }],
		});
		await execute(validArgs());
		payload = await readPayload(calls[calls.length - 1]);
		expect(payload.body as string).toContain('trig-1: lane output lost');

		calls = [];
		getCalls = [];
		await seedRun(directory, [record('C-3', 'LOW', 'src/c3.ts:3')]);
		await execute(validArgs());
		payload = await readPayload(calls[calls.length - 1]);
		expect(payload.body as string).toContain('Coverage kind: FULL');
	});
});

describe('pr_review_submission existing-comments fetch (AC4)', () => {
	test('a non-array GET body degrades to an empty list and proceeds', async () => {
		await seedRun(directory, [record('G-1', 'LOW', 'src/g1.ts:1')]);
		submissionInternals.runExternalTool = async (options) => {
			calls.push(options);
			if (options.args.includes('POST')) {
				return defaultRunResult(options);
			}
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '{"message":"Not Found"}',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).success).toBe(true);
	});

	test('a failing GET refuses instead of risking duplicate posts', async () => {
		await seedRun(directory, [record('G-2', 'LOW', 'src/g2.ts:2')]);
		submissionInternals.runExternalTool = async (options) => {
			calls.push(options);
			if (options.args.includes('POST')) {
				return defaultRunResult(options);
			}
			return {
				status: 'completed',
				exitCode: 1,
				stdout: '',
				stderr: 'gh: Not Found',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('transport-failed');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('a timed-out GET refuses instead of degrading to an empty list', async () => {
		await seedRun(directory, [record('G-4', 'LOW', 'src/g4.ts:4')]);
		submissionInternals.runExternalTool = async (options) => {
			calls.push(options);
			if (options.args.includes('POST')) {
				return defaultRunResult(options);
			}
			return {
				status: 'timeout',
				exitCode: null,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('transport-failed');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('a spawn-error GET refuses instead of degrading to an empty list', async () => {
		await seedRun(directory, [record('G-5', 'LOW', 'src/g5.ts:5')]);
		submissionInternals.runExternalTool = async (options) => {
			calls.push(options);
			if (options.args.includes('POST')) {
				return defaultRunResult(options);
			}
			return {
				status: 'spawn-error',
				exitCode: null,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
				message: 'ENOENT',
			};
		};
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('transport-failed');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('POST transport failures surface typed refusals', async () => {
		const outcomes: Array<Partial<ExternalToolRunResult>> = [
			{ status: 'timeout', exitCode: null },
			{ status: 'spawn-error', exitCode: null, message: 'ENOENT' },
			{ status: 'completed', exitCode: 1, stderr: 'gh: 422 Validation Failed' },
		];
		for (const outcome of outcomes) {
			calls = [];
			getCalls = [];
			await seedRun(directory, [record('G-6', 'LOW', 'src/g6.ts:6')]);
			submissionInternals.runExternalTool = async (options) => {
				calls.push(options);
				if (!options.args.includes('POST')) {
					return defaultRunResult(options);
				}
				return {
					...defaultRunResult(options),
					...outcome,
				} as ExternalToolRunResult;
			};
			const raw = await execute(validArgs());
			const parsed = JSON.parse(raw) as { success: boolean; type: string };
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('transport-failed');
			expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(
				1,
			);
		}
	});

	test('refuses as an idempotent no-op when every finding is already posted', async () => {
		await seedRun(directory, [record('G-3', 'LOW', 'src/g3.ts:3')]);
		submissionInternals.runExternalTool = async (options) => {
			calls.push(options);
			if (options.args.includes('POST')) {
				return defaultRunResult(options);
			}
			const endpoint = options.args[1] ?? '';
			const stdout = endpoint.includes('/reviews')
				? JSON.stringify([{ body: '[G-3] settled evidence for G-3' }])
				: JSON.stringify([{ body: '[G-3] settled evidence for G-3' }]);
			return {
				status: 'completed',
				exitCode: 0,
				stdout,
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('nothing-new');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});
});

describe('pr_review_submission gh absence (AC1 fail-closed)', () => {
	test('refuses with a typed gh-not-found failure', async () => {
		await seedRun(directory, [record('N-1', 'LOW', 'src/n1.ts:1')]);
		submissionInternals.resolveGhBinary = () => null;
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('gh-not-found');
		expect(calls).toHaveLength(0);
	});
});
