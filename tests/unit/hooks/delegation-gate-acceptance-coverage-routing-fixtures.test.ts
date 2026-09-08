/**
 * Issue #1687 (F-007): integration coverage for the ACCEPTANCE gate through
 * the real `toolBefore` hook, including reviewer wiring and fail-open paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	buildAcceptanceCoverageMismatchError,
	checkAcceptanceCoversFrRefs,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	recordPlanCriticApproval,
	seedAuthoritativeTaskWorkflow,
} from './_delegation-gate-helpers';

const FR001_BODY =
	'The widget SHALL render the configured label exactly once on mount.';
const SPEC_MD = [
	'# Spec 1687 fixture',
	'',
	'## Functional Requirements',
	'',
	`- **FR-001 — Widget renders.** ${FR001_BODY}`,
	'- **FR-002 — Multi map.** The task SHALL carry all mapped requirements when it maps to more than one.',
	'',
	'## Success Criteria',
	'',
	'- **SC-001 (FR-001).** Given a mounted widget, when the label is set, then it appears verbatim.',
	'',
].join('\n');

function makeConfig(): PluginConfig {
	// No `worktree` block => worktree serialization is a no-op; delegation_gate on.
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.opencode'), { recursive: true });
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
						files_touched: ['src/mapped-task.ts'],
						fr_refs: ['FR-001'],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small' as const,
						description: 'Unmapped task',
						depends: [],
						files_touched: ['src/unmapped-task.ts'],
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
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
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
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
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

	it('coder, mapped task, ACCEPTANCE = lorem ipsum => dispatches with verbatim body injected (#2205; task-id DISCOVERED from the TASK: line, the real free-text path — no args.task_id)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-coder-bad', 'architect');
		// Deliberately omit args.task_id so resolveDelegatedPlanTaskId must extract
		// "1.1" from the TASK: line — the production resolution path for free-text
		// coder dispatches, where task_id is not reliably present. Pre-#2205 this
		// threw ACCEPTANCE_FIELD_COVERAGE_MISMATCH; the gate now injects the
		// verbatim FR-001 body into the dispatched prompt instead of blocking.
		const output = {
			args: {
				subagent_type: 'coder',
				prompt: 'TASK: 1.1 implement it\nACCEPTANCE: lorem ipsum',
			} as Record<string, unknown>,
		};
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-coder-bad'), output),
		).resolves.toBeUndefined();
		expect(String(output.args.prompt)).toContain(`FR-001: ${FR001_BODY}`);
	});

	it('REVIEWER, mapped task, ACCEPTANCE = lorem ipsum => dispatches with injection (#2205; reviewer path covered)', async () => {
		await seedAuthoritativeTaskWorkflow(tempDir, '1.1', 'pre_check_passed');
		const hooks = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('sess-cov-rev-bad', 'architect');
		const output = {
			args: {
				subagent_type: 'reviewer',
				task_id: '1.1',
				prompt: 'TASK: 1.1 review it\nACCEPTANCE: lorem ipsum',
			} as Record<string, unknown>,
		};
		await expect(
			hooks.toolBefore(toolBeforeInput('sess-cov-rev-bad'), output),
		).resolves.toBeUndefined();
		expect(String(output.args.prompt)).toContain(`FR-001: ${FR001_BODY}`);
	});

	it('omitted requirement body renders the completely-missing fallback in the error contract, not a divergence pointer (#2204)', () => {
		// The mismatch throw is defense-in-depth after #2205's injection; its
		// message contract is unit-tested through the exported builder.
		const specText = SPEC_MD;
		const res = checkAcceptanceCoversFrRefs({
			specText,
			// The agent summarized the task; only coincidental punctuation can
			// match the FR-001 body — pre-#2204 the rendered error pointed at a
			// random "divergence" word in the prompt.
			acceptanceText: 'ACCEPTANCE: coder task: extract module logic',
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		const err = buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		});
		expect(err.message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		expect(err.message).toContain(
			'ACCEPTANCE has here: "[Requirement text completely missing from prompt]"',
		);
		expect(err.message).not.toContain('first divergence at normalized offset');
	});

	it('completely-missing fallback and the ENCODING WARNING co-occur in one rendered error (#1896 + #2204)', () => {
		// spec.md lost its section sign to a `??` save AND the agent omitted the
		// requirement text entirely. Both diagnostic layers must survive into the
		// SAME rendered message: the corruption hint tells the operator to repair
		// spec.md, the fallback line tells them the body is absent from the prompt.
		// Neither a >=10-char prefix nor a >=10-char suffix of the body occurs
		// anywhere in this prompt: the prefix probe stalls at "s" (1 char) and the
		// suffix probe stalls at "." (1 char — the period only appears in "1.1",
		// and "g." never does). So it lands on the genuine completely-missing
		// branch, not #2215's present-but-shifted one.
		//
		// Asserted through the exported builder for the same reason as the sibling
		// test above: post-#2205 the toolBefore throw is defense-in-depth, because
		// injection covers every extractable id before the recheck runs.
		const corruptedSpec = [
			'# Spec 1687 fixture',
			'',
			'## Functional Requirements',
			'',
			'- **FR-001 — Widget renders.** See ?? 4.2 of the retention policy before deleting.',
			'',
		].join('\n');
		const res = checkAcceptanceCoversFrRefs({
			specText: corruptedSpec,
			acceptanceText:
				'TASK: 1.1 implement it\nACCEPTANCE: refactor the module loader',
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		const err = buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		});
		expect(err.message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		expect(err.message).toContain(
			'ACCEPTANCE has here: "[Requirement text completely missing from prompt]"',
		);
		expect(err.message).toContain('ENCODING WARNING:');
		expect(err.message).toContain('??');
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
		await seedAuthoritativeTaskWorkflow(
			tempDir,
			'1.1',
			'pre_check_passed',
			'sess-cov-nospec',
		);
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
