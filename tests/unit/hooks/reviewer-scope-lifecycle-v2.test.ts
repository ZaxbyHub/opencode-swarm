import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	captureReviewerScopeFileFingerprint,
	_internals as fingerprintInternals,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding';
import {
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationReady,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
let laneDirectory = '';
const realRead = fingerprintInternals.read;
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

function git(args: string[], cwd = directory): void {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
}

/** The plan.json fixture installActiveScopeBinding writes is required for taskId resolution. */
async function beginCoder(input: {
	callID: string;
	lane?: boolean;
}): Promise<'coder_started' | null> {
	const childSessionID = `child-${input.callID}`;
	startAgentSession(
		childSessionID,
		'coder',
		input.lane ? laneDirectory : directory,
	);
	swarmState.activeAgent.set(childSessionID, 'coder');
	swarmState.agentSessions.get(childSessionID)!.delegationActive = true;
	installActiveScopeBinding({
		directory: input.lane ? laneDirectory : directory,
		childSessionId: childSessionID,
		parentSessionId: 'parent',
		dispatchCallId: input.callID,
		taskId: '1.1',
		files: ['src/a.ts'],
	});
	return beginApprovedReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nImplement the task.',
		},
		parentSessionID: 'parent',
		callID: input.callID,
	});
}

async function completeCoder(callID: string, output: unknown = SUCCESS_OUTPUT) {
	return completeReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nImplement the task.',
		},
		output,
		parentSessionID: 'parent',
		callID,
	});
}

async function beginReviewer(callID: string) {
	return beginApprovedReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'reviewer',
			prompt: 'TASK: 1.1\nReview the task.',
		},
		parentSessionID: 'parent',
		callID,
		maxBytes: 1024 * 1024,
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('reviewer-scope-lifecycle-v2-');
	laneDirectory = path.join(directory, '.swarm-worktrees', 'sess', 'lane-1');
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.mkdirSync(path.join(laneDirectory, 'src'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'src/a.ts'), 'baseline\n');
	git(['init']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test']);
	git(['add', 'src/a.ts']);
	git(['commit', '-m', 'baseline']);
	fs.appendFileSync(path.join(directory, '.git/info/exclude'), '\n.swarm/\n');
	startAgentSession('parent', 'architect', directory);
	startAgentSession('fixture-child', 'coder', directory);
	installActiveScopeBinding({
		directory,
		childSessionId: 'fixture-child',
		parentSessionId: 'parent',
		dispatchCallId: 'fixture-call',
		taskId: '1.1',
		files: ['src/a.ts'],
	});
});

