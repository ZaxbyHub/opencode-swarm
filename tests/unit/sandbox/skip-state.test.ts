import { describe, expect, test } from 'bun:test';
import {
	_resetSandboxWrapOutcomeState,
	_sandboxWrapOutcomeStateSize,
	clearSandboxWrapOutcome,
	readSandboxWrapOutcome,
	recordSandboxWrapOutcome,
} from '../../../src/sandbox/skip-state';

describe('sandbox wrap outcome state', () => {
	test('records, reads, and clears one outcome', () => {
		_resetSandboxWrapOutcomeState();
		recordSandboxWrapOutcome({
			sessionID: 's1',
			callID: 'c1',
			originalCommandHash: 1,
			finalCommandHash: 2,
			wrapped: true,
			capabilityIdentity: 'cap-1',
			reason: 'wrapped',
			originalCommand: 'echo ok',
			executorMechanism: 'bwrap',
			capabilityMechanism: 'bwrap',
			assessmentCacheKey: 'assessment-1',
		});

		expect(readSandboxWrapOutcome('s1', 'c1')?.wrapped).toBe(true);
		clearSandboxWrapOutcome('s1', 'c1');
		expect(readSandboxWrapOutcome('s1', 'c1')).toBeNull();
	});

	test('state stays bounded', () => {
		_resetSandboxWrapOutcomeState();
		for (let index = 0; index < 600; index++) {
			recordSandboxWrapOutcome({
				sessionID: `s${index}`,
				callID: `c${index}`,
				originalCommandHash: index,
				finalCommandHash: index,
				wrapped: false,
				capabilityIdentity: 'cap',
				reason: 'skip',
				originalCommand: 'echo ok',
				executorMechanism: 'none',
				capabilityMechanism: 'none',
				assessmentCacheKey: 'assessment',
			});
		}

		expect(_sandboxWrapOutcomeStateSize()).toBeLessThanOrEqual(512);
		expect(readSandboxWrapOutcome('s0', 'c0')).toBeNull();
		expect(readSandboxWrapOutcome('s599', 'c599')?.reason).toBe('skip');
	});

	test('keys cannot collide and retained diagnostics are byte-bounded', () => {
		_resetSandboxWrapOutcomeState();
		recordSandboxWrapOutcome({
			sessionID: 'a:b',
			callID: 'c',
			originalCommandHash: 1,
			finalCommandHash: 1,
			wrapped: false,
			capabilityIdentity: 'cap',
			assessmentCacheKey: 'assessment',
			reason: 'x'.repeat(10_000),
			originalCommand: 'y'.repeat(100_000),
			executorMechanism: 'none',
			capabilityMechanism: 'none',
		});
		recordSandboxWrapOutcome({
			sessionID: 'a',
			callID: 'b:c',
			originalCommandHash: 2,
			finalCommandHash: 2,
			wrapped: false,
			capabilityIdentity: 'cap',
			assessmentCacheKey: 'assessment',
			reason: 'other',
			originalCommand: 'echo',
			executorMechanism: 'none',
			capabilityMechanism: 'none',
		});
		expect(readSandboxWrapOutcome('a:b', 'c')?.reason.length).toBe(512);
		expect(readSandboxWrapOutcome('a:b', 'c')?.originalCommand.length).toBe(
			64 * 1024,
		);
		expect(readSandboxWrapOutcome('a', 'b:c')?.reason).toBe('other');
	});
});
