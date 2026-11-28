import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import { forceRecoverReworkTask } from '../../../src/workflow/rework-recovery';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #2755: forceRecoverReworkTask is the architect-only audited escape
 * hatch from `rework_required`. Every precondition fails closed with a
 * distinct error; the success path writes a supervised stage_a_passed and a
 * distinguishable stage_a_repair audit event.
 *
 * Env isolation: the recovery now also materializes the baseline v1 review
 * route receipt (the 2.26 wedge fix), whose MAC secret lives under the
 * app-data roots — redirect them so the suite never touches the developer's
 * real app-data.
 */
describe('forceRecoverReworkTask (issue #2755)', () => {
	let directory = '';
	let cleanup = (): void => {};
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(() => {
		resetSwarmState();
		isolatedEnv = createIsolatedTestEnv();
		({ dir: directory, cleanup } = createSafeTestDir('rework-recovery-'));
		// Explicit project-root marker so assertProjectRoot accepts the temp
		// dir even when a parent (e.g. the user profile) already carries
		// .swarm/ state (host-dependent).
		mkdirSync(path.join(directory, '.git'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function writeMinimalPlan(taskId: string): void {
		const plan = {
			schema_version: '1.0.0',
			title: 'rework-recovery test plan',
			swarm: 'local',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: taskId,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: `rework-recovery task ${taskId}`,
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);
	}

	function writeBundle(
		bucket: 'secretscan' | 'sast_scan',
		timestamp: string,
	): void {
		const entry =
			bucket === 'secretscan'
				? {
						task_id: bucket,
						type: 'secretscan',
						timestamp,
						agent: bucket,
						verdict: 'pass',
						summary: 'seeded green secretscan bundle',
						findings_count: 0,
						files_scanned: 3,
						skipped_files: 0,
						incomplete_files: 0,
						incomplete_paths: [],
					}
				: {
						task_id: bucket,
						type: 'sast',
						timestamp,
						agent: bucket,
						verdict: 'pass',
						summary: 'seeded green sast bundle',
						findings: [],
						engine: 'tier_a',
						files_scanned: 3,
						findings_count: 0,
						findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
					};
		const bundle = {
			schema_version: '1.0.0',
			task_id: bucket,
			entries: [entry],
			created_at: timestamp,
			updated_at: timestamp,
		};
		const dir = path.join(directory, '.swarm', 'evidence', bucket);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, 'evidence.json'),
			JSON.stringify(bundle, null, 2),
			'utf-8',
		);
	}

	async function writeGreenBundles(taskId: string): Promise<void> {
		// Strictly newer than the workflow anchor by construction: derive the
		// bundle timestamp from the durable wedge transition's updatedAt (+60s)
		// instead of the wall clock, so the fixture is deterministic and the
		// greenness predicate's recency floor is genuinely crossed.
		const gateEvidence = await import('../../../src/gate-evidence');
		const anchor = gateEvidence.getTaskWorkflowSnapshot(
			await gateEvidence.readTaskEvidence(directory, taskId),
		).updatedAt;
		const fresh = new Date(Date.parse(anchor) + 60_000).toISOString();
		writeBundle('secretscan', fresh);
		writeBundle('sast_scan', fresh);
	}

	async function seedWorkflow(
		taskId: string,
		steps: Array<'mutate' | 'stageA' | 'stageBFail'>,
	): Promise<void> {
		const { transitionTaskWorkflowEvidence } = await import(
			'../../../src/gate-evidence'
		);
		let generation = 0;
		for (const step of steps) {
			if (step === 'mutate') {
				await transitionTaskWorkflowEvidence(directory, taskId, {
					type: 'accepted_mutation',
					agentType: 'coder',
					expectedGeneration: generation,
					transitionId: `mut-${taskId}-${generation}`,
				});
				generation += 1;
			} else if (step === 'stageA') {
				await transitionTaskWorkflowEvidence(directory, taskId, {
					type: 'stage_a_passed',
					expectedGeneration: generation,
					transitionId: `stage-a-${taskId}-${generation}`,
				});
			} else {
				await transitionTaskWorkflowEvidence(directory, taskId, {
					type: 'stage_b_failed',
					gate: 'test_engineer',
					expectedGeneration: generation,
					transitionId: `stage-b-fail-${taskId}-${generation}`,
				});
			}
		}
	}

	function readEvents(): string {
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		return existsSync(eventsPath) ? readFileSync(eventsPath, 'utf-8') : '';
	}

	it('refuses a non-architect session and leaves durable state untouched', async () => {
		writeMinimalPlan('1.1');
		await seedWorkflow('1.1', ['mutate', 'stageA', 'stageBFail']);
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('coder-session-1', 'coder', directory);
		await expect(
			forceRecoverReworkTask(directory, 'coder-session-1', {
				taskId: '1.1',
				reason: 'coder cannot self-unblock',
			}),
		).rejects.toThrow(/RECOVER_REWORK_ARCHITECT_REQUIRED/);
		const { readTaskEvidence, getTaskWorkflowSnapshot } = await import(
			'../../../src/gate-evidence'
		);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')).state,
		).toBe('rework_required');
	});

	it('refuses an unknown task id and a task outside the current plan', async () => {
		writeMinimalPlan('1.1');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-1', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-1', { taskId: '  ' }),
		).rejects.toThrow(/RECOVER_REWORK_UNKNOWN_TASK/);
		await expect(
			forceRecoverReworkTask(directory, 'arch-1', {
				taskId: '9.9',
				reason: 'foreign task',
			}),
		).rejects.toThrow(/RECOVER_REWORK_UNKNOWN_TASK/);
	});

	it('refuses without a plan on disk', async () => {
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-2', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-2', {
				taskId: '1.1',
				reason: 'no plan',
			}),
		).rejects.toThrow(/PLAN_NOT_FOUND/);
	});

	it('refuses a task that is not at rework_required', async () => {
		writeMinimalPlan('1.2');
		await seedWorkflow('1.2', ['mutate', 'stageA']);
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-3', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-3', {
				taskId: '1.2',
				reason: 'wrong state',
			}),
		).rejects.toThrow(
			/RECOVER_REWORK_STATE_REQUIRED: task 1.2 is at pre_check_passed/,
		);
	});

	it('refuses without green pre-check evidence, including the SAST-disabled shape (plan-critic R1)', async () => {
		writeMinimalPlan('1.3');
		await seedWorkflow('1.3', ['mutate', 'stageA', 'stageBFail']);
		// Secretscan only: a project with SAST disabled never persists a
		// sast_scan bundle; the recovery must fail closed (#2665 trade-off).
		// The bundle timestamp is derived from the durable wedge anchor
		// (deterministic, lint-clean) rather than the wall clock.
		const { readTaskEvidence, getTaskWorkflowSnapshot } = await import(
			'../../../src/gate-evidence'
		);
		const wedgeIso = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.3'),
		).updatedAt;
		writeBundle(
			'secretscan',
			new Date(Date.parse(wedgeIso) + 60_000).toISOString(),
		);
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-4', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-4', {
				taskId: '1.3',
				reason: 'green bundles absent',
			}),
		).rejects.toThrow(
			/RECOVER_REWORK_GREEN_PRECHECK_REQUIRED.*no_pre_check_bundles/,
		);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.3')).state,
		).toBe('rework_required');
	});

	it('recovers to pre_check_passed at an unchanged generation with an audited, distinguishable transition', async () => {
		writeMinimalPlan('1.4');
		await seedWorkflow('1.4', ['mutate', 'stageA', 'stageBFail']);
		await writeGreenBundles('1.4');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-5', 'architect', directory);
		const summary = await forceRecoverReworkTask(directory, 'arch-5', {
			taskId: '1.4',
			reason: 'SKIPPED verdict for a tool-argument error while pytest passes',
		});
		expect(summary.state).toBe('pre_check_passed');
		expect(summary.generation).toBe(1);
		expect(summary.transitionId).toBe('rework-recovery:1.4:gen1');
		expect(summary.auditEventRecorded).toBe(true);

		const { readTaskEvidence, getTaskWorkflowSnapshot } = await import(
			'../../../src/gate-evidence'
		);
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.4'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(snapshot.generation).toBe(1);
		expect(snapshot.lastTransitionId).toBe('rework-recovery:1.4:gen1');
		expect(snapshot.lastOutcome).toBe('stage_a_passed');

		const events = readEvents();
		const auditLine = events
			.split('\n')
			.find(
				(line) =>
					line.includes('"stage_a_repair"') &&
					line.includes('"rework_recovered"'),
			);
		expect(auditLine).toBeDefined();
		expect(auditLine).toContain('"taskId":"1.4"');
		expect(auditLine).toContain('"sessionId":"arch-5"');
		expect(auditLine).toContain('SKIPPED verdict for a tool-argument error');

		// A repeat call cannot fire again: the state precondition fails closed.
		await expect(
			forceRecoverReworkTask(directory, 'arch-5', {
				taskId: '1.4',
				reason: 'second attempt',
			}),
		).rejects.toThrow(/RECOVER_REWORK_STATE_REQUIRED/);
	});

	it('persists the supervisedRecovery marker in the durable evidence (FB-002)', async () => {
		writeMinimalPlan('1.5');
		await seedWorkflow('1.5', ['mutate', 'stageA', 'stageBFail']);
		await writeGreenBundles('1.5');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-6', 'architect', directory);
		await forceRecoverReworkTask(directory, 'arch-6', {
			taskId: '1.5',
			reason: 'supervised recovery marker pin',
		});
		const { readTaskEvidence } = await import('../../../src/gate-evidence');
		expect(
			(await readTaskEvidence(directory, '1.5'))?.workflow?.supervisedRecovery,
		).toBe(true);
	});

	it('refuses stale green bundles (FB-010: recency floor pinned at the call site)', async () => {
		writeMinimalPlan('1.6');
		await seedWorkflow('1.6', ['mutate', 'stageA', 'stageBFail']);
		// Green bundles dated BEFORE the wedge anchor: recency must refuse even
		// though the verdicts are green.
		const { readTaskEvidence, getTaskWorkflowSnapshot } = await import(
			'../../../src/gate-evidence'
		);
		const anchor = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.6'),
		).updatedAt;
		const stale = new Date(Date.parse(anchor) - 60_000).toISOString();
		writeBundle('secretscan', stale);
		writeBundle('sast_scan', stale);
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-7', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-7', {
				taskId: '1.6',
				reason: 'stale bundles',
			}),
		).rejects.toThrow(
			/RECOVER_REWORK_GREEN_PRECHECK_REQUIRED.*pre_check_failed_or_stale/,
		);
	});

	it('distinguishes corrupt evidence from missing evidence (FB-004)', async () => {
		writeMinimalPlan('1.7');
		await seedWorkflow('1.7', ['mutate', 'stageA', 'stageBFail']);
		const evidencePath = path.join(directory, '.swarm', 'evidence', '1.7.json');
		writeFileSync(evidencePath, '{ not valid json', 'utf-8');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-8', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-8', {
				taskId: '1.7',
				reason: 'corrupt evidence',
			}),
		).rejects.toThrow(/RECOVER_REWORK_EVIDENCE_CORRUPT/);
	});

	it('refuses a plan task with no durable evidence as NO_WORKFLOW (FB-013)', async () => {
		writeMinimalPlan('1.8');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-9', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-9', {
				taskId: '1.8',
				reason: 'no evidence yet',
			}),
		).rejects.toThrow(/RECOVER_REWORK_NO_WORKFLOW/);
	});

	it('refuses PLAN_CORRUPT for an unparseable plan (FB-013)', async () => {
		mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'{ not json',
			'utf-8',
		);
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-10', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-10', {
				taskId: '1.1',
				reason: 'corrupt plan',
			}),
		).rejects.toThrow(/PLAN_CORRUPT/);
	});

	it('refuses an unparseable workflow updatedAt as corrupt evidence (FB-013)', async () => {
		writeMinimalPlan('1.9');
		// Hand-write schema-valid evidence with a garbage updatedAt: the
		// TaskWorkflowMetadata schema only requires a string, so corruption can
		// reach the recency anchor.
		await seedWorkflow('1.9', ['mutate', 'stageA', 'stageBFail']);
		const evidencePath = path.join(directory, '.swarm', 'evidence', '1.9.json');
		const raw = JSON.parse(readFileSync(evidencePath, 'utf-8') ?? '{}') as {
			workflow?: { updatedAt?: string };
		};
		expect(raw.workflow).toBeDefined();
		raw.workflow!.updatedAt = 'garbage-not-a-date';
		writeFileSync(evidencePath, JSON.stringify(raw), 'utf-8');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('arch-11', 'architect', directory);
		await expect(
			forceRecoverReworkTask(directory, 'arch-11', {
				taskId: '1.9',
				reason: 'corrupt updatedAt',
			}),
		).rejects.toThrow(
			/RECOVER_REWORK_GREEN_PRECHECK_REQUIRED.*not a parseable timestamp/,
		);
	});

	it('accepts a multi-swarm prefixed architect and still refuses a prefixed non-architect (FB-012)', async () => {
		writeMinimalPlan('1.11');
		await seedWorkflow('1.11', ['mutate', 'stageA', 'stageBFail']);
		await writeGreenBundles('1.11');
		const { ensureAgentSession } = await import('../../../src/state');
		ensureAgentSession('pref-1', 'local_architect', directory);
		const summary = await forceRecoverReworkTask(directory, 'pref-1', {
			taskId: '1.11',
			reason: 'prefixed architect acceptance pin',
		});
		expect(summary.state).toBe('pre_check_passed');

		// Prefixed non-architect: still refused.
		writeMinimalPlan('1.12');
		await seedWorkflow('1.12', ['mutate', 'stageA', 'stageBFail']);
		ensureAgentSession('pref-2', 'mega_coder', directory);
		await expect(
			forceRecoverReworkTask(directory, 'pref-2', {
				taskId: '1.12',
				reason: 'prefixed non-architect',
			}),
		).rejects.toThrow(/RECOVER_REWORK_ARCHITECT_REQUIRED/);
	});
});
