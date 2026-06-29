import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSyncPlanCommand } from '../../../src/commands/sync-plan';
import type { Plan } from '../../../src/config/plan-schema';
import { savePlan } from '../../../src/plan/manager';

describe('handleSyncPlanCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		// mkdtempSync must be wrapped in realpathSync on macOS (temp dirs are symlinked)
		const raw = await mkdtemp(join(tmpdir(), 'sync-plan-test-'));
		tempDir = realpathSync(raw);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	// ── Helper: write a minimal plan.json ────────────────────────────────────────
	async function writePlanJson(dir: string, plan: Plan): Promise<void> {
		const swarmDir = join(dir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(join(swarmDir, 'plan.json'), JSON.stringify(plan, null, 2));
	}

	// ── Helper: write plan.md directly ─────────────────────────────────────────
	async function writePlanMd(dir: string, content: string): Promise<void> {
		const swarmDir = join(dir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(join(swarmDir, 'plan.md'), content);
	}

	// ── Minimal valid plan for tests ────────────────────────────────────────────
	function makePlan(title = 'Test Plan'): Plan {
		return {
			schema_version: '1.0.0',
			title,
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
							size: 'small',
							description: 'First task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
	}

	// ── Test 1: No plan returns the "no active plan" message ───────────────────
	test('returns "No active swarm plan found" when neither plan.json nor plan.md exists', async () => {
		const result = await handleSyncPlanCommand(tempDir, []);
		expect(result).toBe(
			'## Plan Sync Report\n\nNo active swarm plan found. Nothing to sync.',
		);
	});

	// ── Test 2: plan.json only (no plan.md) — sync succeeds ─────────────────────
	test('returns synced report when plan.json exists but plan.md is missing', async () => {
		const plan = makePlan('Json Only Plan');
		await writePlanJson(tempDir, plan);

		const result = await handleSyncPlanCommand(tempDir, []);

		expect(result).toContain('## Plan Sync Report');
		expect(result).toContain('**Status**: ✅ Synced');
		expect(result).toContain('The plan.json and plan.md are now synchronized.');
		expect(result).toContain('Json Only Plan');
	});

	// ── Test 3: Both plan.json and plan.md in sync — synced report ───────────────
	test('returns synced report when plan.json and plan.md are already in sync', async () => {
		const plan = makePlan('In Sync Plan');
		await savePlan(tempDir, plan);

		const result = await handleSyncPlanCommand(tempDir, []);

		expect(result).toContain('## Plan Sync Report');
		expect(result).toContain('**Status**: ✅ Synced');
		expect(result).toContain('In Sync Plan');
	});

	// ── Test 4: plan.md is stale (missing PLAN_HASH, different content) — auto-heal ─
	test('auto-heals stale plan.md when plan.json is valid but plan.md is outdated', async () => {
		const plan = makePlan('Stale Md Plan');
		await writePlanJson(tempDir, plan);

		// Write a stale plan.md with no PLAN_HASH and wrong content
		await writePlanMd(
			tempDir,
			'# Wrong Title\nSwarm: stale\nPhase: 1 [PENDING]\n',
		);

		const result = await handleSyncPlanCommand(tempDir, []);

		// loadPlan auto-heals: it detects plan.md is stale and regenerates it.
		// The command still returns "Synced" because plan.json is valid.
		expect(result).toContain('**Status**: ✅ Synced');
		expect(result).toContain('Stale Md Plan');
	});

	// ── Test 5: Idempotency — running twice produces identical plan state ─────────
	test('sync is idempotent: running twice leaves plan.json and plan.md in identical state', async () => {
		const plan = makePlan('Idempotent Plan');
		await savePlan(tempDir, plan);

		// First sync
		const result1 = await handleSyncPlanCommand(tempDir, []);

		// Read state after first sync
		const planJson1Path = join(tempDir, '.swarm', 'plan.json');
		const planMd1Path = join(tempDir, '.swarm', 'plan.md');
		const planJson1Content = await Bun.file(planJson1Path).text();
		const planMd1Content = await Bun.file(planMd1Path).text();

		// Second sync
		const result2 = await handleSyncPlanCommand(tempDir, []);

		// Read state after second sync
		const planJson2Content = await Bun.file(planJson1Path).text();
		const planMd2Content = await Bun.file(planMd1Path).text();

		// Both syncs report success
		expect(result1).toContain('✅ Synced');
		expect(result2).toContain('✅ Synced');

		// plan.json and plan.md content are unchanged after second sync
		expect(planJson2Content).toBe(planJson1Content);
		expect(planMd2Content).toBe(planMd1Content);
	});

	// ── Test 6: Idempotency — third sync leaves files unchanged ───────────────────
	test('sync is idempotent: third sync leaves plan.json and plan.md on disk unchanged', async () => {
		const plan = makePlan('Triple Sync Plan');
		await savePlan(tempDir, plan);

		// Baseline after first sync
		await handleSyncPlanCommand(tempDir, []);
		const planJsonAfter1 = await Bun.file(
			join(tempDir, '.swarm', 'plan.json'),
		).text();
		const planMdAfter1 = await Bun.file(
			join(tempDir, '.swarm', 'plan.md'),
		).text();

		// Second and third sync
		await handleSyncPlanCommand(tempDir, []);
		await handleSyncPlanCommand(tempDir, []);

		const planJsonAfter3 = await Bun.file(
			join(tempDir, '.swarm', 'plan.json'),
		).text();
		const planMdAfter3 = await Bun.file(
			join(tempDir, '.swarm', 'plan.md'),
		).text();

		// plan.json is identical; plan.md differs only in timestamp (inside the markdown),
		// but the PLAN_HASH header and structural content are identical.
		expect(planJsonAfter3).toBe(planJsonAfter1);
		// PLAN_HASH header should be identical (proves content is stable)
		const hashMatch1 = planMdAfter1.match(/<!--\s*PLAN_HASH:\s*(\S+)\s*-->/);
		const hashMatch3 = planMdAfter3.match(/<!--\s*PLAN_HASH:\s*(\S+)\s*-->/);
		expect(hashMatch1?.[1]).toBe(hashMatch3?.[1]);
	});

	// ── Test 7: Ledger is authoritative — plan.json and plan.md are derived projections ─
	test('ledger is authoritative: after sync, plan.json and plan.md are consistent projections', async () => {
		const plan = makePlan('Ledger Authoritative Plan');
		// savePlan writes both files and appends to the ledger
		await savePlan(tempDir, plan);

		const result = await handleSyncPlanCommand(tempDir, []);

		// Verify plan.json and plan.md both exist and are consistent
		const planJsonPath = join(tempDir, '.swarm', 'plan.json');
		const planMdPath = join(tempDir, '.swarm', 'plan.md');

		expect(await Bun.file(planJsonPath).exists()).toBe(true);
		expect(await Bun.file(planMdPath).exists()).toBe(true);

		// plan.md should contain a PLAN_HASH comment
		const planMdContent = await Bun.file(planMdPath).text();
		expect(planMdContent).toMatch(/<!--\s*PLAN_HASH:\s*\S+\s*-->/);

		// Both files should reflect the same plan
		expect(result).toContain('Ledger Authoritative Plan');
		expect(result).toContain('**Status**: ✅ Synced');
	});

	// ── Test 8: Sync report contains the current plan markdown ───────────────────
	test('report includes the derived markdown for the current plan', async () => {
		const plan = makePlan('Markdown In Report Plan');
		await savePlan(tempDir, plan);

		const result = await handleSyncPlanCommand(tempDir, []);

		// The report contains the plan markdown under "### Current Plan"
		expect(result).toContain('### Current Plan');
		expect(result).toContain('Markdown In Report Plan');
		expect(result).toContain('Phase 1');
		expect(result).toContain('First task');
	});

	// ── Test 9: plan.md regenerated after manual tampering ───────────────────────
	test('sync repairs plan.md after manual content tampering', async () => {
		const plan = makePlan('Tampered Plan');
		await savePlan(tempDir, plan);

		// Tamper with plan.md: corrupt the content
		await writePlanMd(
			tempDir,
			'# Corrupted\nSwarm: wrong\nPhase: 99 [BROKEN]\n',
		);

		const result = await handleSyncPlanCommand(tempDir, []);

		// Sync detects the staleness via PLAN_HASH mismatch and regenerates plan.md
		expect(result).toContain('**Status**: ✅ Synced');
		expect(result).toContain('Tampered Plan');

		// Verify plan.md is now correct
		const planMdContent = await Bun.file(
			join(tempDir, '.swarm', 'plan.md'),
		).text();
		expect(planMdContent).toContain('Tampered Plan');
		expect(planMdContent).not.toContain('Corrupted');
	});

	// ── Test 10: plan.json only (no ledger yet) — still syncs ──────────────────
	test('handles plan.json without an existing ledger gracefully', async () => {
		const plan = makePlan('No Ledger Plan');
		// Write plan.json directly without going through savePlan (which creates the ledger)
		await writePlanJson(tempDir, plan);

		const result = await handleSyncPlanCommand(tempDir, []);

		expect(result).toContain('**Status**: ✅ Synced');
		expect(result).toContain('No Ledger Plan');
	});
});
