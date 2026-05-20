import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_AGENT_PROFILES,
	DEFAULT_ARCHITECT_PROFILE,
	type GuardrailsConfig,
	GuardrailsConfigSchema,
	GuardrailsProfileSchema,
	resolveGuardrailsConfig,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';

describe('GuardrailsProfileSchema', () => {
	it('valid profile with all fields parses', () => {
		const profile = {
			max_tool_calls: 100,
			max_duration_minutes: 15,
			max_repetitions: 5,
			max_consecutive_errors: 3,
			warning_threshold: 0.7,
		};

		const result = GuardrailsProfileSchema.parse(profile);
		expect(result).toEqual(profile);
	});

	it('empty object parses (all fields optional)', () => {
		const result = GuardrailsProfileSchema.parse({});
		expect(result).toEqual({});
	});

	it('single field parses', () => {
		const result = GuardrailsProfileSchema.parse({ max_tool_calls: 50 });
		expect(result).toEqual({ max_tool_calls: 50 });
	});

	it('max_tool_calls 0 (unlimited) parses', () => {
		const result = GuardrailsProfileSchema.parse({ max_tool_calls: 0 });
		expect(result.max_tool_calls).toBe(0);
	});

	it('invalid max_tool_calls (below 0) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_tool_calls: -1 }),
		).toThrow();
	});

	it('invalid max_tool_calls (above 1000) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_tool_calls: 1500 }),
		).toThrow();
	});

	it('max_duration_minutes 0 (unlimited) parses', () => {
		const result = GuardrailsProfileSchema.parse({ max_duration_minutes: 0 });
		expect(result.max_duration_minutes).toBe(0);
	});

	it('invalid max_duration_minutes (below 0) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_duration_minutes: -1 }),
		).toThrow();
	});

	it('invalid max_duration_minutes (above 480) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_duration_minutes: 500 }),
		).toThrow();
	});

	it('invalid max_repetitions (below 3) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_repetitions: 2 }),
		).toThrow();
	});

	it('invalid max_repetitions (above 50) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_repetitions: 60 }),
		).toThrow();
	});

	it('invalid max_consecutive_errors (below 2) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_consecutive_errors: 1 }),
		).toThrow();
	});

	it('invalid max_consecutive_errors (above 20) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_consecutive_errors: 25 }),
		).toThrow();
	});

	it('invalid warning_threshold (below 0.1) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ warning_threshold: 0.05 }),
		).toThrow();
	});

	it('invalid warning_threshold (above 0.9) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ warning_threshold: 0.95 }),
		).toThrow();
	});
});

describe('GuardrailsConfigSchema with profiles', () => {
	it('GuardrailsConfigSchema with profiles field parses', () => {
		const config = {
			enabled: true,
			block_destructive_commands: true,
			shell_audit_log: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			max_transient_retries: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			no_op_warning_threshold: 15,
			max_coder_revisions: 5,
			runaway_output_max_turns: 5,
			profiles: {
				coder: { max_tool_calls: 400 },
				explorer: { max_duration_minutes: 60 },
			},
		};

		const result = GuardrailsConfigSchema.parse(config);
		expect(result).toEqual(config);
	});

	it('GuardrailsConfigSchema without profiles (backward compat) parses', () => {
		const config = {
			enabled: true,
			block_destructive_commands: true,
			shell_audit_log: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			max_transient_retries: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			no_op_warning_threshold: 15,
			max_coder_revisions: 5,
			runaway_output_max_turns: 5,
		};

		const result = GuardrailsConfigSchema.parse(config);
		expect(result).toEqual(config);
	});

	it('empty profiles object parses', () => {
		const config = {
			enabled: true,
			block_destructive_commands: true,
			shell_audit_log: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			max_transient_retries: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			no_op_warning_threshold: 15,
			max_coder_revisions: 5,
			runaway_output_max_turns: 5,
			profiles: {},
		};

		const result = GuardrailsConfigSchema.parse(config);
		expect(result).toEqual(config);
	});

	it('validates profile fields within profiles object', () => {
		const config = {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			profiles: {
				coder: { max_tool_calls: -1 }, // Invalid: below 0
			},
		};

		expect(() => GuardrailsConfigSchema.parse(config)).toThrow();
	});
});

