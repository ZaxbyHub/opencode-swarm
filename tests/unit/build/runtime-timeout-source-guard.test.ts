import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const SRC = path.join(ROOT, 'src');

const REQUIRED_CONSUMERS = [
	'src/hooks/micro-reflector.ts',
	'src/hooks/knowledge-curator.ts',
	'src/services/skill-generator.ts',
	'src/tools/external-skill-discover.ts',
] as const;

function runtimeSourceFiles(): string[] {
	return (readdirSync(SRC, { recursive: true }) as string[])
		.filter((entry) => entry.endsWith('.ts'))
		.filter((entry) => !entry.endsWith('.test.ts'))
		.filter((entry) => !entry.includes(`${path.sep}__tests__${path.sep}`))
		.map((entry) => path.join(SRC, entry));
}

describe('runtime timeout source guard (#1964/#2103)', () => {
	test('forbids runtime AbortSignal timeout construction', () => {
		const offenders = runtimeSourceFiles()
			.filter((file) =>
				readFileSync(file, 'utf8').includes('AbortSignal.timeout('),
			)
			.map((file) => path.relative(ROOT, file));
		expect(offenders).toEqual([]);
	});

	test('keeps every reported consumer on the shared cancellable helper', () => {
		for (const relative of REQUIRED_CONSUMERS) {
			const source = readFileSync(path.join(ROOT, relative), 'utf8');
			expect(source).toContain('withTimeoutSignal');
		}
	});
});
