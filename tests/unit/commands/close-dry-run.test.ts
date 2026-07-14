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
import { _internals, handleCloseCommand } from '../../../src/commands/close';

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

	it('lists a terminal file only under "Would remove unconditionally", not also under "Would clean"', async () => {
		// plan.json is a member of both ACTIVE_STATE_TO_CLEAN and
		// TERMINAL_STATE_FILES; the report must not show it under both
		// sections with two different removal rationales.
		writePlan();

		const out = await handleCloseCommand(testDir, ['--dry-run']);

		const wouldClean = out
			.split('### Would clean')[1]
			.split('### Would remove unconditionally')[0];
		const wouldRemoveUnconditionally = out.split(
			'### Would remove unconditionally',
		)[1];

		expect(wouldRemoveUnconditionally).toContain('plan.json');
		expect(wouldClean).not.toContain('plan.json');
	});

	it('lists every TERMINAL_STATE_FILES member exactly once across Would clean + Would remove unconditionally, even with all four present', async () => {
		// Generalizes the single-file regression above: create all four
		// TERMINAL_STATE_FILES members (not just plan.json) plus a
		// non-terminal ACTIVE_STATE_TO_CLEAN control file, and confirm the
		// fix holds for the whole set — each terminal file appears exactly
		// once (under "Would remove unconditionally" only), while the
		// non-terminal control file still appears under "Would clean".
		writePlan();
		writeFileSync(path.join(swarmDir(), 'plan-ledger.jsonl'), '{}\n');
		writeFileSync(path.join(swarmDir(), 'spec-staleness.json'), '{}');
		writeFileSync(path.join(swarmDir(), 'spec-snapshot.md'), '# spec');
		writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');

		const out = await handleCloseCommand(testDir, ['--dry-run']);

		const wouldClean = out
			.split('### Would clean')[1]
			.split('### Would remove unconditionally')[0];
		const wouldRemoveUnconditionally = out
			.split('### Would remove unconditionally')[1]
			.split('### Git')[0];

		const terminalFiles = [
			'plan.json',
			'plan-ledger.jsonl',
			'spec-staleness.json',
			'spec-snapshot.md',
		];
		for (const file of terminalFiles) {
			// Exactly once overall, and only in the unconditional-removal section.
			const cleanCount = wouldClean.split(file).length - 1;
			const terminalCount = wouldRemoveUnconditionally.split(file).length - 1;
			expect(cleanCount).toBe(0);
			expect(terminalCount).toBe(1);
		}

		// Control: a file present in ACTIVE_STATE_TO_CLEAN but absent from
		// TERMINAL_STATE_FILES must still surface under "Would clean" and
		// must not be swallowed by the exclusion.
		expect(wouldClean).toContain('events.jsonl');
		expect(wouldRemoveUnconditionally).not.toContain('events.jsonl');
	});

	it('never tears down session state (endAgentSession / resetSwarmStatePreservingSingletons not called)', async () => {
		// Locks the docblock's "no tearing down session state" claim: a future
		// refactor that moves teardown earlier must not silently regress this.
		writePlan();
		let endAgentSessionCalls = 0;
		let resetCalls = 0;
		const originalEndAgentSession = _internals.endAgentSession;
		const originalReset = _internals.resetSwarmStatePreservingSingletons;
		_internals.endAgentSession = (...args) => {
			endAgentSessionCalls++;
			return originalEndAgentSession(...args);
		};
		_internals.resetSwarmStatePreservingSingletons = (...args) => {
			resetCalls++;
			return originalReset(...args);
		};
		try {
			await handleCloseCommand(testDir, ['--dry-run']);
			expect(endAgentSessionCalls).toBe(0);
			expect(resetCalls).toBe(0);
		} finally {
			_internals.endAgentSession = originalEndAgentSession;
			_internals.resetSwarmStatePreservingSingletons = originalReset;
		}
	});

	it('handles a plan-free session (cleanup-only) without error', async () => {
		writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');
		const out = await handleCloseCommand(testDir, ['--dry-run']);
		expect(out).toContain('DRY RUN');
		expect(out).toContain('plan-free session');
		expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(true);
	});
});
