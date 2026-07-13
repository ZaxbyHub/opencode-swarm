/**
 * Tests for `/swarm finalize --dry-run` (#1692). The dry-run path is read-only:
 * it returns before the finalize lock and mutates nothing. No heavy close mocks
 * are needed because it never reaches curation/archive/clean/align.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCloseCommand } from '../../../src/commands/close';

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

function writePlan(): void {
	writeFileSync(
		path.join(swarmDir(), 'plan.json'),
		JSON.stringify({
			title: 'DryRun Project',
			phases: [
				{ id: 1, name: 'Alpha', status: 'in_progress', tasks: [] },
				{ id: 2, name: 'Beta', status: 'complete', tasks: [] },
			],
		}),
	);
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-dry-run-'));
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('handleCloseCommand --dry-run', () => {
	it('produces a DRY RUN report and mutates nothing', async () => {
		writePlan();
		writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');
		writeFileSync(path.join(swarmDir(), 'telemetry.jsonl'), '{"t":1}\n');

		const out = await handleCloseCommand(testDir, ['--dry-run']);

		expect(out).toContain('DRY RUN');
		expect(out).toContain('no changes made');
		// Reports the in-progress phase that WOULD be closed.
		expect(out).toContain('#1 Alpha');
		// Lists present artifacts under would-archive / would-clean.
		expect(out).toContain('events.jsonl');
		expect(out).toContain('telemetry.jsonl');

		// Nothing was deleted, no archive bundle was created, no lock file left.
		expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(true);
		expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(true);
		expect(existsSync(path.join(swarmDir(), 'archive'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'close-summary.md'))).toBe(false);
		// .swarm/ still contains exactly what we put there (+ nothing new).
		expect(readdirSync(swarmDir()).sort()).toEqual([
			'events.jsonl',
			'plan.json',
			'telemetry.jsonl',
		]);
	});

	it('never reports WAL sidecars as would-archive/would-clean', async () => {
		writePlan();
		writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), 'shm');
		writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), 'wal');

		const out = await handleCloseCommand(testDir, ['--dry-run']);

		// The would-archive / would-clean lists must not include the sidecars
		// (they are never archived or cleaned). They may only appear in the
		// explanatory footnote.
		const beforeFootnote = out.split('_Note:')[0];
		expect(beforeFootnote).not.toContain('swarm.db-shm');
		expect(beforeFootnote).not.toContain('swarm.db-wal');
		// Sidecars remain on disk.
		expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(true);
	});

	it('handles a plan-free session (cleanup-only) without error', async () => {
		writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');
		const out = await handleCloseCommand(testDir, ['--dry-run']);
		expect(out).toContain('DRY RUN');
		expect(out).toContain('plan-free session');
		expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(true);
	});
});
