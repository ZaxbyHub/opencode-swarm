/**
 * Issue #2302 — captureOrMergeBaseline absorption-gate semantics.
 *
 * Merge tests that changed meaning under the #2302 gate (moved here from
 * sast-baseline.test.ts so the over-cap legacy file does not grow — FR-006):
 * a finding matching neither the exact fingerprints nor the reflow identities
 * of the prior baseline is a NOVEL ABSORPTION and requires an explicit
 * refreshRationale — for already-indexed AND first-time-indexed files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	captureOrMergeBaseline,
	loadBaseline,
} from '../../../src/tools/sast-baseline';
import type { SastScanFinding } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeFinding(
	file: string,
	line: number,
	ruleId = 'sast/js-eval',
): SastScanFinding {
	return {
		rule_id: ruleId,
		severity: 'high',
		message: 'Test finding',
		location: { file, line },
	};
}

let tempDir = '';

beforeEach(() => {
	tempDir = canonicalMkdtemp('sast-absorption-2302-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('captureOrMergeBaseline absorption gate (#2302)', () => {
	it('changed content is a novel absorption: blocked bare, merged with audited rationale', async () => {
		const file = path.join(tempDir, 'changing.js');
		fs.writeFileSync(file, 'eval(old);');
		const findingV1 = makeFinding(file, 1);

		const r1 = await captureOrMergeBaseline(tempDir, 1, [findingV1], 'tier_a', [
			file,
		]);
		expect(r1.status).toBe('written');

		// Load baseline v1 — record original fingerprints
		const loadedV1 = loadBaseline(tempDir, 1);
		expect(loadedV1.status).toBe('found');
		const fpsV1 =
			loadedV1.status === 'found' ? Array.from(loadedV1.fingerprints) : [];

		// Change content and re-capture. The changed line content means the
		// finding matches neither the exact fingerprint nor the reflow key of
		// the prior entry — a novel absorption, which #2302 gates behind an
		// explicit audited rationale.
		fs.writeFileSync(file, 'eval(new_value);');
		const findingV2 = makeFinding(file, 1);

		const rBare = await captureOrMergeBaseline(
			tempDir,
			1,
			[findingV2],
			'tier_a',
			[file],
		);
		expect(rBare.status).toBe('absorption_blocked');
		if (rBare.status === 'absorption_blocked') {
			expect(rBare.blocked.length).toBe(1);
			expect(rBare.blocked[0]?.rule_id).toBe('sast/js-eval');
			expect(rBare.message).toContain('baseline_refresh_rationale');
		}

		// Baseline is untouched by the blocked capture.
		const loadedBlocked = loadBaseline(tempDir, 1);
		expect(loadedBlocked.status).toBe('found');
		if (loadedBlocked.status === 'found') {
			expect(Array.from(loadedBlocked.fingerprints)).toEqual(fpsV1);
		}

		// With a rationale the absorption is audited and proceeds.
		const r2 = await captureOrMergeBaseline(
			tempDir,
			1,
			[findingV2],
			'tier_a',
			[file],
			{
				refreshRationale: 'finding verified pre-existing (content rename)',
				actor: 'session-test-1',
			},
		);
		expect(r2.status).toBe('merged');
		if (r2.status === 'merged') {
			expect(r2.absorbed_finding_count).toBe(1);
		}

		const loadedV2 = loadBaseline(tempDir, 1);
		expect(loadedV2.status).toBe('found');
		if (loadedV2.status === 'found') {
			const fpsV2 = Array.from(loadedV2.fingerprints);

			// Old fingerprint must not appear in new baseline
			for (const oldFp of fpsV1) {
				expect(fpsV2).not.toContain(oldFp);
			}

			// The absorption is recorded with who/when/rationale.
			expect(loadedV2.bundle.triage_log?.length).toBe(1);
			const entry = loadedV2.bundle.triage_log?.[0];
			expect(entry?.rationale).toBe(
				'finding verified pre-existing (content rename)',
			);
			expect(entry?.actor).toBe('session-test-1');
			expect(entry?.absorbed_at).toBeTruthy();
			expect(fpsV2).toContain(entry?.fingerprint);
		}
	});

	it('incremental merge of disjoint file sets — new-file absorption is gated and audited', async () => {
		const fileA = path.join(tempDir, 'a.js');
		const fileB = path.join(tempDir, 'b.js');
		fs.writeFileSync(fileA, 'eval(a);');
		fs.writeFileSync(fileB, 'eval(b);');

		// First capture: file A only
		await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(fileA, 1)],
			'tier_a',
			[fileA],
		);

		// Second capture: file B only. File B is new to the baseline, but a
		// novel finding is a novel absorption regardless of file indexedness
		// (#2302 final-critic revision: the tool cannot tell a pre-delegation
		// capture from a failure-response recapture) — bare capture BLOCKS.
		const rBare = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(fileB, 1)],
			'tier_a',
			[fileB],
		);
		expect(rBare.status).toBe('absorption_blocked');

		const r2 = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(fileB, 1)],
			'tier_a',
			[fileB],
			{
				refreshRationale:
					'pre-delegation capture; finding verified pre-existing',
				actor: 'session-task2',
			},
		);
		expect(r2.status).toBe('merged');
		if (r2.status === 'merged') {
			expect(r2.absorbed_finding_count).toBe(1);
		}

		// Both should be indexed
		const loaded = loadBaseline(tempDir, 1);
		expect(loaded.status).toBe('found');
		if (loaded.status === 'found') {
			const relA = path.relative(tempDir, fileA).replace(/\\/g, '/');
			const relB = path.relative(tempDir, fileB).replace(/\\/g, '/');
			expect(loaded.bundle.files_indexed).toContain(relA);
			expect(loaded.bundle.files_indexed).toContain(relB);
			expect(loaded.fingerprints.size).toBe(2);

			const entry = loaded.bundle.triage_log?.[0];
			expect(entry?.rel_file).toBe(relB);
			expect(entry?.rationale).toBe(
				'pre-delegation capture; finding verified pre-existing',
			);
			expect(entry?.actor).toBe('session-task2');
			expect(entry?.absorbed_at).toBeTruthy();
		}
	});

	it('full prune on re-capture with new findings proceeds under an audited rationale', async () => {
		const fileA = path.join(tempDir, 'prune.js');
		fs.writeFileSync(fileA, 'eval(original);');

		// First capture
		const r1 = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(fileA, 1)],
			'tier_a',
			[fileA],
		);
		expect(r1.status).toBe('written');

		const loadedV1 = loadBaseline(tempDir, 1);
		expect(loadedV1.status).toBe('found');
		const originalFps =
			loadedV1.status === 'found' ? Array.from(loadedV1.fingerprints) : [];
		expect(originalFps.length).toBeGreaterThan(0);

		// Change file content and re-capture with a different finding. The
		// new rule's finding is novel, so the bare capture is blocked (#2302)
		// and only an audited refresh proceeds — prune semantics unchanged.
		fs.writeFileSync(fileA, 'eval(updated_content);');
		const rBare = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(fileA, 1, 'sast/js-dangerous-function')],
			'tier_a',
			[fileA],
		);
		expect(rBare.status).toBe('absorption_blocked');

		const r2 = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(fileA, 1, 'sast/js-dangerous-function')],
			'tier_a',
			[fileA],
			{ refreshRationale: 'audited refresh: rule changed', actor: 's2' },
		);
		expect(r2.status).toBe('merged');

		const loadedV2 = loadBaseline(tempDir, 1);
		expect(loadedV2.status).toBe('found');
		if (loadedV2.status === 'found') {
			for (const oldFp of originalFps) {
				expect(loadedV2.fingerprints.has(oldFp)).toBe(false);
			}
			// The new finding's absorption is recorded.
			expect(loadedV2.bundle.triage_log?.length).toBe(1);
			expect(loadedV2.bundle.triage_log?.[0]?.rationale).toBe(
				'audited refresh: rule changed',
			);
		}
	});
});
