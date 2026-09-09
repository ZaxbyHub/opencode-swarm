import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
	initLedger,
	type LedgerEventInput,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import {
	derivePlanMarkdown,
	loadPlan,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeRichPlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'recovery-2531',
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
						description: 'Rich metadata task',
						depends: ['1.0'],
						acceptance: 'AC: all metadata survives recovery',
						files_touched: ['src/plan/manager.ts'],
						evidence_path: '.swarm/evidence/1.1.md',
						fr_refs: ['FR-1', 'FR-2'],
					},
				],
			},
		],
		execution_profile: {
			parallelization_enabled: false,
			max_concurrent_tasks: 1,
			council_parallel: false,
			locked: true,
			auto_proceed: false,
			commit_after_each_completed_task: false,
			planning_profile: 'strict',
		},
	} as Plan;
}

async function freshDir(tag: string): Promise<string> {
	const directory = canonicalMkdtemp(`recovery-2531-${tag}-`);
	await mkdir(join(directory, '.swarm'), { recursive: true });
	await mkdir(join(directory, '.git'));
	resetStartupLedgerCheck();
	return directory;
}

async function cleanup(directory: string): Promise<void> {
	resetStartupLedgerCheck();
	try {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		/* best-effort on Windows swarm.db handles */
	}
}

function assertRichMetadata(plan: Plan | null): void {
	expect(plan).not.toBeNull();
	const task = plan!.phases[0].tasks[0];
	expect(task.acceptance).toBe('AC: all metadata survives recovery');
	expect(task.files_touched).toEqual(['src/plan/manager.ts']);
	expect(task.fr_refs).toEqual(['FR-1', 'FR-2']);
	expect(task.depends).toEqual(['1.0']);
	expect(task.evidence_path).toBe('.swarm/evidence/1.1.md');
	expect(plan!.execution_profile?.locked).toBe(true);
	expect(plan!.execution_profile?.planning_profile).toBe('strict');
	expect(plan!.execution_profile?.parallelization_enabled).toBe(false);
}

