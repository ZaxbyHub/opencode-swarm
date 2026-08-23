import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals, COMMAND_REGISTRY, type CommandEntry } from './registry.js';
import {
	classifySwarmCommandToolUse,
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
} from './tool-policy.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function cmd(name: string): CommandEntry {
	return COMMAND_REGISTRY[
		name as keyof typeof COMMAND_REGISTRY
	] as CommandEntry;
}

// ---------------------------------------------------------------------------
// 1. CLASSIFICATION SNAPSHOT
// ---------------------------------------------------------------------------

describe('toolPolicy classification snapshot — no regression', () => {
	const EXPECTED_AGENT = new Set<string>([
		'agents',
		'config',
		'config doctor',
		'doctor tools',
		'status',
		'show-plan',
		'help',
		'history',
		'evidence',
		'evidence summary',
		'retrieve',
		'diagnose',
		'preflight',
		'benchmark',
		'gate-audit',
		'gate-stats',
		'costs',
		'knowledge',
		'memory',
		'memory status',
		'memory pending',
		'memory recall-log',
		'memory value-log',
		'memory stale',
		'memory export',
		'memory evaluate',
		'memory consolidation-log',
		// #1466: audit-log hash-chain verification (read-only diagnostic).
		'memory audit-verify',
		'sdd',
		'sdd status',
		'sdd validate',
		// FR-004: sdd project moved from human-only to agent (overwrite gated)
		'sdd project',
		'sync-plan',
		'export',
		'auto-proceed',
		// gap commands
		'pr status',
		'learning',
		'post-mortem',
		// agent-callable PR subscription lifecycle (idempotent + capped;
		// moved from human-only for swarm-pr-subscribe parity)
		'pr subscribe',
		'pr unsubscribe',
		// guardrail diagnostics (pre-existing 'agent' commands not previously
		// enumerated here — registry is the source of truth, both carry
		// toolPolicy: 'agent')
		'guardrail explain',
		'guardrail-log',
		'lanes',
		'ci-simulate',
		// #1672: aggregated context-capsule telemetry stats (toolPolicy: 'agent', toolNoArgs)
		'context-map stats',
		// #1850: cohort memory sharing commands
		'memory link',
		'memory link status',
		'memory unlink',
		// #1822: governed skill optimizer — read-only/proposal commands
		'skill-opt',
		'skill-opt plan',
		'skill-opt status',
		'skill-opt diff',
		'skill-opt history',
	]);

	const EXPECTED_RESTRICTED = new Set<string>([
		'abort-pr-workflow',
		'acknowledge-spec-drift',
		'approve-plan-critic',
		'reset',
		'reset-session',
		'rollback',
		'checkpoint',
		'consolidate',
	]);

	const EXPECTED_NONE = new Set<string>([
		'analyze',
		'archive',
		'brainstorm',
		'clarify',
		'codebase-review',
		'concurrency',
		'council',
		'ci-monitor',
		'coupling',
		'curate',
		'dark-matter',
		'deep-dive',
		'deep-research',
		'design-docs',
		'epic',
		'finalize',
		'full-auto',
		'handoff',
		'issue',
		'link',
		'link status',
		'loop',
		'pr-feedback',
		'pr-review',
		'promote',
		'qa-gates',
		'simulate',
		'specify',
		'turbo',
		'unlink',
		'write-retro',
	]);

	test("'agent' bucket contains exactly the expected commands", () => {
		const actual = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).toolPolicy === 'agent') {
				actual.add(name);
			}
		}
		expect(actual.size).toBe(EXPECTED_AGENT.size);
		for (const name of EXPECTED_AGENT) {
			expect(actual.has(name)).toBe(true);
		}
		for (const name of actual) {
			expect(EXPECTED_AGENT.has(name)).toBe(true);
		}
	});

	test("'restricted' bucket contains exactly the expected 8 commands", () => {
		const actual = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).toolPolicy === 'restricted') {
				actual.add(name);
			}
		}
		expect(actual.size).toBe(8);
		for (const name of EXPECTED_RESTRICTED) {
			expect(actual.has(name)).toBe(true);
		}
		for (const name of actual) {
			expect(EXPECTED_RESTRICTED.has(name)).toBe(true);
		}
	});

	test("'none' bucket contains exactly the expected standalone non-tool commands", () => {
		const actual = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).toolPolicy === 'none') {
				actual.add(name);
			}
		}
		expect(actual.size).toBe(EXPECTED_NONE.size);
		for (const name of EXPECTED_NONE) {
			expect(actual.has(name)).toBe(true);
		}
		for (const name of actual) {
			expect(EXPECTED_NONE.has(name)).toBe(true);
		}
	});

	test('every standalone command (no aliasOf, no subcommandOf) has a toolPolicy', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (!e.aliasOf && !e.subcommandOf) {
				expect(
					e.toolPolicy,
					`Standalone command '${name}' missing toolPolicy`,
				).toBeDefined();
			}
		}
	});

	test('subcommands may have their own toolPolicy (they do not REQUIRE one — optional override)', () => {
		// Subcommands are skipped by validateToolPolicy() — they don't require a toolPolicy.
		// But some subcommands DO have one (e.g. config doctor, sdd project) as an explicit override.
		// The only requirement is that they are skipped by the loader validation.
		const subcommandsWithPolicy = new Set<string>();
		const subcommandsWithoutPolicy = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.subcommandOf) {
				if (e.toolPolicy !== undefined) {
					subcommandsWithPolicy.add(name);
				} else {
					subcommandsWithoutPolicy.add(name);
				}
			}
		}
		// Verify some subcommands DO have toolPolicy (it is allowed as an override)
		expect(subcommandsWithPolicy.size).toBeGreaterThan(0);
		// Verify some subcommands DON'T have toolPolicy (inheriting from parent is valid)
		expect(subcommandsWithoutPolicy.size).toBeGreaterThan(0);
	});

	test('aliases have no toolPolicy (they inherit from target)', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.aliasOf) {
				expect(
					e.toolPolicy,
					`Alias '${name}' should not have its own toolPolicy`,
				).toBeUndefined();
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 2. DERIVED-SET REPRODUCTION
// ---------------------------------------------------------------------------

describe('derived-set reproduction from registry toolPolicy fields', () => {
	test('derived ALLOWLIST = { toolPolicy === "agent" } equals current SWARM_COMMAND_TOOL_ALLOWLIST plus gap commands', () => {
		const derived = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).toolPolicy === 'agent') {
				derived.add(name);
			}
		}
		// pr status, learning, post-mortem are the 3 new gap agent commands
		const expected = new Set([
			...SWARM_COMMAND_TOOL_ALLOWLIST,
			'pr status',
			'learning',
			'post-mortem',
		]);
		expect(derived.size).toBe(expected.size);
		for (const name of expected) {
			expect(derived.has(name)).toBe(true);
		}
		for (const name of derived) {
			expect(expected.has(name)).toBe(true);
		}
	});

	test('derived HUMAN_ONLY = { "human-only" ∪ "restricted" } equals current HUMAN_ONLY_SWARM_COMMANDS plus gap commands', () => {
		const derived = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.toolPolicy === 'human-only' || e.toolPolicy === 'restricted') {
				derived.add(name);
				continue;
			}
			// Dash aliases carry no toolPolicy of their own but resolve to a
			// canonical handler. HUMAN_ONLY_SWARM_COMMANDS includes any alias whose
			// aliasOf target is human-only/restricted so the Bash CLI guardrail
			// blocks the dash form too (e.g. `memory-import` → `memory import`).
			if (e.aliasOf) {
				const target = COMMAND_REGISTRY[
					e.aliasOf as keyof typeof COMMAND_REGISTRY
				] as CommandEntry | undefined;
				if (
					target?.toolPolicy === 'human-only' ||
					target?.toolPolicy === 'restricted'
				) {
					derived.add(name);
				}
			}
		}
		// pr subscribe / pr unsubscribe are now agent-callable, so the derived
		// set matches HUMAN_ONLY_SWARM_COMMANDS exactly.
		const expected = new Set([...HUMAN_ONLY_SWARM_COMMANDS]);
		expect(derived.size).toBe(expected.size);
		for (const name of expected) {
			expect(derived.has(name)).toBe(true);
		}
		for (const name of derived) {
			expect(expected.has(name)).toBe(true);
		}
	});

	test('derived z.enum candidate = { "agent" ∪ "human-only" } equals current SWARM_COMMAND_TOOL_COMMANDS plus all 5 gap commands', () => {
		const derived = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.toolPolicy === 'agent' || e.toolPolicy === 'human-only') {
				derived.add(name);
			}
		}
		// All 5 gap commands: pr status (agent), pr subscribe (agent), pr unsubscribe (agent), learning (agent), post-mortem (agent)
		const expected = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			// current SWARM_COMMAND_TOOL_COMMANDS = agent ∪ human-only
			if (e.toolPolicy === 'agent' || e.toolPolicy === 'human-only') {
				expected.add(name);
			}
		}
		expect(derived.size).toBe(expected.size);
		for (const name of expected) {
			expect(derived.has(name)).toBe(true);
		}
		for (const name of derived) {
			expect(expected.has(name)).toBe(true);
		}
	});

	test('derived NO_ARGS = { toolNoArgs === true } equals current NO_ARGS plus {pr status}', () => {
		// NO_ARGS is not exported from tool-policy.ts, so we hardcode the known set
		// (matches the private NO_ARGS in tool-policy.ts at time of writing)
		const TOOL_POLICY_NO_ARGS = new Set([
			'agents',
			'config',
			'config doctor',
			'doctor tools',
			'status',
			'history',
			'evidence summary',
			'diagnose',
			'preflight',
			'sync-plan',
			'export',
			'memory',
			'memory status',
			'memory export',
			'lanes',
			// #1850: memory link status has toolNoArgs: true
			'memory link status',
			// #1672: context-map stats has toolNoArgs: true
			'context-map stats',
		]);
		const derived = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).toolNoArgs === true) {
				derived.add(name);
			}
		}
		const expected = new Set([...TOOL_POLICY_NO_ARGS, 'pr status']);
		expect(derived.size).toBe(expected.size);
		for (const name of expected) {
			expect(derived.has(name)).toBe(true);
		}
		for (const name of derived) {
			expect(expected.has(name)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. GAP COMMAND CLASSIFICATION
// ---------------------------------------------------------------------------

describe('gap command classification', () => {
	test('pr status: toolPolicy === "agent" AND toolNoArgs === true', () => {
		expect(cmd('pr status').toolPolicy).toBe('agent');
		expect(cmd('pr status').toolNoArgs).toBe(true);
	});

	test('pr subscribe: toolPolicy === "agent" (idempotent + capped, agent-callable)', () => {
		expect(cmd('pr subscribe').toolPolicy).toBe('agent');
	});

	test('pr unsubscribe: toolPolicy === "agent" (idempotent, agent-callable)', () => {
		expect(cmd('pr unsubscribe').toolPolicy).toBe('agent');
	});

	test('learning: toolPolicy === "agent"', () => {
		expect(cmd('learning').toolPolicy).toBe('agent');
	});

	test('post-mortem: toolPolicy === "agent"', () => {
		expect(cmd('post-mortem').toolPolicy).toBe('agent');
	});

	test('costs: toolPolicy === "agent"', () => {
		expect(cmd('costs').toolPolicy).toBe('agent');
	});

	test('ci-simulate: toolPolicy === "agent" with fixed CI gate arguments only', () => {
		expect(cmd('ci-simulate').toolPolicy).toBe('agent');
		expect(cmd('ci-simulate').args).not.toContain('--cmd');
	});
});

describe('cost command argument policies', () => {
	test('benchmark allows cost threshold through swarm_command', () => {
		const resolved = _internals.resolveCommand([
			'benchmark',
			'--ci-gate',
			'--max-cost-usd',
			'0.30',
		]);
		expect(resolved).not.toBeNull();
		expect(classifySwarmCommandToolUse(resolved!)).toEqual({ allowed: true });
	});

	test('costs allows only empty args or --json through swarm_command', () => {
		const jsonResolved = _internals.resolveCommand(['costs', '--json']);
		const badResolved = _internals.resolveCommand(['costs', '--verbose']);
		expect(jsonResolved).not.toBeNull();
		expect(badResolved).not.toBeNull();
		expect(classifySwarmCommandToolUse(jsonResolved!)).toEqual({
			allowed: true,
		});
		expect(classifySwarmCommandToolUse(badResolved!).allowed).toBe(false);
	});
});

describe('gate-audit command argument policy', () => {
	test('allows an explicit swarm preference through swarm_command', () => {
		const resolved = _internals.resolveCommand([
			'gate-audit',
			'--model',
			'provider/model',
			'--swarm',
			'mega',
			'--json',
		]);

		expect(resolved).not.toBeNull();
		expect(classifySwarmCommandToolUse(resolved!)).toEqual({ allowed: true });
	});
});

// ---------------------------------------------------------------------------
// 4. VALIDATE_TOOL_POLICY
// ---------------------------------------------------------------------------

describe('validateToolPolicy() — fail-open loader validation', () => {
	let consoleWarnSpy: (message: string, ...args: unknown[]) => void;
	let warnCalls: { message: string }[];

	beforeEach(() => {
		warnCalls = [];
		consoleWarnSpy = (message: string, ..._args: unknown[]) => {
			warnCalls.push({ message });
		};
	});

	test('validateToolPolicy() does NOT throw (fail-open per AGENTS.md invariant #1)', () => {
		expect(() => _internals.validateToolPolicy()).not.toThrow();
	});

	test('validateToolPolicy() returns { valid: true, warnings: [] } when all standalone commands have toolPolicy', () => {
		const result = _internals.validateToolPolicy();
		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	test('validateToolPolicy() returns no warnings when all standalone commands have explicit toolPolicy', () => {
		// The negative-path (warning emission) is tested in registration-parity.test.ts
		// via the findMissingToolPolicy helper with synthetic fixtures — that test injects
		// entries missing toolPolicy and asserts on the warning count.
		const result = _internals.validateToolPolicy();
		expect(result.warnings.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 5. TWO-TIER HUMAN-ONLY PROPERTY
// ---------------------------------------------------------------------------

describe('two-tier human-only: "restricted" is disjoint from "human-only"', () => {
	test('"restricted" and "human-only" sets are disjoint — no command is both', () => {
		const restricted = new Set<string>();
		const humanOnly = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.toolPolicy === 'restricted') restricted.add(name);
			if (e.toolPolicy === 'human-only') humanOnly.add(name);
		}
		for (const name of restricted) {
			expect(
				humanOnly.has(name),
				`Command '${name}' is in both restricted and human-only sets`,
			).toBe(false);
		}
		for (const name of humanOnly) {
			expect(
				restricted.has(name),
				`Command '${name}' is in both human-only and restricted sets`,
			).toBe(false);
		}
	});

	test('the 8 restricted commands are NOT in the "agent" set', () => {
		const restricted = new Set<string>();
		const agent = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.toolPolicy === 'restricted') restricted.add(name);
			if (e.toolPolicy === 'agent') agent.add(name);
		}
		for (const name of restricted) {
			expect(
				agent.has(name),
				`Restricted command '${name}' must not be in the agent set`,
			).toBe(false);
		}
	});

	test('classifySwarmCommandToolUse: restricted commands are not allowed through the tool', () => {
		// restricted commands are in HUMAN_ONLY_SWARM_COMMANDS but NOT in SWARM_COMMAND_TOOL_ALLOWLIST.
		// classifySwarmCommandToolUse should return allowed: false with human-only message.
		const restricted = [
			'acknowledge-spec-drift',
			'reset',
			'reset-session',
			'rollback',
			'checkpoint',
			'consolidate',
		];
		for (const name of restricted) {
			const resolved = _internals.resolveCommand([name]);
			expect(resolved).not.toBeNull();
			const result = classifySwarmCommandToolUse(resolved!);
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
			}
		}
	});

	test('classifySwarmCommandToolUse: human-only commands (not restricted) return human-only refusal message', () => {
		// Human-only commands are schema-visible but never agent-callable.
		// FR-004: sdd project is now agent-invocable (removed from this list)
		const humanOnly = [
			'review',
			'memory compact',
			'memory import',
			'memory migrate',
		];
		for (const name of humanOnly) {
			const tokens = name.includes(' ') ? name.split(' ') : [name];
			const resolved = _internals.resolveCommand(tokens);
			expect(resolved).not.toBeNull();
			const result = classifySwarmCommandToolUse(resolved!);
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 6. toolPolicy values are valid enum members
// ---------------------------------------------------------------------------

describe('toolPolicy field values are valid', () => {
	test('toolPolicy is always one of the four valid string literals (or undefined for aliases/subcommands)', () => {
		const valid = new Set(['agent', 'human-only', 'restricted', 'none']);
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const e = entry as CommandEntry;
			if (e.toolPolicy !== undefined) {
				expect(valid.has(e.toolPolicy)).toBe(true);
			}
		}
	});
});
