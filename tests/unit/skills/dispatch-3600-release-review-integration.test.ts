import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	bindPrWorkflowHead,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow';
import {
	executePrReviewSubmission,
	_internals as submission,
} from '../../../src/tools/pr-review-submission';
import { createSwarmCommandTool } from '../../../src/tools/swarm-command';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact';
import { bashCommand } from '../../helpers/bash';
import {
	artifactRecord,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	reviewedRow,
	settleReviewerPhase,
} from '../../helpers/pr-review-artifact-fixtures';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const validator = path.resolve(
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);
const slug = 'release-review-scheduler';
const pr = 'https://github.com/example/swarm-fixture/pull/42';
const roots: string[] = [];
const originalDigest = _test_exports.resolvePrWorkflowRevisionDigest;
const originalGh = submission.resolveGhBinary;
const originalRun = submission.runExternalTool;

afterEach(() => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolvePrWorkflowRevisionDigest = originalDigest;
	_test_exports.afterNativeReleaseReceiptWrite = undefined;
	submission.resolveGhBinary = originalGh;
	submission.runExternalTool = originalRun;
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

test.each([
	'APPROVE',
	'INCOMPLETE',
] as const)('release admission after an interrupted approval and %s retry', async (retryVerdict) => {
	const root = canonicalMkdtemp('release-review-scheduler-');
	roots.push(root);
	const trace = path.join(root, '.agents', 'issue-traces', slug);
	fs.mkdirSync(trace, { recursive: true });
	function write(file: string, lines: string[]) {
		fs.writeFileSync(path.join(trace, file), lines.join('\n') + '\n');
	}
	function run(cmd: string[]) {
		const result = Bun.spawnSync({
			cmd,
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 45_000,
		});
		return {
			code: result.exitCode,
			out: result.stdout.toString(),
			err: result.stderr.toString(),
		};
	}
	function git(...args: string[]) {
		const result = run(['git', ...args]);
		if (result.code !== 0) throw new Error(result.err);
		return result.out.trim();
	}
	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'Trace fixture');
	git('config', 'user.email', 'trace@example.invalid');
	git(
		'remote',
		'add',
		'origin',
		'https://github.com/example/swarm-fixture.git',
	);
	git('commit', '--allow-empty', '-qm', 'release candidate');
	const head = git('rev-parse', 'HEAD');
	const tree = git('rev-parse', 'HEAD^{tree}');
	function state(release: boolean, reviewed: string) {
		write('state.md', [
			'# Trace State: release-review-scheduler',
			'protocol: 3.0.0',
			'phase: 5',
			'tier: M',
			'classification: VALID',
			'base-ref: main',
			'base-sha: ' + head,
			'freshness: synced',
			'phase0-tree-id: ' + tree,
			'checkpoint-tree-id: ' + tree,
			'handshake: MATCH',
			'tools: none',
			'merge: AWAITING_USER_APPROVAL',
			'release-bound: ' + (release ? 'yes' : 'no'),
			'next-action: release-review',
			'',
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			'| final-critic | APPROVE | ' +
				reviewed +
				' | ' +
				tree +
				' | 09-final-critic.md |',
		]);
		write('09-final-critic.md', [
			'## Reviewed SHA / diff hash',
			'reviewed-commit: ' + reviewed,
			'tree-id: ' + tree,
			'## Verdict',
			'APPROVE',
		]);
	}
	write('10-pr-body.md', ['PR head: ' + head, 'PR URL: ' + pr]);

	const request = () =>
		run(bashCommand(validator, 'release-review', '--slug', slug));
	state(false, head);
	const ordinary = request();
	expect(ordinary.code, ordinary.err).toBe(0);
	expect(ordinary.out).not.toContain('release-review-action-v1');

	state(true, 'f'.repeat(40));
	const stale = request();
	expect(stale.code, stale.out + stale.err).not.toBe(0);
	expect(stale.out).not.toContain('release-review-action-v1');

	state(true, head);
	write('10c-broad-review.md', [
		'reviewed-commit: ' + head,
		'status: COMPLETE',
		'verdict: APPROVE',
	]);
	const pending = request();
	expect(pending.code, pending.out + pending.err).not.toBe(0);
	const action = pending.out
		.split(/\r?\n/)
		.find((line) => line.startsWith('release-review-action-v1 '));
	expect(action).toBe(
		'release-review-action-v1 head=' + head + ' command=/swarm pr-review ' + pr,
	);

	const match = action?.match(
		/^release-review-action-v1 head=([0-9a-f]{40}) command=\/swarm pr-review (https:\/\/\S+)$/,
	);
	if (!match) throw new Error('missing native review activation request');
	const [, boundHead, url] = match;
	const session = PR_ARTIFACT_SESSION_ID;
	const tool = createSwarmCommandTool(
		{},
		undefined,
		undefined,
		undefined,
		undefined,
		() => 'architect',
	);
	const context = { directory: root, sessionID: session } as Parameters<
		typeof tool.execute
	>[1];
	const command = {
		command: 'pr-review',
		args: [url, '--release-head', boundHead],
	};
	const activation = await tool.execute(command, context);
	expect(activation).toContain(
		'[MODE: PR_REVIEW pr="' + pr + '" council=false]',
	);
	const active = await readPrWorkflowGateState(root, session);
	expect(active).toMatchObject({
		mode: 'PR_REVIEW',
		releaseReview: { head, url },
	});
	await expect(
		bindPrWorkflowHead(root, session, 'e'.repeat(40)),
	).rejects.toThrow('release review head');
	await tool.execute(command, context);
	expect(
		(await readPrWorkflowGateState(root, session))?.workflowInstanceId,
	).toBe(active?.workflowInstanceId);

	write('10b-merge-approval.md', [
		'## User approval (verbatim)',
		'Approved.',
		'## PR head SHA',
		head,
		'## Final critic reviewed-commit',
		head,
	]);
	fs.appendFileSync(
		path.join(trace, 'state.md'),
		`| merge-approval | RECORDED | ${head} | ${tree} | 10b-merge-approval.md |\n`,
	);
	const shim = path.join(root, 'gh');
	const reviewStatus = path.join(root, 'review-output');
	fs.writeFileSync(
		path.join(root, '.git/info/exclude'),
		'/gh\n/review-output\n/.swarm/\n/.agents/issue-traces/\n',
	);
	fs.writeFileSync(
		shim,
		'#!/usr/bin/env bash\ncase "$2" in\nrepos/example/swarm-fixture/pulls/42) printf "%s\\n" "' +
			head +
			'";;\nrepos/example/swarm-fixture/pulls/42/reviews/123) cat review-output;;\n*) exit 2;;\nesac\n',
		{ mode: 0o755 },
	);
	const merge = () =>
		run([
			bashCommand(validator)[0],
			'-c',
			'export PATH="$PWD:/usr/bin:/bin:$PATH"; [ "$(command -v gh)" = "$PWD/gh" ] || exit 19; exec bash "$@"',
			'bash',
			validator,
			'merge',
			'--slug',
			slug,
		]);
	const blocked = merge();
	expect(blocked.code).toBe(1);
	expect(blocked.out).toContain('release-review-action-v1');
	const runId = 'run.fixture';
	write('10c-broad-review.md', ['review-id: 123', 'run-id: ' + runId]);
	const reviewBody = (coverage: string) =>
		`${head}\nPR review submission for run ${runId} at head ${head}. Report verdict: COMMENT.\n- Coverage kind: ${coverage}\n`;
	fs.writeFileSync(reviewStatus, reviewBody('PARTIAL'));
	expect(merge().code).toBe(1);
	fs.writeFileSync(reviewStatus, reviewBody('FULL'));
	const unverified = merge();
	expect(unverified.code, unverified.out + unverified.err).toBe(1);
	expect(unverified.out).toContain(
		'lacks verified native completion provenance',
	);
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	await establishPrReviewPrerequisites(root, runId, session, head, {
		zeroCandidates: true,
		versionedTriggerReceipt: true,
	});
	const findings = (
		boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
		record: ReturnType<typeof artifactRecord>,
	) =>
		executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: runId,
				pr_head_sha: head,
				boundary,
				records: [record],
			},
			root,
			{ sessionID: session },
		);
	expect(
		JSON.parse(
			await findings(
				'post_explorer',
				artifactRecord('CLEAN-REVIEW', 'PENDING', 'route_to_reviewer', 'NONE'),
			),
		),
	).toMatchObject({ success: true });
	await settleReviewerPhase(
		root,
		runId,
		[reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE')],
		['CLEAN-REVIEW'],
		session,
		head,
	);
	const clean = artifactRecord(
		'CLEAN-REVIEW',
		'DISPROVED',
		'suppress_with_reason',
		'NONE',
	);
	for (const boundary of ['post_reviewer', 'post_critic'] as const) {
		expect(JSON.parse(await findings(boundary, clean))).toMatchObject({
			success: true,
		});
	}
	const complete = async (
		reportVerdict: 'APPROVE' | 'INCOMPLETE' = 'APPROVE',
	) =>
		JSON.parse(
			await executeCompletePrWorkflow(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: head,
					report_verdict: reportVerdict,
				},
				root,
				{ sessionID: session },
			),
		);
	const completionPath = path.join(
		root,
		'.swarm/pr-review',
		runId,
		'native-completion.json',
	);
	fs.mkdirSync(completionPath);
	expect(await complete()).toMatchObject({ success: false });
	expect((await readPrWorkflowGateState(root, session))?.releaseReview).toEqual(
		{ url, head },
	);
	fs.rmdirSync(completionPath);
	_test_exports.afterNativeReleaseReceiptWrite = () => {
		throw new Error('fixture interruption after release receipt write');
	};
	expect(await complete()).toMatchObject({ success: false });
	expect(fs.existsSync(completionPath)).toBe(true);
	expect((await readPrWorkflowGateState(root, session))?.releaseReview).toEqual(
		{ url, head },
	);
	_test_exports.afterNativeReleaseReceiptWrite = undefined;
	const completion = await complete(retryVerdict);
	expect(completion).toMatchObject({
		success: true,
		gate_cleared: true,
		terminal_report: { kind: 'COMPLETE' },
	});
	expect(fs.existsSync(completionPath)).toBe(retryVerdict === 'APPROVE');
	submission.resolveGhBinary = () => '/fixture/gh';
	submission.runExternalTool = async ({ args }) => {
		const post = args.includes('POST');
		if (post) {
			const payload = JSON.parse(
				fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8'),
			);
			expect(payload).toMatchObject({ commit_id: head, event: 'COMMENT' });
			fs.writeFileSync(reviewStatus, head + '\n' + payload.body + '\n');
		}
		return {
			status: 'completed',
			exitCode: 0,
			stdout: post ? '{"id":123}' : '[]',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	};
	const submitted = JSON.parse(
		await executePrReviewSubmission(
			{
				run_id: runId,
				pr_head_sha: head,
				repo: 'example/swarm-fixture',
				pr_number: 42,
			},
			root,
			{ sessionID: session },
		),
	);
	expect(submitted).toMatchObject({
		success: true,
		native_release_receipt: retryVerdict === 'APPROVE',
		posted_review_id: 123,
	});
	const admitted = merge();
	if (retryVerdict === 'INCOMPLETE') {
		expect(admitted.code, admitted.out + admitted.err).toBe(1);
		return;
	}
	expect(admitted.code, admitted.out + admitted.err).toBe(0);
	expect(admitted.out).toContain('OK broad-review');
	fs.appendFileSync(reviewStatus, 'tampered review text\n');
	expect(merge().code).toBe(1);
}, 180_000);
