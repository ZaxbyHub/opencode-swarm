import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMutationGateAdapter } from '../../../src/evaluation/gate-audit.js';

const packageRoot = path.resolve(import.meta.dir, '../../..');
const canonicalMutations = [
	'mutation-off-by-one',
	'null-substitution',
	'operator-swap',
	'guard-removal',
	'branch-swap',
	'side-effect-deletion',
] as const;

function tempFixture(source?: string): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mutation-')),
	);
	if (source) {
		fs.writeFileSync(path.join(root, 'baseline.ts'), source);
		fs.writeFileSync(
			path.join(root, 'defect.ts'),
			source.replace('return 1', 'return 2'),
		);
	}
	return root;
}

describe('gate mutation adapter regression: reviewed defects, not red baselines (P0)', () => {
	test('applies and catches all six canonical real defect classes', async () => {
		for (const mutationType of canonicalMutations) {
			const root = tempFixture();
			try {
				fs.cpSync(
					path.join(
						packageRoot,
						'evaluation-fixtures',
						'tier1',
						mutationType,
						'environment',
					),
					root,
					{ recursive: true },
				);
				const result = await runMutationGateAdapter({
					directory: root,
					mutationType,
					timeoutMs: 30_000,
					variant: 'defect',
				});
				expect(result).toEqual({ outcome: 'caught' });
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test('reports survived when a weak suite does not cover the real change', async () => {
		const root = tempFixture('export function value(): number { return 1; }\n');
		try {
			fs.writeFileSync(
				path.join(root, 'defect.test.ts'),
				"import { expect, test } from 'bun:test'; test('weak', () => expect(true).toBe(true));\n",
			);
			const result = await runMutationGateAdapter({
				directory: root,
				mutationType: 'operator-swap',
				timeoutMs: 30_000,
				variant: 'defect',
			});
			expect(result).toEqual({ outcome: 'missed' });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a red baseline is data quality and can never be caught', async () => {
		const root = tempFixture('export function value(): number { return 1; }\n');
		try {
			fs.writeFileSync(
				path.join(root, 'defect.test.ts'),
				"import { expect, test } from 'bun:test'; import { value } from './defect'; test('red', () => expect(value()).toBe(9));\n",
			);
			const result = await runMutationGateAdapter({
				directory: root,
				mutationType: 'operator-swap',
				timeoutMs: 30_000,
				variant: 'defect',
			});
			expect(result).toEqual({
				outcome: 'infrastructure_failure',
				failureCode: 'mutation-red-baseline',
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
