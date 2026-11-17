import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
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

async function seedRun(root: string, records: Record<string, unknown>[]) {
	const runDir = join(root, '.swarm', 'pr-review', RUN_ID);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		join(runDir, 'trigger-eval.json'),
		JSON.stringify({
			run_id: RUN_ID,
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		}),
	);
	await fs.writeFile(
		join(runDir, 'findings.jsonl'),
		records.map((item) => JSON.stringify(item)).join('\n'),
	);
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

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-submission-transport-');
	calls = [];
	submissionInternals.resolveGhBinary = () => '/fake/gh';
	submissionInternals.runExternalTool = async (options) => {
		calls.push(options);
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
	test.each([
		{
			kind: 'inline findings',
			findings: [record('T-1', 'LOW', 'src/t1.ts:3')],
		},
		{
			kind: 'no reportable findings',
			findings: [
				{ ...record('T-1', 'LOW', 'src/t1.ts:3'), status: 'DISMISSED' },
			],
		},
	])('recovers a failed native receipt write with $kind without reposting', async ({
		findings,
	}) => {
		await seedRun(directory, findings);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		const receipt = join(runDir, 'native-submission.json');
		await fs.writeFile(
			join(runDir, 'native-completion.json'),
			JSON.stringify({
				run_id: RUN_ID,
				head: PR_ARTIFACT_HEAD_SHA,
				url: 'https://github.com/' + REPO_SLUG + '/pull/' + PR_NUMBER,
				session_id: PR_ARTIFACT_SESSION_ID,
				coverage: 'COMPLETE',
				verdict: 'APPROVE',
			}),
		);
		await fs.mkdir(receipt);
		const first = JSON.parse(await execute(validArgs()));
		expect(first).toMatchObject({
			success: true,
			native_release_receipt: false,
		});
		const saved = JSON.parse(
			await fs.readFile(join(runDir, 'submission-payload.json'), 'utf8'),
		);
		const postCount = calls.filter((call) => call.args.includes('POST')).length;
		expect(postCount).toBe(1);
		let reviewMode: 'incomplete' | 'ambiguous' | 'unique' = 'incomplete';
		submissionInternals.runExternalTool = async (call) => {
			calls.push(call);
			const result = defaultRunResult(call);
			if (call.args[1]?.includes('/reviews?')) {
				if (reviewMode === 'incomplete') return { ...result, stdout: '{}' };
				const match = {
					id: first.posted_review_id,
					commit_id: PR_ARTIFACT_HEAD_SHA,
					state: 'COMMENTED',
					author_association: 'MEMBER',
					body: saved.body,
				};
				const page = call.args[1].endsWith('&page=2')
					? reviewMode === 'ambiguous'
						? [match, { ...match, id: match.id + 1 }]
						: [match]
					: Array.from({ length: 100 }, (_, id) => ({
							id,
							body: 'earlier review',
						}));
				return {
					...result,
					stdout: JSON.stringify(page),
				};
			}
			if (call.args[1]?.includes('/comments?')) {
				return { ...result, stdout: JSON.stringify(saved.comments) };
			}
			return result;
		};

		expect(JSON.parse(await execute(validArgs()))).toMatchObject({
			success: false,
			type: 'transport-failed',
		});
		reviewMode = 'ambiguous';
		expect(JSON.parse(await execute(validArgs()))).toMatchObject({
			success: false,
			type: 'native-receipt-ambiguous',
		});
		reviewMode = 'unique';
		const blocked = JSON.parse(await execute(validArgs()));
		expect(blocked).toMatchObject({
			success: false,
			type: 'native-receipt-write-failed',
		});
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(
			postCount,
		);
		await fs.rmdir(receipt);
		const completion = join(runDir, 'native-completion.json');
		const proof = await fs.readFile(completion);
		await fs.unlink(completion);
		expect(JSON.parse(await execute(validArgs()))).toMatchObject({
			success: true,
			native_release_receipt: false,
			posted_review_id: first.posted_review_id,
		});
		await fs.writeFile(completion, proof);
		const repaired = JSON.parse(await execute(validArgs()));
		expect(repaired).toMatchObject({
			success: true,
			native_release_receipt: true,
			posted_review_id: first.posted_review_id,
		});
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(
			postCount,
		);
		expect(JSON.parse(await fs.readFile(receipt, 'utf8'))).toMatchObject({
			run_id: RUN_ID,
			head: PR_ARTIFACT_HEAD_SHA,
			review_id: first.posted_review_id,
		});
	});
});