describe('resolveGuardrailsConfig', () => {
	const baseConfig: GuardrailsConfig = {
		enabled: true,
		max_tool_calls: 10,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
		profiles: {
			coder: { max_tool_calls: 20, warning_threshold: 0.7 },
			explorer: { max_duration_minutes: 60 },
		},
	};

	it('returns base when no agentName provided', () => {
		const result = resolveGuardrailsConfig(baseConfig);
		expect(result).toBe(baseConfig);
	});

	it('returns base when agentName is undefined', () => {
		const result = resolveGuardrailsConfig(baseConfig, undefined);
		expect(result).toBe(baseConfig);
	});

	it('returns base when agentName is empty string', () => {
		const result = resolveGuardrailsConfig(baseConfig, '');
		expect(result).toBe(baseConfig);
	});

	it('returns base config when agentName not in built-in profiles (unknown agent gets limits, not exempt)', () => {
		const result = resolveGuardrailsConfig(baseConfig, 'unknown-agent');
		// Unknown agents should get base config, NOT architect defaults
		// This prevents guardrails bypass via unknown agent names
		expect(result.max_tool_calls).toBe(10); // Base config value
		expect(result.max_duration_minutes).toBe(30); // Base config value
		expect(result.max_consecutive_errors).toBe(5); // Base config value
		expect(result.warning_threshold).toBe(0.75); // Base config value
	});

	it('literal "unknown" agent name gets base config limits, not architect exempt', () => {
		const result = resolveGuardrailsConfig(baseConfig, 'unknown');
		// This is the specific regression case: "unknown" was falling back to architect (0 limits)
		// Now it should get base config limits
		expect(result.max_tool_calls).toBe(10); // Base config, NOT 0 (architect exempt)
		expect(result.max_duration_minutes).toBe(30); // Base config, NOT 0 (architect exempt)
	});

	it('merges single field override (coder gets max_tool_calls=20 from profile)', () => {
		const result = resolveGuardrailsConfig(baseConfig, 'coder');
		expect(result.max_tool_calls).toBe(20); // User profile override
		expect(result.max_duration_minutes).toBe(45); // Built-in profile
		expect(result.max_repetitions).toBe(10); // Base value
		expect(result.max_consecutive_errors).toBe(8); // Built-in coder profile (v6.84.1 rate limit hardening)
		expect(result.warning_threshold).toBe(0.7); // User profile override (0.7), not built-in (0.85)
	});

	it('merges multiple field overrides', () => {
		const config: GuardrailsConfig = {
			...baseConfig,
			profiles: {
				coder: {
					max_tool_calls: 50,
					max_duration_minutes: 45,
					max_repetitions: 15,
					max_consecutive_errors: 10,
					warning_threshold: 0.8,
				},
			},
		};

		const result = resolveGuardrailsConfig(config, 'coder');
		expect(result.max_tool_calls).toBe(50); // User override
		expect(result.max_duration_minutes).toBe(45); // User override (same as built-in)
		expect(result.max_repetitions).toBe(15); // User override
		expect(result.max_consecutive_errors).toBe(10); // User override
		expect(result.warning_threshold).toBe(0.8); // User override
	});

	it('profile does not affect other agents (explorer profile does not affect coder resolution)', () => {
		const result = resolveGuardrailsConfig(baseConfig, 'coder');
		expect(result.max_tool_calls).toBe(20); // coder's user profile override
		expect(result.max_duration_minutes).toBe(45); // coder's built-in profile
		expect(result.warning_threshold).toBe(0.7); // coder's user profile override
	});

	it('base profiles field preserved in result', () => {
		const result = resolveGuardrailsConfig(baseConfig, 'coder');
		expect(result.profiles).toBe(baseConfig.profiles);
	});

	it('enabled field not affected by profile', () => {
		const result = resolveGuardrailsConfig(baseConfig, 'coder');
		expect(result.enabled).toBe(true);
	});

	it('profile with partial overrides merges correctly', () => {
		const config: GuardrailsConfig = {
			enabled: true,
			max_tool_calls: 100,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			profiles: {
				test_engineer: { max_consecutive_errors: 2 }, // Only override one field
			},
		};

		const result = resolveGuardrailsConfig(config, 'test_engineer');
		expect(result.max_tool_calls).toBe(400); // Built-in profile value
		expect(result.max_duration_minutes).toBe(45); // Built-in profile value
		expect(result.max_repetitions).toBe(10); // Base value
		expect(result.max_consecutive_errors).toBe(2); // User profile override
		expect(result.warning_threshold).toBe(0.85); // Built-in profile value
	});

	it('multiple profiles can exist with different overrides', () => {
		const config: GuardrailsConfig = {
			enabled: true,
			max_tool_calls: 50,
			max_duration_minutes: 20,
			max_repetitions: 5,
			max_consecutive_errors: 3,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			profiles: {
				coder: { max_tool_calls: 100 },
				explorer: { max_duration_minutes: 40 },
				test_engineer: { max_repetitions: 10 },
			},
		};

		const coderResult = resolveGuardrailsConfig(config, 'coder');
		expect(coderResult.max_tool_calls).toBe(100); // User override

		const explorerResult = resolveGuardrailsConfig(config, 'explorer');
		expect(explorerResult.max_duration_minutes).toBe(40); // User override

		const testerResult = resolveGuardrailsConfig(config, 'test_engineer');
		expect(testerResult.max_repetitions).toBe(10); // User override
	});
});

