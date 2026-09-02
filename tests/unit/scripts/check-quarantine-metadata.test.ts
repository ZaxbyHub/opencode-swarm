/**
 * Fast pure-function coverage for `checkQuarantineMetadata` (check:invariants
 * Check 7, issue #2477) — runs against temp fixture trees instead of spawning
 * the full invariant script (which walks the whole repo).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkQuarantineMetadata } from '../../../scripts/check-invariants';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

function makeRepo(): string {
	const repoDir = canonicalMkdtemp('quarantine-metadata-2477-');
	for (const sub of [
		'scripts/ci/quarantined-tests.txt',
		'scripts/ci/quarantined-tests-windows.txt',
		'scripts/ci/quarantined-tests-macos.txt',
		'scripts/ci/quarantined-integration-tests.txt',
	]) {
		const full = path.join(repoDir, ...sub.split('/'));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, '# header comment\n', 'utf-8');
	}
	tempRoots.push(repoDir);
	return repoDir;
}

function writeList(repoDir: string, name: string, content: string): void {
	fs.writeFileSync(path.join(repoDir, 'scripts', 'ci', name), content, 'utf-8');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

// Date.UTC (not the new Date(string) form): the check:test-clock gate
// blocks added raw-clock lines in test files, and a fixed UTC instant is
// exactly what these fixture assertions need.
const NOW = new Date(Date.UTC(2026, 8, 1));

describe('checkQuarantineMetadata — Check 7 (issue #2477)', () => {
	test('empty lists (headers only) pass', () => {
		const repo = makeRepo();
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(0);
		expect(result.messages).toContain(
			'All active quarantine entries carry OWNER + EXPIRY metadata.',
		);
	});

	test('entry with OWNER + future EXPIRY passes', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests-windows.txt',
			[
				'# context comment',
				'# OWNER: @someone — issue #1',
				'# EXPIRY: 2026-10-15 — retire after green streak',
				'tests/unit/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(0);
	});

	test('entry missing OWNER fails', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests.txt',
			[
				'# EXPIRY: 2026-10-15 — retire after green streak',
				'tests/unit/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain("has no '# OWNER:' line");
	});

	test('entry missing EXPIRY fails', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests.txt',
			['# OWNER: @someone — issue #1', 'tests/unit/example.test.ts'].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain("has no '# EXPIRY:' line");
	});

	test('malformed EXPIRY (not YYYY-MM-DD) fails', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests-macos.txt',
			[
				'# OWNER: @someone — issue #1',
				'# EXPIRY: October 15 — retire',
				'tests/unit/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain('malformed');
	});

	test('EXPIRY inside the 14-day grace window warns but does not fail', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests.txt',
			[
				'# OWNER: @someone — issue #1',
				'# EXPIRY: 2026-08-25 — retire after green streak',
				'tests/unit/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(0);
		expect(result.messages.join('\n')).toContain('WARNING');
		expect(result.messages.join('\n')).toContain('inside the grace window');
	});

	test('EXPIRY beyond the grace window fails', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-integration-tests.txt',
			[
				'# OWNER: @someone — issue #1',
				'# EXPIRY: 2026-08-01 — retire after green streak',
				'tests/integration/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain('beyond the');
		expect(result.messages.join('\n')).toContain('grace window');
	});

	test('metadata separated from the path by a blank line does not count', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests.txt',
			[
				'# OWNER: @someone — issue #1',
				'# EXPIRY: 2026-10-15 — retire after green streak',
				'',
				'tests/unit/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(2);
	});

	test('a missing list file is a violation', () => {
		const repo = makeRepo();
		fs.rmSync(path.join(repo, 'scripts', 'ci', 'quarantined-tests.txt'));
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain('not found');
	});

	// CRLF endings (review F-006/CAND-06): Windows contributors can commit
	// \r\n list files; the parser splits on /\r?\n/ and trims, so entries
	// must still validate.
	test('CRLF line endings parse identically', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests-windows.txt',
			[
				'# context comment',
				'# OWNER: @someone — issue #1',
				'# EXPIRY: 2026-10-15 — retire after green streak',
				'tests/unit/example.test.ts',
			].join('\r\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(0);
	});

	// Multiple entries per list (review F-006/CAND-07): each entry's walk
	// must stop at the blank line between blocks, so a metadata-complete
	// first entry cannot satisfy a metadata-missing second one.
	test('multiple entries are validated independently', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests.txt',
			[
				'# OWNER: @someone — issue #1',
				'# EXPIRY: 2026-10-15 — retire after green streak',
				'tests/unit/first.test.ts',
				'',
				'# context for the second entry',
				'tests/unit/second.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(2);
		const joined = result.messages.join('\n');
		expect(joined).toContain('second.test.ts');
		expect(joined).not.toContain('first.test.ts');
	});

	// A malformed EXPIRY line next to a valid one must surface as a warning
	// instead of vanishing (review F-006/api-001).
	test('malformed EXPIRY next to a valid one warns without failing', () => {
		const repo = makeRepo();
		writeList(
			repo,
			'quarantined-tests.txt',
			[
				'# OWNER: @someone — issue #1',
				'# EXPIRY: October 15 — malformed',
				'# EXPIRY: 2026-10-15 — valid, wins',
				'tests/unit/example.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(0);
		const joined = result.messages.join('\n');
		expect(joined).toContain('WARNING');
		expect(joined).toContain('ignored in favor of');
	});
});
