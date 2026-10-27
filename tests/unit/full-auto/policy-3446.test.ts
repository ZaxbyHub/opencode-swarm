/**
 * #3446 — Full-Auto classifier rules for OpenCode 2: the Code Mode `execute`
 * wrapper (operator opt-in, default off) and `swarm_command` (explicit
 * read-only set only). Kept apart from policy.test.ts, which is at the FR-006
 * line cap.
 */
import { describe, expect, test } from 'bun:test';
import {
	classifyFullAutoToolAction,
	type FullAutoClassifierInput,
} from '../../../src/full-auto/policy';

const PROJECT = '/repo/project';

function input(
	overrides: Partial<FullAutoClassifierInput>,
): FullAutoClassifierInput {
	return {
		sessionID: 'sess-1',
		toolName: 'read',
		args: {},
		directory: PROJECT,
		fullAutoConfig: {
			enabled: true,
			mode: 'supervised',
			permission_policy: { enabled: true, allow_defaults: true },
		},
		...overrides,
	};
}

describe('classifyFullAutoToolAction — OpenCode v2 Code Mode `execute` wrapper', () => {
	// OpenCode v2 exposes plugin and MCP tools to the model through a single
	// host-owned `execute` tool whose input is a JS program (`{ code }`). Every
	// nested `tools.<name>()` call is dispatched through the same
	// tool.execute.before chain under its OWN name, so each is classified
	// individually; escalating the wrapper as well sends every plugin tool call
	// to the critic twice (wrapper, then nested).
	//
	// v2 tool events carry no field proving a tool is host-owned (the event is
	// {tool, sessionID, agent, messageID, id, input}), so a third-party tool
	// that merely shares the name `execute` cannot be told apart. The
	// pass-through is therefore OFF by default and needs the operator's opt-in
	// (`permission_policy.trust_code_mode_wrapper`), the v2 adapter's per-call
	// mark, AND a program that is exactly one tool call with a plain-data
	// argument — the sandbox also exposes `fetch` and `Function` (#3446).
	const singleCall = {
		code: 'return await tools.declare_scope({ files: ["a.ts"] });',
	};
	const trusting = (mode: 'supervised' | 'strict' = 'supervised') => ({
		enabled: true,
		mode,
		permission_policy: {
			enabled: true,
			allow_defaults: true,
			trust_code_mode_wrapper: true,
		},
	});

	test('escalates a marked single-call wrapper by default (no operator opt-in)', () => {
		for (const permission_policy of [
			{ enabled: true, allow_defaults: true },
			{ enabled: true, allow_defaults: true, trust_code_mode_wrapper: false },
		]) {
			const d = classifyFullAutoToolAction(
				input({
					toolName: 'execute',
					args: singleCall,
					hostCodeModeWrapper: true,
					fullAutoConfig: {
						enabled: true,
						mode: 'supervised',
						permission_policy,
					},
				}),
			);
			expect(d.action).toBe('escalate_critic');
		}
	});

	test('allows a marked single-call wrapper when the operator opts in', () => {
		const d = classifyFullAutoToolAction(
			input({
				toolName: 'execute',
				args: singleCall,
				hostCodeModeWrapper: true,
				fullAutoConfig: trusting(),
			}),
		);
		expect(d.action).toBe('allow');
		if (d.action === 'allow') expect(d.tier).toBe('local');
	});

	test('allows an opted-in marked single-call wrapper in strict mode too (nested call stays gated)', () => {
		const d = classifyFullAutoToolAction(
			input({
				toolName: 'execute',
				args: singleCall,
				hostCodeModeWrapper: true,
				fullAutoConfig: trusting('strict'),
			}),
		);
		expect(d.action).toBe('allow');
	});

	test('escalates an unmarked execute call (no v2 adapter mark, e.g. a v1 host) even when opted in', () => {
		// The classifier only trusts the adapter's per-call mark. A third-party
		// tool that shares the name `execute` on a v2 host IS marked by the
		// adapter and so is indistinguishable (see the real-adapter tests in
		// tests/unit/host/v2/code-mode-wrapper-3446.test.ts); that residual is
		// why the pass-through is an operator opt-in.
		for (const hostCodeModeWrapper of [undefined, false]) {
			const d = classifyFullAutoToolAction(
				input({
					toolName: 'execute',
					args: singleCall,
					hostCodeModeWrapper,
					fullAutoConfig: trusting(),
				}),
			);
			expect(d.action).toBe('escalate_critic');
		}
	});

	test('still escalates a marked wrapper whose program can reach the network or run arbitrary code', () => {
		const programs = [
			"return await fetch('http://localhost:4000/health');",
			"return await tools.x({ a: fetch('http://u') });",
			"await fetch('http://u'); return await tools.declare_scope({});",
			"return Function('return fetch')()('http://u');",
			"return tools['con' + 'structor']('return fetch')();",
			'const r = await tools.declare_scope({}); return r;',
			'return tools.x({}).then(fetch);',
		];
		for (const code of programs) {
			for (const mode of ['supervised', 'strict'] as const) {
				const d = classifyFullAutoToolAction(
					input({
						toolName: 'execute',
						args: { code },
						hostCodeModeWrapper: true,
						fullAutoConfig: trusting(mode),
					}),
				);
				expect(d.action).toBe('escalate_critic');
			}
		}
	});

	test('still escalates a marked execute call that carries no usable code program', () => {
		for (const args of [{}, { code: 42 }, { command: 'rm -rf /' }, undefined]) {
			const d = classifyFullAutoToolAction(
				input({
					toolName: 'execute',
					args: args as Record<string, unknown>,
					hostCodeModeWrapper: true,
					fullAutoConfig: trusting(),
				}),
			);
			expect(d.action).toBe('escalate_critic');
		}
	});

	test('does not treat other unknown tools as pass-through', () => {
		const d = classifyFullAutoToolAction(
			input({
				toolName: 'run_code',
				args: singleCall,
				hostCodeModeWrapper: true,
				fullAutoConfig: trusting(),
			}),
		);
		expect(d.action).toBe('escalate_critic');
	});
});

