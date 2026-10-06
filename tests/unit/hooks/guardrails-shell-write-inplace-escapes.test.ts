/**
 * Integration: quoted C escapes (`'s/\t/ /'`, `-F '\t'`) in sed, perl and
 * awk scripts reach the guardrails toolBefore hook as one quoted word and are
 * allowed for the architect and for a coder scoped to src/. The same commands
 * with a file outside the root are still blocked, and a glob in a sed `-f`
 * argument (`../*.sed`) is still blocked for read-only roles.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-escapes-');

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

let sessionCounter = 0;
function session(role: string, scoped = false): string {
	const id = `${role}-escapes-${sessionCounter++}`;
	startAgentSession(id, role);
	if (scoped) {
		installActiveScopeBinding({
			directory: TEST_DIR,
			childSessionId: id,
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});
	}
	return id;
}

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

const rootEscape = (role: string, path: string) =>
	new RegExp(
		`^WRITE BLOCKED: Agent "${role}" is not authorised to write "[^"]*${path}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
	);

// Each allowed form, paired with the same script editing a file outside the
// root (rejected), so the allowed rows cannot pass by allowing everything.
const ESCAPE_FORMS = [
	String.raw`sed -i -e 's/\t/ /g'`,
	String.raw`sed -i -e 's/\r$//'`,
	String.raw`sed -i -e 's/a\nb/c/'`,
	String.raw`sed -i -e "s/\t/ /"`,
	String.raw`sed -i --expression 's/\t//'`,
	String.raw`sed -i -e 's/\x41/A/'`,
	String.raw`perl -i -pe 's/\t/ /g'`,
	String.raw`perl -i -pe 's/\r//'`,
	String.raw`perl -i -pe 's/\n//'`,
	String.raw`awk -i inplace -e '{gsub(/\t/," ")}1'`,
	String.raw`awk -i inplace -v OFS='\t' '{$1=$1}1'`,
	String.raw`awk -i inplace -F '\t' '{print $2}'`,
	String.raw`awk -i inplace -F "\t" '{print $2}'`,
	String.raw`awk -i inplace -F '[\t ]' '{print}'`,
	"echo 😀; sed -i -e 's/a*/b/'",
];

describe('guardrails shell writes: quoted C escapes in in-place scripts', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each(
		ESCAPE_FORMS.flatMap((form) => [
			['architect', form, false] as const,
			['coder', form, true] as const,
		]),
	)('%s: %s src/a.ts is allowed', async (role, form, scoped) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role, scoped);
		await expect(
			hooks.toolBefore(bashInput(id), output(`${form} src/a.ts`)),
		).resolves.toBeUndefined();
	});

	it.each(
		ESCAPE_FORMS.flatMap((form) => [
			['architect', form, false] as const,
			['coder', form, true] as const,
		]),
	)('%s: %s src/a.ts ../v is blocked', async (role, form, scoped) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role, scoped);
		await expect(
			hooks.toolBefore(bashInput(id), output(`${form} src/a.ts ../v`)),
		).rejects.toThrow(rootEscape(role, String.raw`[\\/]v`));
	});

	// A glob in a sed script-file argument splits into the script file and
	// more files to edit (mirrors the `../[ab].sed` row).
	it.each([
		'architect',
		'sme',
		'critic_sounding_board',
	])('%s: sed -i -f ../*.sed src/a.ts is blocked', async (role) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role);
		await expect(
			hooks.toolBefore(bashInput(id), output('sed -i -f ../*.sed src/a.ts')),
		).rejects.toThrow(rootEscape(role, String.raw`[\\/]\*\.sed`));
	});

	// An unquoted glob after a character outside the BMP is still seen.
	it('architect: echo 😀; sed -i -e * ../v src/a.ts is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session('architect');
		await expect(
			hooks.toolBefore(
				bashInput(id),
				output('echo 😀; sed -i -e * ../v src/a.ts'),
			),
		).rejects.toThrow(rootEscape('architect', String.raw`[\\/]v`));
	});
});
