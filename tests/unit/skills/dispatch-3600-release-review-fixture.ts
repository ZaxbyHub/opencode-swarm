import { afterEach, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getCoordinationState,
	transitionCoordinationState,
} from '../../../src/db/coordination-store';
import {
	_test_exports,
	bindPrWorkflowHead,
	enforcePrWorkflowToolBefore,
	readPrWorkflowGateState,
	readPrWorkflowGateStateForRecovery,
} from '../../../src/hooks/pr-workflow-gate';
import {
	prWorkflowSessionFileStem,
	withSessionStateMutation,
	workflowGateStateLockRelativePath,
	workflowGateStatePath,
} from '../../../src/pr-review/persistence';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow';
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

export async function runReleaseAdmission(
	variant: 'POLICY' | 'APPROVE' | 'INCOMPLETE' | 'MERGED' | 'RECOVERY_ABORT',
) {
	const retryVerdict = variant === 'INCOMPLETE' ? 'INCOMPLETE' : 'APPROVE';
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
			timeout: 100_000,
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
	git('commit', '--allow-empty', '-qm', 'base');
	const base = git('rev-parse', 'HEAD');
	fs.writeFileSync(path.join(root, 'release.txt'), 'release candidate\n');
	git('add', 'release.txt');
	git('commit', '-qm', 'release candidate');
	const head = git('rev-parse', 'HEAD');
	const tree = git('rev-parse', 'HEAD^{tree}');
	const shim = path.join(root, 'gh');
	const reviewStatus = path.join(root, 'review-output');
	const liveHead = path.join(root, 'live-head');
	const label = path.join(root, 'release-label');
	const mergeStatus = path.join(root, 'merge-status');
	fs.writeFileSync(liveHead, head + '\n');
	fs.writeFileSync(label, 'no\n');
	fs.writeFileSync(
		path.join(root, '.git/info/exclude'),
		'/gh\n/review-output\n/live-head\n/release-label\n/merge-status\n/.swarm/\n/.agents/issue-traces/\n',
	);
	fs.writeFileSync(
		shim,
		'#!/usr/bin/env bash\ncase "$2" in\n' +
			'repos/example/swarm-fixture/pulls/42)\n' +
			'  case "$4" in *.merge_commit_sha*) cat merge-status;; *) cat live-head;; esac\n' +
			'  case "$4" in *classification*) cat release-label;; esac;;\n' +
			'repos/example/swarm-fixture/pulls/43) printf "%s\\n" "' +
			base +
			'" no;;\n' +
			'repos/example/swarm-fixture/pulls/42/reviews/123) cat review-output;;\n' +
			'*) exit 2;;\nesac\n',
		{ mode: 0o755 },
	);
	const check = (stage: 'release-review' | 'merge') =>
		run([
			bashCommand(validator)[0],
			'-c',
			'export PATH="$PWD:/usr/bin:/bin:$PATH"; [ "$(command -v gh)" = "$PWD/gh" ] || exit 19; exec bash "$@"',
			'bash',
			validator,
			stage,
			'--slug',
			slug,
		]);
	function state(release: boolean | undefined, reviewed: string) {
		write('state.md', [
			'# Trace State: release-review-scheduler',
			'protocol: 3.0.0',
			'phase: 5',
			'tier: M',
			'classification: VALID',
			'base-ref: main',
			'base-sha: ' + base,
			'freshness: synced',
			'phase0-tree-id: ' + tree,
			'checkpoint-tree-id: ' + tree,
			'handshake: MATCH',
			'tools: none',
			'merge: AWAITING_USER_APPROVAL',
			...(release === undefined
				? []
				: ['release-bound: ' + (release ? 'yes' : 'no')]),
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

	const request = () => check('release-review');
	if (variant === 'POLICY') {
		state(false, head);
		const ordinary = request();
		expect(ordinary.code, ordinary.err).toBe(0);
		expect(ordinary.out).not.toContain('release-review-action-v1');
		fs.writeFileSync(label, 'yes\n');
		for (const marker of [undefined, false]) {
			state(marker, head);
			const labeled = request();
			expect(labeled.code, labeled.out + labeled.err).toBe(1);
			expect(labeled.out).toContain('release-review-action-v1');
		}
		fs.writeFileSync(label, 'no\n');

		state(true, 'f'.repeat(40));
		const stale = request();
		expect(stale.code, stale.out + stale.err).not.toBe(0);
		expect(stale.out).not.toContain('release-review-action-v1');
	}

	state(true, head);
	write('10c-broad-review.md', [
		'reviewed-commit: ' + head,
		'status: COMPLETE',
		'verdict: APPROVE',
	]);
	const boundHead = head;
	const url = pr;
	if (variant === 'POLICY') {
		const pending = request();
		expect(pending.code, pending.out + pending.err).not.toBe(0);
		const action = pending.out
			.split(/\r?\n/)
			.find((line) => line.startsWith('release-review-action-v1 '));
		expect(action).toBe(
			`release-review-action-v1 head=${head} command=/swarm pr-review ${pr} --release-head ${head}`,
		);

		const match = action?.match(
			/^release-review-action-v1 head=([0-9a-f]{40}) command=\/swarm pr-review (https:\/\/\S+) --release-head ([0-9a-f]{40})$/,
		);
		if (!match) throw new Error('missing native review activation request');
		const [, announcedHead, announcedUrl, announcedBoundHead] = match;
		expect(announcedBoundHead).toBe(announcedHead);
		expect(announcedUrl).toBe(pr);
	}

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
		schemaVersion: 2,
		releaseReview: { head, url },
	});
	expect(
		_test_exports.parseGateState({ ...active, schemaVersion: 1 }),
	).toMatchObject({
		success: true,
		data: { schemaVersion: 2, releaseReview: { head, url } },
	});
	expect(
		_test_exports.parseGateState({ ...active, releaseReview: undefined })
			.success,
	).toBe(false);
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
	const merge = () => check('merge');
	const statePath = path.join(trace, 'state.md');
	const releaseState = fs.readFileSync(statePath, 'utf8');
	fs.writeFileSync(statePath, releaseState.replace('release-bound: yes\n', ''));
	fs.unlinkSync(path.join(trace, '10-pr-body.md'));
	const missingPublication = merge();
	expect(missingPublication.code).toBe(1);
	expect(missingPublication.out).toContain('missing PR publication evidence');
	write('10-pr-body.md', ['PR head: ' + head]);
	const missingUrl = merge();
	expect(missingUrl.code).toBe(1);
	expect(missingUrl.out).toContain('invalid published PR URL');
	write('10-pr-body.md', [
		'PR head: ' + head,
		'PR URL: ' + pr.replace(/42$/, '43'),
	]);
	const wrongOrdinaryPr = merge();
	expect(wrongOrdinaryPr.code).toBe(1);
	expect(wrongOrdinaryPr.out).toContain('live PR head could not be verified');
	write('10-pr-body.md', ['PR head: ' + head, 'PR URL: ' + pr]);
	fs.writeFileSync(statePath, releaseState);
	const runId = 'run.fixture';
	write('10c-broad-review.md', ['review-id: 123', 'run-id: ' + runId]);
	const reviewBody = (coverage: string, commit = head) =>
		`${commit}\nPR review submission for run ${runId} at head ${head}. Report verdict: COMMENT.\n- Coverage kind: ${coverage}\n`;
	if (variant === 'POLICY') {
		fs.writeFileSync(liveHead, base + '\n');
		const movedHead = merge();
		expect(movedHead.code, movedHead.out + movedHead.err).toBe(1);
		expect(movedHead.out).toContain('live PR head could not be verified');
		fs.writeFileSync(liveHead, head + '\n');
		fs.writeFileSync(reviewStatus, reviewBody('FULL', base));
		const wrongCommit = merge();
		expect(wrongCommit.code, wrongCommit.out + wrongCommit.err).toBe(1);
		expect(wrongCommit.out).toContain('release-review-action-v1');
		fs.writeFileSync(reviewStatus, reviewBody('PARTIAL'));
		const partial = merge();
		expect(partial.code, partial.out + partial.err).toBe(1);
		expect(partial.out).toContain('release-review-action-v1');
		fs.writeFileSync(reviewStatus, reviewBody('FULL'));
		const unverified = merge();
		expect(unverified.code, unverified.out + unverified.err).toBe(1);
		expect(unverified.out).toContain(
			'lacks verified native completion provenance',
		);
		return;
	}

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
	expect(await complete()).toMatchObject({
		success: false,
		message: expect.stringContaining('native-completion.json'),
	});
	expect((await readPrWorkflowGateState(root, session))?.releaseReview).toEqual(
		{ url, head },
	);
	fs.rmdirSync(completionPath);
	_test_exports.afterNativeReleaseReceiptWrite = () => {
		throw new Error('fixture interruption after release receipt write');
	};
	expect(await complete()).toMatchObject({
		success: false,
		message: 'fixture interruption after release receipt write',
	});
	expect(JSON.parse(fs.readFileSync(completionPath, 'utf8'))).toMatchObject({
		run_id: runId,
		head,
		verdict: 'APPROVE',
	});
	expect((await readPrWorkflowGateState(root, session))?.releaseReview).toEqual(
		{ url, head },
	);
	_test_exports.afterNativeReleaseReceiptWrite = undefined;
	if (variant === 'RECOVERY_ABORT') {
		const namespace = `pr-workflow.state:${prWorkflowSessionFileStem(session)}`;
		const row = getCoordinationState(root, namespace, 'state');
		if (!row) throw new Error('missing authoritative release gate');
		const corrupted = {
			...JSON.parse(row.payload),
			revision: 'not-a-number',
		};
		const writeCorruptRow = (expectedRevision: number) => {
			const result = transitionCoordinationState(root, {
				namespace,
				entityKey: 'state',
				expectedRevision,
				generation: row.generation,
				status: row.status,
				payload: JSON.stringify(corrupted),
			});
			if (result.outcome !== 'applied' || !result.state) {
				throw new Error('could not seed corrupt release gate');
			}
			return result.state.revision;
		};
		const corruptRowRevision = writeCorruptRow(row.revision);
		const shadow = workflowGateStatePath(root, session);
		fs.writeFileSync(
			shadow,
			JSON.stringify({ ...corrupted, prReviewArtifactRunId: 'different-run' }),
		);
		await expect(
			readPrWorkflowGateStateForRecovery(root, session),
		).rejects.toThrow('is invalid');
		fs.writeFileSync(shadow, JSON.stringify(corrupted));
		const abortArgs = {
			mode: 'PR_REVIEW',
			kind: 'recovery',
			reason: 'state corrupted',
		};
		await expect(
			enforcePrWorkflowToolBefore(
				root,
				session,
				'abort_pr_workflow',
				abortArgs,
			),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(root, session, 'pr_workflow_status', {}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(root, session, 'complete_pr_workflow', {}),
		).rejects.toThrow('is invalid');
		const abort = async () =>
			JSON.parse(
				await executeAbortPrWorkflow(abortArgs, root, { sessionID: session }),
			);
		_test_exports.beforeAbortClear = async () => {
			writeCorruptRow(corruptRowRevision);
		};
		expect(await abort()).toMatchObject({
			success: false,
			message: expect.stringContaining('gate state changed'),
		});
		expect(fs.existsSync(completionPath)).toBe(true);
		_test_exports.beforeAbortClear = undefined;
		expect(await abort()).toMatchObject({
			success: true,
			gate_cleared: true,
			state_salvaged: true,
			cas_escape_disclosure:
				'state revision unsalvageable; cleared without compare-and-swap',
		});
		expect(fs.existsSync(completionPath)).toBe(false);
		await expect(readPrWorkflowGateState(root, session)).resolves.toBeNull();
		return;
	}
	let competingRead: Promise<unknown> | undefined;
	if (variant === 'APPROVE') {
		const lockPath = path.join(
			root,
			'.swarm',
			workflowGateStateLockRelativePath(session),
		);
		_test_exports.afterNativeReleaseReceiptWrite = () => {
			expect(fs.statSync(lockPath).isFile()).toBe(true);
			competingRead = withSessionStateMutation(root, session, () =>
				readPrWorkflowGateState(root, session),
			);
		};
	}
	const completion = await complete(retryVerdict);
	if (variant === 'APPROVE') {
		if (!competingRead) throw new Error('missing competing gate mutation');
		await expect(competingRead).resolves.toBeNull();
		_test_exports.afterNativeReleaseReceiptWrite = undefined;
	}
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
	if (variant !== 'MERGED') {
		const admitted = merge();
		if (retryVerdict === 'INCOMPLETE') {
			expect(admitted.code, admitted.out + admitted.err).toBe(1);
			expect(admitted.out).toContain(
				'lacks verified native completion provenance',
			);
			return;
		}
		expect(admitted.code, admitted.out + admitted.err).toBe(0);
		expect(admitted.out).toContain('OK broad-review');
		fs.appendFileSync(reviewStatus, 'tampered review text\n');
		const tampered = merge();
		expect(tampered.code, tampered.out + tampered.err).toBe(1);
		expect(tampered.out).toContain(
			'lacks verified native completion provenance',
		);
		return;
	}

	git('checkout', '-q', '--detach', base);
	git('cherry-pick', '--no-commit', head);
	git('commit', '-qm', 'squashed release');
	const squash = git('rev-parse', 'HEAD');
	fs.writeFileSync(
		statePath,
		fs
			.readFileSync(statePath, 'utf8')
			.replace('merge: AWAITING_USER_APPROVAL', 'merge: MERGED'),
	);
	fs.appendFileSync(
		path.join(trace, '10b-merge-approval.md'),
		`## Merge commit SHA\n${squash}\n`,
	);
	const mergedReleaseState = fs.readFileSync(statePath, 'utf8');
	fs.writeFileSync(
		statePath,
		mergedReleaseState.replace('release-bound: yes\n', 'release-bound: no\n'),
	);
	fs.writeFileSync(mergeStatus, `true\n${base}\n${squash}\n`);
	const wrongMergedHead = merge();
	expect(wrongMergedHead.code, wrongMergedHead.out + wrongMergedHead.err).toBe(
		1,
	);
	expect(wrongMergedHead.out).toContain('OK stable-patch-id');
	expect(wrongMergedHead.out).toContain(
		'live PR merge identity could not be verified',
	);
	fs.writeFileSync(statePath, mergedReleaseState);
	fs.writeFileSync(mergeStatus, `true\n${head}\n${squash}\n`);
	const reconciled = merge();
	expect(reconciled.code, reconciled.out + reconciled.err).toBe(0);
	expect(reconciled.out).toContain('OK broad-review');
}
