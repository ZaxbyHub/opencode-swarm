/**
 * Tests for src/hooks/auto-review.ts — opt-in execution-diff review by the
 * reviewer model at task/phase boundaries. Uses the _internals DI seam
 * (writing-tests skill) instead of mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import {
	_internals,
	createAutoReviewHook,
	resetAutoReviewTracking,
	runAutoReview,
} from '../../../src/hooks/auto-review';
import { swarmState } from '../../../src/state';

let tmpDir: string;
const origComputeDiff = _internals.computeExecutionDiff;
const origDispatch = _internals.dispatchReviewer;
const origRun = _internals.runAutoReview;
const origNow = _internals.now;

function makeConfig(overrides: Record<string, unknown> = {}) {
	return AutoReviewConfigSchema.parse({ enabled: true, ...overrides });
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'auto-review-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	resetAutoReviewTracking();
});

afterEach(() => {
	_internals.computeExecutionDiff = origComputeDiff;
	_internals.dispatchReviewer = origDispatch;
	_internals.runAutoReview = origRun;
	_internals.now = origNow;
	resetAutoReviewTracking();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ─── Hook gating ──────────────────────────────────────────────────────────────

describe('createAutoReviewHook — gating', () => {
	function recordingHook(config = makeConfig()) {
		const calls: Array<{ trigger: string; taskId?: string; phase?: number }> =
			[];
		_internals.runAutoReview = async (input) => {
			calls.push({
				trigger: input.trigger,
				taskId: input.taskId,
				phase: input.phase,
			});
		};
		const hook = createAutoReviewHook({
			config,
			directory: tmpDir,
			injectAdvisory: () => {},
		});
		return { hook, calls };
	}

	test('no-op when disabled', async () => {
		const { hook, calls } = recordingHook(makeConfig({ enabled: false }));
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 1 } },
		);
		expect(calls).toHaveLength(0);
	});

	test('default trigger (phase_boundary) dispatches on phase_complete only', async () => {
		const { hook, calls } = recordingHook();
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'completed' } },
		);
		expect(calls).toHaveLength(0);
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 2 } },
		);
		expect(calls).toEqual([{ trigger: 'phase_boundary', phase: 2 }]);
	});

	test('task_completion trigger dispatches only on completed status', async () => {
		const { hook, calls } = recordingHook(
			makeConfig({ trigger: 'task_completion' }),
		);
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'in_progress' } },
		);
		expect(calls).toHaveLength(0);
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'completed' } },
		);
		expect(calls).toEqual([{ trigger: 'task_completion', taskId: '1.1' }]);
	});

	test('both trigger covers task and phase, other tools ignored', async () => {
		const { hook, calls } = recordingHook(makeConfig({ trigger: 'both' }));
		let now = 1_000_000;
		_internals.now = () => now;
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '2.1', status: 'completed' } },
		);
		now += 61_000; // past cooldown
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 3 } },
		);
		await hook.toolAfter({ tool: 'write', sessionID: 's1' }, { args: {} });
		expect(calls.map((c) => c.trigger)).toEqual([
			'task_completion',
			'phase_boundary',
		]);
	});

	test('non-architect session never triggers a review pass', async () => {
		const { hook, calls } = recordingHook();
		swarmState.activeAgent.set('s-coder', 'coder');
		try {
			await hook.toolAfter(
				{ tool: 'phase_complete', sessionID: 's-coder' },
				{ args: { phase: 1 } },
			);
			expect(calls).toHaveLength(0);
			swarmState.activeAgent.set('s-arch', 'mega_architect');
			await hook.toolAfter(
				{ tool: 'phase_complete', sessionID: 's-arch' },
				{ args: { phase: 1 } },
			);
			expect(calls).toHaveLength(1);
		} finally {
			swarmState.activeAgent.delete('s-coder');
			swarmState.activeAgent.delete('s-arch');
		}
	});

	test('60s cooldown suppresses repeated dispatches for the same session', async () => {
		const { hook, calls } = recordingHook();
		let now = 1_000_000;
		_internals.now = () => now;
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 1 } },
		);
		now += 10_000; // within cooldown — phase_complete retry must not spam
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 1 } },
		);
		expect(calls).toHaveLength(1);
		now += 61_000;
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 1 } },
		);
		expect(calls).toHaveLength(2);
	});
});

// ─── runAutoReview ────────────────────────────────────────────────────────────

const APPROVED = 'VERDICT: APPROVED\nRISK: LOW\nISSUES: none';
const REJECTED = [
	'VERDICT: REJECTED',
	'RISK: HIGH',
	'ISSUES:',
	'- [CRITICAL] src/a.ts:7 SQL built by string concatenation',
	'FIXES:',
	'- use a parameterized query',
].join('\n');

function runInput(advisories: string[]) {
	return {
		directory: tmpDir,
		sessionID: 's1',
		trigger: 'phase_boundary' as const,
		phase: 1,
		config: { timeout_ms: 30_000, max_diff_kb: 256 },
		injectAdvisory: (_sid: string, msg: string) => {
			advisories.push(msg);
		},
	};
}

function readEvents(): Array<Record<string, unknown>> {
	const p = path.join(tmpDir, '.swarm', 'events.jsonl');
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function readReceipts(): Array<Record<string, unknown>> {
	const indexPath = path.join(
		tmpDir,
		'.swarm',
		'review-receipts',
		'index.json',
	);
	if (!fs.existsSync(indexPath)) return [];
	return JSON.parse(fs.readFileSync(indexPath, 'utf-8')).entries;
}

describe('runAutoReview', () => {
	test('APPROVED verdict: persists receipt + event, no advisory', async () => {
		_internals.computeExecutionDiff = async () => ({
			status: 'ok' as const,
			diff: 'diff --git a/x b/x\n+1',
		});
		_internals.dispatchReviewer = async () => APPROVED;
		const advisories: string[] = [];
		await runAutoReview(runInput(advisories));

		expect(advisories).toHaveLength(0);
		const receipts = readReceipts();
		expect(receipts).toHaveLength(1);
		expect(receipts[0].verdict).toBe('approved');
		const events = readEvents();
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('auto_review');
		expect(events[0].verdict).toBe('approved');
	});

	test('REJECTED verdict: persists rejected receipt and injects advisory with findings', async () => {
		_internals.computeExecutionDiff = async () => ({
			status: 'ok' as const,
			diff: 'diff --git a/x b/x\n+1',
		});
		_internals.dispatchReviewer = async () => REJECTED;
		const advisories: string[] = [];
		await runAutoReview(runInput(advisories));

		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('[AUTO-REVIEW]');
		expect(advisories[0]).toContain('REJECTED');
		expect(advisories[0]).toContain('SQL built by string concatenation');
		expect(advisories[0]).toContain('parameterized query');
		expect(readReceipts()[0].verdict).toBe('rejected');
		expect(readEvents()[0].verdict).toBe('rejected');
	});

	test('unparseable reviewer output: advisory marks UNVERIFIED, no receipt', async () => {
		_internals.computeExecutionDiff = async () => ({
			status: 'ok' as const,
			diff: 'diff --git a/x b/x\n+1',
		});
		_internals.dispatchReviewer = async () => 'looks great!';
		const advisories: string[] = [];
		await runAutoReview(runInput(advisories));

		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('UNVERIFIED');
		expect(readReceipts()).toHaveLength(0);
		expect(readEvents()[0].verdict).toBe('unparseable');
	});

	test('clean working tree: skipped event, no dispatch, no advisory', async () => {
		_internals.computeExecutionDiff = async () => ({
			status: 'clean' as const,
		});
		let dispatched = false;
		_internals.dispatchReviewer = async () => {
			dispatched = true;
			return APPROVED;
		};
		const advisories: string[] = [];
		await runAutoReview(runInput(advisories));

		expect(dispatched).toBe(false);
		expect(advisories).toHaveLength(0);
		expect(readEvents()[0].verdict).toBe('skipped');
	});

	test('dispatch failure is fail-open: error event, no throw, no advisory', async () => {
		_internals.computeExecutionDiff = async () => ({
			status: 'ok' as const,
			diff: 'diff --git a/x b/x\n+1',
		});
		_internals.dispatchReviewer = async () => {
			throw new Error('no client');
		};
		const advisories: string[] = [];
		await expect(runAutoReview(runInput(advisories))).resolves.toBeUndefined();
		expect(advisories).toHaveLength(0);
		expect(readEvents()[0].verdict).toBe('error');
	});

	test('diff collection failure is reported honestly as error, not as skipped', async () => {
		// Previously a collection failure (git missing, timeout, maxBuffer
		// exceeded) was indistinguishable from a clean tree and mislabeled
		// "no working-tree changes" (adversarial review finding 4).
		_internals.computeExecutionDiff = async () => ({
			status: 'error' as const,
			reason: 'maxBuffer length exceeded',
		});
		let dispatched = false;
		_internals.dispatchReviewer = async () => {
			dispatched = true;
			return APPROVED;
		};
		const advisories: string[] = [];
		await runAutoReview(runInput(advisories));
		expect(dispatched).toBe(false);
		const event = readEvents()[0];
		expect(event.verdict).toBe('error');
		expect(event.detail).toContain('maxBuffer length exceeded');
	});
});

// ─── Schema ───────────────────────────────────────────────────────────────────

describe('AutoReviewConfigSchema', () => {
	test('safe defaults: disabled, phase_boundary trigger, bounded sizes', () => {
		const parsed = AutoReviewConfigSchema.parse({});
		expect(parsed.enabled).toBe(false);
		expect(parsed.trigger).toBe('phase_boundary');
		expect(parsed.timeout_ms).toBe(300_000);
		expect(parsed.max_diff_kb).toBe(256);
	});

	test('rejects out-of-range bounds', () => {
		expect(AutoReviewConfigSchema.safeParse({ timeout_ms: 1 }).success).toBe(
			false,
		);
		expect(
			AutoReviewConfigSchema.safeParse({ max_diff_kb: 99_999 }).success,
		).toBe(false);
		expect(
			AutoReviewConfigSchema.safeParse({ trigger: 'always' }).success,
		).toBe(false);
	});
});
