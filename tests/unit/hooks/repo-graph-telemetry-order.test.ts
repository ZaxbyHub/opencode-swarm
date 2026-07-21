import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

describe('repo graph startup ordering', () => {
	test('initTelemetry is called before repoGraphHook.init is registered for post-resolution startup', () => {
		const indexPath = path.resolve(__dirname, '../../../src/index.ts');
		const sourceCode = readFileSync(indexPath, 'utf-8');

		const initTelemetryLine = sourceCode.indexOf(
			'initTelemetry(ctx.directory);',
		);
		const registrationLine = sourceCode.indexOf(
			'postResolutionTasks.push(() => {',
			initTelemetryLine,
		);
		const initCallMatch = sourceCode.match(/repoGraphHook\s*\n\s*\.init\(\)/);
		const initCallLine = initCallMatch ? (initCallMatch.index ?? -1) : -1;

		expect(initTelemetryLine).toBeGreaterThanOrEqual(0);
		expect(registrationLine).toBeGreaterThanOrEqual(0);
		expect(initCallLine).toBeGreaterThanOrEqual(0);
		expect(initTelemetryLine).toBeLessThan(registrationLine);
		expect(registrationLine).toBeLessThan(initCallLine);
		expect(sourceCode.slice(registrationLine, initCallLine)).not.toContain(
			'queueMicrotask',
		);
	});
});
