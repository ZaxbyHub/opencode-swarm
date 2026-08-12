import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The only cross-module mock in this file is the scoped node:fs error simulation.
// The reset command does not import state; this suite verifies the real singleton
// remains intact without a process-global state mock.
import { handleResetCommand } from '../../../src/commands/reset';
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
		// Restore the node:fs mock used by the EBUSY/EACCES cases below.
		mock.restore();
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
		expect(result).toContain('✅ Deleted plan-ledger.jsonl');
		expect(result).toContain('✅ Deleted plan.json');

		// Resurrection guard: both plan.json and plan-ledger.jsonl must be absent
		// so a subsequent loadPlan()/replayFromLedger() has nothing to resurrect.
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'plan-ledger.jsonl'))).toBe(
			false,
		);
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

	// ── EBUSY / LOCKED FILE ERROR HANDLING (FR-007) ──────────────────────────────
	// Simulates EBUSY during unlinkSync (used by reset for .swarm/ files and root
	// legacy artifacts). Verifies catch path produces '❌ Failed to delete ...'
	// friendly message (instead of crash) and that processing continues for
	// remaining files/artifacts. Uses mock.module('node:fs') + spread real exports
	// + afterEach(mock.restore()) per writing-tests skill. Dynamic re-import after
	// mock ensures SUT binds the mocked fs (matches handoff.error-handling.test.ts
	// and close-plan-terminal-state.test.ts patterns). existsSync mocked to true
	// so delete paths are exercised; unlink throws on first call, succeeds on
	// retry/subsequent to prove continuation.
	describe('EBUSY simulation for locked files during reset (FR-007)', () => {
		test('reports friendly error for EBUSY on unlinkSync but continues processing other files', async () => {
			let unlinkCallCount = 0;
			const ebusiError = Object.assign(
				new Error('EBUSY: resource busy or locked'),
				{
					code: 'EBUSY',
				},
			);

			await mock.module('node:fs', () => ({
				...realFs,
				existsSync: mock((_p: string) => true),
				unlinkSync: mock((_p: string) => {
					unlinkCallCount++;
					if (unlinkCallCount === 1) {
						throw ebusiError;
					}
					// succeed on subsequent calls (simulates "retry" and continuation to next files)
				}),
			}));

			// Re-import to get fresh module with mock applied (top-level import captured real fs)
			const { handleResetCommand: handleResetWithMock } = await import(
				'../../../src/commands/reset'
			);

			const result = await handleResetWithMock(tempDir, ['--confirm']);

			// Friendly error message for the file whose unlink threw (first call)
			expect(result).toContain('## Swarm Reset Complete');
			expect(result).toContain('❌ Failed to delete plan.md');

			// Processing continued (subsequent unlinks succeeded per mock counter)
			expect(result).toContain('✅ Deleted plan.json');
			expect(result).toContain('✅ Deleted context.md');

			// No crash; command produced full output with footer
			expect(result).toContain(
				'Swarm state has been cleared. Start fresh with a new plan.',
			);
		});
	});

	// ── EACCES / PERMISSION DENIED + rmSync FAILURE PATH (FR-014) ─────────────────────
	// Simulates EACCES (permission denied) during unlinkSync on the FIRST call but
	// succeeding on retry (per task spec). Also overrides rmSync to exercise the
	// summaries/ catch path. Verifies friendly '❌ Failed to delete ...' messages
	// (contains "Failed to delete") and that command continues processing other
	// files without crashing. Uses the exact mock.module('node:fs') + ...fsSync spread
	// + existsSync always-true + dynamic re-import + afterEach(mock.restore()) pattern
	// already established in this file (and state mock at top for reference).
	describe('EACCES simulation for permission-denied files during reset (FR-014)', () => {
		test('reports friendly error for EACCES on unlinkSync but continues processing other files (and exercises rmSync failure)', async () => {
			let unlinkCallCount = 0;
			const eaccesError = Object.assign(
				new Error('EACCES: permission denied'),
				{
					code: 'EACCES',
				},
			);

			await mock.module('node:fs', () => ({
				...realFs,
				existsSync: mock((_p: string) => true),
				unlinkSync: mock((_p: string) => {
					unlinkCallCount++;
					if (unlinkCallCount === 1) {
						throw eaccesError;
					}
					// succeed on subsequent calls (simulates "retry" and continuation to next files)
				}),
				rmSync: mock((_p: string, _opts?: unknown) => {
					// throw to exercise the summaries/ directory failure path in reset
					throw eaccesError;
				}),
			}));

			// Re-import to get fresh module with mock applied (top-level import captured real fs)
			const { handleResetCommand: handleResetWithMock } = await import(
				'../../../src/commands/reset'
			);

			const resetResult = await handleResetWithMock(tempDir, ['--confirm']);

			// Friendly error message for the file whose unlink threw (first call)
			expect(resetResult).toContain('## Swarm Reset Complete');
			expect(resetResult).toContain('❌ Failed to delete plan.md');

			// Processing continued (subsequent unlinks succeeded per mock counter)
			expect(resetResult).toContain('✅ Deleted plan.json');
			expect(resetResult).toContain('✅ Deleted context.md');

			// rmSync failure path also exercised
			expect(resetResult).toContain('❌ Failed to delete summaries/');

			// No crash; command produced full output with footer
			expect(resetResult).toContain(
				'Swarm state has been cleared. Start fresh with a new plan.',
			);
		});
	});
});
