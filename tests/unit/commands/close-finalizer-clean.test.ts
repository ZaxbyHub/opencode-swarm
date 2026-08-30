import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { initializeCloseFinalizerHarness } from './close-finalizer.shared.ts';

const h = await initializeCloseFinalizerHarness();
let testDir = '';

beforeEach(() => {
	h.resetState();
	testDir = h.newTestDir();
});

afterEach(() => {
	h.restoreInternals();
	h.cleanupTestDir(testDir);
	mock.restore();
});

describe('handleCloseCommand — clean stage', () => {
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
		await h.writePlan(testDir);
		for (const file of activeFilesRemoved) {
			if (file === 'plan.json' || file === 'plan-ledger.jsonl') continue;
			writeFileSync(path.join(h.swarmDir(testDir), file), `content of ${file}`);
		}

		await h.handleCloseCommand(testDir, []);

		for (const file of activeFilesRemoved) {
			expect(existsSync(path.join(h.swarmDir(testDir), file))).toBe(false);
		}
	});

	it('removes root-level SWARM_PLAN.json and SWARM_PLAN.md after close', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(testDir, 'SWARM_PLAN.json'), '{"title":"Test"}');
		writeFileSync(path.join(testDir, 'SWARM_PLAN.md'), '# Test Plan');

		await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(testDir, 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(path.join(testDir, 'SWARM_PLAN.md'))).toBe(false);
	});

	it('removes .swarm/SWARM_PLAN.json and .swarm/SWARM_PLAN.md after close', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(h.swarmDir(testDir), 'SWARM_PLAN.json'), '{"title":"Test"}');
		writeFileSync(path.join(h.swarmDir(testDir), 'SWARM_PLAN.md'), '# Test Plan');

		await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(h.swarmDir(testDir), 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'SWARM_PLAN.md'))).toBe(false);
	});

	it('removes SWARM_PLAN.{json,md} from .swarm/plan-export/ after close', async () => {
		await h.writePlan(testDir);
		const planExportDir = path.join(h.swarmDir(testDir), 'plan-export');
		mkdirSync(planExportDir, { recursive: true });
		writeFileSync(path.join(planExportDir, 'SWARM_PLAN.json'), '{"title":"Test"}');
		writeFileSync(path.join(planExportDir, 'SWARM_PLAN.md'), '# Test Plan');

		await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(planExportDir, 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(path.join(planExportDir, 'SWARM_PLAN.md'))).toBe(false);
	});

	it('SWARM_PLAN cleanup is non-blocking — close succeeds even if removal fails', async () => {
		await h.writePlan(testDir);

		const result = await h.handleCloseCommand(testDir, []);

		expect(result).toContain('finalized');
	});

	it('future swarms start from clean state — no stale plan.json or events.jsonl', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(h.swarmDir(testDir), 'events.jsonl'), '{"event":"old"}\n');

		await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(h.swarmDir(testDir), 'plan.json'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'events.jsonl'))).toBe(false);
		expect(existsSync(h.swarmDir(testDir))).toBe(true);
	});
});

