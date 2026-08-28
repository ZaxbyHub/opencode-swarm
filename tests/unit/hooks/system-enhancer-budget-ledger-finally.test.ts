/**
 * FR-004 regression test (issue #1737, task 2.2).
 *
 * The unified budget ledger write in system-enhancer.ts's hook body
 * (`resetUnifiedBudget` + `setSystemEnhancerDemand`) must be unconditional:
 * it must execute even when an exception is thrown AFTER `tryInject()` has
 * already mutated `output.system` — i.e. real token budget has already been
 * consumed — but BEFORE either finalize call site (Path A / Path B) is
 * reached.
 *
 * Before the fix, such a mid-turn throw was caught by the hook's own inner
 * `catch` (which just `warn()`s) and the ledger write was skipped entirely
 * for that turn. `getSystemEnhancerDemand()` fails open to 0 on a
 * missing/stale entry (src/services/injection-budget.ts), so
 * knowledge-injector could then allocate against undercounted demand and
 * push combined injected tokens past a configured `unified_injection_tokens`
 * ceiling.
 *
 * This test forces that exact mid-turn throw (via a marker-gated mock of
 * `extractPlanCursor`, which system-enhancer.ts calls uncaught right after
 * its first successful `tryInject()` call) and asserts the ledger still
 * reflects the real accumulated demand — not 0/absent — after the fix.
 *
 * Isolated in its own file (rather than folded into
 * system-enhancer-budget.test.ts) because it uses `mock.module` on
 * `hooks/extractors.js`, which — per the DI-seam comment in
 * src/hooks/utils.ts — leaks across files in Bun's shared test-runner
 * process. The throw is gated behind a unique marker string embedded only
 * in this file's own fixture plan.md, so the mock is a no-op for every
 * other test that happens to share the process.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import * as realExtractors from '../../../src/hooks/extractors.js';
import {
	clearTurnLedger,
	getProducerEmission,
	getTurnLedgerSummary,
} from '../../../src/services/injection-budget.js';
import { resetSwarmState } from '../../../src/state.js';

const FORCE_THROW_MARKER = '__FR004_FORCE_LEDGER_THROW__';

// Mocked BEFORE system-enhancer.ts is (lazily) required below, so the hook
// body's `extractPlanCursor` import resolves to this wrapper. Every real
// export is passed through untouched; only `extractPlanCursor` is wrapped,
// and it only diverges from the real implementation when the fixture's
// plan.md contains the marker string.
mock.module('../../../src/hooks/extractors.js', () => ({
	...realExtractors,
	extractPlanCursor: (
		planContent: string,
		options?: { maxTokens?: number; lookaheadTasks?: number },
	) => {
		if (
			typeof planContent === 'string' &&
			planContent.includes(FORCE_THROW_MARKER)
		) {
			throw new Error(
				'Simulated mid-turn exception after injection (FR-004 repro)',
			);
		}
		return realExtractors.extractPlanCursor(planContent, options);
	},
}));

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return fs.mkdtempSync(path.join(baseDir, 'system-enhancer-ledger-finally-'));
}

// Loaded lazily via `require` (after the `mock.module` registration above
// has already run at module-evaluation time) so the mocked extractors
// module is guaranteed to be in place. Mirrors the pattern used in
// system-enhancer-load-evidence.test.ts for the same reason.
function getCreateSystemEnhancerHook(): typeof import('../../../src/hooks/system-enhancer.js').createSystemEnhancerHook {
	return require('../../../src/hooks/system-enhancer.js')
		.createSystemEnhancerHook;
}

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'ledger-finally-test',
	title: 'Ledger Finally Test',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

describe('system-enhancer budget ledger — unconditional write on mid-turn throw (FR-004)', () => {
	let tempDir: string;
	const sessionID = 'fr004-ledger-finally-session';

	beforeEach(() => {
		tempDir = createRelativeTempDir();
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'plan.json'), PLAN_JSON);
		// The marker forces the mocked extractPlanCursor to throw — but only
		// AFTER the phase-header tryInject() above it in Path A has already
		// pushed real content and consumed real budget.
		fs.writeFileSync(
			path.join(swarmDir, 'plan.md'),
			`# Plan\n\n${FORCE_THROW_MARKER}\n`,
		);
		fs.writeFileSync(path.join(swarmDir, 'context.md'), '# Context\n');
		resetSwarmState();
		clearTurnLedger(sessionID);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		clearTurnLedger(sessionID);
	});

	it('writes the actual injected demand to the ledger even when the hook throws after injection', async () => {
		const unifiedBudget = 4600; // below the combined SE (≤4000) + KI (≤~660) cap
		const config: PluginConfig = {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
			context_budget: {
				max_injection_tokens: 4000,
				unified_injection_tokens: unifiedBudget,
			},
		};

		const createSystemEnhancerHook = getCreateSystemEnhancerHook();
		const hook = createSystemEnhancerHook(config, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: [] as string[] };

		// The simulated throw must not propagate out of the hook — the hook's
		// own inner catch (and the outer safeHook wrapper) swallow it.
		await expect(transform({ sessionID }, output)).resolves.toBeUndefined();

		// Sanity check on the fixture itself: the phase-header injection ran
		// BEFORE the simulated throw, so it must be present...
		expect(
			output.system.some((s) => s.includes('[SWARM CONTEXT] Phase:')),
		).toBe(true);
		// ...but the plan-cursor injection, which runs immediately after the
		// throw point, must be absent — proving the throw genuinely
		// interrupted the hook mid-injection (not that the fixture failed to
		// trigger Path A's injections at all).
		expect(output.system.some((s) => s.includes('[SWARM PLAN CURSOR]'))).toBe(
			false,
		);

		// FR-004/#2107 §2 assertion: despite the mid-turn throw, the ledger
		// reflects the REAL demand accumulated up to the throw point — not the
		// fail-open-to-0 default getProducerEmission() returns for a
		// missing/stale entry.
		const recordedDemand = getProducerEmission(sessionID, 'system-enhancer');
		expect(recordedDemand).toBeGreaterThan(0);

		// And beginTurnLedger() actually ran with the configured ceiling —
		// proving a ledger entry exists at all, not merely that
		// getProducerEmission's default happens to be non-zero.
		expect(getTurnLedgerSummary(sessionID)?.totalBudget).toBe(unifiedBudget);
	});
});
