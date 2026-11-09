/**
 * Check 10 (issue #2969) — raw renameSync / raw rm crash-consistency ratchet.
 *
 * Unit tests for `checkRawWriteRatchet` and its pure helpers
 * (`diffAllowlistGrowth`, `parseRawWriteAllowlist`, `regenRawWriteAllowlist`)
 * in scripts/check-invariants.ts: per-file quota freeze, dead-entry
 * fail-close, both-dimensions growth vs the git base (new path OR count
 * increase) without an `# APPROVED-NEW:` marker, bootstrap introduction mode,
 * shrink-is-clean, fixture-tree skip, and the regen flag's writer.
 *
 * Self-exclusion note: this file builds its raw-rm fixture call sites and the
 * db-handle string with join-literals (the MOCK_MODULE_CALL precedent in
 * check-bash-gates-legacy-oracle.test.ts) and keeps every dot-db and raw-rm
 * spelling out of its own source and comments — otherwise the tests arm
 * (db-handle predicate on file content) would freeze THIS file in the real
 * allowlist.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	checkRawWriteRatchet,
	diffAllowlistGrowth,
	parseRawWriteAllowlist,
	regenRawWriteAllowlist,
} from '../../../scripts/check-invariants';
import { runGit } from '../../../scripts/gate-utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ALLOWLIST_REL = 'scripts/raw-write-allowlist.txt';
/** The raw-rm fixture call, built from pieces so this file stays outside the tests arm. */
const RM_CALL = ['fs.', 'rm', 'Sync(p);'].join('');
/** The db-handle fixture name, built from pieces — same reason as RM_CALL. */
const DB_NAME = ['swarm', '.', 'd', 'b'].join('');

const tempRoots: string[] = [];

function track(dir: string): string {
	tempRoots.push(dir);
	return dir;
}

function write(root: string, rel: string, content: string): string {
	const full = path.join(root, ...rel.split('/'));
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
	return full;
}

/** `count` raw renameSync call sites; site #n sits on line n+1. */
function srcWithRawRenames(count: number): string {
	const lines = ['export function save(): void {'];
	for (let i = 0; i < count; i += 1) {
		lines.push('\tfs.renameSync(tmp, out);');
	}
	lines.push('}');
	return `${lines.join('\n')}\n`;
}

/** A db-handle test file: content references the DB_NAME path and has `count` raw rm sites. */
function dbTestWithRawRm(count: number): string {
	const lines = [
		"import * as fs from 'node:fs';",
		`const dbPath = path.join(dir, ${JSON.stringify(DB_NAME)});`,
		'export function cleanup(): void {',
	];
	for (let i = 0; i < count; i += 1) {
		lines.push(`\t${RM_CALL}`);
	}
	lines.push('}');
	return `${lines.join('\n')}\n`;
}

