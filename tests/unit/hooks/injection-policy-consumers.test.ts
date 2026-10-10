/**
 * Issue #3100 (PR #3181 swarm-pr-review follow-ups) — consumer-side tests
 * that complement tests/unit/hooks/injection-policy.test.ts:
 *
 * PRR-010 prototype-key lookup — Object.prototype keys ('constructor',
 *   '__proto__', ...) resolve to truthy inherited values, so a truthiness
 *   guard alone lets them through and then throws on
 *   `SUPPRESSED_UNDER[<Function>].includes`. Each must fail toward emission.
 * PRR-002 fail-open catch — a corrupt gate fixture drives the throwing
 *   gate-state read end-to-end and asserts composition still emits
 *   everything (the branch this PR mutated, `return false` -> `return null`).
 * PRR-003 behavioral budget wiring — the enhancer's two budget-report call
 *   sites are proven behaviorally, so an argument-level mutation fails a
 *   real assertion rather than only a textual occurrence count.
 *
 * Split from the main policy suite to stay under the repo's 500-line test
 * file cap (AGENTS.md invariant 7 / check:test-file-cap).
 *
 * No mock.module: real hook, real temp workspaces, real (corrupt) gate
 * fixtures. No raw clock reads.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	type InjectionChannel,
	shouldInjectChannel,
} from '../../../src/hooks/injection-policy';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { workflowGateStateRelativePath } from '../../../src/pr-review/persistence';
import {
	getSessionBudgetPct,
	getSessionBudgetTokens,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { writeRawPrWorkflowGateState } from '../../helpers/pr-workflow-lane-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

afterAll(() => {
	closeAllProjectDbs();
});

const PR_REVIEW: { mode: 'PR_REVIEW' } = { mode: 'PR_REVIEW' };

const PLAN_MD = `# Injection policy consumer fixture plan

## Phase 1: Foundation [IN PROGRESS]
- [ ] 1.1: First pending task with a reasonably long description so the cursor has content to carry
- [ ] 1.2: Second pending task with a different scope area for lookahead coverage
`;

const CONTEXT_MD = `# Project context (injection policy consumer fixture)

## Agent Activity

| Agent | Tool | Target | Status |
|---|---|---|---|
| coder | write | src/foo.ts | completed |
| reviewer | review | src/foo.ts | completed |

## Decisions

- D1: injection policy consumer fixture decision row
`;

const AGENT_CONTEXT_MARKER = '[SWARM AGENT CONTEXT]';
const CURSOR_MARKER = '[SWARM PLAN CURSOR]';
const PARALLEL_HINT_MARKER = '[SWARM HINT] Parallel pre-check';

function pathAConfig(): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	} as PluginConfig;
}

function pathBConfig(): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		context_budget: { scoring: { enabled: true } },
	} as PluginConfig;
}

/** Runs the transform and captures the session budget BEFORE the
 *  resetSwarmState() inside clears `lastBudgetBySession` — the observable
 *  effect of the enhancer's budget-report call sites. */
async function runTransformWithBudget(
	config: PluginConfig,
	dir: string,
	sessionID: string,
): Promise<{ system: string[]; budgetPct: number; budgetTokens: number }> {
	resetSwarmState();
	swarmState.activeAgent.set(sessionID, 'architect');
	const hook = createSystemEnhancerHook(config, dir, { surface: 'messages' });
	const transform = hook['experimental.chat.system.transform'] as unknown as (
		input: { sessionID: string },
		output: { system: string[] },
	) => Promise<void>;
	const output = { system: [] as string[] };
	await transform({ sessionID }, output);
	const budgetPct = getSessionBudgetPct(sessionID);
	const budgetTokens = getSessionBudgetTokens(sessionID);
	resetSwarmState();
	return { system: output.system, budgetPct, budgetTokens };
}

async function runTransform(
	config: PluginConfig,
	dir: string,
	sessionID: string,
): Promise<string[]> {
	resetSwarmState();
	swarmState.activeAgent.set(sessionID, 'architect');
	const hook = createSystemEnhancerHook(config, dir, {
		surface: 'messages',
	});
	const transform = hook['experimental.chat.system.transform'] as unknown as (
		input: { sessionID: string },
		output: { system: string[] },
	) => Promise<void>;
	const output = { system: [] as string[] };
	await transform({ sessionID }, output);
	resetSwarmState();
	return output.system;
}

async function seedWorkspace(
	dir: string,
	planMd = PLAN_MD,
	contextMd: string | null = CONTEXT_MD,
): Promise<void> {
	await mkdir(join(dir, '.swarm'), { recursive: true });
	await writeFile(join(dir, '.swarm', 'plan.md'), planMd, 'utf8');
	if (contextMd !== null) {
		await writeFile(join(dir, '.swarm', 'context.md'), contextMd, 'utf8');
	}
}

/**
 * Write a gate-state file that is invalid JSON, WITHOUT creating an
 * authoritative coordination row. `readPrWorkflowGateState` then falls
 * through to the legacy shadow file, throws on the parse, and the
 * composer's `.catch(() => null)` runs — the fail-open branch under test.
 */
async function writeGateFixtureBytes(
	dir: string,
	sessionID: string,
): Promise<void> {
	const rel = workflowGateStateRelativePath(sessionID);
	await mkdir(dirname(join(dir, '.swarm', rel)), { recursive: true });
	await writeFile(join(dir, '.swarm', rel), '{"corrupt":not-json', 'utf8');
}

