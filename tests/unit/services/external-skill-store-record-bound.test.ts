/**
 * Stage B round 6 — store.update({ maxRecordBytes }) enforces the record cap
 * on the ACTUAL merged object immediately before the atomic write (PR #3942
 * feedback).
 *
 * Promote measures the post-update record pre-write, but update() re-reads
 * the candidate and applies the patch to the NEWER object — a concurrent
 * mutation between promote's read and the store's read can push the PERSISTED
 * record over PROMOTION_RECORD_MAX_BYTES. The bound must therefore also hold
 * inside update(), against the real merge, refusing to write when exceeded.
 *
 * Callers that omit the option must behave byte-for-byte as before.
 *
 * Note: the error class is asserted via `.name`/message (not an instanceof
 * import) so this file links and fails for the RIGHT reason against pre-fix
 * code (no enforcement → no throw).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import {
	applyCandidatePatch,
	createExternalSkillStore,
} from '../../../src/services/external-skill-store.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function createStore(directory: string) {
	return createExternalSkillStore(directory, { max_candidates: 500 });
}

async function seedCandidate(directory: string): Promise<string> {
	const store = createStore(directory);
	const added = await store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'record-bound-publisher',
		sha256: 'a'.repeat(64),
		fetched_at: '2026-01-15T12:00:00.000Z',
		skill_name: 'record-bound-skill',
		skill_body: 'Safe skill body with no dangerous patterns.',
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [],
	});
	return added.id;
}

function recordFile(directory: string, id: string): string {
	return path.join(directory, '.swarm', 'skills', 'candidates', `${id}.json`);
}

describe('external-skill-store — update maxRecordBytes bound (Stage B round 6)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-store-bound-');
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('over-bound merged record throws a typed error and leaves the file unchanged', async () => {
		const id = await seedCandidate(projectDir);
		const store = createStore(projectDir);
		const before = fs.readFileSync(recordFile(projectDir, id), 'utf-8');

		const patch = {
			evaluation_verdict: 'promoted' as const,
			evaluation_history: [
				{
					verdict: 'promoted' as const,
					timestamp: '2026-06-09T12:00:00.000Z',
					actor: 'user',
					reason: 'x '.repeat(2_000),
				},
			],
		};
		const existing = await store.get(id);
		const mergedBytes = Buffer.byteLength(
			JSON.stringify(
				applyCandidatePatch(
					existing as ExternalSkillCandidate,
					patch,
					'2026-01-01T00:00:00.000Z',
				),
				null,
				'\t',
			),
			'utf8',
		);
		const cap = mergedBytes - 1; // exactly one byte over

		let threw: unknown;
		try {
			await store.update(id, patch, { maxRecordBytes: cap });
		} catch (err) {
			threw = err;
		}

		expect(
			threw,
			'update must refuse to write an over-bound merge',
		).toBeInstanceOf(Error);
		const named = threw as { name?: string; message?: string };
		expect(named.name).toBe('RecordTooLargeError');
		expect(named.message).toContain(`${mergedBytes}`);
		expect(named.message).toContain(`${cap}`);
		// File bytes on disk UNCHANGED — the refusal happens before the write.
		expect(fs.readFileSync(recordFile(projectDir, id), 'utf-8')).toBe(before);
	});

	test('at-bound merged record (exactly maxRecordBytes) writes normally', async () => {
		const id = await seedCandidate(projectDir);
		const store = createStore(projectDir);

		const patch = {
			evaluation_verdict: 'promoted' as const,
			evaluation_history: [
				{
					verdict: 'promoted' as const,
					timestamp: '2026-06-09T12:00:00.000Z',
					actor: 'user',
					reason: 'at-bound entry',
				},
			],
		};
		const existing = await store.get(id);
		const mergedBytes = Buffer.byteLength(
			JSON.stringify(
				applyCandidatePatch(
					existing as ExternalSkillCandidate,
					patch,
					'2026-01-01T00:00:00.000Z',
				),
				null,
				'\t',
			),
			'utf8',
		);

		const updated = await store.update(id, patch, {
			maxRecordBytes: mergedBytes,
		});
		expect(updated?.evaluation_verdict).toBe('promoted');
		const onDisk = fs.readFileSync(recordFile(projectDir, id), 'utf-8');
		expect(onDisk).toContain('at-bound entry');
		expect(Buffer.byteLength(onDisk, 'utf8')).toBe(mergedBytes);
	});

	test('option omitted — behavior unchanged: an over-bound merge still writes', async () => {
		const id = await seedCandidate(projectDir);
		const store = createStore(projectDir);

		const patch = {
			evaluation_verdict: 'promoted' as const,
			evaluation_history: [
				{
					verdict: 'promoted' as const,
					timestamp: '2026-06-09T12:00:00.000Z',
					actor: 'user',
					reason: 'x '.repeat(2_000),
				},
			],
		};

		const updated = await store.update(id, patch);
		expect(updated?.evaluation_verdict).toBe('promoted');
		expect(fs.readFileSync(recordFile(projectDir, id), 'utf-8')).toContain(
			'promoted',
		);
	});
});