async function gitOk(repoDir: string, ...args: string[]): Promise<void> {
	const result = await runGit(args, repoDir, 10_000);
	if (result.exitCode === 0) return;
	throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/**
 * A real git fixture (the oracle makeRepo pattern): seed files + optional
 * base allowlist committed on main, then origin/main branched at that commit.
 * The WORKING TREE copy of the allowlist is what Check 10 reads as head —
 * tests mutate it after this returns.
 */
async function gitBaseFixture(
	prefix: string,
	seed: { rel: string; content: string }[],
	baseAllowlist: string | null,
): Promise<string> {
	const repoDir = track(canonicalMkdtemp(prefix));
	await gitOk(repoDir, 'init', '-q', '-b', 'main');
	await gitOk(repoDir, 'config', 'user.email', 'test@example.com');
	await gitOk(repoDir, 'config', 'user.name', 'Test');
	for (const file of seed) {
		write(repoDir, file.rel, file.content);
	}
	if (baseAllowlist !== null) {
		write(repoDir, ALLOWLIST_REL, baseAllowlist);
	}
	await gitOk(repoDir, 'add', '-A');
	await gitOk(repoDir, 'commit', '-q', '-m', 'base');
	await gitOk(repoDir, 'branch', 'origin/main');
	return repoDir;
}

function plainFixture(prefix: string): string {
	return track(canonicalMkdtemp(prefix));
}

const HEADER =
	'=== Check 10: raw renameSync / raw rm ratchet (crash-consistency allowlist, issue #2969) ===';

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('Check 10 raw-write ratchet — live-count arms (no git)', () => {
	test('(1) raw renameSync with no allowlist entry violates, per excess site', async () => {
		const root = plainFixture('raw-write-live-over-');
		write(root, 'src/a.ts', srcWithRawRenames(1));
		write(root, ALLOWLIST_REL, '# fixture allowlist — header only\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBeGreaterThanOrEqual(1);
		expect(result.messages.join('\n')).toContain(
			'ERROR: src/a.ts:2 raw renameSync site 1/1 exceeds the frozen quota (0)',
		);
	});

	test('(2) exact-count allowlist is clean', async () => {
		const root = plainFixture('raw-write-exact-');
		write(root, 'src/a.ts', srcWithRawRenames(2));
		write(root, 'tests/unit/db-handle.test.ts', dbTestWithRawRm(1));
		write(
			root,
			ALLOWLIST_REL,
			'src/a.ts: 2\ntests/unit/db-handle.test.ts: 1\n',
		);
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(0);
		expect(result.messages.join('\n')).toContain(
			'allowlist entries: 2 (src: 1, tests: 1)',
		);
		expect(result.messages.join('\n')).toContain(
			'src arm: 1 file(s), 2 raw renameSync site(s) | tests arm: 1 file(s), 1 raw rm site(s)',
		);
	});

	test('(3) dead entry (allowed 1, live 0) violates', async () => {
		const root = plainFixture('raw-write-dead-');
		write(root, 'src/a.ts', 'export const ok = 1;\n'); // zero raw sites
		write(root, ALLOWLIST_REL, 'src/a.ts: 1\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain(
			"ERROR: dead allowlist entry 'src/a.ts: 1' — the live scan finds 0 site(s)",
		);
	});

	test('(10) missing allowlist in a real-repo shape (src/ + .git) violates', async () => {
		const root = plainFixture('raw-write-missing-real-');
		write(root, 'src/a.ts', srcWithRawRenames(1));
		fs.mkdirSync(path.join(root, '.git')); // real-repo shape, no git needed
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain(
			'ERROR: scripts/raw-write-allowlist.txt not found',
		);
	});

	test('(11) fixture tree without src/ skips cleanly', async () => {
		const root = plainFixture('raw-write-no-src-');
		fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(0);
		expect(result.messages).toContain(HEADER);
		expect(result.messages).toContain(
			'Check 10 skipped: no raw-write allowlist in this tree',
		);
	});

	test('(12) regen writes the live counts and yields a clean check', () => {
		const root = plainFixture('raw-write-regen-');
		write(root, 'src/a.ts', srcWithRawRenames(2));
		write(root, 'src/b.ts', srcWithRawRenames(1));
		write(root, 'tests/unit/db-handle.test.ts', dbTestWithRawRm(3));
		const result = regenRawWriteAllowlist(root);
		expect(result.srcEntries).toBe(2);
		expect(result.testsEntries).toBe(1);
		const written = fs.readFileSync(
			path.join(root, ...ALLOWLIST_REL.split('/')),
			'utf-8',
		);
		expect(written).toContain('src/a.ts: 2');
		expect(written).toContain('src/b.ts: 1');
		expect(written).toContain('tests/unit/db-handle.test.ts: 3');
		// The regenerated freeze must satisfy the check on its own tree.
		return checkRawWriteRatchet(root).then((check) => {
			expect(check.violations).toBe(0);
		});
	});
});

describe('Check 10 raw-write ratchet — growth vs git base', () => {
	test('(4) growth new-path without marker violates', async () => {
		const root = await gitBaseFixture(
			'raw-write-grow-new-',
			[{ rel: 'src/old.ts', content: srcWithRawRenames(1) }],
			'src/old.ts: 1\n',
		);
		write(root, 'src/new.ts', srcWithRawRenames(1));
		write(root, ALLOWLIST_REL, 'src/old.ts: 1\nsrc/new.ts: 1\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain(
			"ERROR (ratchet): raw-write quota growth 'src/new.ts: 0 -> 1' without approval.",
		);
	});

	test('(5) growth count-increase on an existing path without marker violates', async () => {
		const root = await gitBaseFixture(
			'raw-write-grow-count-',
			[{ rel: 'src/a.ts', content: srcWithRawRenames(1) }],
			'src/a.ts: 1\n',
		);
		write(root, 'src/a.ts', srcWithRawRenames(2));
		write(root, ALLOWLIST_REL, 'src/a.ts: 2\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain(
			"ERROR (ratchet): raw-write quota growth 'src/a.ts: 1 -> 2' without approval.",
		);
		expect(result.messages.join('\n')).toContain(
			'       Add a standalone marker line:  # APPROVED-NEW: src/a.ts: 2',
		);
	});

	test('(6) growth WITH a matching APPROVED-NEW marker is clean', async () => {
		const root = await gitBaseFixture(
			'raw-write-grow-marker-',
			[{ rel: 'src/a.ts', content: srcWithRawRenames(1) }],
			'src/a.ts: 1\n',
		);
		write(root, 'src/a.ts', srcWithRawRenames(2));
		write(root, ALLOWLIST_REL, '# APPROVED-NEW: src/a.ts: 2\nsrc/a.ts: 2\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(0);
		expect(result.messages.join('\n')).toContain(
			'Grown in this PR: 1 | Approved-new markers found: 1 | Unapproved: 0',
		);
	});

	test('(7) bootstrap (base has no allowlist file) is introduction mode — clean', async () => {
		const root = await gitBaseFixture(
			'raw-write-bootstrap-',
			[{ rel: 'src/a.ts', content: srcWithRawRenames(1) }],
			null, // base commit has NO allowlist at all
		);
		write(root, ALLOWLIST_REL, 'src/a.ts: 1\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(0);
		expect(result.messages.join('\n')).toContain(
			'NOTE: base origin/main has no raw-write allowlist — introduction mode (no growth markers required).',
		);
	});

	test('(8) shrink (count decreased) is clean', async () => {
		const root = await gitBaseFixture(
			'raw-write-shrink-',
			[{ rel: 'src/a.ts', content: srcWithRawRenames(2) }],
			'src/a.ts: 2\n',
		);
		write(root, 'src/a.ts', srcWithRawRenames(1));
		write(root, ALLOWLIST_REL, 'src/a.ts: 1\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(0);
	});

	test('(9) shrink-to-zero (entry removed) is clean', async () => {
		const root = await gitBaseFixture(
			'raw-write-shrink-zero-',
			[
				{ rel: 'src/a.ts', content: srcWithRawRenames(1) },
				{ rel: 'src/b.ts', content: srcWithRawRenames(1) },
			],
			'src/a.ts: 1\nsrc/b.ts: 1\n',
		);
		fs.rmSync(path.join(root, 'src', 'b.ts'));
		write(root, ALLOWLIST_REL, 'src/a.ts: 1\n');
		const result = await checkRawWriteRatchet(root);
		expect(result.violations).toBe(0);
	});

	test('RAW_WRITE_ENFORCE=0 soft-warns growth (non-blocking)', async () => {
		const root = await gitBaseFixture(
			'raw-write-softwarn-',
			[{ rel: 'src/a.ts', content: srcWithRawRenames(1) }],
			'src/a.ts: 1\n',
		);
		write(root, 'src/a.ts', srcWithRawRenames(2));
		write(root, ALLOWLIST_REL, 'src/a.ts: 2\n');
		const previous = process.env.RAW_WRITE_ENFORCE;
		process.env.RAW_WRITE_ENFORCE = '0';
		try {
			const result = await checkRawWriteRatchet(root);
			expect(result.violations).toBe(0);
			expect(result.messages.join('\n')).toContain(
				'RAW_WRITE_ENFORCE is off — soft-warn (non-blocking).',
			);
		} finally {
			if (previous === undefined) {
				delete process.env.RAW_WRITE_ENFORCE;
			} else {
				process.env.RAW_WRITE_ENFORCE = previous;
			}
		}
	});
});

describe('Check 10 raw-write ratchet — pure helpers', () => {
	test('diffAllowlistGrowth flags new paths and count increases; shrinks are clean', () => {
		const base = 'src/a.ts: 2\nsrc/old.ts: 1\n';
		const head = 'src/a.ts: 3\nsrc/new.ts: 1\n';
		expect(diffAllowlistGrowth(base, head)).toEqual([
			{ path: 'src/a.ts', baseCount: 2, headCount: 3 },
			{ path: 'src/new.ts', baseCount: 0, headCount: 1 },
		]);
		// Shrink (2 -> 1) and shrink-to-zero (entry dropped) are both clean.
		expect(diffAllowlistGrowth(base, 'src/a.ts: 1\n')).toEqual([]);
		expect(diffAllowlistGrowth(base, 'src/old.ts: 1\n')).toEqual([]);
		// Unchanged is clean.
		expect(diffAllowlistGrowth(base, base)).toEqual([]);
	});

	test('parseRawWriteAllowlist separates entries, markers, and malformed lines', () => {
		const parsed = parseRawWriteAllowlist(
			[
				'# header comment',
				'# APPROVED-NEW: src/a.ts: 4',
				'src/a.ts: 4',
				'src/b.ts: 1',
				'not-an-entry',
				'',
			].join('\n'),
		);
		expect(parsed.entries.get('src/a.ts')).toBe(4);
		expect(parsed.entries.get('src/b.ts')).toBe(1);
		expect(parsed.approvedMarkers.has('src/a.ts: 4')).toBe(true);
		expect(parsed.malformedLines).toEqual(['not-an-entry']);
	});
});