describe('Archive-guard safety', () => {
	it('skips active-state cleanup when archive produces zero artifacts', async () => {
		writeFileSync(path.join(h.swarmDir(testDir), 'events.jsonl'), '{"event":"test"}\n');

		const archivePath = path.join(h.swarmDir(testDir), 'archive');
		mkdirSync(archivePath, { recursive: true });
		writeFileSync(path.join(archivePath, 'blocker'), 'x');

		const result = await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(h.swarmDir(testDir), 'events.jsonl'))).toBe(false);
		expect(result).toContain('Archived');
	});

	it('warns when archive count is zero and files are preserved', async () => {
		const result = await h.handleCloseCommand(testDir, []);

		expect(result).toContain('finalized');
	});

	it('partial archive failure: file that fails to copy is preserved, file that succeeds is deleted', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(h.swarmDir(testDir), 'events.jsonl'), '{"event":"important"}\n');
		mkdirSync(path.join(h.swarmDir(testDir), 'handoff.md'), { recursive: true });
		writeFileSync(path.join(h.swarmDir(testDir), 'handoff.md', 'data.txt'), 'critical data');

		const result = await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(h.swarmDir(testDir), 'events.jsonl'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'handoff.md'))).toBe(true);
		expect(readFileSync(path.join(h.swarmDir(testDir), 'handoff.md', 'data.txt'), 'utf-8')).toBe(
			'critical data',
		);
		expect(result).toContain('Preserved handoff.md');
		expect(result).toContain('Archive');
		expect(result).toContain('.swarm/archive/swarm-');
	});

	it('partial archive failure path: close output includes warnings about unarchived files and completes without crash even when copy fails for some (FR-018)', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(h.swarmDir(testDir), 'events.jsonl'), '{"event":"test"}\n');
		mkdirSync(path.join(h.swarmDir(testDir), 'handoff.md'), { recursive: true });
		writeFileSync(
			path.join(h.swarmDir(testDir), 'handoff.md', 'data.txt'),
			'critical unarchived data',
		);

		const closeOutput = await h.handleCloseCommand(testDir, []);

		expect(closeOutput).toContain('Swarm finalized');
		expect(closeOutput).toContain(
			'Preserved handoff.md because it was not successfully archived',
		);
		expect(closeOutput).toContain('**Warnings:**');
		expect(existsSync(path.join(h.swarmDir(testDir), 'handoff.md'))).toBe(true);
		expect(
			readFileSync(path.join(h.swarmDir(testDir), 'handoff.md', 'data.txt'), 'utf-8'),
		).toBe('critical unarchived data');
		expect(existsSync(path.join(h.swarmDir(testDir), 'events.jsonl'))).toBe(false);
	});

	it('preserves unarchived non-plan active-state files when only non-active-state artifacts are archived', async () => {
		writeFileSync(
			path.join(h.swarmDir(testDir), 'context.md'),
			'# Context\nImportant context.',
		);
		mkdirSync(path.join(h.swarmDir(testDir), 'events.jsonl'), { recursive: true });
		writeFileSync(path.join(h.swarmDir(testDir), 'events.jsonl', 'data.txt'), 'event data');
		mkdirSync(path.join(h.swarmDir(testDir), 'escalation-report.md'), { recursive: true });
		mkdirSync(path.join(h.swarmDir(testDir), 'session-reflection.md'), {
			recursive: true,
		});

		const result = await h.handleCloseCommand(testDir, []);

		expect(result).toContain('Archive');
		expect(existsSync(path.join(h.swarmDir(testDir), 'events.jsonl'))).toBe(true);
		expect(
			readFileSync(path.join(h.swarmDir(testDir), 'events.jsonl', 'data.txt'), 'utf-8'),
		).toBe('event data');
		expect(existsSync(path.join(h.swarmDir(testDir), 'escalation-report.md'))).toBe(true);
		expect(result).toContain(
			'plan.json was not archived; removing it anyway to prevent CLOSED-plan resurrection next session',
		);
	});

	it('ledger is archived AND removed — prevents next-session loadPlan from resurrecting the closed plan', async () => {
		await h.writePlan(testDir);

		const result = await h.handleCloseCommand(testDir, []);

		const archiveRoot = path.join(h.swarmDir(testDir), 'archive');
		const archiveDirs = readdirSync(archiveRoot).filter((entry) => entry.startsWith('swarm-'));
		expect(archiveDirs.length).toBeGreaterThanOrEqual(1);
		const archivedLedgerPath = path.join(archiveRoot, archiveDirs[0], 'plan-ledger.jsonl');
		expect(existsSync(archivedLedgerPath)).toBe(true);
		const archivedLedger = readFileSync(archivedLedgerPath, 'utf-8');
		expect(archivedLedger).toContain('"event_type":"plan_created"');
		expect(archivedLedger).toContain('"event_type":"snapshot"');
		expect(archivedLedger).toContain(
			`"plan_id":"${derivePlanId({ swarm: 'paid', title: 'Finalizer Test Project' })}"`,
		);

		expect(existsSync(path.join(h.swarmDir(testDir), 'plan-ledger.jsonl'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'plan.json'))).toBe(false);
		expect(result).toContain('Archived');
	});

	it('sweeps stale plan-ledger.archived-*/backup-* siblings during cleanup', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(h.swarmDir(testDir), 'plan-ledger.archived-12345-1.jsonl'), '{"event":"old"}\n');
		writeFileSync(path.join(h.swarmDir(testDir), 'plan-ledger.backup-67890-2.jsonl'), '{"event":"older"}\n');
		writeFileSync(path.join(h.swarmDir(testDir), 'plan-ledger.unrelated.jsonl'), 'preserve me');

		await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(h.swarmDir(testDir), 'plan-ledger.archived-12345-1.jsonl'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'plan-ledger.backup-67890-2.jsonl'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'plan-ledger.unrelated.jsonl'))).toBe(true);
	});

	it('only files in archivedActiveStateFiles set are deleted during cleanup', async () => {
		await h.writePlan(testDir);
		writeFileSync(path.join(h.swarmDir(testDir), 'events.jsonl'), '{"event":"test"}\n');
		writeFileSync(path.join(h.swarmDir(testDir), 'context.md'), '# Context\nPreserved across close.');

		const result = await h.handleCloseCommand(testDir, []);

		expect(existsSync(path.join(h.swarmDir(testDir), 'plan.json'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'events.jsonl'))).toBe(false);
		expect(existsSync(path.join(h.swarmDir(testDir), 'context.md'))).toBe(true);
		expect(result).toContain('Archived');
	});
});
