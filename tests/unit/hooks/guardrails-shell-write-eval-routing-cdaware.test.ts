/**
 * #3347 scope-gated eval routing — cd-aware effective-directory legs and the
 * recurrence guardrail. RED at the pre-#3347 base, GREEN after the fix.
 *
 * The frozen 3347 suite (guardrails-shell-write-eval-routing-3347.test.ts)
 * pins the no-cd directions (out-of-scope reject, read-only authority
 * reject, scope-less blanket retain, opaque/dynamic hard blocks). This
 * post-freeze sibling adds:
 * - the cd-aware routing target: an eval runs at its TRACKED working
 *   directory, so `cd src && python -c …` from a src/-scoped coder is
 *   in-scope and admitted, while the same eval at the root is rejected;
 * - same-interpreter MULTI-OCCURRENCE preservation through all three dedupe
 *   layers (detection, resolution, mergeWriteAnalyses): the second
 *   occurrence after an out-of-scope cd still reaches the scope check
 *   instead of collapsing into the first (plan-critic r2-3), including a
 *   compound that carries a Windows-detected write so the merged analysis
 *   path is exercised;
 * * - a Windows-style-cwd unit leg for the cd tracking (plan-critic r2-4);
 * - the recurrence guardrail scan: every interpreter_eval emit site in
 *   shell-write-detect.ts must either set `capability: true` or name the
 *   opaque class in its comment.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetObservedHostShell } from '../../../src/hooks/shell-executor-context';
import {
	detectWindowsWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-eval-cdaware-');

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

function makeBashInput(sessionID: string) {
	return { tool: 'bash' as const, sessionID, callID: 'call-1' };
}

function makeOutput(command: string) {
	return { args: { command } };
}

function scopedCoder(sessionId: string, scope: string[] = ['src/']): void {
	startAgentSession(sessionId, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionId,
		taskId: '1.1',
		files: scope,
		dispatchCallId: 'call-1',
	});
}

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cd-aware eval routing (#3347)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects a scoped coder eval at the session root (no cd)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('cd-1');

		await expect(
			hooks.toolBefore(
				makeBashInput('cd-1'),
				makeOutput(`python -c "print(1)"`),
			),
		).rejects.toThrow(/SCOPE_VIOLATION.*outside the active scope/);
	});

	it('admits a scoped coder eval after cd into the declared scope', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('cd-2');

		await expect(
			hooks.toolBefore(
				makeBashInput('cd-2'),
				makeOutput(`cd src && python -c "print(1)"`),
			),
		).resolves.toBeUndefined();
	});

	it('rejects the same eval after a cd back outside the scope', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('cd-3');

		// NOTE: semicolon-separated cds. A pre-existing walker gap (out of
		// this PR's scope, disclosed in the trace) loses the SECOND cd of a
		// single `cd a && cd b && …` chain; `;`-separated compounds track
		// every cd, which is the shape the multi-occurrence legs below use.
		await expect(
			hooks.toolBefore(
				makeBashInput('cd-3'),
				makeOutput(`cd src; cd ..; python -c "print(1)"`),
			),
		).rejects.toThrow(/SCOPE_VIOLATION.*outside the active scope/);
	});

	// The bare `eval '…'` keyword is intentionally NOT tested through the
	// gate: checkShellWriteScope unwraps shell wrappers (bash -c, sh -c,
	// eval) BEFORE detection (the dcUnwrapWrappers pass), so a benign
	// `eval "echo hi"` is analyzed as its inner read-only command and never
	// surfaces as a capability write. The detector-level `eval` emit stays
	// pinned by the emit-site guardrail scan below.
});

describe('opaque eval classes keep the blanket block (#3347)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('never capability-flags the opaque detector classes (mutation-probe M5 killer)', () => {
		// Detector level: the EncodedCommand / nested-script-block / dynamic
		// invocation writes must NOT carry the capability flag, or a scoped
		// agent could have them ROUTED instead of blanket-blocked. (Gate
		// level, these payloads are additionally defended by the fail-closed
		// parse gate, which fires first — pinned by the frozen 3347 suite's
		// /BLOCKED/ leg.)
		const encoded = detectWindowsWrites(
			'powershell -encodedcommand AAAA',
			'powershell',
		);
		expect(encoded.writes).toHaveLength(1);
		expect(encoded.writes[0].capability).toBeUndefined();

		const nested = detectWindowsWrites(
			'& ({ Set-Content ../outside.txt x })',
			'powershell',
		);
		expect(
			nested.writes.some(
				(w) => w.category === 'interpreter_eval' && w.capability === undefined,
			),
		).toBe(true);

		const dynamic = detectWindowsWrites(
			"Invoke-Expression 'Set-Content x y'",
			'powershell',
		);
		expect(
			dynamic.writes.some(
				(w) => w.category === 'interpreter_eval' && w.capability === undefined,
			),
		).toBe(true);
	});
});

describe('same-interpreter multi-occurrence preservation (#3347)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects when the SECOND same-interpreter eval sits outside the scope', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('occ-1');

		await expect(
			hooks.toolBefore(
				makeBashInput('occ-1'),
				makeOutput(
					`cd src && python -c "print(1)"; cd .. && python -c "print(2)"`,
				),
			),
		).rejects.toThrow(/SCOPE_VIOLATION.*outside the active scope/);
	});

	it('admits when every occurrence stays inside the scope', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('occ-2');

		await expect(
			hooks.toolBefore(
				makeBashInput('occ-2'),
				makeOutput(`cd src && python -c "print(1)" && python -c "print(2)"`),
			),
		).resolves.toBeUndefined();
	});

	it('rejects when the FIRST same-interpreter eval sits outside the scope (reverse order)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('occ-4');

		await expect(
			hooks.toolBefore(
				makeBashInput('occ-4'),
				makeOutput(`cd ..; python -c "print(1)"; cd src; python -c "print(2)"`),
			),
			// The cd target itself escapes the workspace, so the ROOT_ESCAPE
			// denial fires before the scope check — either way the out-of-scope
			// first occurrence cannot be admitted.
		).rejects.toThrow(
			/AUTHORITY_ROOT_ESCAPE|SCOPE_VIOLATION.*outside the active scope/,
		);
	});

	it('still rejects a command-substitution redirect target at the gate ($(cmd) form)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('occ-5');

		await expect(
			hooks.toolBefore(
				makeBashInput('occ-5'),
				makeOutput(`echo x > $(pwd)/out.txt`),
			),
		).rejects.toThrow(/dynamic path target|cannot be statically resolved/);
	});

	it('keeps the merged-analysis path occurrence-aware: a Windows-detected write in the compound does not collapse the out-of-scope second eval', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		scopedCoder('occ-3');

		// The Set-Content segment makes the Windows analysis non-empty, so the
		// gate runs mergeWriteAnalyses before resolution (the third dedupe
		// layer). The final python eval still sits at the session root.
		await expect(
			hooks.toolBefore(
				makeBashInput('occ-3'),
				makeOutput(
					`cd src && python -c "print(1)"; cd .. && Set-Content OUTSIDE.md hi; python -c "print(2)"`,
				),
			),
		).rejects.toThrow(/outside the active scope|not authorised/);
	});
});

describe('windows-safe cd tracking (#3347 plan r3)', () => {
	it('resolves a cd-relative redirect target under a native Windows cwd', () => {
		const writes = [
			{
				category: 'redirect' as const,
				operator: '>',
				path: 'out.txt',
			},
		];
		const result = resolveWriteTargets(
			'cd src && echo x > out.txt',
			writes,
			'C:\\work\\proj',
		);
		expect(result.length).toBe(1);
		expect(result[0].resolvedPath?.replace(/\//g, '\\')).toBe(
			'C:\\work\\proj\\src\\out.txt',
		);
	});

	it('carries the tracked directory as the capability eval working directory', () => {
		const analysis = resolveWriteTargets(
			'cd src && python -c "print(1)"',
			[
				{
					category: 'interpreter_eval' as const,
					operator: 'python [eval]',
					path: null,
					capability: true as const,
				},
			],
			'C:\\work\\proj',
		);
		expect(analysis.length).toBe(1);
		expect(analysis[0].evalDirectory?.replace(/\//g, '\\')).toBe(
			'C:\\work\\proj\\src',
		);
	});
});

describe('interpreter_eval emit-site guardrail (#3347 recurrence)', () => {
	afterEach(() => {
		resetObservedHostShell();
	});

	it('every interpreter_eval emit site is capability-flagged or documented opaque', () => {
		const source = readFileSync(
			path.join('src', 'hooks', 'shell-write-detect.ts'),
			'utf8',
		);
		const lines = source.split('\n');
		const offenders: string[] = [];
		lines.forEach((line, index) => {
			if (!line.includes("category: 'interpreter_eval'")) return;
			// A push site is classified by its surrounding window: the
			// capability flag must appear within the object literal (same or
			// next line), or the nearest comment above must name the opaque
			// class.
			const window = lines.slice(Math.max(0, index - 6), index + 4).join('\n');
			if (!/capability:\s*true|opaque/i.test(window)) {
				offenders.push(`line ${index + 1}: ${line.trim()}`);
			}
		});
		expect(offenders).toEqual([]);
	});
});
