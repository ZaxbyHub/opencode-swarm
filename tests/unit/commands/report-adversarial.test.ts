import { describe, expect, test } from 'bun:test';
import { parseReportArgs } from '../../../src/commands/report.js';

describe('parseReportArgs — adversarial inputs (issue #2482/#2048)', () => {
	test('unknown flag rejected with usage', () => {
		const { error } = parseReportArgs(['--evil']);
		expect(error).toContain('Unrecognized argument: --evil');
		expect(error).toContain('Usage:');
	});

	test('each value flag may appear at most once', () => {
		for (const flag of ['--task', '--session', '--trace', '--run', '--since']) {
			const { error } = parseReportArgs([flag, 'a', flag, 'b']);
			expect(error).toContain('at most once');
		}
	});

	test('missing / empty / flag-like values rejected', () => {
		expect(parseReportArgs(['--task']).error).toContain('non-empty value');
		expect(parseReportArgs(['--task', '--json']).error).toContain(
			'non-empty value',
		);
	});

	test('--since must parse as ISO-8601', () => {
		expect(parseReportArgs(['--since', 'not-a-date']).error).toContain(
			'ISO-8601',
		);
		expect(
			parseReportArgs(['--since', '2026-01-01T00:00:00Z']).error,
		).toBeUndefined();
	});

	test('SQL metacharacters in values are accepted as opaque filter strings', () => {
		const { parsed, error } = parseReportArgs([
			'--task',
			"'; DROP TABLE x; --",
		]);
		expect(error).toBeUndefined();
		expect(parsed!.filter.taskId).toBe("'; DROP TABLE x; --");
	});
});
