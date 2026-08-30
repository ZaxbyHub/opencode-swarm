import { describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { createCloseFinalizerHarness } from './close-finalizer.fixture.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { derivePlanId } from '../../../src/plan/utils.js';

const harness = await createCloseFinalizerHarness();
const { handleCloseCommand, swarmDir, writePlan } = harness;

describe('handleCloseCommand — archive and clean stages', () => {
	describe('Archive stage', () => {
		it('creates an archive directory under .swarm/archive/ with a timestamped name', async () => {
			await writePlan();

			await handleCloseCommand(harness.testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			expect(existsSync(archiveBase)).toBe(true);

			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			const archiveName = entries.find((e) => e.startsWith('swarm-'));
			expect(archiveName).toBeDefined();
			// Timestamp pattern: swarm-YYYY-MM-DDTHH-MM-SS-…
			expect(archiveName).toMatch(/^swarm-\d{4}-\d{2}-\d{2}T/);
		});

		it('copies plan.json, context.md, and events.jsonl into the archive when they exist', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nSome context',
			);
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"started"}\n',
			);

			await handleCloseCommand(harness.testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			const archiveEntry = readdirSync(archiveBase).find((e) =>
				e.startsWith('swarm-'),
			);
			expect(archiveEntry).toBeDefined();

			const archivePath = path.join(archiveBase, archiveEntry!);
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'context.md'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'events.jsonl'))).toBe(true);

			// Verify content fidelity of events.jsonl
			const archivedEvents = readFileSync(
				path.join(archivePath, 'events.jsonl'),
				'utf-8',
			);
			expect(archivedEvents).toContain('{"event":"started"}');
		});

		it('return message includes archive result', async () => {
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('Archived');
			expect(result).toContain('.swarm/archive/swarm-');
		});
	});

	// ── STAGE 3: CLEAN ───────────────────────────────────────────────

	describe('Clean stage', () => {
		it('removes active-state files after archiving', async () => {
			const activeFilesRemoved = [
				'plan.json',
				'plan.md',
				'plan-ledger.jsonl',
				'events.jsonl',
				'handoff.md',
				'handoff-prompt.md',
				'handoff-consumed.md',
				'escalation-report.md',
			];
			await writePlan();
			for (const f of activeFilesRemoved) {
				if (f === 'plan.json' || f === 'plan-ledger.jsonl') continue;
				writeFileSync(path.join(swarmDir(), f), `content of ${f}`);
			}

			await handleCloseCommand(harness.testDir, []);

			for (const f of activeFilesRemoved) {
				expect(existsSync(path.join(swarmDir(), f))).toBe(false);
			}
		});

		it('removes root-level SWARM_PLAN.json and SWARM_PLAN.md after close', async () => {
			await writePlan();
			writeFileSync(path.join(harness.testDir, 'SWARM_PLAN.json'), '{"title":"Test"}');
			writeFileSync(path.join(harness.testDir, 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(harness.testDir, 'SWARM_PLAN.json'))).toBe(
				false,
			);
			expect(existsSync(path.join(harness.testDir, 'SWARM_PLAN.md'))).toBe(false);
		});

		it('removes .swarm/SWARM_PLAN.json and .swarm/SWARM_PLAN.md after close', async () => {
			await writePlan();
			writeFileSync(path.join(swarmDir(), 'SWARM_PLAN.json'), '{"title":"Test"}');
			writeFileSync(path.join(swarmDir(), 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(swarmDir(), 'SWARM_PLAN.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'SWARM_PLAN.md'))).toBe(false);
		});

		it('removes SWARM_PLAN.{json,md} from .swarm/plan-export/ after close', async () => {
			await writePlan();
			const planExportDir = path.join(swarmDir(), 'plan-export');
			mkdirSync(planExportDir, { recursive: true });
			writeFileSync(
				path.join(planExportDir, 'SWARM_PLAN.json'),
				'{"title":"Test"}',
			);
			writeFileSync(path.join(planExportDir, 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(planExportDir, 'SWARM_PLAN.json'))).toBe(false);
			expect(existsSync(path.join(planExportDir, 'SWARM_PLAN.md'))).toBe(false);
		});

		it('SWARM_PLAN cleanup is non-blocking — close succeeds even if removal fails', async () => {
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			expect(result).toContain('finalized');
		});

		it('future swarms start from clean state — no stale plan.json or events.jsonl', async () => {
			await writePlan();
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"event":"old"}\n');

			await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			expect(existsSync(swarmDir())).toBe(true);
		});
	});

	// ── archive-guard: clean skipped when archive fails ─────────────

	describe('Archive-guard safety', () => {
		it('skips active-state cleanup when archive produces zero artifacts', async () => {
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);

			const archivePath = path.join(swarmDir(), 'archive');
			mkdirSync(archivePath, { recursive: true });
			writeFileSync(path.join(archivePath, 'blocker'), 'x');
			const result = await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			expect(result).toContain('Archived');
		});

		it('warns when archive count is zero and files are preserved', async () => {
			const result = await handleCloseCommand(harness.testDir, []);
			expect(result).toContain('finalized');
		});

		it('partial archive failure: file that fails to copy is preserved, file that succeeds is deleted', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"important"}\n',
			);
			mkdirSync(path.join(swarmDir(), 'handoff.md'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'handoff.md', 'data.txt'),
				'critical data',
			);

			const result = await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'handoff.md'))).toBe(true);
			expect(
				readFileSync(path.join(swarmDir(), 'handoff.md', 'data.txt'), 'utf-8'),
			).toBe('critical data');
			expect(result).toContain('Preserved handoff.md');
			expect(result).toContain('Archive');
			expect(result).toContain('.swarm/archive/swarm-');
		});

		it('partial archive failure path: close output includes warnings about unarchived files and completes without crash even when copy fails for some (FR-018)', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);
			mkdirSync(path.join(swarmDir(), 'handoff.md'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'handoff.md', 'data.txt'),
				'critical unarchived data',
			);

			const closeOutput = await handleCloseCommand(harness.testDir, []);

			expect(closeOutput).toContain('Swarm finalized');
			expect(closeOutput).toContain(
				'Preserved handoff.md because it was not successfully archived',
			);
			expect(closeOutput).toContain('**Warnings:**');
			expect(existsSync(path.join(swarmDir(), 'handoff.md'))).toBe(true);
			expect(
				readFileSync(path.join(swarmDir(), 'handoff.md', 'data.txt'), 'utf-8'),
			).toBe('critical unarchived data');
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
		});

		it('preserves unarchived non-plan active-state files when only non-active-state artifacts are archived', async () => {
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nImportant context.',
			);
			mkdirSync(path.join(swarmDir(), 'events.jsonl'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl', 'data.txt'),
				'event data',
			);
			mkdirSync(path.join(swarmDir(), 'escalation-report.md'), {
				recursive: true,
			});
			mkdirSync(path.join(swarmDir(), 'session-reflection.md'), {
				recursive: true,
			});

			const result = await handleCloseCommand(harness.testDir, []);

			expect(result).toContain('Archive');
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(true);
			expect(
				readFileSync(
					path.join(swarmDir(), 'events.jsonl', 'data.txt'),
					'utf-8',
				),
			).toBe('event data');
			expect(existsSync(path.join(swarmDir(), 'escalation-report.md'))).toBe(
				true,
			);
			expect(result).toContain(
				'plan.json was not archived; removing it anyway to prevent CLOSED-plan resurrection next session',
			);
		});

		it('ledger is archived AND removed — prevents next-session loadPlan from resurrecting the closed plan', async () => {
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			const archiveRoot = path.join(swarmDir(), 'archive');
			const archiveDirs = readdirSync(archiveRoot).filter((d) =>
				d.startsWith('swarm-'),
			);
			expect(archiveDirs.length).toBeGreaterThanOrEqual(1);
			const archivedLedgerPath = path.join(
				archiveRoot,
				archiveDirs[0],
				'plan-ledger.jsonl',
			);
			expect(existsSync(archivedLedgerPath)).toBe(true);
			const archivedLedger = readFileSync(archivedLedgerPath, 'utf-8');
			expect(archivedLedger).toContain('"event_type":"plan_created"');
			expect(archivedLedger).toContain('"event_type":"snapshot"');
			expect(archivedLedger).toContain(
				`"plan_id":"${derivePlanId({ swarm: 'paid', title: 'Finalizer Test Project' })}"`,
			);
			expect(existsSync(path.join(swarmDir(), 'plan-ledger.jsonl'))).toBe(
				false,
			);
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(result).toContain('Archived');
		});

		it('sweeps stale plan-ledger.archived-*/backup-* siblings during cleanup', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.archived-12345-1.jsonl'),
				'{"event":"old"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.backup-67890-2.jsonl'),
				'{"event":"older"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.unrelated.jsonl'),
				'preserve me',
			);

			await handleCloseCommand(harness.testDir, []);

			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.archived-12345-1.jsonl')),
			).toBe(false);
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.backup-67890-2.jsonl')),
			).toBe(false);
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.unrelated.jsonl')),
			).toBe(true);
		});

		it('only files in archivedActiveStateFiles set are deleted during cleanup', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nPreserved across close.',
			);

			const result = await handleCloseCommand(harness.testDir, []);

			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'context.md'))).toBe(true);
			expect(result).toContain('Archived');
		});
	});
});