describe('resolveGuardrailsConfig architect defaults', () => {
	const base: GuardrailsConfig = {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
	};

	it('architect gets built-in default profile automatically', () => {
		const result = resolveGuardrailsConfig(base, 'architect');
		expect(result.max_tool_calls).toBe(0); // Unlimited
		expect(result.max_duration_minutes).toBe(0);
		expect(result.max_consecutive_errors).toBe(8);
		expect(result.warning_threshold).toBe(0.75);
	});

	it('architect built-in does not override max_repetitions (not in DEFAULT_AGENT_PROFILES.architect)', () => {
		const result = resolveGuardrailsConfig(base, 'architect');
		expect(result.max_repetitions).toBe(10);
		expect(result.max_tool_calls).toBe(0); // Should be unlimited (0)
	});

	it('non-architect agents also get their built-in defaults', () => {
		const result = resolveGuardrailsConfig(base, 'coder');
		expect(result.max_tool_calls).toBe(400); // Built-in coder profile
		expect(result.max_duration_minutes).toBe(45); // Built-in coder profile
		expect(result.warning_threshold).toBe(0.85); // Built-in coder profile
	});

	it('user profile overrides built-in architect defaults', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: {
				architect: { max_tool_calls: 300 },
			},
		};

		const result = resolveGuardrailsConfig(config, 'architect');
		expect(result.max_tool_calls).toBe(300); // User wins
		expect(result.max_duration_minutes).toBe(0); // Built-in
		expect(result.warning_threshold).toBe(0.75); // Built-in
	});

	it('user can fully override all architect built-in defaults', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: {
				architect: {
					max_tool_calls: 250,
					max_duration_minutes: 45,
					max_consecutive_errors: 4,
					warning_threshold: 0.6,
				},
			},
		};

		const result = resolveGuardrailsConfig(config, 'architect');
		expect(result.max_tool_calls).toBe(250);
		expect(result.max_duration_minutes).toBe(45);
		expect(result.max_consecutive_errors).toBe(4);
		expect(result.warning_threshold).toBe(0.6);
	});

	it('DEFAULT_ARCHITECT_PROFILE values match DEFAULT_AGENT_PROFILES.architect', () => {
		const result = GuardrailsProfileSchema.parse(DEFAULT_ARCHITECT_PROFILE);
		expect(result.max_tool_calls).toBe(0); // Unlimited
		expect(result.max_duration_minutes).toBe(0);
		expect(result.max_consecutive_errors).toBe(8);
		expect(result.warning_threshold).toBe(0.75);
	});

	it('architect built-in does not affect other agents in same config', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: {
				coder: { max_tool_calls: 100 },
			},
		};

		const result = resolveGuardrailsConfig(config, 'coder');
		expect(result.max_tool_calls).toBe(100); // User coder profile
		expect(result.max_duration_minutes).toBe(45); // Built-in coder profile
	});
});

