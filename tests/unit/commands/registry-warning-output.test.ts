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

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [message] = warnSpy.mock.calls[0] ?? [];
		expect(typeof message).toBe('string');
		expect(message).toContain('COMMAND_REGISTRY alias warnings');
		expect(message).toContain(
			"Multiple aliases point to 'config doctor': config-doctor, doctor",
		);
		expect(message).toContain(
			"Multiple aliases point to 'diagnose': diagnosis, health",
		);
	});
});
