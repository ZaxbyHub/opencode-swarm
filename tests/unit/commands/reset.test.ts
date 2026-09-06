import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	handleResetCommand,
	_internals as resetInternals,
} from '../../../src/commands/reset';
import type { Plan } from '../../../src/config/plan-schema';
import { savePlan } from '../../../src/plan/manager';
import {
	getSessionBudgetPct,
	setSessionBudget,
	swarmState,
} from '../../../src/state';

describe('handleResetCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-reset-test-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('Without --confirm - returns warning text, files NOT deleted', async () => {
		// Create both files
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
`,
		);

		const result = await handleResetCommand(tempDir, []);

		expect(result).toContain('## Swarm Reset');
		expect(result).toContain('⚠️ This will delete all swarm state from .swarm/');
		expect(result).toContain('.swarm/reset-backups/');
		expect(result).toContain('To confirm, run: `/swarm reset --confirm`');

		// Verify files still exist
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(true);
	});

	test('With --confirm - files ARE deleted', async () => {
		// Create both files
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
`,
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);

		// Verify files are deleted
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(false);
	});

	test('With --confirm, files already missing - reports not found', async () => {
		// Don't create any files
		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('⏭️ plan.md not found (skipped)');
		expect(result).toContain('⏭️ context.md not found (skipped)');
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);
	});

	test('With --confirm, only plan.md exists - deletes plan.md, skips context.md', async () => {
		// Create only plan.md
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('⏭️ context.md not found (skipped)');
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);

		// Verify plan.md is deleted but context.md was never created
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(false);
	});

	test('Warning message mentions auto-backup and portable export', async () => {
		const result = await handleResetCommand(tempDir, []);

		expect(result).toContain('.swarm/reset-backups/');
		expect(result).toContain('/swarm export');
	});

	test('With --confirm flag', async () => {
		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
	});

	test('With additional args alongside --confirm', async () => {
		// Create both files
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
`,
		);

		const result = await handleResetCommand(tempDir, [
			'--confirm',
			'extra',
			'args',
		]);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');
	});

	test('With --confirm - also deletes plan.json when present', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ swarm: 'test', title: 'Test Plan', phases: [] }),
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.json');
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(false);
	});

	test('With --confirm - deletes SWARM_PLAN artifacts from .swarm/', async () => {
		await writeFile(join(tempDir, '.swarm', 'SWARM_PLAN.json'), '{}');
		await writeFile(join(tempDir, '.swarm', 'SWARM_PLAN.md'), '# Plan');
		await writeFile(join(tempDir, '.swarm', 'checkpoints.json'), '[]');
		await writeFile(join(tempDir, '.swarm', 'events.jsonl'), '');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted SWARM_PLAN.json');
		expect(result).toContain('✅ Deleted SWARM_PLAN.md');
		expect(result).toContain('✅ Deleted checkpoints.json');
		expect(result).toContain('✅ Deleted events.jsonl');
		expect(existsSync(join(tempDir, '.swarm', 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'SWARM_PLAN.md'))).toBe(false);
	});

	test('With --confirm - deletes SWARM_PLAN artifacts from .swarm/plan-export/', async () => {
		await mkdir(join(tempDir, '.swarm', 'plan-export'), { recursive: true });
		await writeFile(
			join(tempDir, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
			'{}',
		);
		await writeFile(
			join(tempDir, '.swarm', 'plan-export', 'SWARM_PLAN.md'),
			'# Plan',
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan-export/SWARM_PLAN.json');
		expect(result).toContain('✅ Deleted plan-export/SWARM_PLAN.md');
		expect(
			existsSync(join(tempDir, '.swarm', 'plan-export', 'SWARM_PLAN.json')),
		).toBe(false);
		expect(
			existsSync(join(tempDir, '.swarm', 'plan-export', 'SWARM_PLAN.md')),
		).toBe(false);
	});

	test('With --confirm - deletes legacy root-level SWARM_PLAN artifacts', async () => {
		await writeFile(join(tempDir, 'SWARM_PLAN.json'), '{}');
		await writeFile(join(tempDir, 'SWARM_PLAN.md'), '# Plan');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted SWARM_PLAN.json (root)');
		expect(result).toContain('✅ Deleted SWARM_PLAN.md (root)');
		expect(existsSync(join(tempDir, 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(join(tempDir, 'SWARM_PLAN.md'))).toBe(false);
	});

	test('With --confirm - skips missing optional artifacts silently', async () => {
		// Windows symlink/junction creation (and some other fs ops like root-level
		// cleanup) intentionally catch-and-skip on failure (swallows error silently
		// in catch {} blocks). Skip is intentional on Windows because symlink/junction
		// creation requires elevated privileges or developer mode enabled.
		// See close-finalizer.test.ts for the actual symlink guard test pattern
		// and FR-017 / council findings from #1167.
		// Only create plan.md; all other files absent
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '# Plan');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('⏭️ plan.json not found (skipped)');
		expect(result).toContain('⏭️ SWARM_PLAN.json not found (skipped)');
		expect(result).toContain('⏭️ checkpoints.json not found (skipped)');
		expect(result).toContain('⏭️ events.jsonl not found (skipped)');
	});

	// ── SPEC-DRIFT + PLAN-LEDGER STATE (resurrection guard) ──────────────────────
	// Verifies reset wipes single-session spec-drift state (spec.md,
	// spec-staleness.json, spec-snapshot.md) and plan-ledger.jsonl, matching the
	// fix applied to /swarm close. Without this, spec-staleness.json survives as
	// an existence-only gate that hard-blocks core write tools, and a surviving
	// plan-ledger.jsonl gets replayed by replayFromLedger() on the next
	// loadPlan(), resurrecting the wiped plan back into plan.json.
	test('With --confirm - deletes spec-drift state files (spec.md, spec-staleness.json, spec-snapshot.md)', async () => {
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec');
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({ stale: true }),
		);
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), '# Snapshot');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted spec.md');
		expect(result).toContain('✅ Deleted spec-staleness.json');
		expect(result).toContain('✅ Deleted spec-snapshot.md');
		expect(existsSync(join(tempDir, '.swarm', 'spec.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		expect(existsSync(join(tempDir, '.swarm', 'spec-snapshot.md'))).toBe(false);
	});

	test('With --confirm - deletes plan-ledger.jsonl and prevents plan resurrection via replayFromLedger', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ swarm: 'test', title: 'Test Plan', phases: [] }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'plan-ledger.jsonl'),
			`${JSON.stringify({ op: 'create', title: 'Test Plan' })}\n`,
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Cleared authoritative plan ledger');
		expect(result).toContain('✅ Deleted plan.json');

		// Resurrection guard: both plan.json and plan-ledger.jsonl must be absent
		// so a subsequent loadPlan()/replayFromLedger() has nothing to resurrect.
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'plan-ledger.jsonl'))).toBe(
			false,
		);
	});

	test('regression: a concurrent save cannot resurrect plan.json after reset clears authority', async () => {
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Reset race',
			swarm: 'reset-race',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Race writer',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		await savePlan(tempDir, plan);

		const originalClear = resetInternals.clearPlanLedgerForReset;
		let enteredClear!: () => void;
		const clearEntered = new Promise<void>((resolve) => {
			enteredClear = resolve;
		});
		let releaseClear!: () => void;
		const releaseGate = new Promise<void>((resolve) => {
			releaseClear = resolve;
		});
		resetInternals.clearPlanLedgerForReset = async (directory) => {
			enteredClear();
			await releaseGate;
			await originalClear(directory);
		};

		try {
			const reset = handleResetCommand(tempDir, ['--confirm']);
			await clearEntered;
			// Before the fix reset dropped the ledger lock before projection cleanup,
			// letting this real save publish a new plan.json from stale in-memory state.
			await expect(savePlan(tempDir, plan)).rejects.toThrow(
				/Plan write blocked/,
			);
			releaseClear();
			await reset;

			expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(false);
			expect(existsSync(join(tempDir, '.swarm', 'plan-ledger.jsonl'))).toBe(
				false,
			);
		} finally {
			resetInternals.clearPlanLedgerForReset = originalClear;
		}
	});

	// ── SINGLETON PRESERVATION (FR-001d) ─────────────────────────────────
	// Verifies that the reset command path does not disturb the 7 module-scoped
	// singletons that are preserved by resetSwarmStatePreservingSingletons (used by close).
	// reset command only clears .swarm/ files + automation; swarmState singletons must survive.
	test('singleton preservation through reset command path - 7 init singletons survive', async () => {
		// Create .swarm/plan.md so the reset command actually deletes it.
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '# test');

		// Set sentinel values for the 7 preserved singletons (populated at plugin init).
		// Also seed transient state that a bare resetSwarmState would clear.
		const sentinelClient = { __reset_test: 'preserved-opencode-client' };
		const original = {
			opencodeClient: swarmState.opencodeClient,
			fullAutoEnabledInConfig: swarmState.fullAutoEnabledInConfig,
			curatorInitAgentNames: swarmState.curatorInitAgentNames,
			curatorPhaseAgentNames: swarmState.curatorPhaseAgentNames,
			skillImproverAgentNames: swarmState.skillImproverAgentNames,
			specWriterAgentNames: swarmState.specWriterAgentNames,
			generatedAgentNames: swarmState.generatedAgentNames,
			pendingEvents: swarmState.pendingEvents,
			lastBudgetPct: getSessionBudgetPct('s1'),
		};
		try {
			swarmState.opencodeClient = sentinelClient as never;
			swarmState.fullAutoEnabledInConfig = true;
			swarmState.curatorInitAgentNames = ['reset_init_a', 'reset_init_b'];
			swarmState.curatorPhaseAgentNames = ['reset_phase_x'];
			swarmState.skillImproverAgentNames = ['reset_skill_y'];
			swarmState.specWriterAgentNames = ['reset_spec_z'];
			swarmState.generatedAgentNames = ['reset_gen_1', 'reset_gen_2'];
			swarmState.pendingEvents = 999;
			setSessionBudget('s1', 42, 128000);
			swarmState.activeToolCalls.set('reset-test-call', { tool: 'y' });

			const result = await handleResetCommand(tempDir, ['--confirm']);

			// Reset command still performs its file/automation work.
			expect(result).toContain('## Swarm Reset Complete');
			expect(result).toContain('✅ Deleted plan.md');

			// All 7 singletons must survive the reset command path (proves no bare or
			// preserving reset of swarmState was triggered by handleResetCommand).
			expect(swarmState.opencodeClient).toBe(sentinelClient);
			expect(swarmState.fullAutoEnabledInConfig).toBe(true);
			expect(swarmState.curatorInitAgentNames).toEqual([
				'reset_init_a',
				'reset_init_b',
			]);
			expect(swarmState.curatorPhaseAgentNames).toEqual(['reset_phase_x']);
			expect(swarmState.skillImproverAgentNames).toEqual(['reset_skill_y']);
			expect(swarmState.specWriterAgentNames).toEqual(['reset_spec_z']);
			expect(swarmState.generatedAgentNames).toEqual([
				'reset_gen_1',
				'reset_gen_2',
			]);
		} finally {
			Object.assign(swarmState, original);
			swarmState.activeToolCalls.delete('reset-test-call');
		}
	});
});
