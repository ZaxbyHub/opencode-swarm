/**
 * Tests for quoted-heredoc body neutralization in shell write detection
 * (#3754 + #3761) and the origin-aware parse/authority denial messages.
 *
 * #3761: bash-parser 0.5.0 has no heredoc-body lexing — dense quoted
 * heredoc writes to in-scope targets were hard-blocked as parse failures,
 * and body text was misread as live commands. #3754 F3: the
 * AUTHORITY_ROOT_ESCAPE denial names the deciding layer.
 *
 * @jest-environment node
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	neutralizeQuotedHeredocBodies,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-heredoc-3761-');

function defaultConfig(): GuardrailsConfig {
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

function coderSession(id: string): void {
	startAgentSession(id, 'coder');
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

const DENSE_BODY = [
	'# Bug Report — oow-write-routing',
	'',
	'## Symptom',
	'',
	'Out-of-workspace file writes have no sanctioned channel in the',
	'OpenCode session stack. Observed 2026-11-19: an agent appending a dated',
	"section to '~/.obsidian/Proofpoint/Projects/salman-homebrew-tap/findings.md'",
	"(a) found the 'write' tool blocked ('AUTHORITY_ROOT_ESCAPE'), (b) tried",
	"'cat >> … <<'EOF'' calling shell \"the sanctioned fallback\" — a",
	'self-invented justification, sanctioned nowhere — and was rejected by',
	"the swarm write guard with 'BLOCKED: bash write detection failed to",
	"parse command — rejecting for safety', (c) pivoted to 'desktop-commander' via the mesh",
	'write path (Cortex MCP) and the mandatory post-write audit.',
];

function denseCatCommand(target: string): string {
	return [`cat > ${target} <<'EOF'`, ...DENSE_BODY, 'EOF'].join('\n');
}

describe('guardrails quoted-heredoc neutralization (#3761)', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	beforeEach(() => {
		resetSwarmState();
	});

	describe('helper shape grammar', () => {
		it('neutralizes the dense cat shape (UTF-16 length + lines preserved)', () => {
			const cmd = denseCatCommand('notes/findings.md');
			const out = neutralizeQuotedHeredocBodies(cmd);
			expect(out).not.toBe(cmd);
			expect(out.length).toBe(cmd.length);
			expect(out.split('\n').length).toBe(cmd.split('\n').length);
			// opener + terminator verbatim, body blanked
			expect(out.split('\n')[0]).toBe(cmd.split('\n')[0]);
			expect(out.split('\n').at(-1)).toBe('EOF');
			expect(out).not.toContain('/etc/passwd');
		}, 60_000);

		it('refuses an astral body preserves UTF-16 length (emoji body)', () => {
			const cmd = "cat > notes/x.md <<'EOF'\nemoji 🌍 body line\nEOF";
			const out = neutralizeQuotedHeredocBodies(cmd);
			expect(out.length).toBe(cmd.length);
			expect(out).not.toContain('🌍');
		}, 60_000);

		it('refuses non-cat receivers, glued assignments, comments, multi-openers, here-strings, partial and unquoted delimiters', () => {
			const unchanged = [
				// executing receiver — the body is executed by bash
				"bash <<'EOF'\necho pwn > ../outside.md\nEOF",
				// glued env assignment: first token is cat=foo, real bash runs bash
				"cat=foo bash <<'EOF'\necho pwn > ../outside.md\nEOF",
				// word-start # comments out the opener, body lines are live
				"cat # <<'EOF'\necho pwn > ../outside.md\nEOF",
				"echo # <<'EOF'\necho pwn > ../outside.md\nEOF",
				// multiple heredoc openers (POSIX operator-order queue)
				"cat <<B <<'A'\n$(echo x > ../outside.md)\nB\ninert\nA",
				// here-string, not a heredoc
				"cat <<< 'not a heredoc' > notes/x.md",
				// escaped opener
				'cat \\<< "EOF" > notes/x.md',
				// partial-quoted delimiter
				"cat <<E'OF' > notes/x.md\nbody\nE'OF'",
				// unquoted delimiter (expansion-capable body)
				'cat <<EOF > notes/x.md\nfound the "write" tool ("X")\nEOF',
				// quoted redirect target
				"cat > 'my notes.md' <<'EOF'\nbody\nEOF",
				// compound: prior cd — resolution must keep the original text
				"cd .. && cat > notes/x.md <<'EOF'\nplain body\nEOF",
				// piped consumer
				"cat <<'EOF' | bash\necho pwn > ../outside.md\nEOF",
				// unclosed (no terminator)
				"cat > notes/x.md <<'EOF'\nnever terminated\n",
				// CRLF terminator does not match
				"cat > notes/x.md <<'EOF'\nbody\r\nEOF\r",
			];
			for (const cmd of unchanged) {
				expect(neutralizeQuotedHeredocBodies(cmd)).toBe(cmd);
			}
		}, 60_000);

		it('accepts the <<- tab-stripped terminator and a trailing newline', () => {
			const cmd =
				"cat > notes/x.md <<-'EOF'\n\tbody with leading-tab terminator\n\tEOF";
			const out = neutralizeQuotedHeredocBodies(cmd);
			expect(out).not.toBe(cmd);
			expect(out.length).toBe(cmd.length);
			const withNewline = "cat > notes/x.md <<'EOF'\nbody\nEOF\n";
			expect(neutralizeQuotedHeredocBodies(withNewline).length).toBe(
				withNewline.length,
			);
		}, 60_000);
	});

	describe('detector composition (the analysis the guard runs)', () => {
		it('dense quoted body is inert: /etc/passwd unreported, real target reported', () => {
			const cmd = "cat > notes/doc.md <<'EOF'\necho x > /etc/passwd\nEOF";
			const analysis = detectPosixWrites(neutralizeQuotedHeredocBodies(cmd));
			expect(analysis.parseError).toBeFalsy();
			const paths = analysis.writes
				.map((w) => w.path)
				.filter((p): p is string => typeof p === 'string');
			expect(paths).not.toContain('/etc/passwd');
			expect(paths.some((p) => p.endsWith('notes/doc.md'))).toBe(true);
		}, 60_000);

		it('unquoted dense body still parse-blocks at the detector (no widening)', () => {
			const cmd =
				'cat > notes/x.md <<EOF\nfound the "write" tool ("X") and (parens)\nEOF';
			const analysis = detectPosixWrites(neutralizeQuotedHeredocBodies(cmd));
			expect(analysis.parseError).toBe(true);
		}, 60_000);

		it('unclosed quoted heredoc: detector behavior unchanged (parseError falsy, redirect reported)', () => {
			const cmd = [
				"cat > notes/x.md <<'EOF'",
				'first body line never terminated',
				'second body line never terminated',
			].join('\n');
			const analysis = detectPosixWrites(cmd);
			expect(analysis.parseError).toBeFalsy();
			const paths = analysis.writes
				.map((w) => w.path)
				.filter((p): p is string => typeof p === 'string');
			expect(paths.some((p) => p.endsWith('notes/x.md'))).toBe(true);
		}, 60_000);
	});

	describe('end-to-end through the real guard', () => {
		it('dense quoted heredoc to an in-scope target is not parse-blocked', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('heredoc-e2e-1');
			setDeclaredScope('heredoc-e2e-1', ['notes/']);
			try {
				await hooks.toolBefore(
					{ tool: 'bash', sessionID: 'heredoc-e2e-1', callID: 'c1' },
					{ args: { command: denseCatCommand('notes/findings.md') } },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				expect(msg).not.toContain('failed to parse command');
			}
		}, 60_000);

		it('dense quoted heredoc to an out-of-scope target blocks with a scope/authority denial', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('heredoc-e2e-2');
			setDeclaredScope('heredoc-e2e-2', ['notes/']);
			expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'heredoc-e2e-2', callID: 'c1' },
					{ args: { command: denseCatCommand('../outside/esc.md') } },
				),
			).rejects.toThrow(/SCOPE_VIOLATION|AUTHORITY_ROOT_ESCAPE/);
		}, 60_000);

		it('receiver-execution shapes stay blocked (bash stdin, cat|bash)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('heredoc-e2e-3');
			setDeclaredScope('heredoc-e2e-3', ['notes/']);
			await expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'heredoc-e2e-3', callID: 'c1' },
					{
						args: {
							command: "bash <<'EOF'\necho pwn > ../outside/esc.md\nEOF",
						},
					},
				),
			).rejects.toThrow(/BLOCKED|WRITE BLOCKED/);
		}, 60_000);

		it('genuine parse failures carry the not-a-policy-refusal clause', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('heredoc-e2e-4');
			setDeclaredScope('heredoc-e2e-4', ['notes/']);
			expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'heredoc-e2e-4', callID: 'c1' },
					{ args: { command: "echo 'unclosed quote" } },
				),
			).rejects.toThrow(
				/parse failure, not a policy refusal|failed to parse command \(parse failure/,
			);
		}, 60_000);

		it('ambient shell-state assignment is a POLICY refusal, not a parse failure', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('heredoc-e2e-5');
			setDeclaredScope('heredoc-e2e-5', ['notes/']);
			expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'heredoc-e2e-5', callID: 'c1' },
					{ args: { command: 'BASH_ENV=/tmp/x.sh cat notes/a.md' } },
				),
			).rejects.toThrow(/ambient shell-state key .* policy refusal/);
		}, 60_000);

		it('inert ambient-state text in a quoted body no longer trips the policy scan', () => {
			const cmd = "cat > notes/env.md <<'EOF'\nexport BASH_ENV=/tmp/x.sh\nEOF";
			const analysis = detectPosixWrites(neutralizeQuotedHeredocBodies(cmd));
			expect(analysis.parseError).toBeFalsy();
			expect(
				analysis.writes.some(
					(w) => w.operator === 'ambient shell-state key assignment',
				),
			).toBe(false);
		}, 60_000);
	});

	describe('AUTHORITY_ROOT_ESCAPE names the deciding layer (#3754 F3)', () => {
		it('write-tool denial carries layer=containment and the external_directory hint', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('heredoc-auth-1');
			setDeclaredScope('heredoc-auth-1', ['notes/']);
			const outsideAbs = path.resolve(TEST_DIR, '..', 'esc-3761.md');
			try {
				await hooks.toolBefore(
					{ tool: 'write', sessionID: 'heredoc-auth-1', callID: 'c1' },
					{ args: { path: outsideAbs, content: 'x' } },
				);
				throw new Error('expected the write to be denied');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				expect(msg).toContain('AUTHORITY_ROOT_ESCAPE');
				expect(msg).toContain('layer=containment');
				expect(msg).toContain('permission.external_directory');
			}
		}, 60_000);
	});
});
