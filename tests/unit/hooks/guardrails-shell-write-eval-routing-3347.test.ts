/**
 * Inspectable POSIX inline-code interpreter evals must be ROUTED through the
 * same universal-deny / file-authority / declared-scope checks as any other
 * write, with the session's effective directory (the project root in these
 * tests) as the target — instead of the blanket
 * "BLOCKED: python [eval] evaluates inline code …" throw (issue #3347 /
 * #3323 item 3).
 *
 * Post-fix outcomes pinned here:
 * - read-only roles (explorer, sme) are rejected by the file-authority check
 *   ("not authorised to write" + the agent name);
 * - a coder with declared scope `src/` running an eval from the project-root
 *   cwd (outside the scope) gets the declared-scope rejection (scope-shaped
 *   error, NOT the blanket eval message);
 * - scope-gated routing (plan-critic round 1, finding 2): read-only roles'
 *   evals are rejected by the file-authority check naming the role; evals for
 *   agents WITH a declared scope route at the eval's effective directory
 *   (out-of-scope rejects with the scope error); scope-less write-capable
 *   roles (architect, reviewer) KEEP the fail-closed eval block — the
 *   #3347 AC3 "eval-block tests pass at head" wording and the config-zone
 *   eval guard pin (guardrails-shell-write.test.ts s53) stay green;
 * - opaque eval classes (PowerShell -EncodedCommand) and dynamic redirect
 *   targets keep their hard blocks;
 * - a non-canonical spelling (`env python3.12 -c …`, issue #3343) flows
 *   detect-then-route end to end.
 *
 * RED at base, GREEN after the fix (#3347).
 *
 * Deviation note: the originally sketched "coder + scope covering the whole
 * test root (files: ['./'])" leg is inexpressible — normalizeScopePath
 * (src/scope/scope-binding.ts) rejects '.', './' and '' so createScopeBinding
 * returns null and every legal binding's entries resolve to proper subpaths
 * of the effective directory. In-scope eval legs therefore use `cd` into the
 * declared scope (cd-aware effective directory) and live in the post-freeze
 * sibling suite guardrails-shell-write-eval-routing-cdaware.test.ts; this
 * frozen file pins the out-of-scope, read-only, scope-less, opaque, and
 * dynamic-target directions.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-eval-routing-');
const BLANKET_EVAL_MESSAGE = /evaluates inline code/;

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeBashInput(sessionID: string, callID = 'call-1') {
	return { tool: 'bash' as const, sessionID, callID };
}

function makeShellInput(sessionID: string, callID = 'call-1') {
	return { tool: 'shell' as const, sessionID, callID };
}

function setDeclaredScope(sessionId: string, scope: string[]): void {
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionId,
		taskId: '1.1',
		files: scope,
		dispatchCallId: 'call-1',
	});
}

const PY_EVAL = 'python -c "print(1)"';

describe('null-path eval authority', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects an explorer eval with the file-authority error naming the agent', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-explorer', 'explorer');

		let caught: Error | undefined;
		try {
			await hooks.toolBefore(makeBashInput('s347-explorer'), {
				args: { command: PY_EVAL },
			});
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toContain('not authorised to write');
		expect(caught?.message).toContain('explorer');
	});

	it('rejects an sme eval with the file-authority error naming the agent', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-sme', 'sme');

		let caught: Error | undefined;
		try {
			await hooks.toolBefore(makeBashInput('s347-sme'), {
				args: { command: PY_EVAL },
			});
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toContain('not authorised to write');
		expect(caught?.message).toContain('sme');
	});
});

describe('null-path eval declared scope', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects a coder eval outside the declared scope with a scope-shaped error, not the blanket eval block', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-coder-src', 'coder');
		setDeclaredScope('s347-coder-src', ['src/']);

		let caught: Error | undefined;
		try {
			await hooks.toolBefore(makeBashInput('s347-coder-src'), {
				args: { command: PY_EVAL },
			});
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toMatch(
			/outside the (active|declared) scope|SCOPE_VIOLATION|not authorised/,
		);
		expect(caught?.message).not.toMatch(BLANKET_EVAL_MESSAGE);
	});

	it('keeps a scope-free write-capable reviewer eval fail-closed (scope-gated routing)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-reviewer', 'reviewer');

		await expect(
			hooks.toolBefore(makeBashInput('s347-reviewer'), {
				args: { command: PY_EVAL },
			}),
		).rejects.toThrow(BLANKET_EVAL_MESSAGE);
	});

	it('keeps the architect eval fail-closed at the project root (config-zone guard retained)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-architect', 'architect');

		await expect(
			hooks.toolBefore(makeBashInput('s347-architect'), {
				args: { command: PY_EVAL },
			}),
		).rejects.toThrow(BLANKET_EVAL_MESSAGE);
	});

	it('still blocks a PowerShell -EncodedCommand eval (opaque class keeps the hard block)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-arch-enc', 'architect');

		await expect(
			hooks.toolBefore(makeShellInput('s347-arch-enc'), {
				args: { command: 'powershell -encodedcommand AAAA' },
			}),
		).rejects.toThrow(/BLOCKED/);
	});

	it('still blocks a dynamic redirect target ($VAR) for a scoped coder', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-coder-dyn', 'coder');
		setDeclaredScope('s347-coder-dyn', ['src/']);

		await expect(
			hooks.toolBefore(makeBashInput('s347-coder-dyn'), {
				args: { command: 'echo x > $OUT' },
			}),
		).rejects.toThrow(/dynamic path target|cannot be statically resolved/);
	});
});

describe('non-canonical spelling integration', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	beforeEach(() => {
		resetSwarmState();
	});

	it('routes an env python3.12 eval through the scope check (#3343 detection + #3347 routing)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('s347-coder-env', 'coder');
		setDeclaredScope('s347-coder-env', ['src/']);

		let caught: Error | undefined;
		try {
			await hooks.toolBefore(makeBashInput('s347-coder-env'), {
				args: {
					command: `env python3.12 -c "open('out.txt','w').write('x')"`,
				},
			});
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toMatch(
			/outside the (active|declared) scope|SCOPE_VIOLATION|not authorised/,
		);
		expect(caught?.message).not.toMatch(BLANKET_EVAL_MESSAGE);
	});
});
