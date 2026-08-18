/**
 * Issue #2205: framework-side semantic injection of FR-###/SC-### requirement
 * text into the ACCEPTANCE field. The delegation gate now appends the VERBATIM
 * spec.md requirement bodies for every mapped id the ACCEPTANCE text does not
 * already cover, mutating the dispatch args in place so the downstream
 * coder/reviewer receives the exact requirement text. The architect only has
 * to list the ids (e.g. `ACCEPTANCE: FR-001`); byte-for-byte copying is no
 * longer LLM responsibility.
 *
 * Two layers:
 *  1. Pure-unit tests of `injectSpecRequirementsIntoAcceptance`.
 *  2. Integration tests through the REAL `toolBefore` hook, proving a
 *     summary/id-only ACCEPTANCE on a mapped task now dispatches (pre-#2205 it
 *     was blocked by ACCEPTANCE_FIELD_COVERAGE_MISMATCH) and that the mutated
 *     args record carries the verbatim body downstream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	createDelegationGateHook,
	injectSpecRequirementsIntoAcceptance,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	recordPlanCriticApproval,
	seedAuthoritativeTaskWorkflow,
} from './_delegation-gate-helpers';

const FR001_BODY =
	'The widget SHALL render the configured label exactly once on mount.';
const FR002_BODY =
	'The task SHALL carry all mapped requirements when it maps to more than one.';

const SPEC_MD = [
	'# Spec 2205 fixture',
	'',
	'## Functional Requirements',
	'',
	`- **FR-001 — Widget renders.** ${FR001_BODY}`,
	`- **FR-002 — Multi map.** ${FR002_BODY}`,
	'',
].join('\n');

// ===========================================================================
// Layer 1 — pure-unit tests of injectSpecRequirementsIntoAcceptance
// ===========================================================================

describe('injectSpecRequirementsIntoAcceptance (unit, #2205)', () => {
	it('appends the verbatim body after the ACCEPTANCE header for uncovered ids', () => {
		const args: Record<string, unknown> = {
			prompt:
				'TASK: 1.1 implement it\nACCEPTANCE: FR-001\nCONSTRAINT: stay scoped',
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).not.toBeNull();
		expect(result?.field).toBe('prompt');
		expect(result?.injectedIds).toEqual(['FR-001']);
		// The verbatim body is injected INSIDE the ACCEPTANCE section — before the
		// CONSTRAINT field line — and the rest of the prompt is preserved.
		expect(args.prompt).toContain(`FR-001: ${FR001_BODY}`);
		const headerIdx = String(args.prompt).indexOf('ACCEPTANCE: FR-001');
		const bodyIdx = String(args.prompt).indexOf(`FR-001: ${FR001_BODY}`);
		const constraintIdx = String(args.prompt).indexOf(
			'CONSTRAINT: stay scoped',
		);
		expect(bodyIdx).toBeGreaterThan(headerIdx);
		expect(constraintIdx).toBeGreaterThan(bodyIdx);
	});

	it('is a no-op (null) when the acceptance already covers every mapped id', () => {
		const args: Record<string, unknown> = {
			prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${FR001_BODY}`,
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toBeNull();
		expect(args.prompt).toBe(
			`TASK: 1.1 implement it\nACCEPTANCE: ${FR001_BODY}`,
		);
	});

	it('injects only the uncovered ids of a multi-mapped task', () => {
		const args: Record<string, unknown> = {
			prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${FR001_BODY}`,
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-001', 'FR-002'],
			specText: SPEC_MD,
		});
		expect(result?.injectedIds).toEqual(['FR-002']);
		expect(args.prompt).toContain(`FR-002: ${FR002_BODY}`);
		expect(String(args.prompt).match(new RegExp(FR001_BODY, 'g'))?.length).toBe(
			1,
		);
	});

	it('skips ids missing from spec.md (fail-open) and returns null when nothing is injectable', () => {
		const args: Record<string, unknown> = {
			prompt: 'TASK: 1.1 implement it\nACCEPTANCE: summary text',
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-999'],
			specText: SPEC_MD,
		});
		expect(result).toBeNull();
		expect(args.prompt).toBe(
			'TASK: 1.1 implement it\nACCEPTANCE: summary text',
		);
	});

	it('returns null for empty frRefs', () => {
		const args: Record<string, unknown> = {
			prompt: 'TASK: 1.2 implement it\nACCEPTANCE: task-derived statement',
		};
		expect(
			injectSpecRequirementsIntoAcceptance({
				args,
				frRefs: [],
				specText: SPEC_MD,
			}),
		).toBeNull();
	});

	it('mutates the first args field carrying the ACCEPTANCE header (description fallback)', () => {
		const args: Record<string, unknown> = {
			description: 'ACCEPTANCE: FR-001',
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result?.field).toBe('description');
		expect(args.description).toContain(`FR-001: ${FR001_BODY}`);
	});

	it('returns null when no args field carries an ACCEPTANCE header', () => {
		const args: Record<string, unknown> = { prompt: 'no acceptance here' };
		expect(
			injectSpecRequirementsIntoAcceptance({
				args,
				frRefs: ['FR-001'],
				specText: SPEC_MD,
			}),
		).toBeNull();
	});

	it('handles a bare ACCEPTANCE header with content on following lines', () => {
		const args: Record<string, unknown> = {
			prompt:
				'TASK: 1.1 implement it\nACCEPTANCE:\nsummary line\nNEXT_FIELD: value',
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result?.injectedIds).toEqual(['FR-001']);
		const prompt = String(args.prompt);
		// Injected directly under the bare header, still above the summary line.
		expect(prompt.indexOf(`FR-001: ${FR001_BODY}`)).toBeGreaterThan(
			prompt.indexOf('ACCEPTANCE:'),
		);
		expect(prompt.indexOf(`FR-001: ${FR001_BODY}`)).toBeLessThan(
			prompt.indexOf('summary line'),
		);
	});
});

// ===========================================================================
// Layer 2 — integration through the REAL toolBefore hook
// ===========================================================================

describe('toolBefore ACCEPTANCE injection gate (integration, #2205)', () => {
	let tempDir: string;

	function makeConfig(): PluginConfig {
		return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
	}

	function makeTempProject(prefix: string): string {
		const dir = canonicalMkdtemp(prefix);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		return dir;
	}

	async function writeFixturePlan(dir: string): Promise<void> {
		const plan: Plan = {
			schema_version: '1.0.0' as const,
			title: 'Injection Test Plan',
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
							files_touched: ['src/mapped-task.ts'],
							fr_refs: ['FR-001'],
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

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('c2205-inj-');
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

	function toolBeforeInput(sessionID: string, callID = 'call-1') {
		return { tool: 'Task', sessionID, callID };
	}

	it('id-only ACCEPTANCE dispatches and the args record carries the verbatim body downstream (#2205)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-ids', 'architect');
		// Pre-#2205 this exact dispatch was blocked with
		// ACCEPTANCE_FIELD_COVERAGE_MISMATCH (summary, not verbatim body).
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt: 'TASK: 1.1 implement it\nACCEPTANCE: FR-001',
		};
		const output = { args };
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-2205-ids'), output),
		).resolves.toBeUndefined();
		// The mutation must land on the record the host re-reads (output.args),
		// so the downstream coder actually receives the verbatim requirement.
		expect(String(output.args.prompt)).toContain(`FR-001: ${FR001_BODY}`);
	});

	it('summary-only ACCEPTANCE (no ids anywhere) also dispatches after injection', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-summary', 'architect');
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt:
				'TASK: 1.1 implement it\nACCEPTANCE: make the widget show the label',
		};
		const output = { args };
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-2205-summary'), output),
		).resolves.toBeUndefined();
		expect(String(output.args.prompt)).toContain(`FR-001: ${FR001_BODY}`);
	});

	it('legacy verbatim ACCEPTANCE still dispatches with no duplicate injection', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-verbatim', 'architect');
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${FR001_BODY}`,
		};
		const output = { args };
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-2205-verbatim'), output),
		).resolves.toBeUndefined();
		expect(
			String(output.args.prompt).match(new RegExp(FR001_BODY, 'g'))?.length,
		).toBe(1);
	});

	it('adversarial: paraphrased ACCEPTANCE dispatches with the verbatim body injected (#2205)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-paraphrase', 'architect');
		const paraphrased: Record<string, unknown> = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt:
				'TASK: 1.1 implement it\nACCEPTANCE: make the widget show the label after mounting per config',
		};
		const paraphrasedOutput = { args: paraphrased };
		await expect(
			hooks.toolBefore(
				toolBeforeInput('sess-2205-paraphrase'),
				paraphrasedOutput,
			),
		).resolves.toBeUndefined();
		expect(String(paraphrasedOutput.args.prompt)).toContain(
			`FR-001: ${FR001_BODY}`,
		);
	});

	it('adversarial: partial (truncated) body copy dispatches with the full verbatim body injected (#2205)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-partial', 'architect');
		const partial: Record<string, unknown> = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt: `TASK: 1.1 implement it\nACCEPTANCE: ${FR001_BODY.slice(
				0,
				Math.floor(FR001_BODY.length / 2),
			)}`,
		};
		const partialOutput = { args: partial };
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-2205-partial'), partialOutput),
		).resolves.toBeUndefined();
		expect(String(partialOutput.args.prompt)).toContain(
			`FR-001: ${FR001_BODY}`,
		);
	});

	it('adversarial: multi-mapped task injects only the uncovered id, no duplicates (#2205)', async () => {
		const multiPlan: Plan = JSON.parse(
			fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf8'),
		) as Plan;
		multiPlan.phases[0]?.tasks.push({
			id: '2.1',
			phase: 1,
			status: 'pending',
			size: 'small',
			description: 'Multi-mapped task',
			depends: [],
			files_touched: ['src/multi.ts'],
			fr_refs: ['FR-001', 'FR-002'],
		});
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(multiPlan, null, 2),
		);
		await recordPlanCriticApproval(tempDir, multiPlan);

		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-multi', 'architect');
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			task_id: '2.1',
			prompt: `TASK: 2.1 implement it\nACCEPTANCE: ${FR001_BODY}`,
		};
		const output = { args };
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-2205-multi'), output),
		).resolves.toBeUndefined();
		// FR-002 was uncovered → injected; FR-001 already verbatim → no duplicate.
		expect(String(output.args.prompt)).toContain(`FR-002: ${FR002_BODY}`);
		expect(
			String(output.args.prompt).match(new RegExp(FR001_BODY, 'g'))?.length,
		).toBe(1);
	});

	it('reviewer dispatches also receive the injection (gate covers reviewer path)', async () => {
		// The reviewer dispatch path additionally requires the task workflow to
		// have advanced past idle (TASK_WORKFLOW_STAGE_A_REQUIRED).
		await seedAuthoritativeTaskWorkflow(tempDir, '1.1', 'pre_check_passed');
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-2205-reviewer', 'architect');
		const args: Record<string, unknown> = {
			subagent_type: 'reviewer',
			task_id: '1.1',
			prompt: 'TASK: 1.1 review it\nACCEPTANCE: FR-001',
		};
		const output = { args };
		let caught: Error | undefined;
		try {
			await hooks.toolBefore(toolBeforeInput('sess-2205-reviewer'), output);
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeUndefined();
		expect(String(output.args.prompt)).toContain(`FR-001: ${FR001_BODY}`);
	});
});
