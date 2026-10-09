/**
 * Issue #3093: plan-cursor + parallel pre-check suppression under an active
 * PR_REVIEW gate.
 *
 * Pins the #3093 contract at the repo-suite layer: while a PR-workflow gate
 * with mode 'PR_REVIEW' is active for the composing session (durable state via
 * the real SQLite coordination authority), the system-enhancer composition
 * must NOT emit the `[SWARM PLAN CURSOR]` block nor the `[SWARM HINT]
 * Parallel pre-check enabled` guidance on EITHER context path (Path A default
 * injection, Path B opt-in scoring candidates) — while the `[SWARM CONTEXT]`
 * phase header still proves the branch ran rather than the whole composition
 * dying. Suppression is mode-scoped (an active PR_FEEDBACK gate keeps the
 * cursor) and non-sticky (cursor emission resumes after
 * clearPrWorkflowGateState). No gate at all keeps the byte-preserving default.
 *
 * No mock.module: production modules are imported statically and driven with
 * real temp workspaces (system-enhancer-plan-cursor-config-2580 precedent).
 * No raw clock reads: the gate fixture carries fixed activation timestamps.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { clearPrWorkflowGateState } from '../../../src/hooks/pr-workflow-gate';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState } from '../../../src/state';
import { writeRawPrWorkflowGateState } from '../../helpers/pr-workflow-lane-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Release the process-cached SQLite project-DB handles the gate fixtures open
// (PRR-009): verdicts are unaffected, but leaking them for the shard lifetime
// diverges from the sibling-suite convention (21 hooks suites close them).
afterAll(() => {
	closeAllProjectDbs();
});

const PLAN_MD = `# PC3093 Gate suppression regression fixture plan

## Phase 1: Foundation [COMPLETE]
- [x] 1.1: Scaffold the isolated workspace conventions with deterministic fixtures so gate-state scenarios never share mutable directories or depend on wall-clock time
- [x] 1.2: Wire the durable gate-state authority through the production SQLite coordination store so test-written state is byte-equivalent to what a real activation persists

## Phase 2: Composition [COMPLETE]
- [x] 2.1: Route both architect context paths through the shared composition boundary so suppression decisions observe one durable gate input instead of two divergent ones
- [x] 2.2: Keep the cursor builder pure in the extraction layer so gate reads belong exclusively to the composition layer that owns emission

## Phase 3: Verification [IN PROGRESS]
- [ ] 3.1: Pin the suppression contract for the default injection path with an active PR_REVIEW gate for the exact composing session
- [ ] 3.2: Pin the suppression contract for the scoring-candidates path under the same active gate
- [ ] 3.3: Prove suppression is not sticky by clearing the gate mid-scenario and observing resumed cursor emission on the same directory and session

## Phase 4: Release [PENDING]
- [ ] 4.1: Ship the release fragment and confirm the merge queue stays green across every supported host platform
`;

const CURSOR_OPEN = '[SWARM PLAN CURSOR]';
const CURSOR_CLOSE = '[/SWARM PLAN CURSOR]';
const PARALLEL_HINT_MARKER = '[SWARM HINT] Parallel pre-check enabled';
const PARALLEL_HINT_DISABLED_MARKER =
	'[SWARM HINT] Parallel pre-check disabled';

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

async function makeWorkspace(): Promise<string> {
	const dir = canonicalMkdtemp('pc-gate-3093-');
	await mkdir(join(dir, '.swarm'), { recursive: true });
	await writeFile(join(dir, '.swarm', 'plan.md'), PLAN_MD, 'utf8');
	return dir;
}

async function runTransform(
	config: PluginConfig,
	dir: string,
	sessionID: string,
): Promise<string[]> {
	resetSwarmState();
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

type GateFixture = 'none' | 'pr_review' | 'pr_feedback';

async function activateGate(
	dir: string,
	sessionID: string,
	gate: GateFixture,
): Promise<void> {
	if (gate === 'pr_review') {
		await writeRawPrWorkflowGateState(dir, sessionID, {});
	} else if (gate === 'pr_feedback') {
		await writeRawPrWorkflowGateState(dir, sessionID, {
			mode: 'PR_FEEDBACK',
		});
	}
}

async function withGateScenario(
	config: PluginConfig,
	sessionID: string,
	gate: GateFixture,
	body: (system: string[]) => Promise<void>,
): Promise<void> {
	const dir = await makeWorkspace();
	try {
		await activateGate(dir, sessionID, gate);
		await body(await runTransform(config, dir, sessionID));
	} finally {
		// Best-effort: the hook can hold a handle on Windows until process
		// exit; a leaked tmp dir never affects verdicts.
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

function cursorBlock(system: string[]): string | null {
	const joined = system.join('\n');
	const start = joined.indexOf(CURSOR_OPEN);
	const end = joined.indexOf(CURSOR_CLOSE);
	if (start === -1 || end === -1 || end < start) return null;
	return joined.slice(start, end + CURSOR_CLOSE.length);
}

function hasParallelHint(system: string[]): boolean {
	return system.join('\n').includes(PARALLEL_HINT_MARKER);
}

describe('plan-cursor gate suppression (#3093) — active PR_REVIEW gate', () => {
	it('Path A: suppresses the cursor block and the parallel pre-check hint while composition still runs', async () => {
		await withGateScenario(
			pathAConfig(),
			's1-patha-pr-review',
			'pr_review',
			async (system) => {
				expect(cursorBlock(system)).toBeNull();
				expect(hasParallelHint(system)).toBe(false);
				expect(system.join('\n')).toContain('[SWARM CONTEXT] Phase:');
			},
		);
	});

	it('Path B: suppresses the cursor candidate and the parallel pre-check hint while composition still runs', async () => {
		await withGateScenario(
			pathBConfig(),
			's2-pathb-pr-review',
			'pr_review',
			async (system) => {
				expect(cursorBlock(system)).toBeNull();
				expect(hasParallelHint(system)).toBe(false);
				expect(system.join('\n')).toContain('[SWARM CONTEXT] Current phase:');
			},
		);
	});

	it('Path A: suppression is not sticky — the cursor resumes after clearPrWorkflowGateState on the same dir+session', async () => {
		const dir = await makeWorkspace();
		const sessionID = 's3-clear-resume';
		try {
			await activateGate(dir, sessionID, 'pr_review');

			const first = await runTransform(pathAConfig(), dir, sessionID);
			expect(cursorBlock(first)).toBeNull();
			expect(hasParallelHint(first)).toBe(false);
			expect(first.join('\n')).toContain('[SWARM CONTEXT] Phase:');

			await clearPrWorkflowGateState(dir, sessionID);

			const second = await runTransform(pathAConfig(), dir, sessionID);
			expect(cursorBlock(second)).toContain(CURSOR_OPEN);
			expect(hasParallelHint(second)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe('plan-cursor gate suppression (#3093) — mode discriminant and default', () => {
	it('Path A: an active PR_FEEDBACK gate still emits the cursor and the parallel pre-check hint', async () => {
		await withGateScenario(
			pathAConfig(),
			's4-patha-pr-feedback',
			'pr_feedback',
			async (system) => {
				expect(cursorBlock(system)).toContain(CURSOR_OPEN);
				expect(hasParallelHint(system)).toBe(true);
			},
		);
	});

	it('Path A: no gate at all still emits the cursor and the parallel pre-check hint (byte-preserving default)', async () => {
		await withGateScenario(
			pathAConfig(),
			's5-patha-no-gate',
			'none',
			async (system) => {
				expect(cursorBlock(system)).toContain(CURSOR_OPEN);
				expect(hasParallelHint(system)).toBe(true);
			},
		);
	});
});

describe('plan-cursor gate suppression (#3093) — disabled pre-check variant, Path B positive controls, session scoping', () => {
	function pathAWithPrecheckDisabled(): PluginConfig {
		return {
			...pathAConfig(),
			pipeline: { parallel_precheck: false },
		} as PluginConfig;
	}

	function pathBWithPrecheckDisabled(): PluginConfig {
		return {
			...pathBConfig(),
			pipeline: { parallel_precheck: false },
		} as PluginConfig;
	}

	it('Path A + PR_REVIEW + parallel_precheck:false suppresses BOTH hint variants (PRR-006)', async () => {
		await withGateScenario(
			pathAWithPrecheckDisabled(),
			's6-patha-disabled-precheck',
			'pr_review',
			async (system) => {
				const joined = system.join('\n');
				expect(cursorBlock(system)).toBeNull();
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(false);
				expect(joined.includes(PARALLEL_HINT_DISABLED_MARKER)).toBe(false);
				expect(joined).toContain('[SWARM CONTEXT] Phase:');
			},
		);
	});

	it('Path B + PR_REVIEW + parallel_precheck:false suppresses BOTH hint variants (PRR-006)', async () => {
		await withGateScenario(
			pathBWithPrecheckDisabled(),
			's7-pathb-disabled-precheck',
			'pr_review',
			async (system) => {
				const joined = system.join('\n');
				expect(cursorBlock(system)).toBeNull();
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(false);
				expect(joined.includes(PARALLEL_HINT_DISABLED_MARKER)).toBe(false);
				expect(joined).toContain('[SWARM CONTEXT] Current phase:');
			},
		);
	});

	it('Path B positive control: no gate emits the cursor AND the enabled hint (PRR-006)', async () => {
		await withGateScenario(
			pathBConfig(),
			's8-pathb-nogate-positive',
			'none',
			async (system) => {
				expect(cursorBlock(system)).toContain(CURSOR_OPEN);
				expect(hasParallelHint(system)).toBe(true);
			},
		);
	});

	it('Path B positive control: PR_FEEDBACK emits the cursor AND the enabled hint (PRR-006)', async () => {
		await withGateScenario(
			pathBConfig(),
			's9-pathb-prfeedback-positive',
			'pr_feedback',
			async (system) => {
				expect(cursorBlock(system)).toContain(CURSOR_OPEN);
				expect(hasParallelHint(system)).toBe(true);
			},
		);
	});

	it('session scoping: a gate owned by a DIFFERENT session does not suppress (PRR-007)', async () => {
		const dir = await makeWorkspace();
		try {
			await writeRawPrWorkflowGateState(dir, 's10-gate-owner', {});
			const system = await runTransform(pathAConfig(), dir, 's10-composer');
			expect(cursorBlock(system)).toContain(CURSOR_OPEN);
			expect(hasParallelHint(system)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
