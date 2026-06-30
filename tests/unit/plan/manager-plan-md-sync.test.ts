import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	derivePlanMarkdown,
	isPlanMdInSync,
	regeneratePlanMarkdown,
} from '../../../src/plan/manager';

// ---------------------------------------------------------------------------
// FR-001 / F-11: isPlanMdInSync must NOT treat a non-equivalent plan.md that
// merely CONTAINS the expected rendering (strict superset / substring) as
// "in sync". The legitimate sync paths are (1) PLAN_HASH header match and
// (2) normalized exact equality. The former permissive substring fallback
// produced false positives and has been removed.
//
// derivePlanMarkdown() embeds a fresh `Updated: <ISO>` timestamp on every call,
// so the exact-equality and substring paths are non-deterministic at runtime
// unless time is frozen. We freeze Date.prototype.toISOString for the
// timestamp-dependent cases so the test is deterministic. The PLAN_HASH path is
// timestamp-independent (computePlanContentHash excludes timestamps) and does
// not require freezing.
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Sync Test Plan',
		swarm: 'sync-swarm',
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
						status: 'in_progress',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

async function writePlanMd(dir: string, content: string): Promise<void> {
	const swarmDir = join(dir, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	await writeFile(join(swarmDir, 'plan.md'), content, 'utf-8');
}

describe('isPlanMdInSync — FR-001 / F-11 substring-fallback tightening', () => {
	let tempDir: string;
	let toISOStringSpy: ReturnType<typeof spyOn> | null = null;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'plan-md-sync-'));
		// Freeze the timestamp embedded by derivePlanMarkdown so the
		// exact-equality and superset cases are deterministic.
		toISOStringSpy = spyOn(Date.prototype, 'toISOString').mockReturnValue(
			'2026-01-01T00:00:00.000Z',
		);
	});

	afterEach(async () => {
		toISOStringSpy?.mockRestore();
		toISOStringSpy = null;
		mock.restore();
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('PLAN_HASH header match → in sync (true)', async () => {
		const plan = createTestPlan();
		// regeneratePlanMarkdown writes plan.md with the `<!-- PLAN_HASH: ... -->`
		// header that the primary sync check extracts and compares.
		await regeneratePlanMarkdown(tempDir, plan);

		expect(await isPlanMdInSync(tempDir, plan)).toBe(true);
	});

	test('normalized exact-equality (no PLAN_HASH header) → in sync (true)', async () => {
		const plan = createTestPlan();
		// Legacy plan.md generated before hashing was added: no header, but the
		// content is byte-for-byte the derived rendering (time frozen).
		const exact = derivePlanMarkdown(plan);
		await writePlanMd(tempDir, exact);

		expect(await isPlanMdInSync(tempDir, plan)).toBe(true);
	});

	test('regression (F-11): strict superset of the expected rendering → OUT of sync (false)', async () => {
		// Previous buggy behavior: the permissive fallback
		//   `normalizedActual.includes(normalizedExpected) || ...`
		// reported a plan.md that merely CONTAINS the expected rendering (with
		// extra, non-equivalent phases/tasks appended) as "in sync". With time
		// frozen, `includes()` is true for this input, so the OLD code returned
		// true. The tightened code returns false because there is neither a
		// PLAN_HASH header match nor exact equality.
		const plan = createTestPlan();
		const expected = derivePlanMarkdown(plan);
		const superset = `${expected}\n\n## Phase 99: Injected [PENDING]\n- [ ] 99.1: an extra task not present in plan.json [SMALL]\n`;
		await writePlanMd(tempDir, superset);

		// Sanity: the superset genuinely contains the expected rendering, so the
		// removed substring fallback would have matched.
		expect(superset.trim().includes(expected.trim())).toBe(true);

		expect(await isPlanMdInSync(tempDir, plan)).toBe(false);
	});

	test('missing plan.md → OUT of sync (false)', async () => {
		const plan = createTestPlan();
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		// No plan.md written.
		expect(await isPlanMdInSync(tempDir, plan)).toBe(false);
	});
});
