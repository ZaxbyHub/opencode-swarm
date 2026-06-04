import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

describe('repo graph startup ordering', () => {
	test('initTelemetry is called before repoGraphHook.init is queued', () => {
		const indexPath = path.resolve(__dirname, '../../../src/index.ts');
		const sourceCode = readFileSync(indexPath, 'utf-8');

		const initTelemetryLine = sourceCode.indexOf(
			'initTelemetry(ctx.directory);',
		);
		const queueLine = sourceCode.indexOf('queueMicrotask(() => {');
		const initCallMatch = sourceCode.match(/repoGraphHook\s*\n\s*\.init\(\)/);
		const initCallLine = initCallMatch ? (initCallMatch.index ?? -1) : -1;

		expect(initTelemetryLine).toBeGreaterThanOrEqual(0);
		expect(queueLine).toBeGreaterThanOrEqual(0);
		expect(initCallLine).toBeGreaterThanOrEqual(0);
		expect(initTelemetryLine).toBeLessThan(queueLine);
		expect(initTelemetryLine).toBeLessThan(initCallLine);
	});
});
