/**
 * `/swarm status` renders the context estimate against the denominator the
 * percentage was ACTUALLY measured with (issue #1619).
 *
 * The renderer used to back-compute the token estimate from
 * `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens` — a constant whose value was
 * **40000** (`origin/main:src/services/context-budget-service.ts:116`), NOT the
 * 128000 schema default for `model_limits.default`, which lived on a different
 * path. That was already wrong for anyone who set `context_budget.model_limits`,
 * and became wrong for nearly everyone once the denominator started deriving
 * from the live `model.limit.context`: a session on a 1M-window model at 12.5%
 * was rendered as "12.5% used (est. 5,000 / 40,000 tokens)", numbers that
 * contradict the percentage printed beside them.
 *
 * The fix pairs the denominator with the pct in one per-session record
 * at the two statements that write the pct, and surfaces it on `StatusData`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
	formatStatusMarkdown,
	getStatusData,
	type StatusData,
} from '../../../src/services/status-service';
import {
	resetSwarmState,
	setSessionBudget,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function baseStatus(overrides: Partial<StatusData> = {}): StatusData {
	return {
		hasPlan: true,
		currentPhase: 'Phase 1',
		completedTasks: 1,
		totalTasks: 4,
		agentCount: 3,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		compactionCount: 0,
		lastSnapshotAt: null,
		...overrides,
	};
}

/** Pulls the `**Context**: …` line out of the rendered markdown. */
function contextLine(markdown: string): string | undefined {
	return markdown.split('\n').find((l) => l.startsWith('**Context**:'));
}

describe('formatStatusMarkdown — context denominator', () => {
	test('renders the estimate against a 1M window, not the 40000 constant', () => {
		const line = contextLine(
			formatStatusMarkdown(
				baseStatus({ contextBudgetPct: 12.5, contextBudgetTokens: 1_000_000 }),
			),
		);
		expect(line).toBe(
			'**Context**: 12.5% used (est. 125,000 / 1,000,000 tokens)',
		);
		// The pre-fix render would have said `5,000 / 40,000` for the same pct —
		// 40000 was `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens` on main. Pin the
		// real pre-fix denominator, not the 128000 that was never on this path.
		expect(line).not.toContain('40,000');
		expect(line).not.toContain('128,000');
	});

	test('renders the estimate against a 200k Copilot window', () => {
		expect(
			contextLine(
				formatStatusMarkdown(
					baseStatus({ contextBudgetPct: 50, contextBudgetTokens: 200000 }),
				),
			),
		).toBe('**Context**: 50.0% used (est. 100,000 / 200,000 tokens)');
	});

	test('honours a user-configured working budget smaller than the window', () => {
		expect(
			contextLine(
				formatStatusMarkdown(
					baseStatus({ contextBudgetPct: 80, contextBudgetTokens: 60000 }),
				),
			),
		).toBe('**Context**: 80.0% used (est. 48,000 / 60,000 tokens)');
	});

	test('omits the token estimate entirely when the denominator is unknown', () => {
		// Rather than fabricating one against a constant. Unreachable in
		// production — the pct and the denominator are written together — but a
		// synthetic snapshot must not be given a made-up window.
		for (const contextBudgetTokens of [undefined, null, 0]) {
			const line = contextLine(
				formatStatusMarkdown(
					baseStatus({ contextBudgetPct: 42.5, contextBudgetTokens }),
				),
			);
			expect(line).toBe('**Context**: 42.5% used');
		}
	});

	test('still renders nothing when no budget report has run', () => {
		expect(
			contextLine(formatStatusMarkdown(baseStatus({ contextBudgetPct: null }))),
		).toBeUndefined();
	});
});

describe('getStatusData — denominator is carried from swarmState', () => {
	let root: string;

	beforeEach(() => {
		resetSwarmState();
		root = canonicalMkdtemp('swarm-status-denominator-');
		mkdirSync(path.join(root, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		rmSync(root, { recursive: true, force: true });
	});

	test('surfaces the denominator alongside the pct', async () => {
		setSessionBudget('s-display', 37.5, 200000);
		const status = await getStatusData(root, {});
		expect(status.contextBudgetPct).toBe(37.5);
		expect(status.contextBudgetTokens).toBe(200000);
		expect(contextLine(formatStatusMarkdown(status))).toBe(
			'**Context**: 37.5% used (est. 75,000 / 200,000 tokens)',
		);
	});

	test('reports a null denominator before any budget report has run', async () => {
		const status = await getStatusData(root, {});
		expect(status.contextBudgetTokens).toBeNull();
	});
});
