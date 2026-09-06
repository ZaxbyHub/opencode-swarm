/**
 * Lifecycle coverage for `.swarm/run-memory.jsonl`.
 *
 * The file is plan-scoped: entries are keyed by plan task IDs like "1.1". If it
 * survives a `/swarm close` or `/swarm reset`, the next plan's identically
 * numbered tasks inherit the previous plan's failures, and the architect is fed
 * failure history for work that was never attempted.
 *
 * These assert on the actual artifact lists rather than on a comment, so
 * deleting either entry from close.ts / reset.ts fails here (project directive
 * 2: wired end-to-end includes test coverage).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..', '..', 'src', 'commands');
const RUN_MEMORY = 'run-memory.jsonl';

/**
 * Extract a `const NAME = [ ... ];` array literal's quoted string entries.
 * Tolerates indentation: `filesToReset` is declared inside a function, so its
 * closing bracket is not at column 0 like the module-scope ones in close.ts.
 */
function arrayEntries(source: string, constName: string): string[] {
	const start = source.indexOf(`const ${constName} = [`);
	expect(start).toBeGreaterThan(-1);
	const end = source.slice(start).search(/\n[ \t]*\];/);
	expect(end).toBeGreaterThan(0);
	// Match only lines that are ENTIRELY a quoted entry. A bare /'([^']+)'/
	// sweep also matches apostrophes inside the surrounding prose comments
	// ("one plan's failures"), which silently swallows real entries.
	return [
		...source.slice(start, start + end).matchAll(/^[ \t]*'([^']+)',[ \t]*$/gm),
	].map((m) => m[1]);
}

describe('/swarm close handles run-memory.jsonl', () => {
	const closeSource = readFileSync(join(SRC, 'close', 'constants.ts'), 'utf-8');

	it('archives it, so the forensic bundle keeps the outcome trail', () => {
		expect(arrayEntries(closeSource, 'ARCHIVE_ARTIFACTS')).toContain(
			RUN_MEMORY,
		);
	});

	it('cleans it, so the next plan does not inherit stale task outcomes', () => {
		expect(arrayEntries(closeSource, 'ACTIVE_STATE_TO_CLEAN')).toContain(
			RUN_MEMORY,
		);
	});

	it('is archived before it is cleaned (archive-first guard applies)', () => {
		const archiveIdx = closeSource.indexOf('const ARCHIVE_ARTIFACTS');
		const cleanIdx = closeSource.indexOf('const ACTIVE_STATE_TO_CLEAN');
		expect(archiveIdx).toBeGreaterThan(-1);
		expect(cleanIdx).toBeGreaterThan(archiveIdx);
	});

	it('is NOT treated as a link-redirected knowledge artifact', () => {
		// KNOWLEDGE_FAMILY_ARTIFACTS is skipped by close when the worktree is
		// linked, because that store is cohort-shared. Run memory is plan-scoped
		// and local, so including it there would leak one plan's failures into
		// every linked peer and skip its cleanup.
		const start = closeSource.indexOf('const KNOWLEDGE_FAMILY_ARTIFACTS');
		expect(start).toBeGreaterThan(-1);
		const end = closeSource.indexOf(']);', start);
		expect(closeSource.slice(start, end)).not.toContain(RUN_MEMORY);
	});
});

describe('/swarm reset handles run-memory.jsonl', () => {
	const resetSource = readFileSync(join(SRC, 'reset.ts'), 'utf-8');

	it('deletes it, since reset wipes the plan it is keyed to', () => {
		expect(arrayEntries(resetSource, 'filesToReset')).toContain(RUN_MEMORY);
	});

	it('backs it up before deleting (filesToReset feeds the backup call)', () => {
		// reset passes [...filesToReset, 'summaries'] to
		// backupSwarmStateBeforeReset, so membership in filesToReset is what
		// makes the documented restore path cover this file.
		expect(resetSource).toContain('...filesToReset');
		expect(resetSource).toContain('backupSwarmStateBeforeReset');
	});
});

describe('docs stay honest about the artifact', () => {
	it('commands.md lists run-memory.jsonl for both close and reset', () => {
		const docs = readFileSync(
			join(import.meta.dir, '..', '..', '..', 'docs', 'commands.md'),
			'utf-8',
		);
		// Two mentions: the finalize cleanup scope and the reset delete list.
		const mentions = [...docs.matchAll(/run-memory\.jsonl/g)].length;
		expect(mentions).toBeGreaterThanOrEqual(2);
	});
});
