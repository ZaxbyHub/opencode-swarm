/**
 * Evidence-bundle byte-aware compaction with archive
 * (src/evidence/manager.ts, the 2026-11-27 task-2.18 wedge).
 *
 * The entry-count cap (100) cannot bound a bundle whose entries are large:
 * the sast_scan pseudo-task bundle carries full findings lists, so 100
 * entries ran to ~528KB against the 512000-byte cap and every further
 * append threw — each gate run's evidence save failed (SAST verdict fail at
 * 0 findings) and Stage A wedged. These tests pin the healed contract:
 * an oversized append archives its oldest entries (nothing lost, archive
 * written BEFORE the compacted bundle) and succeeds; a single entry over
 * the cap still fails honestly; an archive failure aborts with the bundle
 * untouched; the archive rotates at its bound.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema';
import { EVIDENCE_MAX_JSON_BYTES } from '../../../src/config/evidence-schema';
import {
	_internals,
	loadEvidence,
	saveEvidence,
} from '../../../src/evidence/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK = 'sast_scan';

function makeSastEntry(seed: string, sizeBytes: number): Evidence {
	return {
		type: 'sast',
		task_id: TASK,
		timestamp: `2026-11-27T00:${seed}:00.000Z`,
		agent: 'sast_scanner',
		verdict: 'pass',
		summary: `${seed}-${'f'.repeat(Math.max(0, sizeBytes))}`,
		findings: [],
		engine: 'tier_a',
		files_scanned: 0,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	} as unknown as Evidence;
}

let directory: string;
const realInternals = { ..._internals };

beforeEach(() => {
	directory = canonicalMkdtemp('swarm-evidence-compact-');
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

function archivePath(): string {
	return path.join(
		directory,
		'.swarm',
		'evidence',
		TASK,
		'evidence-archive.jsonl',
	);
}

function bundlePath(): string {
	return path.join(directory, '.swarm', 'evidence', TASK, 'evidence.json');
}

describe('saveEvidence — byte-aware compaction with archive', () => {
	test('an oversized append archives oldest entries and succeeds', async () => {
		// 3 entries a ~200KB each: any two fit, all three never.
		const entrySize = 200_000;
		await saveEvidence(directory, TASK, makeSastEntry('01', entrySize));
		await saveEvidence(directory, TASK, makeSastEntry('02', entrySize));
		expect(fs.existsSync(archivePath())).toBe(false);

		const result = await saveEvidence(
			directory,
			TASK,
			makeSastEntry('03', entrySize),
		);

		// The newest two survive in the bundle; the oldest was archived.
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].summary.startsWith('02-')).toBe(true);
		expect(result.entries[1].summary.startsWith('03-')).toBe(true);
		const onDisk = JSON.parse(fs.readFileSync(bundlePath(), 'utf8'));
		expect(onDisk.entries).toHaveLength(2);
		expect(JSON.stringify(onDisk).length).toBeLessThanOrEqual(
			EVIDENCE_MAX_JSON_BYTES,
		);
		// The archive holds exactly the dropped entry, nothing lost.
		const archived = fs.readFileSync(archivePath(), 'utf8').trim().split('\n');
		expect(archived).toHaveLength(1);
		expect(JSON.parse(archived[0]).summary.startsWith('01-')).toBe(true);
	});

	test('a single entry that alone exceeds the cap still throws honestly', async () => {
		await expect(
			saveEvidence(directory, TASK, makeSastEntry('59', 600_000)),
		).rejects.toThrow('exceeds maximum');
		// Nothing was archived and no bundle was written.
		expect(fs.existsSync(archivePath())).toBe(false);
		expect(fs.existsSync(bundlePath())).toBe(false);
	});

	test('an archive failure aborts the save with the bundle untouched', async () => {
		await saveEvidence(directory, TASK, makeSastEntry('01', 200_000));
		await saveEvidence(directory, TASK, makeSastEntry('02', 200_000));
		const before = fs.readFileSync(bundlePath(), 'utf8');
		_internals.appendArchive = (async (): Promise<void> => {
			throw new Error('archive disk full');
		}) as typeof _internals.appendArchive;

		await expect(
			saveEvidence(directory, TASK, makeSastEntry('03', 200_000)),
		).rejects.toThrow('archive disk full');
		// Fail-closed: the bundle still holds BOTH old entries — compaction
		// never persisted a drop the archive did not take.
		expect(fs.readFileSync(bundlePath(), 'utf8')).toBe(before);
	});

	test('the archive rotates at its bound and keeps bounded generations', async () => {
		// Shrink the rotation bound via the seam so the test needs no 5MB.
		_internals.archiveMaxBytes = 64;
		let appended = '';
		_internals.appendArchive = (async (
			file: string,
			text: string,
		): Promise<void> => {
			appended = text;
			fs.appendFileSync(file, text, 'utf8');
		}) as typeof _internals.appendArchive;

		// First compaction: archive created with entry 01.
		await saveEvidence(directory, TASK, makeSastEntry('01', 200_000));
		await saveEvidence(directory, TASK, makeSastEntry('02', 200_000));
		await saveEvidence(directory, TASK, makeSastEntry('03', 200_000));
		expect(fs.existsSync(archivePath())).toBe(true);

		// Force the archive past the (shrunken) bound, then compact again —
		// the oversized archive rotates into a timestamped generation.
		fs.appendFileSync(archivePath(), 'x'.repeat(128) + '\n');
		await saveEvidence(directory, TASK, makeSastEntry('04', 200_000));
		const dirEntries = fs.readdirSync(
			path.join(directory, '.swarm', 'evidence', TASK),
		);
		const rotated = dirEntries.filter(
			(f) => f.startsWith('evidence-archive-') && f.endsWith('.jsonl'),
		);
		expect(rotated.length).toBe(1);
		expect(fs.existsSync(archivePath())).toBe(true);
		// The active archive holds the newest drop (02).
		expect(appended.includes('02-')).toBe(true);
	});

	test('loads still work after compaction (last-entry semantics intact)', async () => {
		await saveEvidence(directory, TASK, makeSastEntry('01', 200_000));
		await saveEvidence(directory, TASK, makeSastEntry('02', 200_000));
		await saveEvidence(directory, TASK, makeSastEntry('03', 200_000));
		const loaded = await loadEvidence(directory, TASK);
		expect(loaded.status).toBe('found');
		if (loaded.status !== 'found') return;
		expect(loaded.bundle.entries).toHaveLength(2);
		const last = loaded.bundle.entries[loaded.bundle.entries.length - 1];
		expect((last as { summary: string }).summary.startsWith('03-')).toBe(true);
	});
});
