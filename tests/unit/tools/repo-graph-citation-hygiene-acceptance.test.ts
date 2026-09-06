/** Acceptance coverage for issue #2489 / AC5. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../../../');

describe('issue #2489 AC5 — repo-graph citation and test-isolation hygiene', () => {
	test('does not retain the stale repo-graph citation baseline entries', () => {
		const baselinePath = path.join(
			repositoryRoot,
			'scripts',
			'registry-citation-baseline.json',
		);
		const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
			entries?: Array<{ rowId?: string }>;
		};
		expect(
			(baseline.entries ?? []).filter((entry) => entry.rowId === 'repo-graph'),
		).toEqual([]);
	});

	test('close-stage regression coverage uses the scoped DI seam', () => {
		const testPath = path.join(
			repositoryRoot,
			'tests',
			'unit',
			'commands',
			'close-repo-memory-close-throws.test.ts',
		);
		const source = readFileSync(testPath, 'utf8');
		const moduleCall = `${['mock', 'module'].join('.')}(`;
		expect(source).not.toContain(moduleCall);
		expect(source).toContain('closeInternals.closeRepoMemory');
	});
});