describe('stripKnownSwarmPrefix', () => {
	it("strips 'paid_' prefix", () => {
		const result = stripKnownSwarmPrefix('paid_architect');
		expect(result).toBe('architect');
	});

	it("strips 'local_' prefix", () => {
		const result = stripKnownSwarmPrefix('local_coder');
		expect(result).toBe('coder');
	});

	it("strips 'mega_' prefix", () => {
		const result = stripKnownSwarmPrefix('mega_explorer');
		expect(result).toBe('explorer');
	});

	it("strips 'default_' prefix", () => {
		const result = stripKnownSwarmPrefix('default_sme');
		expect(result).toBe('sme');
	});

	it('returns unprefixed name unchanged', () => {
		const result = stripKnownSwarmPrefix('architect');
		expect(result).toBe('architect');
	});

	it('returns empty string unchanged', () => {
		const result = stripKnownSwarmPrefix('');
		expect(result).toBe('');
	});

	it('strips any prefix ending with known agent name', () => {
		const result = stripKnownSwarmPrefix('custom_architect');
		expect(result).toBe('architect');
	});

	it('strips compound prefixes ending with known agent name', () => {
		const result = stripKnownSwarmPrefix('paid_local_architect');
		expect(result).toBe('architect');
	});

	it('does not strip when no known agent name suffix found', () => {
		const result = stripKnownSwarmPrefix('custom_unknown');
		expect(result).toBe('custom_unknown');
	});

	// New tests for case-insensitive + separator-aware matching
	describe('case-insensitive matching', () => {
		it("strips 'PAID_ARCHITECT' (uppercase)", () => {
			const result = stripKnownSwarmPrefix('PAID_ARCHITECT');
			expect(result).toBe('architect');
		});

		it("strips 'Local_Coder' (mixed case)", () => {
			const result = stripKnownSwarmPrefix('Local_Coder');
			expect(result).toBe('coder');
		});

		it("strips 'MEGA_EXPLORER' (uppercase)", () => {
			const result = stripKnownSwarmPrefix('MEGA_EXPLORER');
			expect(result).toBe('explorer');
		});

		it("strips 'Default_SME' (mixed case)", () => {
			const result = stripKnownSwarmPrefix('Default_SME');
			expect(result).toBe('sme');
		});

		it("strips 'PAID_CODER' (uppercase)", () => {
			const result = stripKnownSwarmPrefix('PAID_CODER');
			expect(result).toBe('coder');
		});
	});

	describe('separator-aware matching (hyphen)', () => {
		it("strips 'paid-architect' (hyphen separator)", () => {
			const result = stripKnownSwarmPrefix('paid-architect');
			expect(result).toBe('architect');
		});

		it("strips 'local-coder' (hyphen separator)", () => {
			const result = stripKnownSwarmPrefix('local-coder');
			expect(result).toBe('coder');
		});

		it("strips 'mega-explorer' (hyphen separator)", () => {
			const result = stripKnownSwarmPrefix('mega-explorer');
			expect(result).toBe('explorer');
		});

		it("strips 'team-alpha-reviewer' (compound hyphen)", () => {
			const result = stripKnownSwarmPrefix('team-alpha-reviewer');
			expect(result).toBe('reviewer');
		});
	});

	describe('separator-aware matching (space)', () => {
		it("strips 'paid architect' (space separator)", () => {
			const result = stripKnownSwarmPrefix('paid architect');
			expect(result).toBe('architect');
		});

		it("strips 'local coder' (space separator)", () => {
			const result = stripKnownSwarmPrefix('local coder');
			expect(result).toBe('coder');
		});

		it("strips 'mega explorer' (space separator)", () => {
			const result = stripKnownSwarmPrefix('mega explorer');
			expect(result).toBe('explorer');
		});
	});

	describe('combined case + separator variants', () => {
		it("strips 'PAID-ARCHITECT' (uppercase + hyphen)", () => {
			const result = stripKnownSwarmPrefix('PAID-ARCHITECT');
			expect(result).toBe('architect');
		});

		it("strips 'Paid_Architect' (mixed case + underscore)", () => {
			const result = stripKnownSwarmPrefix('Paid_Architect');
			expect(result).toBe('architect');
		});

		it("strips 'Local-Coder' (mixed case + hyphen)", () => {
			const result = stripKnownSwarmPrefix('Local-Coder');
			expect(result).toBe('coder');
		});

		it("strips 'MEGA EXPLORER' (uppercase + space)", () => {
			const result = stripKnownSwarmPrefix('MEGA EXPLORER');
			expect(result).toBe('explorer');
		});
	});

	describe('exact known agent name matching', () => {
		it("returns 'architect' unchanged (exact)", () => {
			const result = stripKnownSwarmPrefix('architect');
			expect(result).toBe('architect');
		});

		it("returns 'coder' unchanged (exact)", () => {
			const result = stripKnownSwarmPrefix('coder');
			expect(result).toBe('coder');
		});

		it("returns 'ARCHITECT' unchanged (exact case-insensitive)", () => {
			const result = stripKnownSwarmPrefix('ARCHITECT');
			expect(result).toBe('architect');
		});
	});

	describe('unknown agent behavior preserved', () => {
		it('unknown agent with non-agent suffix returns unchanged', () => {
			const result = stripKnownSwarmPrefix('unknown-agent');
			expect(result).toBe('unknown-agent');
		});

		it('random name returns unchanged', () => {
			const result = stripKnownSwarmPrefix('foo-bar-baz');
			expect(result).toBe('foo-bar-baz');
		});

		it('name ending with architect token maps to architect (normalization)', () => {
			// Per constraint: "unknown names must not map to architect UNLESS they
			// clearly end with architect token" - so "not-an-architect" DOES
			// clearly end with architect token and should map
			const result = stripKnownSwarmPrefix('not-an-architect');
			expect(result).toBe('architect');
		});
	});

	// Focused tests for architect exemption with normalized variants
	describe('architect exemption with normalized variants', () => {
		const base: GuardrailsConfig = {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
		};

		it('paid-architect (hyphen) gets architect exempt limits', () => {
			const result = resolveGuardrailsConfig(base, 'paid-architect');
			expect(result.max_tool_calls).toBe(0); // Unlimited (architect exempt)
			expect(result.max_duration_minutes).toBe(0);
		});

		it('paid architect (space) gets architect exempt limits', () => {
			const result = resolveGuardrailsConfig(base, 'paid architect');
			expect(result.max_tool_calls).toBe(0); // Unlimited (architect exempt)
			expect(result.max_duration_minutes).toBe(0);
		});

		it('PAID_ARCHITECT (uppercase) gets architect exempt limits', () => {
			const result = resolveGuardrailsConfig(base, 'PAID_ARCHITECT');
			expect(result.max_tool_calls).toBe(0); // Unlimited (architect exempt)
			expect(result.max_duration_minutes).toBe(0);
		});

		it('Paid_Architect (mixed case) gets architect exempt limits', () => {
			const result = resolveGuardrailsConfig(base, 'Paid_Architect');
			expect(result.max_tool_calls).toBe(0); // Unlimited (architect exempt)
			expect(result.max_duration_minutes).toBe(0);
		});

		it('subagent variants get subagent limits, not architect', () => {
			// Verify subagent guardrails still apply for normalized variants
			const coderResult = resolveGuardrailsConfig(base, 'local-coder');
			expect(coderResult.max_tool_calls).toBe(400); // Coder limit
			expect(coderResult.max_duration_minutes).toBe(45);

			const explorerResult = resolveGuardrailsConfig(base, 'mega explorer');
			expect(explorerResult.max_tool_calls).toBe(150); // Explorer limit
			expect(explorerResult.max_duration_minutes).toBe(20);
		});
	});
});

