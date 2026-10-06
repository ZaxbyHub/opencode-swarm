/**
 * Integration: an expansion inside the sed `-i` flag word itself
 * (`X=' 1d /etc/passwd'; sed -i$X src/a.ts`) splits into `-i`, a script and
 * extra files at run time. The detector reports the flag word as a dynamic
 * candidate, so the guardrails toolBefore hook blocks the call for every
 * role instead of admitting the hidden write.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { startAgentSession } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-inplace-flag-');

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

function bashInput(sessionID: string) {
	return { tool: 'bash' as const, sessionID, callID: 'call-1' };
}

function output(command: string) {
	return { args: { command } };
}

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('guardrails shell writes: an expansion in the sed -i flag word', () => {
	const COMMAND = "X=' 1d /etc/passwd'; sed -i$X src/a.ts";

	it.each([
		'sme',
		'critic_sounding_board',
		'architect',
	])('%s: the call is blocked as a dynamic write target', async (role) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`${role}-inplace-flag`, role);
		await expect(
			hooks.toolBefore(bashInput(`${role}-inplace-flag`), output(COMMAND)),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "-i\$X" that cannot be statically resolved/,
		);
	});

	// Any option word, not only -i: `-e$X` splits into `-e 1d /etc/passwd`.
	it('sme: an expansion in the -e word is blocked as a dynamic target', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('sme-e-flag', 'sme');
		await expect(
			hooks.toolBefore(
				bashInput('sme-e-flag'),
				output("X=' 1d /etc/passwd'; sed -e$X -i src/a.ts"),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "-e\$X" that cannot be statically resolved/,
		);
	});

	// A detached option argument: `-e $X` splits into `-e 1d /etc/passwd`.
	it('architect: an expansion in a detached -e argument is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-e-arg', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-e-arg'),
				output("X='1d /etc/passwd'; sed -e $X -i src/a.ts"),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "\$X" that cannot be statically resolved/,
		);
	});

	// A quote inside a command substitution must not hide the unquoted `$X`
	// after it: `"$(: "'")"$X` runs `sed -i -n 1d /etc/passwd src/f.ts`.
	it('architect: a word with a command substitution is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-subst-quote', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-subst-quote'),
				output(`X='1d /etc/passwd'; sed -i -n "$(: "'")"$X src/f.ts`),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target ""\$\(: "'"\)"\$X" that cannot be statically resolved/,
		);
	});

	// A double quote inside single quotes opens nothing: `'"'$X` runs
	// `sed -i -n '"1d' /etc/passwd src/f.ts`.
	it('architect: an unquoted expansion after a quoted quote is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-sq-quote', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-sq-quote'),
				output(`X='1d /etc/passwd'; sed -i -n '"'$X src/f.ts`),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "'"'\$X" that cannot be statically resolved/,
		);
	});

	// A backslash-escaped quote opens nothing: `\"$X` splits.
	it('architect: an unquoted expansion after an escaped quote is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-bs-quote', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-bs-quote'),
				output(String.raw`X='1d /etc/passwd'; sed -i -n \"$X src/f.ts`),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "\\"\$X" that cannot be statically resolved/,
		);
	});

	// An array expansion splits even inside double quotes.
	it('architect: a quoted array expansion in the -e word is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-e-array', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-e-array'),
				output('sed -e"${A[@]}" -i src/f.ts'),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "-e"\$\{A\[@\]\}"" that cannot be statically resolved/,
		);
	});

	// A double-quoted script variable is one word: the in-scope edit passes.
	it('architect: a double-quoted script expansion is not a write target', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-quoted-script', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-quoted-script'),
				output('sed -i -e "s/$a/$b/" src/a.ts'),
			),
		).resolves.toBeUndefined();
	});
});
