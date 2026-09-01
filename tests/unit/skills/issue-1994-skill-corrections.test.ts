/**
 * Issue #1994 — post-mortem correction ratchets.
 *
 * Locks in the skill/prompt guidance and durable-record corrections this issue
 * required (S1 added_lines wiring, S4 smallest-justified-scope, P1 plan freeze,
 * P2 docs-attestation integrity, qa-sweep staleness fix, FR-009 descope record,
 * proposed dual-validation pattern). Every assertion targets text introduced by
 * this issue's fix; none of it exists on the pre-fix tree, so each check is
 * falsifiable by reverting the corresponding edit.
 *
 * Pattern per tests/unit/agents/architect-declare-scope-instruction.test.ts —
 * no mocks, no tempdirs, reads repository files from process.cwd().
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';
import type { Plan } from '../../../src/config/plan-schema';
import { computePlanStructureHash } from '../../../src/plan/ledger';

const readSkill = (relativePath: string): string =>
	readFileSync(join(process.cwd(), relativePath), 'utf-8');

const executeSkill = readSkill('.opencode/skills/execute/SKILL.md');
const swarmImplementSkill = readSkill(
	'.opencode/skills/swarm-implement/SKILL.md',
);
const criticGateOpenCode = readSkill('.opencode/skills/critic-gate/SKILL.md');
const criticGateClaude = readSkill('.claude/skills/critic-gate/SKILL.md');
const phaseWrapSkill = readSkill('.opencode/skills/phase-wrap/SKILL.md');
const runningTestsSkill = readSkill('.opencode/skills/running-tests/SKILL.md');
const swarmPrReviewSkill = readSkill(
	'.opencode/skills/swarm-pr-review/SKILL.md',
);
const qaSweepClaude = readSkill('.claude/skills/qa-sweep/SKILL.md');
const engineeringInvariants = readSkill('docs/engineering-invariants.md');

const architectPrompt = createArchitectAgent('gpt-4').config.prompt!;

describe('issue #1994 S1 — placeholder_scan diff scoping wired into Stage A callers', () => {
	it('execute skill step 5e instructs passing added_lines from the working tree', () => {
		const start = executeSkill.indexOf('5e. Run `placeholder_scan`');
		expect(start).toBeGreaterThan(-1);
		const slice = executeSkill.slice(
			start,
			executeSkill.indexOf('5f. Run `imports`'),
		);
		expect(slice).toContain('added_lines');
		// Working-tree form: at 5e the coder's edits are uncommitted, so a
		// commit-range diff (<base>...HEAD) would return zero added lines. The
		// skill text itself carries that warning, so only assert the prescribed
		// command form positively.
		expect(slice).toContain('git diff -U0 HEAD');
	});

	it('execute skill step 5e documents the fail-closed omission fallback', () => {
		const start = executeSkill.indexOf('5e. Run `placeholder_scan`');
		const slice = executeSkill.slice(
			start,
			executeSkill.indexOf('5f. Run `imports`'),
		);
		expect(slice).toContain('OMIT that file from `added_lines`');
		expect(slice).toContain('fail-closed');
		expect(slice).toContain('cross-check');
		expect(slice).toContain('existing debt');
	});

	it('execute skill step 5e forbids empty arrays and guessed line-number maps', () => {
		const start = executeSkill.indexOf('5e. Run `placeholder_scan`');
		const slice = executeSkill.slice(
			start,
			executeSkill.indexOf('5f. Run `imports`'),
		);
		expect(slice).toContain('NEVER pass an empty line array');
		expect(slice).toContain('NEVER hand-enumerate guessed line numbers');
		expect(slice).toContain('silently suppresses findings');
	});

	it('architect prompt Stage A block carries the added_lines instruction', () => {
		const start = architectPrompt.indexOf('STAGE A: AUTOMATED TOOL GATES');
		const end = architectPrompt.indexOf('STAGE B: AGENT REVIEW GATES');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = architectPrompt.slice(start, end);
		expect(slice).toContain('placeholder_scan DIFF SCOPING');
		expect(slice).toContain('added_lines');
		expect(slice).toContain('git diff -U0 HEAD');
		expect(slice).toContain('fail-closed');
		expect(slice).toContain('Never pass an empty line array');
	});

	it('running-tests documents the no-diff-line-numbers fallback', () => {
		expect(runningTestsSkill).toContain(
			'## Placeholder Scans Without Diff Line Numbers',
		);
		expect(runningTestsSkill).toContain('fail-closed');
		expect(runningTestsSkill).toContain('NEVER pass an empty line array');
		expect(runningTestsSkill).toContain(
			'NEVER hand-enumerate guessed line numbers',
		);
	});

	it('swarm-pr-review Phase 2 tool-candidate rules scope placeholder_scan signals', () => {
		const start = swarmPrReviewSkill.indexOf('Tool candidate rules:');
		const end = swarmPrReviewSkill.indexOf('## Phase 3');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = swarmPrReviewSkill.slice(start, end);
		expect(slice).toContain('placeholder_scan');
		expect(slice).toContain('added_lines');
		expect(slice).toContain('pre-existing-debt candidate');
	});

	it('qa-sweep no longer claims placeholder_scan has no baseline concept', () => {
		expect(qaSweepClaude).not.toContain('no baseline concept');
		expect(qaSweepClaude).toContain('`placeholder_scan`');
		expect(qaSweepClaude).toContain('added_lines');
		expect(qaSweepClaude).toContain('fail-closed');
	});
});

describe('issue #1994 S4 — smallest justified scope on SCOPE_CONFLICT', () => {
	it('swarm-implement Phase 3 forbids widening to a plan-inferred superset', () => {
		const start = swarmImplementSkill.indexOf(
			'### Phase 3 - Implement in scoped units',
		);
		const end = swarmImplementSkill.indexOf(
			'### Phase 4 - Objective validation',
		);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = swarmImplementSkill.slice(start, end);
		expect(slice).toContain('Smallest justified scope on `SCOPE_CONFLICT`');
		expect(slice).toContain('SMALLEST justified scope');
		expect(slice).toContain('NEVER resolve a `SCOPE_CONFLICT` by widening');
		expect(slice).toContain('plan-inferred superset');
		expect(slice).toContain('Split the task into separate delegations');
	});

	it('the rule requires narrowing the conflicting lower-precedence source first', () => {
		const start = swarmImplementSkill.indexOf(
			'### Phase 3 - Implement in scoped units',
		);
		const end = swarmImplementSkill.indexOf(
			'### Phase 4 - Objective validation',
		);
		const slice = swarmImplementSkill.slice(start, end);
		expect(slice).toContain('repair stale plan scope with `save_plan`');
		expect(slice).toContain('`FILE:` lines');
		expect(slice).toContain(
			're-declaring alone leaves the non-subset relation',
		);
	});

	it('the rule cross-references the execute skill scope-recovery contract', () => {
		const start = swarmImplementSkill.indexOf(
			'### Phase 3 - Implement in scoped units',
		);
		const end = swarmImplementSkill.indexOf(
			'### Phase 4 - Objective validation',
		);
		const slice = swarmImplementSkill.slice(start, end);
		expect(slice).toContain('Do not widen scope just to make the sets agree');
	});
});

describe('issue #1994 P1 — plan freeze after approval (critic-gate)', () => {
	it('critic-gate mirror pair is byte-identical', () => {
		expect(criticGateClaude).toBe(criticGateOpenCode);
	});

	it('critic-gate documents the plan freeze anchored to the structure hash', () => {
		expect(criticGateOpenCode).toContain('PLAN FREEZE AFTER APPROVAL');
		expect(criticGateOpenCode).toContain('computePlanStructureHash');
		expect(criticGateOpenCode).toContain('MATERIAL (invalidates the approval)');
	});

	it('material bullet names the structural task fields it claims (hash behavior proven below)', () => {
		// `name` is deliberately absent — TaskSchema has no name field
		// (src/config/plan-schema.ts); see the plan-critic review in the
		// issue-1994 trace.
		const materialLine = criticGateOpenCode
			.split('\n')
			.find((line) => line.startsWith('- MATERIAL'));
		expect(materialLine).toBeDefined();
		for (const field of [
			'`id`',
			'`phase`',
			'`description`',
			'`acceptance`',
			'`depends`',
		]) {
			expect(materialLine).toContain(field);
		}
		// `removed_task_ids` is a save_plan ARGUMENT, not a hashed field: task
		// removal changes the hash through the task array itself (post-hoc
		// audit of PR #2457, finding 3).
		expect(materialLine).toContain('`removed_task_ids` `save_plan` argument');
		expect(materialLine).toContain('never the argument itself');
		// fr_refs is NOT in the hashed MATERIAL list (computePlanStructureHash
		// deliberately excludes it — src/plan/ledger.ts) and `name` does not
		// exist on tasks at all.
		expect(materialLine).not.toContain('`fr_refs`');
		expect(materialLine).not.toContain('`name`');
	});

	it('default-MATERIAL catch-all names every hashed field the specific bullets omit', () => {
		// Post-hoc audit of PR #2457, finding 1: computePlanStructureHash also
		// hashes schema_version, swarm, migration_status, execution_profile,
		// phase id/name/required_agents — none of which the MATERIAL or
		// BOOKKEEPING-GRADE bullets named. The catch-all bullet must close that
		// gap so the approve_plan_critic bookkeeping recovery cannot be
		// rationalized for those genuinely material fields.
		const catchAllLine = criticGateOpenCode
			.split('\n')
			.find((line) => line.startsWith('- DEFAULT-MATERIAL CATCH-ALL'));
		expect(catchAllLine).toBeDefined();
		expect(catchAllLine).toContain('MATERIAL by default');
		// Position-agnostic classification (PR #2463 review fix C1): the
		// BOOKKEEPING-GRADE bullet sits BELOW this one, so a directional
		// "not listed above" would wrongly pull bookkeeping fields into
		// MATERIAL-by-default.
		expect(catchAllLine).toContain(
			'not classified by the other bullets in this list',
		);
		expect(catchAllLine).not.toContain('not listed above');
		for (const field of [
			'`schema_version`',
			'`swarm`',
			'`migration_status`',
			'`execution_profile`',
			'`id`',
			'`name`',
			'`required_agents`',
		]) {
			expect(catchAllLine).toContain(field);
		}
		expect(catchAllLine).toContain('never the bookkeeping recovery');
	});

	it('fr_refs is material on process grounds with an honest hash caveat', () => {
		expect(criticGateOpenCode).toContain(
			'`fr_refs` changes are MATERIAL on process grounds',
		);
		expect(criticGateOpenCode).toContain(
			'the runtime will not catch this for you',
		);
	});

	it('status-only changes are excluded from the hash and stay action-free', () => {
		expect(criticGateOpenCode).toContain('STATUS-ONLY');
		expect(criticGateOpenCode).toContain(
			'excluded from the hash and never invalidate the approval',
		);
	});

	it('hashed bookkeeping fields route to approve_plan_critic, not a re-critic', () => {
		expect(criticGateOpenCode).toContain('BOOKKEEPING-GRADE hashed fields');
		expect(criticGateOpenCode).toContain('`files_touched`-only reconciliation');
		expect(criticGateOpenCode).toContain('`approve_plan_critic`');
	});

	it('batching rule is operational (one re-critic per accumulated batch)', () => {
		expect(criticGateOpenCode).toContain('Batching rule');
		expect(criticGateOpenCode).toContain('count as ONE batch');
		expect(criticGateOpenCode).toContain(
			'never split material changes across separate calls to dodge the re-critic',
		);
	});

	describe('schema-bound hash differential (computePlanStructureHash)', () => {
		// Post-hoc audit of PR #2457, finding 4: the previous version of this
		// suite asserted the plan-freeze taxonomy against hardcoded strings
		// only. These tests derive the hashed-field behavior from the REAL
		// computePlanStructureHash so the critic-gate skill text cannot drift
		// from the runtime hash semantics.
		const baseTask = {
			id: '1.1',
			phase: 1,
			status: 'pending',
			size: 'small',
			description: 'do the thing',
			depends: [],
			acceptance: 'it is done',
			files_touched: ['src/a.ts'],
			evidence_path: undefined,
			blocked_reason: undefined,
			fr_refs: ['FR-001'],
		};
		const basePlan = {
			schema_version: '1.0.0',
			title: 'T',
			swarm: 'S',
			current_phase: 1,
			migration_status: undefined,
			execution_profile: undefined,
			phases: [
				{
					id: 1,
					name: 'P1',
					status: 'pending',
					tasks: [baseTask],
					type: undefined,
					required_agents: undefined,
				},
			],
		} as unknown as Plan;

		const hashAfter = (mutate: (plan: Plan) => void): string => {
			const clone = structuredClone(basePlan);
			mutate(clone);
			return computePlanStructureHash(clone);
		};
		const baseHash = computePlanStructureHash(basePlan);
		const firstTask = (plan: Plan): Record<string, unknown> =>
			(plan.phases[0] as unknown as Record<string, unknown>).tasks[0] as Record<
				string,
				unknown
			>;
		const firstPhase = (plan: Plan): Record<string, unknown> =>
			plan.phases[0] as unknown as Record<string, unknown>;

		it('excludes status fields and fr_refs from the hash (skill: STATUS-ONLY + fr_refs caveat)', () => {
			expect(
				hashAfter((plan) => {
					firstTask(plan).status = 'in_progress';
				}),
			).toBe(baseHash);
			expect(
				hashAfter((plan) => {
					firstPhase(plan).status = 'in_progress';
				}),
			).toBe(baseHash);
			expect(
				hashAfter((plan) => {
					firstTask(plan).fr_refs = ['FR-001', 'FR-002'];
				}),
			).toBe(baseHash);
		});

		it('hashes the MATERIAL task fields named by the skill', () => {
			for (const [field, value] of [
				['id', '1.2'],
				['phase', 2],
				['description', 'other thing'],
				['acceptance', 'it is really done'],
				['depends', ['1.0']],
			] as const) {
				expect(
					hashAfter((plan) => {
						firstTask(plan)[field] = value;
					}),
				).not.toBe(baseHash);
			}
		});

		it('hashes task addition and removal (removed_task_ids framing)', () => {
			expect(
				hashAfter((plan) => {
					(firstPhase(plan).tasks as unknown[]).push({
						...baseTask,
						id: '1.2',
					});
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					(firstPhase(plan).tasks as unknown[]).pop();
				}),
			).not.toBe(baseHash);
		});

		it('hashes the BOOKKEEPING-GRADE fields named by the skill', () => {
			for (const [field, value] of [
				['size', 'medium'],
				['evidence_path', '.swarm/evidence/x'],
				['blocked_reason', 'waiting'],
				['files_touched', ['src/b.ts']],
			] as const) {
				expect(
					hashAfter((plan) => {
						firstTask(plan)[field] = value;
					}),
				).not.toBe(baseHash);
			}
			expect(
				hashAfter((plan) => {
					plan.title = 'Other';
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					plan.current_phase = 2;
				}),
			).not.toBe(baseHash);
		});

		it('hashes the DEFAULT-MATERIAL CATCH-ALL fields named by the skill', () => {
			expect(
				hashAfter((plan) => {
					(plan as unknown as Record<string, unknown>).schema_version = '9.9.9';
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					plan.swarm = 'Other';
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					(plan as unknown as Record<string, unknown>).migration_status =
						'migrated';
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					(plan as unknown as Record<string, unknown>).execution_profile = {
						max_concurrent_tasks: 2,
					};
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					firstPhase(plan).id = 2;
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					firstPhase(plan).name = 'P2';
				}),
			).not.toBe(baseHash);
			expect(
				hashAfter((plan) => {
					firstPhase(plan).required_agents = ['coder', 'reviewer'];
				}),
			).not.toBe(baseHash);
		});
	});
});

describe('issue #1994 P2 — docs-attestation integrity (phase-wrap)', () => {
	it('phase-wrap requires inspection-backed docs attestations', () => {
		const start = phaseWrapSkill.indexOf('5.59.');
		expect(start).toBeGreaterThan(-1);
		const slice = phaseWrapSkill.slice(
			start,
			phaseWrapSkill.indexOf('CATASTROPHIC VIOLATION CHECK'),
		);
		expect(slice).toContain('Docs-attestation integrity');
		expect(slice).toContain("actually inspected the phase's changed files");
		expect(slice).toContain('files read, per-file verdict');
		expect(slice).toContain('process violation');
	});
});

describe('issue #1994 record — FR-009 descope + proposed dual-validation pattern', () => {
	it('engineering-invariants records the post-mortem correction entry', () => {
		expect(engineeringInvariants).toContain(
			'Issue #1994 — post-mortem fabricated an FR-009 precedent',
		);
	});

	it('FR-009 disposition is DESCOPE with traceable provenance', () => {
		const start = engineeringInvariants.indexOf(
			'Issue #1994 — post-mortem fabricated an FR-009 precedent',
		);
		// Whitespace-normalized so paragraph reflow cannot break the ratchet.
		const flat = engineeringInvariants
			.slice(start, start + 5000)
			.replace(/\s+/g, ' ');
		expect(flat).toContain('FR-009 disposition: DESCOPE');
		expect(flat).toContain('b7e12d36');
		// Durability pairing (post-hoc audit of PR #2457, finding 2): the
		// canonical hash is paired with its post-rewrite local twin so a fresh
		// clone can always resolve the provenance.
		expect(flat).toContain('d82c7172');
		expect(flat).toContain('issue-#1691 investigation');
		expect(flat).toContain('#1978');
		expect(flat).toContain(
			'Do not cite FR-009 as a closed schema+runtime precedent',
		);
	});

	it('dual-validation pattern is recorded as PROPOSED, not an established precedent', () => {
		const start = engineeringInvariants.indexOf(
			'Issue #1994 — post-mortem fabricated an FR-009 precedent',
		);
		const flat = engineeringInvariants
			.slice(start, start + 5000)
			.replace(/\s+/g, ' ');
		expect(flat).toContain('Proposed pattern (NOT an established precedent)');
		expect(flat).toContain('primary and authoritative');
		expect(flat).toContain('OBSERVABLE');
		expect(flat).toContain('safety-critical invariants only');
	});
});