afterEach(() => {
	fingerprintInternals.read = realRead;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer scope lifecycle v2 (issue #2100 contracts D/E/F)', () => {
	test('a coder with zero observed writes and a clean tree completes as no_change; reviewer dispatch is typed-blocked, not stale', async () => {
		expect(await beginCoder({ callID: 'coder-nochange' })).toBe(
			'coder_started',
		);
		expect(await completeCoder('coder-nochange')).toBe('coder_no_change');
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-nochange',
			})?.status,
		).toBe('no_change');

		await expect(beginReviewer('reviewer-nochange')).rejects.toThrow(
			/REVIEWER_SCOPE_NO_CHANGE/,
		);
		// The generation is retained for architect retry — never discarded.
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-nochange',
			})?.status,
		).toBe('no_change');
	});

	test('zero observed writes with a dirty tree stays collecting with an actionable advisory', async () => {
		expect(await beginCoder({ callID: 'coder-dirty' })).toBe('coder_started');
		fs.writeFileSync(path.join(directory, 'src/rogue.ts'), 'rogue\n');
		expect(await completeCoder('coder-dirty')).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-dirty',
			})?.status,
		).toBe('collecting');
		const advisories = (
			swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? []
		).join('\n');
		expect(advisories).toContain('REVIEWER_SCOPE_UNATTRIBUTED_CHANGE');
		expect(advisories).toContain('ACTION[architect]');
	});

	test('ready publication is gated on fingerprint completeness (contract E)', async () => {
		expect(await beginCoder({ callID: 'coder-incomplete' })).toBe(
			'coder_started',
		);
		// Route the write but never record its fingerprint.
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-incomplete',
				file: 'src/a.ts',
			}),
		).toBe(true);
		expect(await completeCoder('coder-incomplete')).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-incomplete',
			})?.status,
		).toBe('collecting');
		const advisories = (
			swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? []
		).join('\n');
		expect(advisories).toContain('REVIEWER_CAPTURE_INCOMPLETE');
	});

	test('a genuine byte change before reviewer dispatch is stale and discarded (retry cannot fake equality)', async () => {
		expect(await beginCoder({ callID: 'coder-drift' })).toBe('coder_started');
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-drift',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'coder bytes\n');
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-drift',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-drift',
			}),
		).toBe(true);
		// A later real change invalidates equality — stale, generation discarded.
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'mutated bytes\n');
		await expect(beginReviewer('reviewer-drift')).rejects.toThrow(
			/REVIEWER_SCOPE_STALE/,
		);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-drift',
			}),
		).toBeNull();
	});

	test('exhausted transient retries throw a typed error and RETAIN the generation', async () => {
		expect(await beginCoder({ callID: 'coder-transient' })).toBe(
			'coder_started',
		);
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-transient',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'stable bytes\n');
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-transient',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-transient',
			}),
		).toBe(true);
		// Every capture attempt races: the read hook mutates the file each time.
		let reads = 0;
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			reads += 1;
			const bytesRead = realRead(fd, buffer, offset, length, position);
			if (bytesRead > 0) {
				fs.writeFileSync(path.join(directory, 'src/a.ts'), 'raced bytes\n');
			}
			return bytesRead;
		}) as typeof realRead;
		await expect(beginReviewer('reviewer-transient')).rejects.toThrow(
			/REVIEWER_CAPTURE_RETRY_EXHAUSTED/,
		);
		// Infrastructure failure must NOT have discarded the generation.
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-transient',
			})?.status,
		).toBe('ready');
	});

	test('F-005: a zero deadline never skips the final funded attempt; attempt counts are true', async () => {
		const { _internals: lifecycleInternals } = await import(
			'../../../src/hooks/reviewer-scope-lifecycle'
		);
		expect(await beginCoder({ callID: 'coder-deadline' })).toBe(
			'coder_started',
		);
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-deadline',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'stable bytes\n');
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-deadline',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-deadline',
			}),
		).toBe(true);
		// Every attempt races AND the retry deadline is already expired: the
		// middle attempt may be skipped, but the FINAL funded attempt must run.
		let reads = 0;
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			reads += 1;
			const bytesRead = realRead(fd, buffer, offset, length, position);
			if (bytesRead > 0) {
				fs.writeFileSync(path.join(directory, 'src/a.ts'), 'raced again\n');
			}
			return bytesRead;
		}) as typeof realRead;
		const previousBackoff = lifecycleInternals.backoffMs;
		const previousDeadline = lifecycleInternals.retryDeadlineMs;
		lifecycleInternals.backoffMs = 0;
		lifecycleInternals.retryDeadlineMs = 0;
		try {
			const error = await beginReviewer('reviewer-deadline').catch(
				(thrown: Error) => thrown,
			);
			expect(error.message).toContain('REVIEWER_CAPTURE_RETRY_EXHAUSTED');
			// attempts=2/3 with an always-expired deadline proves: attempt 1
			// ran, attempt 2 was deadline-skipped (middle), and the FINAL
			// funded attempt 3 still ran and self-aborted on its own expired
			// per-chunk deadline. The early-exit regression would report 1/3
			// with the final slot unspent.
			expect(error.message).toContain('attempts=2/3');
		} finally {
			lifecycleInternals.backoffMs = previousBackoff;
			lifecycleInternals.retryDeadlineMs = previousDeadline;
		}
		// Under an always-expired deadline every attempt self-aborts on its
		// pre-chunk deadline check (by design) — the attempts count above is
		// the contract proof, not chunk throughput.
	});

	test('a permanent capture failure reports attempts=1/3 (true count)', async () => {
		expect(await beginCoder({ callID: 'coder-permanent' })).toBe(
			'coder_started',
		);
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-permanent',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'stable bytes\n');
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-permanent',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-permanent',
			}),
		).toBe(true);
		// The path becomes a directory: non_regular is permanent, no retries.
		fs.rmSync(path.join(directory, 'src/a.ts'));
		fs.mkdirSync(path.join(directory, 'src/a.ts'));
		const error = await beginReviewer('reviewer-permanent').catch(
			(thrown: Error) => thrown,
		);
		expect(error.message).toContain('REVIEWER_CAPTURE_FAILED');
		expect(error.message).toContain('attempts=1/3');
		expect(error.message).toContain('responsible: architect');
	});

});