describe('classifyFullAutoToolAction — swarm_command (#3446)', () => {
	// The tool policy is an allowlist of what an AGENT may run, not a safety
	// classification: it includes state-changing and process-spawning commands.
	// Only the explicit read-only set passes (the permission hook computes the
	// verdict), and never in strict mode.
	const strict = {
		enabled: true,
		mode: 'strict' as const,
		permission_policy: { enabled: true, allow_defaults: true },
	};

	test('allows a command the permission hook marked read-only', () => {
		const d = classifyFullAutoToolAction(
			input({
				toolName: 'swarm_command',
				args: { command: 'status', args: [] },
				swarmCommandReadOnly: true,
			}),
		);
		expect(d.action).toBe('allow');
		if (d.action === 'allow') expect(d.tier).toBe('local');
	});

	test('escalates in strict mode even when read-only', () => {
		const d = classifyFullAutoToolAction(
			input({
				toolName: 'swarm_command',
				args: { command: 'status', args: [] },
				swarmCommandReadOnly: true,
				fullAutoConfig: strict,
			}),
		);
		expect(d.action).toBe('escalate_critic');
	});

	test('escalates when the read-only verdict is absent or false', () => {
		for (const swarmCommandReadOnly of [undefined, false]) {
			const d = classifyFullAutoToolAction(
				input({
					toolName: 'swarm_command',
					args: { command: 'sdd project', args: [] },
					swarmCommandReadOnly,
				}),
			);
			expect(d.action).toBe('escalate_critic');
		}
	});

	test('the verdict does not leak to other tools', () => {
		const d = classifyFullAutoToolAction(
			input({
				toolName: 'checkpoint',
				args: {},
				swarmCommandReadOnly: true,
			}),
		);
		expect(d.action).toBe('escalate_critic');
	});
});
