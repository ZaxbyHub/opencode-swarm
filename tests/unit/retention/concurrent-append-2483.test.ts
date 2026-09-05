/**
 * Issue #2483 review round 2: concurrent-append serialization for the
 * jsonl-cap per-file mutex. 200 in-flight appends to the SAME file under a
 * cap of 5 must leave exactly 5 whole records on disk, no torn lines, and no
 * `.tmp-` residue — proving the per-file mutex (and the compact-before-
 * append ordering) serialize real concurrent writers, not just sequential
 * interleaves.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { clearRetentionCapOverrides } from '../../../src/retention/caps.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { appendCappedJsonl, readTailJsonl, _internals } = await import(
	'../../../src/retention/jsonl-cap.js'
);

const tempRoots: string[] = [];

afterEach(() => {
	clearRetentionCapOverrides();
	for (const dir of tempRoots) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('concurrent appends serialize through the per-file mutex (review FB-4)', () => {
	it('200 concurrent appends under cap 5 leave exactly 5 whole records and no temp residue', async () => {
		const root = canonicalMkdtemp('concurrent-2483-');
		tempRoots.push(root);
		const dir = path.join(root, '.swarm');
		const filePath = path.join(dir, 'concurrent.jsonl');

		await Promise.all(
			Array.from({ length: 200 }, (_, i) =>
				appendCappedJsonl(filePath, JSON.stringify({ i }), {
					maxEntries: 5,
				}),
			),
		);

		// Exactly 5 whole records on disk; every line parses; content is a
		// contiguous slice of the appended sequence (no torn or lost lines in
		// the middle).
		const lines = readFileSync(filePath, 'utf-8')
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(5);
		const parsed = lines.map((line) => JSON.parse(line) as { i: number });
		for (let k = 1; k < parsed.length; k++) {
			expect(parsed[k].i).toBe(parsed[k - 1].i + 1);
		}

		// The bounded reader agrees with the raw file, and the mutex chain has
		// fully drained (self-deleting entry).
		expect(await readTailJsonl(filePath, { maxEntries: 10 })).toHaveLength(5);
		expect(_internals.appendChains.size).toBe(0);
		expect(existsSync(dir)).toBe(true);
		expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual(
			[],
		);
	}, 30_000);
});
