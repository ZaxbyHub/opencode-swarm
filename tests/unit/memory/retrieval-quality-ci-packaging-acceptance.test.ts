/** Acceptance coverage for issue #2490 / AC14 packaging and CI wiring. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../../..');
const packageManifest = JSON.parse(
	readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
) as { files?: unknown };
const workflow = readFileSync(
	path.join(repositoryRoot, '.github/workflows/ci.yml'),
	'utf8',
);

describe('issue #2490 AC14 — retrieval-quality package and CI wiring', () => {
	test('ships every held-out corpus path in the package files allowlist', () => {
		expect(Array.isArray(packageManifest.files)).toBe(true);
		const files = packageManifest.files as string[];
		expect(
			files.some((entry) =>
				/^tests\/fixtures\/memory-recall-heldout(?:\/|\/\*\*|$)/.test(entry),
			),
		).toBe(true);
	});

	test('runs retrieval quality from the blocking memory regression job', () => {
		const job = workflow.match(
			/memory-recall-regression:[\s\S]*?(?=\n\s{2}[A-Za-z0-9_-]+:|\s*$)/,
		)?.[0];
		expect(job).toBeDefined();
		expect(job).toContain('bun run check:retrieval-quality');
	});

	test('path-sensitive unit CI promotes relevant changes to the three-OS matrix', () => {
		expect(workflow).toContain(
			'fromJSON(\'["ubuntu-latest","macos-latest","windows-latest"]\')',
		);
		expect(workflow).toContain(
			"needs.detect-paths.outputs.touches-platform-paths == 'true'",
		);
		const pathDetector = workflow.match(
			/git diff --name-only[\s\S]*?echo "touches-platform-paths=false"/,
		)?.[0];
		expect(pathDetector).toBeDefined();
		for (const relevantPath of [
			'src/lang/',
			'src/memory/',
			'src/evaluation/',
			'src/tools/',
			'tests/fixtures/memory-recall-heldout/',
		]) {
			expect(pathDetector, `missing path trigger: ${relevantPath}`).toContain(
				relevantPath,
			);
		}
	});
});
