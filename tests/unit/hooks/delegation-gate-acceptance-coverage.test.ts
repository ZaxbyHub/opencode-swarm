/**
 * Issue #1687 (F-007): pre-dispatch ACCEPTANCE *coverage* enforcement for coder
 * and reviewer delegations. The existing gate only proves ACCEPTANCE is
 * non-empty (`validateCoderReviewerAcceptanceField`); this layer proves the
 * ACCEPTANCE text actually CONTAINS the verbatim requirement body for each spec
 * FR-###/SC-### the plan task maps to — so `ACCEPTANCE: lorem ipsum` on a mapped
 * task is now blocked, while every uncertainty stays FAIL-OPEN (a false-positive
 * BLOCK would halt a real swarm).
 *
 * Two layers:
 *  1. Pure-unit tests of the exported helpers
 *     (extractSpecRequirementBodyById / normalizeAcceptanceText /
 *     checkAcceptanceCoversFrRefs).
 *  2. Integration tests through the REAL `toolBefore` hook, proving the check is
 *     wired ABOVE the coder-only early-return (so REVIEWER is gated too) and that
 *     every precondition-failure path is fail-open.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	checkAcceptanceCoversFrRefs,
	createDelegationGateHook,
	extractSpecRequirementBodyById,
	normalizeAcceptanceText,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

// ---------------------------------------------------------------------------
// Shared spec fixture (mirrors the real spec.md bullet format:
//   `- **FR-001 — Title.** body`  and  `- **SC-001 (FR-001).** body`).
// ---------------------------------------------------------------------------
const FR001_BODY =
	'The widget SHALL render the configured label exactly once on mount.';
const FR002_BODY =
	'The task SHALL carry all mapped requirements when it maps to more than one.';
const SC001_BODY =
	'Given a mounted widget, when the label is set, then it appears verbatim.';

const SPEC_MD = [
	'# Spec 1687 fixture',
	'',
	'## Functional Requirements',
	'',
	`- **FR-001 — Widget renders.** ${FR001_BODY}`,
	`- **FR-002 — Multi map.** ${FR002_BODY}`,
	'',
	'## Success Criteria',
	'',
	`- **SC-001 (FR-001).** ${SC001_BODY}`,
	'',
].join('\n');

// ===========================================================================
// Layer 1 — pure-unit tests of the exported helpers
// ===========================================================================

describe('extractSpecRequirementBodyById (unit)', () => {
	it('returns the body for an FR-### line (excludes the id/title prefix)', () => {
		const body = extractSpecRequirementBodyById(SPEC_MD, 'FR-001');
		expect(body).not.toBeNull();
		expect((body as string).trim()).toBe(FR001_BODY);
		// The `**FR-001 — Widget renders.**` prefix is NOT part of the body.
		expect(body).not.toContain('Widget renders');
	});

	it('returns the body for an SC-### line (excludes the (FR-###) prefix)', () => {
		const body = extractSpecRequirementBodyById(SPEC_MD, 'SC-001');
		expect(body).not.toBeNull();
		expect((body as string).trim()).toBe(SC001_BODY);
		expect(body).not.toContain('(FR-001)');
	});

	it('returns null for an id that is not present in the spec', () => {
		expect(extractSpecRequirementBodyById(SPEC_MD, 'FR-999')).toBeNull();
		expect(extractSpecRequirementBodyById(SPEC_MD, 'SC-042')).toBeNull();
	});

	it('does not match a longer id sharing a prefix (word boundary)', () => {
		const spec = '- **FR-0012 — Longer id.** Some other requirement body.';
		expect(extractSpecRequirementBodyById(spec, 'FR-001')).toBeNull();
	});

	it('does not treat an in-parenthetical id as its own bullet', () => {
		// FR-001 appears only inside SC-001's `(FR-001)` parenthetical here.
		const spec = `- **SC-001 (FR-001).** ${SC001_BODY}`;
		expect(extractSpecRequirementBodyById(spec, 'FR-001')).toBeNull();
	});
});

describe('normalizeAcceptanceText (unit)', () => {
	it('collapses whitespace/newlines, strips ** and backticks, lowercases', () => {
		const raw = '- **FR-001**  The `widget`\n   SHALL   render.';
		expect(normalizeAcceptanceText(raw)).toBe(
			'fr-001 the widget shall render.',
		);
	});

	it('is symmetric: same output for the same content with markup differences', () => {
		const a = normalizeAcceptanceText(`**FR-001 — X.** ${FR001_BODY}`);
		const b = normalizeAcceptanceText(
			`fr-001 — x.   ${FR001_BODY.toLowerCase()}`,
		);
		expect(a).toBe(b);
	});

	// Closeout finding (F-007): the architect's LLM "byte-for-byte" copy routinely
	// substitutes an em-dash `—` for `--` and curly quotes for straight ones. The
	// real spec bodies contain both (em-dashes and apostrophes), so the normalizer
	// MUST fold these symmetrically or a good-faith verbatim copy false-blocks and
	// halts the swarm.
	it('folds em/en dash and `--` to the same token', () => {
		expect(normalizeAcceptanceText('a — b')).toBe(
			normalizeAcceptanceText('a -- b'),
		);
		expect(normalizeAcceptanceText('a – b')).toBe(
			normalizeAcceptanceText('a - b'),
		);
	});

	it('folds curly quotes to straight (single and double)', () => {
		expect(normalizeAcceptanceText('the coder’s field')).toBe(
			normalizeAcceptanceText("the coder's field"),
		);
		expect(normalizeAcceptanceText('say “hi” now')).toBe(
			normalizeAcceptanceText('say "hi" now'),
		);
	});
});

describe('checkAcceptanceCoversFrRefs (unit)', () => {
	it('covered when ACCEPTANCE contains the verbatim body', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `TASK: x\nACCEPTANCE: ${FR001_BODY}`,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when ACCEPTANCE also includes the **FR-001 — Title.** prefix', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: **FR-001 — Widget renders.** ${FR001_BODY}`,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered despite whitespace / markdown / case differences', () => {
		const noisy = `ACCEPTANCE:   the WIDGET shall   render\tthe **configured** label exactly once on mount.`;
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: noisy,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('NOT covered for lorem ipsum — names the missing id', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: lorem ipsum dolor sit amet',
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: false, missingId: 'FR-001' });
	});

	it('multi-FR: covered when both bodies present', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY} ${FR002_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('multi-FR: not-covered names the FIRST missing id', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: false, missingId: 'FR-002' });
	});

	it('unknown id in frRefs is skipped (fail-open, covered:true)', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: totally unrelated text',
			frRefs: ['FR-999'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('empty frRefs => covered:true', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: anything',
			frRefs: [],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	// Closeout finding (F-007): spec body uses an em-dash and a curly apostrophe;
	// a good-faith copy that renders them as `--` / straight `'` must STILL be
	// covered (no false-block). This is the exact real-spec case (FR bodies in the
	// live spec.md carry em-dashes and apostrophes).
	it('covered when copy differs only by dash-width / curly-vs-straight quotes', () => {
		const punctSpec = [
			'## Functional Requirements',
			'',
			'- **FR-050 — Coder’s field.** The coder’s ACCEPTANCE — populated by the architect — SHALL match verbatim.',
			'',
		].join('\n');
		const goodFaithCopy =
			"ACCEPTANCE: The coder's ACCEPTANCE -- populated by the architect -- SHALL match verbatim.";
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: goodFaithCopy,
			frRefs: ['FR-050'],
			specText: punctSpec,
		});
		expect(result).toEqual({ covered: true });
	});
});

// ===========================================================================
// Layer 2 — integration through toolBefore (wiring + reviewer coverage + fail-open)
// ===========================================================================

function makeConfig(): PluginConfig {
	// No `worktree` block => worktree serialization is a no-op; delegation_gate on.
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

/**
 * Plan with:
 *  - task 1.1 mapped to FR-001 (the check target),
 *  - task 1.2 with NO fr_refs (FR-004 fail-open target).
 * Records the plan-critic approval snapshot so the plan-critic gate does not
 * pre-empt the coverage check on the coder path.
 */
