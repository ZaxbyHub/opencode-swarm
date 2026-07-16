/**
 * #1848 §3: immutable rewrite/merge history tests.
 *
 * Verifies that before/after/reason/evidence survive a rewrite (the only copy
 * of prior lesson text is never overwritten) and that the audit log is
 * bounded (FIFO cap).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	appendRewriteHistory,
	readRewriteHistory,
	resolveRewriteHistoryPath,
} from '../../../src/hooks/knowledge-store.js';
import type { RewriteHistoryRecord } from '../../../src/hooks/knowledge-types.js';

// Track created temp dirs so they can be removed (avoid leaking into tmpdir).
const createdTmpDirs: string[] = [];
afterEach(() => {
	while (createdTmpDirs.length > 0) {
		const dir = createdTmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmpDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'swarm-rwh-')));
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	createdTmpDirs.push(dir);
	return dir;
}

function makeRecord(
	entryId: string,
	before: string,
	after: string,
	beforeRev: number,
	afterRev: number,
): RewriteHistoryRecord {
	return {
		entry_id: entryId,
		before_lesson: before,
		after_lesson: after,
		before_revision: beforeRev,
		after_revision: afterRev,
		actor: 'wt-A',
		reason: 'clarification',
		evidence_refs: ['ev-1'],
		timestamp: '2026-07-15T00:00:00Z',
		action: 'rewrite',
	};
}

describe('appendRewriteHistory + readRewriteHistory', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir();
	});

	it('appends a record and reads it back preserving before/after', async () => {
		const rec = makeRecord(
			'e1',
			'old lesson text here!!',
			'new lesson text here!!',
			1,
			2,
		);
		await appendRewriteHistory(dir, rec);

		const records = await readRewriteHistory(dir);
		expect(records.length).toBe(1);
		expect(records[0].before_lesson).toBe('old lesson text here!!');
		expect(records[0].after_lesson).toBe('new lesson text here!!');
		expect(records[0].reason).toBe('clarification');
		expect(records[0].evidence_refs).toEqual(['ev-1']);
	});

	it('preserves immutable history across multiple rewrites', async () => {
		await appendRewriteHistory(
			dir,
			makeRecord('e1', 'v1 text here!!!!!!!!!', 'v2 text here!!!!!!!!!', 1, 2),
		);
		await appendRewriteHistory(
			dir,
			makeRecord('e1', 'v2 text here!!!!!!!!!', 'v3 text here!!!!!!!!!', 2, 3),
		);

		const records = await readRewriteHistory(dir);
		expect(records.length).toBe(2);
		// The first record's before is still 'v1' (immutable).
		expect(records[0].before_lesson).toBe('v1 text here!!!!!!!!!');
		expect(records[1].before_lesson).toBe('v2 text here!!!!!!!!!');
	});

	it('is FIFO-capped at 2000 records (bounded audit trail)', async () => {
		// Pre-seed the file with 2000 records directly (fast), then append 5
		// more via appendRewriteHistory and verify the cap drops the oldest 5.
		const filePath = resolveRewriteHistoryPath(dir);
		const seed: RewriteHistoryRecord[] = Array.from({ length: 2000 }, (_, i) =>
			makeRecord(
				`seed-${i}`,
				`before-${i}!!!!!!!!!`,
				`after-${i}!!!!!!!!!!`,
				i,
				i + 1,
			),
		);
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(
			filePath,
			seed.map((r) => JSON.stringify(r)).join('\n') + '\n',
		);

		// Append 5 more — this triggers the FIFO cap.
		for (let i = 0; i < 5; i++) {
			await appendRewriteHistory(
				dir,
				makeRecord(
					`new-${i}`,
					`before-new-${i}!!!!`,
					`after-new-${i}!!!!!`,
					i,
					i + 1,
				),
			);
		}
		const records = await readRewriteHistory(dir);
		expect(records.length).toBe(2000);
		// Oldest 5 seed records dropped (FIFO); the 5 new records present.
		expect(records[0].entry_id).toBe('seed-5');
		expect(records.some((r) => r.entry_id === 'new-4')).toBe(true);
	});

	it('resolveRewriteHistoryPath is link-aware (cohort-scoped)', () => {
		const resolved = resolveRewriteHistoryPath(dir);
		expect(resolved).toContain('knowledge-rewrites.jsonl');
	});
});
