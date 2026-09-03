import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEnforce, parseArgs } from '../../../scripts/drift-check';

const repoRoot = resolve(import.meta.dir, '../../..');

describe('drift-check authoritative enforcement — issue #2479', () => {
	test('explicit --enforce is independent of the environment', () => {
		expect(parseArgs(['--enforce', '--no-report']).enforce).toBe(true);
		expect(isEnforce(true)).toBe(true);
	});

	test('CI and the local pre-push aggregate both select hard enforcement', () => {
		const workflow = readFileSync(
			resolve(repoRoot, '.github/workflows/drift-check.yml'),
			'utf-8',
		);
		const packageJson = JSON.parse(
			readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
		) as { scripts: Record<string, string> };
		expect(workflow).toContain(
			'bun run scripts/drift-check.ts --enforce --report drift-report.md',
		);
		expect(workflow).not.toContain('vars.DRIFT_CHECK_ENFORCE');
		expect(packageJson.scripts['check:pre-push']).toBe(
			'bun run scripts/drift-check.ts --enforce --no-report && bun run check:registry-citations',
		);
	});
});