describe('loadPlan recovery ladder (#2531)', () => {
	let directory: string;

	beforeEach(() => {
		directory = '';
	});

	afterEach(async () => {
		if (directory) await cleanup(directory);
	});

	test('validation-failure path recovers the critic-approved snapshot before markdown migration', async () => {
		directory = await freshDir('approved-before-md');
		const authoritative = makeRichPlan('Ledger authority plan');
		const planId = derivePlanId(authoritative);
		await initLedger(
			directory,
			planId,
			computePlanLedgerHash(authoritative),
			authoritative,
		);
		await takeSnapshotEvent(directory, authoritative, {
			source: 'critic_approved',
			approvalMetadata: {
				phase: 1,
				verdict: 'APPROVE',
				summary: 'test approval',
			},
		});
		await appendLedgerEvent(directory, {
			event_type: 'plan_reset',
			source: 'test-reset',
			plan_id: planId,
		});
		// Schema-invalid but JSON-valid plan.json with a matching identity.
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify({ ...authoritative, schema_version: '9.9.9' }, null, 2),
			'utf8',
		);
		const mdPlan = makeRichPlan('Wrong MD projection');
		await writeFile(
			join(directory, '.swarm', 'plan.md'),
			derivePlanMarkdown(mdPlan),
			'utf8',
		);

		const loaded = await loadPlan(directory);

		expect(loaded?.title).toBe('Ledger authority plan');
		assertRichMetadata(loaded);
	});

	test('invalid UTF-8 bytes in plan.json recover from the ledger without mojibake', async () => {
		directory = await freshDir('fatal-bootstrap');
		const bootstrapPlan = makeRichPlan('Ledger bootstrap plan');
		// Legacy ledger WITH an embedded plan: the replay rung has a
		// recoverable authoritative plan, so loadPlan must return it (not
		// null) and it must carry no decode-introduced U+FFFD.
		await initLedger(
			directory,
			derivePlanId(bootstrapPlan),
			computePlanLedgerHash(bootstrapPlan),
			bootstrapPlan,
		);
		const json = JSON.stringify(bootstrapPlan, null, 2);
		const marker = 'Rich metadata task';
		const idx = json.indexOf(marker);
		const corrupted = Buffer.concat([
			Buffer.from(json.slice(0, idx), 'utf8'),
			Buffer.from([0xc3, 0x28]),
			Buffer.from(json.slice(idx + marker.length), 'utf8'),
		]);
		await writeFile(join(directory, '.swarm', 'plan.json'), corrupted);

		const loaded = await loadPlan(directory);

		// The recovered plan is the ledger's embedded plan, byte-faithful —
		// never a lenient-decoded mojibake rendering of the corrupted file.
		expect(loaded).not.toBeNull();
		expect(loaded?.title).toBe('Ledger bootstrap plan');
		const serialized = JSON.stringify([
			loaded?.title,
			...(loaded?.phases.flatMap((p) => p.tasks.map((t) => t.description)) ??
				[]),
		]);
		expect(serialized.includes('\uFFFD')).toBe(false);
	});

	test('invalid UTF-8 plan.json with no recoverable ledger plan returns null, never mojibake', async () => {
		directory = await freshDir('fatal-bootstrap-null');
		const bootstrapPlan = makeRichPlan('Ledger bootstrap plan');
		// Legacy ledger: plan_created WITHOUT an embedded plan — no rung has
		// a recoverable plan, so loadPlan must return null rather than a
		// lenient-decoded plan.
		await initLedger(
			directory,
			derivePlanId(bootstrapPlan),
			computePlanLedgerHash(bootstrapPlan),
		);
		const json = JSON.stringify(bootstrapPlan, null, 2);
		const marker = 'Rich metadata task';
		const idx = json.indexOf(marker);
		const corrupted = Buffer.concat([
			Buffer.from(json.slice(0, idx), 'utf8'),
			Buffer.from([0xc3, 0x28]),
			Buffer.from(json.slice(idx + marker.length), 'utf8'),
		]);
		await writeFile(join(directory, '.swarm', 'plan.json'), corrupted);

		const loaded = await loadPlan(directory);

		expect(loaded).toBeNull();
	});

	test('degraded latest snapshot falls back to recoverable older history', async () => {
		directory = await freshDir('degraded-snapshot');
		const older = makeRichPlan('Recoverable older snapshot');
		const planId = derivePlanId(older);
		await initLedger(directory, planId, computePlanLedgerHash(older), older);
		await takeSnapshotEvent(directory, older, {
			source: 'savePlan_manager',
		});
		await appendLedgerEvent(directory, {
			event_type: 'snapshot',
			plan_id: planId,
			source: 'savePlan_manager',
			payload: {
				plan: { ...(older as object), phases: [] },
				payload_hash: 'degraded-payload-hash',
			},
		} as LedgerEventInput);

		const loaded = await loadPlan(directory);

		expect(loaded?.title).toBe('Recoverable older snapshot');
		assertRichMetadata(loaded);
	});

	test('truncated ledger + schema-invalid plan.json: verified prefix rebuilds, poison suffix never consulted', async () => {
		directory = await freshDir('truncated-invalid');
		const donor = await freshDir('truncated-invalid-donor');
		try {
			const plan = makeRichPlan('Approved on verified prefix');
			const planId = derivePlanId(plan);
			await initLedger(donor, planId, computePlanLedgerHash(plan), plan);
			await takeSnapshotEvent(donor, plan, {
				source: 'critic_approved',
				approvalMetadata: { phase: 1, verdict: 'APPROVE', summary: 'x' },
			});
			const donorLines = readFileSync(
				join(donor, '.swarm', 'plan-ledger.jsonl'),
				'utf8',
			)
				.split('\n')
				.filter((line) => line.trim() !== '');
			// Poison AFTER the verified plan_created root: the prefix is
			// trusted and rebuilds the plan; the post-poison snapshot is
			// never consulted.
			await writeFile(
				join(directory, '.swarm', 'plan-ledger.jsonl'),
				`${donorLines[0]}\n{"poison": true}\n${donorLines[1]}\n`,
				'utf8',
			);
			await writeFile(
				join(directory, '.swarm', 'plan.json'),
				JSON.stringify({ ...plan, schema_version: '9.9.9' }, null, 2),
				'utf8',
			);
			await writeFile(
				join(directory, '.swarm', 'plan.md'),
				derivePlanMarkdown(makeRichPlan('Truncated fallback plan')),
				'utf8',
			);

			const loaded = await loadPlan(directory);

			expect(loaded?.title).toBe('Approved on verified prefix');
		} finally {
			await cleanup(donor);
		}
	});

	test('poison before every event + schema-invalid plan.json: markdown migration with quarantine intact', async () => {
		directory = await freshDir('poison-first');
		const donor = await freshDir('poison-first-donor');
		try {
			const plan = makeRichPlan('Never verified plan');
			const planId = derivePlanId(plan);
			await initLedger(donor, planId, computePlanLedgerHash(plan), plan);
			const donorLines = readFileSync(
				join(donor, '.swarm', 'plan-ledger.jsonl'),
				'utf8',
			)
				.split('\n')
				.filter((line) => line.trim() !== '');
			// Poison BEFORE every event: the integrity view has an EMPTY
			// verified prefix, no anchor identity exists, so recovery
			// conservatively skips ledger state and the lossy markdown
			// migration is the rung (documented outcome matrix).
			await writeFile(
				join(directory, '.swarm', 'plan-ledger.jsonl'),
				`{"poison": true}\n${donorLines[0]}\n`,
				'utf8',
			);
			await writeFile(
				join(directory, '.swarm', 'plan.json'),
				JSON.stringify({ ...plan, schema_version: '9.9.9' }, null, 2),
				'utf8',
			);
			await writeFile(
				join(directory, '.swarm', 'plan.md'),
				derivePlanMarkdown(makeRichPlan('Poison-first fallback plan')),
				'utf8',
			);

			const loaded = await loadPlan(directory);

			expect(loaded?.migration_status).toBe('migrated');
			expect(loaded?.title).toBe('Poison-first fallback plan');
		} finally {
			await cleanup(donor);
		}
	});
});
