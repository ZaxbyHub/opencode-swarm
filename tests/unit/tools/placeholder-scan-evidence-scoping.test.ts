/**
 * Placeholder_scan evidence scoping metadata (PR #2457 review follow-up, F-2).
 *
 * An added_lines-filtered run suppresses pre-existing-line findings by design,
 * so the persisted evidence must disclose that a scoping map was in force.
 * These tests observe the saveEvidence payload through the `_internals` DI seam
 * (AGENTS.md invariant 7 — DI over `mock.module`) and assert bounded scoping
 * metadata: present only when a map was supplied, never the map itself.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceVerdict } from '../../../src/config/evidence-schema';
import { placeholderScan } from '../../../src/tools/placeholder-scan';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

interface CapturedPayload {
	verdict: EvidenceVerdict;
	findings_count: number;
	diff_scoped?: boolean;
	added_lines_files?: number;
	added_lines_total?: number;
}

let tmpRoot: string | undefined;
const captured: CapturedPayload[] = [];
const realSaveEvidence = (await import('../../../src/evidence/manager'))
	.saveEvidence;

afterEach(() => {
	captured.length = 0;
});

afterAll(() => {
	if (tmpRoot) safeRmRecursive(tmpRoot);
});

function setupProject(): string {
	tmpRoot = canonicalMkdtemp('placeholder-evidence-scoping-');
	// Explicit .git boundary: evidence writers require a clear project root
	// (issue #2384 fixture lesson).
	fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true });
	fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmpRoot, 'src', 'thing.ts'),
		[
			'export const a = 1;',
			'// TODO: pre-existing debt',
			'// TODO: newly added',
			'',
		].join('\n'),
	);
	return tmpRoot;
}

describe('placeholder_scan evidence scoping metadata', () => {
	it('records diff_scoped counts when an added_lines map is supplied', async () => {
		const root = setupProject();
		const seam = (await import('../../../src/tools/placeholder-scan'))
			._internals;
		seam.saveEvidence = async (_directory, _task, payload) => {
			captured.push(payload as CapturedPayload);
		};
		try {
			const result = await placeholderScan(
				{
					changed_files: [path.join(root, 'src', 'thing.ts')],
					added_lines: { 'src/thing.ts': [3] },
				},
				root,
			);
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].excerpt).toContain('newly added');
			expect(captured).toHaveLength(1);
			expect(captured[0].diff_scoped).toBe(true);
			expect(captured[0].added_lines_files).toBe(1);
			expect(captured[0].added_lines_total).toBe(1);
		} finally {
			seam.saveEvidence = realSaveEvidence;
		}
	});

	it('counts Set-valued added_lines identically to arrays (direct-API path)', async () => {
		// The zod tool boundary only admits arrays, but the direct placeholderScan
		// API accepts `Set<number>` — the counting code branches on
		// `instanceof Set ? size : length`, so pin both halves (review C2).
		const root = setupProject();
		const seam = (await import('../../../src/tools/placeholder-scan'))
			._internals;
		seam.saveEvidence = async (_directory, _task, payload) => {
			captured.push(payload as CapturedPayload);
		};
		try {
			const result = await placeholderScan(
				{
					changed_files: [path.join(root, 'src', 'thing.ts')],
					added_lines: { 'src/thing.ts': new Set([3]) },
				},
				root,
			);
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(captured).toHaveLength(1);
			expect(captured[0].diff_scoped).toBe(true);
			expect(captured[0].added_lines_files).toBe(1);
			expect(captured[0].added_lines_total).toBe(1);
		} finally {
			seam.saveEvidence = realSaveEvidence;
		}
	});

	it('omits the scoping metadata entirely for an unfiltered run', async () => {
		const root = setupProject();
		const seam = (await import('../../../src/tools/placeholder-scan'))
			._internals;
		seam.saveEvidence = async (_directory, _task, payload) => {
			captured.push(payload as CapturedPayload);
		};
		try {
			const result = await placeholderScan(
				{ changed_files: [path.join(root, 'src', 'thing.ts')] },
				root,
			);
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(2);
			expect(captured).toHaveLength(1);
			expect(captured[0].diff_scoped).toBeUndefined();
			expect(captured[0].added_lines_files).toBeUndefined();
			expect(captured[0].added_lines_total).toBeUndefined();
		} finally {
			seam.saveEvidence = realSaveEvidence;
		}
	});
});
