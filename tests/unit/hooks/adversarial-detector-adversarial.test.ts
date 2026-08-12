import { describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { DEFAULT_MODELS } from '../../../src/config/constants';
import {
	detectAdversarialPair,
	formatAdversarialWarning,
	resolveAgentModel,
} from '../../../src/hooks/adversarial-detector';

describe('adversarial-detector - Adversarial Security Testing', () => {
	const mockConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	describe('resolveAgentModel - Boundary Violations', () => {
		it('ATTACK 1: Empty string agentName should return DEFAULT_MODELS.default', () => {
			const result = resolveAgentModel('', mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 2: Null-like agent names (__proto__) - FIXED: returns DEFAULT_MODELS.default', () => {
			const result = resolveAgentModel('__proto__', mockConfig);
			// FIXED: Returns DEFAULT_MODELS.default (string) instead of prototype object
			// safeGet() uses Object.hasOwn() which prevents prototype chain pollution
			expect(typeof result).toBe('string');
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 2b: Null-like agent names (constructor) - FIXED: returns DEFAULT_MODELS.default', () => {
			const result = resolveAgentModel('constructor', mockConfig);
			// FIXED: Returns DEFAULT_MODELS.default (string) instead of constructor function
			// safeGet() uses Object.hasOwn() which prevents prototype chain pollution
			expect(typeof result).toBe('string');
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 2c: Null-like agent names (prototype) should return DEFAULT_MODELS.default', () => {
			const result = resolveAgentModel('prototype', mockConfig);
			// This one is safe since 'prototype' is not a special property
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 3: Very long agent names (1000+ chars) should not crash', () => {
			const longName = 'a'.repeat(1000);
			const result = resolveAgentModel(longName, mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 3b: Extremely long agent names (10000+ chars) should not crash', () => {
			const longName = 'a'.repeat(10000);
			const result = resolveAgentModel(longName, mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});
	});

	describe('detectAdversarialPair - Malformed Inputs', () => {
		it('ATTACK 4: Empty string agents should not throw', () => {
			expect(() => detectAdversarialPair('', '', mockConfig)).not.toThrow();
		});

		it('ATTACK 5: Unicode agent names should not throw - BEHAVIOR: unknown agents share default model and ARE adversarial', () => {
			const result = detectAdversarialPair('😀', '🔥', mockConfig);
			// Both unknown agents resolve to DEFAULT_MODELS.default, making them adversarial
			// This is expected behavior, not a vulnerability
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 5b: Mixed Unicode and ASCII agent names should not throw - BEHAVIOR: both unknown, share default model', () => {
			const result = detectAdversarialPair('agent-😀', 'agent-🔥', mockConfig);
			// Both unknown agents resolve to DEFAULT_MODELS.default, making them adversarial
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 5c: Right-to-left override Unicode should not throw - BEHAVIOR: both unknown, share default model', () => {
			const result = detectAdversarialPair('\u202e', '\u202f', mockConfig);
			// Both unknown agents resolve to DEFAULT_MODELS.default, making them adversarial
			expect(result).toBe(DEFAULT_MODELS.default);
		});
	});

	describe('formatAdversarialWarning - Injection Attempts', () => {
		it('ATTACK 6: XSS injection in agentA should be included verbatim', () => {
			const result = formatAdversarialWarning(
				'<script>alert("XSS")</script>',
				'reviewer',
				'model-1',
				'gate',
			);
			expect(result).toContain('<script>alert("XSS")</script>');
		});

		it('ATTACK 6b: XSS injection in agentB should be included verbatim', () => {
			const result = formatAdversarialWarning(
				'coder',
				'<img src=x onerror=alert(1)>',
				'model-1',
				'gate',
			);
			expect(result).toContain('<img src=x onerror=alert(1)>');
		});

		it('ATTACK 6c: XSS injection in sharedModel should be included verbatim', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'javascript:alert(1)',
				'gate',
			);
			expect(result).toContain('javascript:alert(1)');
		});

		it('ATTACK 7: Empty policy should return standard warn message', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-1',
				'',
			);
			expect(result).toContain('Same-model adversarial pair detected');
			expect(result).not.toContain('GATE POLICY');
		});

		it('ATTACK 7b: Null-like policy values should return standard warn message', () => {
			const result1 = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-1',
				'null',
			);
			expect(result1).toContain('Same-model adversarial pair detected');
			expect(result1).not.toContain('GATE POLICY');

			const result2 = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-1',
				'undefined',
			);
			expect(result2).toContain('Same-model adversarial pair detected');
			expect(result2).not.toContain('GATE POLICY');
		});
	});

	describe('resolveAgentModel - Config Override Edge Cases', () => {
		it('ATTACK 8: Config override with empty string should fall through to DEFAULT_MODELS', () => {
			const configWithEmptyModel: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				agents: {
					coder: {
						model: '',
					},
				},
			};

			const result = resolveAgentModel('coder', configWithEmptyModel);
			// Empty string is falsy, so should fall through to DEFAULT_MODELS
			expect(result).toBe(DEFAULT_MODELS.coder);
		});

		it('ATTACK 8b: Config override with whitespace-only string should fall through', () => {
			const configWithWhitespace: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				agents: {
					coder: {
						model: '   ',
					},
				},
			};

			const result = resolveAgentModel('coder', configWithWhitespace);
			// Whitespace is not a valid model and must fall through safely.
			expect(result).toBe(DEFAULT_MODELS.coder);
		});

		it('ATTACK 8c: Config override with object-like strings - BEHAVIOR: normalized to lowercase, falls through to default', () => {
			const configWithObjectLike: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				agents: {
					'[object Object]': {
						model: 'fake-model',
					},
				},
			};

			const result = resolveAgentModel('[object Object]', configWithObjectLike);
			// The agent name is normalized to lowercase, so '[object Object]' becomes '[object object]'
			// This doesn't match the config key '[object Object]', so it falls through to default
			expect(result).toBe(DEFAULT_MODELS.default);
		});
	});

	describe('detectAdversarialPair - Unexpected Behavior', () => {
		it('ATTACK 9: Both unknown agents resolve to DEFAULT_MODELS.default - BEHAVIOR: they ARE adversarial', () => {
			const result = detectAdversarialPair('unknown1', 'unknown2', mockConfig);
			// Unknown agents all share DEFAULT_MODELS.default, making them adversarial
			// This is expected behavior but worth noting
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 9b: Same unknown agent twice should return shared default model', () => {
			const result = detectAdversarialPair(
				'unknown-agent',
				'unknown-agent',
				mockConfig,
			);
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 9c: One unknown, one known agent with same default model', () => {
			// explorer uses 'google/gemini-2.5-flash' which is the default
			const result = detectAdversarialPair(
				'unknown-agent',
				'explorer',
				mockConfig,
			);
			expect(result).toBe(DEFAULT_MODELS.default);
		});
	});

	describe('resolveAgentModel - Prototype Pollution Attempts', () => {
		it('ATTACK 10: Constructor chain access should be safe', () => {
			const result = resolveAgentModel('constructor.prototype', mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 10b: __proto__ chain access should be safe', () => {
			const result = resolveAgentModel('__proto__.__proto__', mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 10c: Nested prototype access should be safe', () => {
			const result = resolveAgentModel('constructor.constructor', mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});
	});

	describe('detectAdversarialPair - Case Sensitivity Edge Cases', () => {
		it('ATTACK 11: Mixed case agent names should normalize correctly', () => {
			// Both resolve to the same base agent after prefix stripping and lowercasing
			// architect key is intentionally absent from DEFAULT_MODELS so it falls back to default
			const result = detectAdversarialPair(
				'ARCHITECT',
				'architect',
				mockConfig,
			);
			expect(result).toBe(DEFAULT_MODELS.default.toLowerCase());
		});

		it('ATTACK 11b: Case variations should not cause false positives', () => {
			// Different agents with different models should not match even with mixed case
			const result = detectAdversarialPair(
				'CODER',
				'TEST_ENGINEER',
				mockConfig,
			);
			expect(result).toBeNull();
		});
	});

	describe('formatAdversarialWarning - String Formatting Attacks', () => {
		it('ATTACK 12: Format string injection should not crash', () => {
			const result = formatAdversarialWarning('%s', '%d', '%f', 'gate');
			expect(result).toContain('%s');
			expect(result).toContain('%d');
			expect(result).toContain('%f');
		});

		it('ATTACK 12b: Newline injection in agent names', () => {
			const result = formatAdversarialWarning(
				'agent\nA',
				'agent\nB',
				'model\nC',
				'gate',
			);
			expect(result).toContain('agent\nA');
			expect(result).toContain('agent\nB');
			expect(result).toContain('model\nC');
		});

		it('ATTACK 12c: Null byte injection should be handled safely', () => {
			const result = formatAdversarialWarning(
				'agent\x00A',
				'agent\x00B',
				'model\x00C',
				'gate',
			);
			expect(result).toContain('agent\x00A');
			expect(result).toContain('agent\x00B');
			expect(result).toContain('model\x00C');
		});
	});

	describe('resolveAgentModel - Swarm Config Attack Vectors', () => {
		it('ATTACK 14: Swarm config with adversarial agent names - FIXED: ignores prototype pollution', () => {
			const configWithSwarm: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				swarms: {
					cloud: {
						name: 'Cloud Swarm',
						agents: {
							__proto__: {
								model: 'attacker-model',
							},
						},
					},
				},
			};

			// This should not crash - accessing __proto__ on the agents object
			const result = resolveAgentModel('__proto__', configWithSwarm);
			// FIXED: safeGet() prevents prototype pollution, returns DEFAULT_MODELS.default
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 14b: Swarm config with long agent names', () => {
			const longAgentName = 'a'.repeat(100);
			const configWithSwarm: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				swarms: {
					fast: {
						name: 'Fast Swarm',
						agents: {
							[longAgentName]: {
								model: 'fast-model',
							},
						},
					},
				},
			};

			const result = resolveAgentModel(longAgentName, configWithSwarm);
			// Arbitrary config keys are not registered canonical agent roles.
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 14c: Multiple swarms with legitimate agent named "constructor"', () => {
			const configWithMultipleSwarms: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				swarms: {
					swarm1: {
						agents: {
							constructor: {
								model: 'swarm1-model',
							},
						},
					},
					swarm2: {
						agents: {
							constructor: {
								model: 'swarm2-model',
							},
						},
					},
				},
			};

			// Unknown role keys cannot become registered agents or borrow the first swarm.
			const result = resolveAgentModel('constructor', configWithMultipleSwarms);
			expect(result).toBe(DEFAULT_MODELS.default);
		});
	});

	describe('Integration Attack Vectors', () => {
		it('ATTACK 13: Chain attacks combining multiple vectors', () => {
			// Long name with null-like components and unicode
			const longAttackName = '__proto__-'.repeat(50) + '😀';
			const result = resolveAgentModel(longAttackName, mockConfig);
			expect(result).toBe(DEFAULT_MODELS.default);
		});

		it('ATTACK 13b: Combined XSS and prototype pollution', () => {
			const result = formatAdversarialWarning(
				'<script>__proto__</script>',
				'<img onerror=constructor>',
				'javascript:__proto__.pollution',
				'',
			);
			expect(result).toContain('<script>__proto__</script>');
			expect(result).toContain('<img onerror=constructor>');
			expect(result).toContain('javascript:__proto__.pollution');
			expect(result).not.toContain('GATE POLICY');
		});
	});
});