describe('resolveGuardrailsConfig with prefixed agent names', () => {
	const base: GuardrailsConfig = {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
	};

	it('local_architect gets architect defaults', () => {
		const result = resolveGuardrailsConfig(base, 'local_architect');
		expect(result.max_tool_calls).toBe(0); // Unlimited
		expect(result.max_duration_minutes).toBe(0);
	});

	it('paid_architect gets architect defaults', () => {
		const result = resolveGuardrailsConfig(base, 'paid_architect');
		expect(result.max_tool_calls).toBe(0); // Unlimited
		expect(result.max_duration_minutes).toBe(0);
	});

	it('mega_architect gets architect defaults', () => {
		const result = resolveGuardrailsConfig(base, 'mega_architect');
		expect(result.max_tool_calls).toBe(0); // Unlimited
	});

	it('local_coder gets coder built-in defaults', () => {
		const result = resolveGuardrailsConfig(base, 'local_coder');
		expect(result.max_tool_calls).toBe(400); // Built-in coder profile
		expect(result.max_duration_minutes).toBe(45); // Built-in coder profile
		expect(result.warning_threshold).toBe(0.85); // Built-in coder profile
	});

	it('profile lookup uses base name', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: { coder: { max_tool_calls: 400 } },
		};
		const result = resolveGuardrailsConfig(config, 'local_coder');
		expect(result.max_tool_calls).toBe(400);
	});

	it('prefixed profile name as fallback', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: { paid_coder: { max_tool_calls: 350 } },
		};
		const result = resolveGuardrailsConfig(config, 'paid_coder');
		expect(result.max_tool_calls).toBe(350);
	});

	it('user profile overrides architect built-in even with prefix', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: { architect: { max_tool_calls: 300 } },
		};
		const result = resolveGuardrailsConfig(config, 'local_architect');
		expect(result.max_tool_calls).toBe(300);
		expect(result.max_duration_minutes).toBe(0);
	});

	it('custom swarm name architect gets architect defaults', () => {
		const result = resolveGuardrailsConfig(base, 'enterprise_architect');
		expect(result.max_tool_calls).toBe(0); // Unlimited
		expect(result.max_duration_minutes).toBe(0);
		expect(result.max_consecutive_errors).toBe(8);
		expect(result.warning_threshold).toBe(0.75);
	});

	it('custom swarm name coder gets coder built-in defaults', () => {
		const result = resolveGuardrailsConfig(base, 'team_alpha_coder');
		expect(result.max_tool_calls).toBe(400); // Built-in coder profile
		expect(result.max_duration_minutes).toBe(45); // Built-in coder profile
		expect(result.warning_threshold).toBe(0.85); // Built-in coder profile
	});

	it('custom swarm name profile lookup uses base name', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: { coder: { max_tool_calls: 500 } },
		};
		const result = resolveGuardrailsConfig(config, 'myswarm_coder');
		expect(result.max_tool_calls).toBe(500);
	});
});

