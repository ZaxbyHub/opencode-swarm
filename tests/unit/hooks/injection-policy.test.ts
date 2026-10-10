/**
 * Issue #3100: shared gate-aware injection policy for session-state
 * directive channels.
 *
 * Three blocks:
 * 1. Policy unit matrix — literal expectations per channel × gate state
 *    (PR_REVIEW / PR_FEEDBACK / null), NAMED must-not-suppress cases for
 *    the command banner and delegation steering under every state, and a
 *    structural ratchet (registry completeness; empty never-suppress
 *    lists; exhaustive matrix keys).
 * 2. Consumer integration — the real createSystemEnhancerHook on both
 *    context paths with real SQLite gate fixtures (plan-cursor-gate-
 *    suppression.test.ts conventions): the agent-activity table channel
 *    suppresses under PR_REVIEW and emits otherwise, the migrated #3093
 *    channels behave identically, and the kind-sharing adversarial
 *    advisory stays ungated (no over-suppression by candidate kind).
 * 3. Budget-report consumer — getContextBudgetReport counts zero cursor
 *    tokens when the policy suppressed the channel, plus the call-site
 *    wiring ratchet.
 *
 * Review follow-ups (PR #3181 swarm-pr-review): PRR-002 fail-open catch,
 * PRR-003 budget wiring and PRR-010 prototype-key lookup are covered by
 * the sibling suite tests/unit/hooks/injection-policy-consumers.test.ts;
 * this file keeps the policy matrix, the direct service check, and the
 * textual wiring ratchet.
 *
 * No mock.module: production modules are imported statically and driven
 * with real temp workspaces. No raw clock reads: gate fixtures carry
 * fixed activation timestamps.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	INJECTION_CHANNEL_CONTENT_CLASS,
	type InjectionChannel,
	SUPPRESSED_UNDER,
	shouldInjectChannel,
} from '../../../src/hooks/injection-policy';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { getContextBudgetReport } from '../../../src/services/context-budget-service';
import { resetSwarmState, swarmState } from '../../../src/state';
import { writeRawPrWorkflowGateState } from '../../helpers/pr-workflow-lane-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

afterAll(() => {
	closeAllProjectDbs();
});

const PR_REVIEW: { mode: 'PR_REVIEW' } = { mode: 'PR_REVIEW' };
const PR_FEEDBACK: { mode: 'PR_FEEDBACK' } = { mode: 'PR_FEEDBACK' };

describe('injection policy matrix (#3100) — literal decisions per channel and gate state', () => {
	it('plan-execution channels: plan-cursor suppresses ONLY under PR_REVIEW', () => {
		expect(shouldInjectChannel('plan-cursor', PR_REVIEW)).toBe(false);
		expect(shouldInjectChannel('plan-cursor', PR_FEEDBACK)).toBe(true);
		expect(shouldInjectChannel('plan-cursor', null)).toBe(true);
	});

	it('plan-execution channels: parallel-precheck suppresses ONLY under PR_REVIEW', () => {
		expect(shouldInjectChannel('parallel-precheck', PR_REVIEW)).toBe(false);
		expect(shouldInjectChannel('parallel-precheck', PR_FEEDBACK)).toBe(true);
		expect(shouldInjectChannel('parallel-precheck', null)).toBe(true);
	});

	it('agent-activity channel: suppresses ONLY under PR_REVIEW', () => {
		expect(shouldInjectChannel('agent-activity', PR_REVIEW)).toBe(false);
		expect(shouldInjectChannel('agent-activity', PR_FEEDBACK)).toBe(true);
		expect(shouldInjectChannel('agent-activity', null)).toBe(true);
	});

	it('AC2 policy-path preservation: command-banner NEVER suppresses under any gate state', () => {
		expect(shouldInjectChannel('command-banner', PR_REVIEW)).toBe(true);
		expect(shouldInjectChannel('command-banner', PR_FEEDBACK)).toBe(true);
		expect(shouldInjectChannel('command-banner', null)).toBe(true);
	});

	it('AC2 policy-path preservation: delegation-steering NEVER suppresses under any gate state', () => {
		expect(shouldInjectChannel('delegation-steering', PR_REVIEW)).toBe(true);
		expect(shouldInjectChannel('delegation-steering', PR_FEEDBACK)).toBe(true);
		expect(shouldInjectChannel('delegation-steering', null)).toBe(true);
	});

	it('unknown channel values fail toward emission', () => {
		expect(
			shouldInjectChannel('not-a-channel' as InjectionChannel, PR_REVIEW),
		).toBe(true);
	});

	it('structural ratchet: registry is complete and never-suppress lists stay empty', () => {
		const channels = Object.keys(
			INJECTION_CHANNEL_CONTENT_CLASS,
		) as InjectionChannel[];
		expect(channels.sort()).toEqual([
			'agent-activity',
			'command-banner',
			'delegation-steering',
			'parallel-precheck',
			'plan-cursor',
		]);
		for (const channel of channels) {
			expect(INJECTION_CHANNEL_CONTENT_CLASS[channel]).toBeTruthy();
		}
		// The two load-bearing classes must stay must-not-suppress (AC2):
		// suppression lists structurally empty, pinned so a future matrix
		// edit cannot silently sweep the banner or the delegation steering.
		expect(SUPPRESSED_UNDER['command-contract']).toEqual([]);
		expect(SUPPRESSED_UNDER['delegation-steering']).toEqual([]);
		// Every content class has a matrix row.
		expect(Object.keys(SUPPRESSED_UNDER).sort()).toEqual([
			'agent-activity',
			'command-contract',
			'delegation-steering',
			'plan-execution',
		]);
	});
});

const PLAN_MD = `# Injection policy fixture plan (#3100)

## Phase 1: Foundation [IN PROGRESS]
- [ ] 1.1: First pending task with a reasonably long description so the cursor has content to carry
- [ ] 1.2: Second pending task with a different scope area for lookahead coverage
`;

const CONTEXT_MD = `# Project context (injection policy fixture)

## Agent Activity

| Agent | Tool | Target | Status |
|---|---|---|---|
| coder | write | src/foo.ts | completed |
| reviewer | review | src/foo.ts | completed |

## Decisions

- D1: injection policy fixture decision row
`;

const AGENT_CONTEXT_MARKER = '[SWARM AGENT CONTEXT]';
const CURSOR_MARKER = '[SWARM PLAN CURSOR]';
const PARALLEL_HINT_MARKER = '[SWARM HINT] Parallel pre-check';
const ADVERSARIAL_MARKER = 'Same-model adversarial pair detected';

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
	const dir = canonicalMkdtemp('inj-policy-3100-');
	await mkdir(join(dir, '.swarm'), { recursive: true });
	await writeFile(join(dir, '.swarm', 'plan.md'), PLAN_MD, 'utf8');
	await writeFile(join(dir, '.swarm', 'context.md'), CONTEXT_MD, 'utf8');
	return dir;
}

async function runTransform(
	config: PluginConfig,
	dir: string,
	sessionID: string,
): Promise<string[]> {
	resetSwarmState();
	// The agent-activity channel keys on the composing session's active
	// agent (extractAgentContext).
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

async function withScenario(
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
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

describe('injection policy consumers (#3100) — agent-activity channel, both composition paths', () => {
	it('Path A + PR_REVIEW: agent-activity table suppressed while composition still runs', async () => {
		await withScenario(
			pathAConfig(),
			's1-patha-pr-review',
			'pr_review',
			async (system) => {
				const joined = system.join('\n');
				expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(false);
				expect(joined.includes(CURSOR_MARKER)).toBe(false);
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(false);
				expect(joined).toContain('[SWARM CONTEXT] Phase:');
			},
		);
	});

	it('Path B + PR_REVIEW: agent-activity candidate suppressed while composition still runs', async () => {
		await withScenario(
			pathBConfig(),
			's2-pathb-pr-review',
			'pr_review',
			async (system) => {
				const joined = system.join('\n');
				expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(false);
				expect(joined.includes(CURSOR_MARKER)).toBe(false);
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(false);
				expect(joined).toContain('[SWARM CONTEXT] Current phase:');
			},
		);
	});

	it('Path A + PR_FEEDBACK: agent-activity table still emitted (mode-scoped)', async () => {
		await withScenario(
			pathAConfig(),
			's3-patha-pr-feedback',
			'pr_feedback',
			async (system) => {
				const joined = system.join('\n');
				expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(true);
				expect(joined.includes(CURSOR_MARKER)).toBe(true);
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(true);
			},
		);
	});

	it('Path B + PR_FEEDBACK: agent-activity candidate still emitted (mode-scoped)', async () => {
		await withScenario(
			pathBConfig(),
			's4-pathb-pr-feedback',
			'pr_feedback',
			async (system) => {
				const joined = system.join('\n');
				expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(true);
				expect(joined.includes(CURSOR_MARKER)).toBe(true);
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(true);
			},
		);
	});

	it('Path A + no gate: byte-preserving default emits everything', async () => {
		await withScenario(
			pathAConfig(),
			's5-patha-no-gate',
			'none',
			async (system) => {
				const joined = system.join('\n');
				expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(true);
				expect(joined.includes(CURSOR_MARKER)).toBe(true);
				expect(joined.includes(PARALLEL_HINT_MARKER)).toBe(true);
			},
		);
	});

	it('session scoping: a gate owned by a DIFFERENT session does not suppress the agent-activity channel', async () => {
		const dir = await makeWorkspace();
		try {
			await writeRawPrWorkflowGateState(dir, 's6-gate-owner', {});
			const system = await runTransform(pathAConfig(), dir, 's6-composer');
			const joined = system.join('\n');
			expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(true);
			expect(joined.includes(CURSOR_MARKER)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it('no over-suppression by candidate kind: the adversarial advisory (kind agent_context) stays emitted under PR_REVIEW while the table suppresses', async () => {
		// Real kind-collision probe (plan-critic round 2): coder and
		// reviewer share one model so the same-model adversarial warning
		// composes; a by-kind guard sweeping every 'agent_context'
		// candidate would eat it. The table must suppress; the warning
		// must not.
		const dir = await makeWorkspace();
		try {
			const sessionID = 's7-adversarial-control';
			await activateGate(dir, sessionID, 'pr_review');
			resetSwarmState();
			swarmState.activeAgent.set(sessionID, 'reviewer');
			const config = {
				...pathBConfig(),
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			} as PluginConfig;
			const hook = createSystemEnhancerHook(config, dir, {
				surface: 'messages',
			});
			const transform = hook[
				'experimental.chat.system.transform'
			] as unknown as (
				input: { sessionID: string },
				output: { system: string[] },
			) => Promise<void>;
			const output = { system: [] as string[] };
			await transform({ sessionID }, output);
			resetSwarmState();
			const joined = output.system.join('\n');
			expect(joined.includes(ADVERSARIAL_MARKER)).toBe(true);
			expect(joined.includes(AGENT_CONTEXT_MARKER)).toBe(false);
			expect(joined.includes(CURSOR_MARKER)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe('injection policy consumer (#3100) — context-budget report', () => {
	it('counts cursor tokens by default and zero when the policy suppressed the channel', async () => {
		const dir = canonicalMkdtemp('inj-policy-budget-');
		try {
			await mkdir(join(dir, '.swarm'), { recursive: true });
			await writeFile(join(dir, '.swarm', 'plan.md'), PLAN_MD, 'utf8');
			const budgetConfig = {
				enabled: true,
				budgetTokens: 100_000,
				warningPct: 70,
				criticalPct: 90,
			};
			const defaultReport = await getContextBudgetReport(
				dir,
				'prompt',
				budgetConfig,
				{ enabled: true },
			);
			expect(defaultReport.planCursorTokens).toBeGreaterThan(0);
			const suppressedReport = await getContextBudgetReport(
				dir,
				'prompt',
				budgetConfig,
				{ enabled: true },
				true,
			);
			expect(suppressedReport.planCursorTokens).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it('wiring ratchet: both system-enhancer budget-report calls pass the policy decision (3 plan-cursor policy uses)', () => {
		const repoRoot = resolve(import.meta.dir, '..', '..', '..');
		const source = readFileSync(
			join(repoRoot, 'src', 'hooks', 'system-enhancer.ts'),
			'utf8',
		);
		// Reflow-tolerant (\s* spans the formatter's line wrapping): 1 policy
		// bind + 2 budget-report call sites. The budget sites must not use the
		// #3093 boolean identifier (that would break the frozen
		// 5-occurrence ratchet in plan-cursor-gate-ratchet-3093.test.ts).
		const uses = source.match(/shouldInjectChannel\(\s*'plan-cursor'/g) ?? [];
		expect(uses.length).toBe(3);
	});
});
