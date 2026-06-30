import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { _internals } from '../../../src/commands/registry.js';

describe('command registry validation warnings', () => {
	let warnSpy: ReturnType<typeof spyOn>;
	const originalDebug = process.env.OPENCODE_SWARM_DEBUG;

	beforeEach(() => {
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (originalDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		}
	});

	test('stays out of normal output when debug logging is disabled', () => {
		delete process.env.OPENCODE_SWARM_DEBUG;

		_internals.emitValidationWarnings('COMMAND_REGISTRY alias warnings', [
			"Multiple aliases point to 'config doctor': config-doctor, doctor",
		]);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	test('goes to debug logs when debug logging is enabled', () => {
		process.env.OPENCODE_SWARM_DEBUG = '1';

		_internals.emitValidationWarnings('COMMAND_REGISTRY alias warnings', [
			"Multiple aliases point to 'config doctor': config-doctor, doctor",
			"Multiple aliases point to 'diagnose': diagnosis, health",
		]);

		const messages = warnSpy.mock.calls
			.map((call) => call[0])
			.filter((value): value is string => typeof value === 'string');

		expect(messages.length).toBeGreaterThan(0);
		expect(
			messages.some((message) =>
				message.includes('COMMAND_REGISTRY alias warnings'),
			),
		).toBe(true);
		expect(
			messages.some((message) =>
				message.includes(
					"Multiple aliases point to 'config doctor': config-doctor, doctor",
				),
			),
		).toBe(true);
		expect(
			messages.some((message) =>
				message.includes(
					"Multiple aliases point to 'diagnose': diagnosis, health",
				),
			),
		).toBe(true);
		expect(messages.join('\n')).toContain('COMMAND_REGISTRY alias warnings');
	});
});