describe('resolveGuardrailsConfig rate-limit hardened profiles (v6.84.1)', () => {
	const base: GuardrailsConfig = {
		enabled: true,
		max_tool_calls: 100,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
	};

	it('test_engineer gets max_consecutive_errors=8 from built-in profile', () => {
		const result = resolveGuardrailsConfig(base, 'test_engineer');
		expect(result.max_consecutive_errors).toBe(8);
		expect(result.max_tool_calls).toBe(400); // Also verify other built-in values
		expect(result.max_duration_minutes).toBe(45);
	});

	it('explorer gets max_consecutive_errors=8 from built-in profile', () => {
		const result = resolveGuardrailsConfig(base, 'explorer');
		expect(result.max_consecutive_errors).toBe(8);
		expect(result.max_tool_calls).toBe(150); // Also verify other built-in values
		expect(result.max_duration_minutes).toBe(20);
	});

	it('reviewer gets max_consecutive_errors=8 from built-in profile', () => {
		const result = resolveGuardrailsConfig(base, 'reviewer');
		expect(result.max_consecutive_errors).toBe(8);
		expect(result.max_tool_calls).toBe(200); // Also verify other built-in values
		expect(result.max_duration_minutes).toBe(30);
	});

	it('DEFAULT_AGENT_PROFILES has max_consecutive_errors=8 for hardened agents', () => {
		expect(DEFAULT_AGENT_PROFILES.coder.max_consecutive_errors).toBe(8);
		expect(DEFAULT_AGENT_PROFILES.test_engineer.max_consecutive_errors).toBe(8);
		expect(DEFAULT_AGENT_PROFILES.explorer.max_consecutive_errors).toBe(8);
		expect(DEFAULT_AGENT_PROFILES.reviewer.max_consecutive_errors).toBe(8);
	});

	it('user profile can override hardened agent max_consecutive_errors', () => {
		const config: GuardrailsConfig = {
			...base,
			profiles: {
				explorer: { max_consecutive_errors: 6 },
			},
		};
		const result = resolveGuardrailsConfig(config, 'explorer');
		expect(result.max_consecutive_errors).toBe(6); // User override wins
	});
});

describe('GuardrailsProfileSchema idle_timeout_minutes', () => {
	it('valid idle_timeout_minutes parses', () => {
		const result = GuardrailsProfileSchema.parse({ idle_timeout_minutes: 30 });
		expect(result.idle_timeout_minutes).toBe(30);
	});

	it('idle_timeout_minutes at min (5) parses', () => {
		const result = GuardrailsProfileSchema.parse({ idle_timeout_minutes: 5 });
		expect(result.idle_timeout_minutes).toBe(5);
	});

	it('idle_timeout_minutes at max (240) parses', () => {
		const result = GuardrailsProfileSchema.parse({ idle_timeout_minutes: 240 });
		expect(result.idle_timeout_minutes).toBe(240);
	});

	it('idle_timeout_minutes below min (4) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ idle_timeout_minutes: 4 }),
		).toThrow();
	});

	it('idle_timeout_minutes above max (241) rejects', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ idle_timeout_minutes: 241 }),
		).toThrow();
	});
});