async function writeFixturePlan(dir: string): Promise<void> {
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Coverage Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small' as const,
						description: 'Mapped task',
						depends: [],
						files_touched: [],
						fr_refs: ['FR-001'],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small' as const,
						description: 'Unmapped task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), SPEC_MD);
	await recordPlanCriticApproval(dir, plan);
}

function toolBeforeInput(sessionID: string, callID = 'call-1') {
	return { tool: 'Task', sessionID, callID };
}

describe('toolBefore ACCEPTANCE coverage gate (integration, F-007/#1687)', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c1687-cov-');
		await writeFixturePlan(tempDir);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('coder, mapped task, verbatim FR body in ACCEPTANCE => resolves', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-coder-ok', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-coder-ok'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${FR001_BODY}`,
				},
			}),
		).resolves.toBeUndefined();
	});

	it('coder, mapped task, ACCEPTANCE = lorem ipsum => rejects COVERAGE_MISMATCH (task-id DISCOVERED from the TASK: line, the real free-text path — no args.task_id)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-coder-bad', 'architect');
		// Deliberately omit args.task_id so resolveDelegatedPlanTaskId must extract
		// "1.1" from the TASK: line — the production resolution path for free-text
		// coder dispatches, where task_id is not reliably present.
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-coder-bad'), {
				args: {
					subagent_type: 'coder',
					prompt: 'TASK: 1.1 implement it\nACCEPTANCE: lorem ipsum',
				},
			}),
		).rejects.toThrow(/ACCEPTANCE_FIELD_COVERAGE_MISMATCH/);
	});

	it('REVIEWER, mapped task, ACCEPTANCE = lorem ipsum => rejects (proves check gates reviewer above the coder-only return)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-rev-bad', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-rev-bad'), {
				args: {
					subagent_type: 'reviewer',
					task_id: '1.1',
					prompt: 'TASK: 1.1 review it\nACCEPTANCE: lorem ipsum',
				},
			}),
		).rejects.toThrow(/ACCEPTANCE_FIELD_COVERAGE_MISMATCH/);
	});

	it('task with NO fr_refs, task-derived ACCEPTANCE => resolves (FR-004 fail-open)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-nofr', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-nofr'), {
				args: {
					subagent_type: 'coder',
					task_id: '1.2',
					prompt:
						'TASK: 1.2 implement the unmapped task\nACCEPTANCE: done when the unmapped task compiles and its tests pass',
				},
			}),
		).resolves.toBeUndefined();
	});

	it('spec.md absent but fr_refs set => resolves (fail-open on missing spec)', async () => {
		fs.rmSync(path.join(tempDir, '.swarm', 'spec.md'), { force: true });
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-nospec', 'architect');
		// Reviewer isolates the check from downstream coder-only gates; the mapped
		// task still resolves to 1.1, but the spec read fails => fail-open skip.
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-nospec'), {
				args: {
					subagent_type: 'reviewer',
					task_id: '1.1',
					prompt: 'TASK: 1.1 review it\nACCEPTANCE: anything at all here',
				},
			}),
		).resolves.toBeUndefined();
	});

	it('unresolvable task_id (no id in prompt) => resolves (fail-open)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-noid', 'architect');
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-noid'), {
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: review the thing\nACCEPTANCE: lorem ipsum unresolved',
				},
			}),
		).resolves.toBeUndefined();
	});
});