describe('injection policy — prototype-key lookup safety (PRR-010)', () => {
	// Object.prototype keys resolve to truthy inherited values, so a
	// truthiness guard alone would pass them and then throw on
	// `SUPPRESSED_UNDER[<Function>].includes`. Each must fail toward
	// emission instead.
	for (const key of [
		'constructor',
		'__proto__',
		'toString',
		'hasOwnProperty',
		'valueOf',
		'isPrototypeOf',
	]) {
		it(`unknown channel "${key}" fails toward emission instead of throwing`, () => {
			expect(() =>
				shouldInjectChannel(key as InjectionChannel, PR_REVIEW),
			).not.toThrow();
			expect(shouldInjectChannel(key as InjectionChannel, PR_REVIEW)).toBe(
				true,
			);
		});
	}
});

describe('injection policy — fail-open on a corrupt gate read (PRR-002)', () => {
	it('a throwing gate-state read still emits every channel (fail-open), Path A', async () => {
		const dir = canonicalMkdtemp('inj-policy-corrupt-');
		const sessionID = 'corrupt-gate-patha';
		try {
			await mkdir(join(dir, '.swarm'), { recursive: true });
			await writeFile(join(dir, '.swarm', 'plan.md'), PLAN_MD, 'utf8');
			await writeFile(join(dir, '.swarm', 'context.md'), CONTEXT_MD, 'utf8');
			// Corrupt the LEGACY gate file only (no authoritative row is
			// written), so the reader falls through to the file path and
			// throws on the JSON parse. This drives the composer's
			// `.catch(() => null)` — the branch this PR mutated.
			await writeGateFixtureBytes(dir, sessionID);
			const system = await runTransform(pathAConfig(), dir, sessionID);
			const joined = system.join('\n');
			// Fail-open == the no-gate scenario: nothing suppressed.
			expect(joined.includes(CURSOR_MARKER)).toBe(true);
			expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(true);
			expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it('a throwing gate-state read still emits every channel (fail-open), Path B', async () => {
		const dir = canonicalMkdtemp('inj-policy-corrupt-b-');
		const sessionID = 'corrupt-gate-pathb';
		try {
			await mkdir(join(dir, '.swarm'), { recursive: true });
			await writeFile(join(dir, '.swarm', 'plan.md'), PLAN_MD, 'utf8');
			await writeFile(join(dir, '.swarm', 'context.md'), CONTEXT_MD, 'utf8');
			await writeGateFixtureBytes(dir, sessionID);
			const system = await runTransform(pathBConfig(), dir, sessionID);
			const joined = system.join('\n');
			expect(joined.includes(CURSOR_MARKER)).toBe(true);
			expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe('injection policy — enhancer budget wiring is behavioral, not textual (PRR-003)', () => {
	// The source-scan ratchet can only count occurrences; an
	// argument-level mutation at either budget call site would keep the
	// count at 3. This drives the enhancer and asserts the observable
	// consequence: under an active PR_REVIEW gate the stored session
	// budget must drop by the cursor's share, because the report stops
	// counting a cursor the prompt never contained.
	function budgetConfig(): PluginConfig {
		return {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
				model_limits: { default: 4000 },
			},
		} as unknown as PluginConfig;
	}

	const BUDGET_PLAN_MD = `# Budget wiring fixture plan

## Phase 1: Foundation [IN PROGRESS]
- [ ] 1.1: A pending task with a deliberately long description so the extracted plan cursor carries a large token payload that is well above measurement noise for the percentage assertion below
- [ ] 1.2: Another pending task with a different scope area and another long description so lookahead coverage contributes further cursor tokens to the budget fixture
- [ ] 1.3: A third pending task, again long, so the cursor is comfortably large relative to the configured budget denominator
- [ ] 1.4: A fourth pending task with a long description to push the cursor token count further above the noise floor for this fixture
`;

	it('Path A: an active PR_REVIEW gate lowers the stored session budget by the suppressed cursor', async () => {
		const dir = canonicalMkdtemp('inj-policy-budget-wire-');
		const sessionID = 'budget-wire-patha';
		try {
			await mkdir(join(dir, '.swarm'), { recursive: true });
			await writeFile(join(dir, '.swarm', 'plan.md'), BUDGET_PLAN_MD, 'utf8');

			const ungated = await runTransformWithBudget(
				budgetConfig(),
				dir,
				sessionID,
			);
			expect(ungated.system.join('\n')).toContain(CURSOR_MARKER);
			expect(ungated.budgetPct).toBeGreaterThan(0);

			await writeRawPrWorkflowGateState(dir, sessionID, {});
			const gated = await runTransformWithBudget(
				budgetConfig(),
				dir,
				sessionID,
			);
			expect(gated.system.join('\n')).not.toContain(CURSOR_MARKER);
			const { budgetPct: ungatedPct } = ungated;
			const { budgetPct: gatedPct, budgetTokens: denominator } = gated;

			// The wiring's whole point: the report stops counting the
			// suppressed cursor, so the budget percentage must drop and
			// the recovered tokens must be a real, non-trivial amount.
			expect(gatedPct).toBeLessThan(ungatedPct);
			const recoveredTokens = ((ungatedPct - gatedPct) * denominator) / 100;
			expect(recoveredTokens).toBeGreaterThan(0);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
