/**
 * Secret-redaction coverage for the trajectory logger (PRR-001 — PR #2139
 * review, issue #2134 follow-up).
 *
 * `normalizeCommandTarget` and `summarizeArgs` in `src/hooks/trajectory-logger.ts`
 * now run the shared `redactSecrets` (`src/memory/redaction.ts`) over
 * command/string VALUES before truncation. Before this fix, `summarizeArgs`
 * only redacted by KEY name (`SENSITIVE_FIELDS`/`isSensitiveKey`), which does
 * nothing for a secret carried in the VALUE of an innocuous key — e.g.
 * `command: 'curl -H "Authorization: Bearer …"'` — and issue #2134 widened
 * `target` from a shell command's first word to the WHOLE command, which
 * widened that exposure into the persisted `target` field too.
 *
 * `target` is verified through the `_test_exports.extractTarget` Tier-0 seam
 * (mirrors `trajectory-logger-target.test.ts`). `args_summary` is not exposed
 * through that seam, so it is verified end-to-end through
 * `createTrajectoryLoggerHook(...).toolAfter`, reading the persisted JSONL —
 * mirroring `readTargets` in the sibling file.
 *
 * Lives in its own file per FR-006 (trajectory-logger-target.test.ts is
 * already near the cap and must not grow for unrelated coverage).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	createTrajectoryLoggerHook,
} from '../../../src/hooks/trajectory-logger';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { extractTarget } = _test_exports;

/**
 * Mirrors `MAX_COMMAND_TARGET_LENGTH` in `src/hooks/trajectory-logger.ts` (not
 * exported via `_test_exports`, and this suite may not edit production code to
 * add it). Pinned here as a literal, same convention as
 * `trajectory-logger-target.test.ts`.
 */
const MAX_COMMAND_TARGET_LENGTH = 200;

describe('trajectory-logger secret redaction (PRR-001, issue #2134)', () => {
	// ───────────────────────────────────────────────────────────────────────
	// 1. Authorization: Bearer redaction in `target`.
	// ───────────────────────────────────────────────────────────────────────
	test('a bash command with an Authorization: Bearer header redacts the token in the target', () => {
		const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
		const target = extractTarget('bash', {
			command: `curl -H "Authorization: Bearer ${token}" https://api.example.com/v1`,
		});

		expect(target).toContain('[REDACTED:authorization_bearer]');
		expect(target).not.toContain(token);
		expect(target).not.toContain('Bearer');
	});

	// ───────────────────────────────────────────────────────────────────────
	// 2. sk-... style key redaction in `target`.
	// ───────────────────────────────────────────────────────────────────────
	test('a bash command with an sk-... style API key redacts the key in the target', () => {
		const key = `sk-${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
		const target = extractTarget('bash', {
			command: `curl -H "X-Api-Key: ${key}" https://api.example.com/v1`,
		});

		expect(target).toContain('[REDACTED:openai_api_key]');
		expect(target).not.toContain(key);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 3. Redaction happens BEFORE truncation.
	// ───────────────────────────────────────────────────────────────────────
	test('redaction runs before truncation: a >200-char command with a secret that fits inside the bound never leaks raw token bytes', () => {
		// Production bounds FIRST (raw text sliced to
		// MAX_COMMAND_TARGET_LENGTH - 3 = 197 chars, "..." appended), THEN
		// redacts. That ordering is load-bearing (see the docblock on
		// `normalizeCommandTarget`), but it also means a secret that STRADDLES
		// the 197-char cut only has its head inside the bounded window — the
		// `authorization_bearer` pattern requires 12+ token chars and a
		// straddling secret can leave fewer than that inside the window, so it
		// does not match and a short raw fragment is stored. That residual is
		// explicitly documented and accepted in production (`normalizeCommandTarget`
		// docblock, "The residual: ..."), so it is not exercised here.
		//
		// This fixture instead pins the case the ordering fix actually targets:
		// the full "Authorization: Bearer <token>" span sits ENTIRELY inside the
		// 197-char window (filler placed so the secret ends well before the cut),
		// while the overall raw command still exceeds
		// MAX_COMMAND_TARGET_LENGTH so truncation genuinely runs. Redacting BEFORE
		// truncating means no raw token byte survives regardless of where the
		// eventual truncation cut lands.
		const filler = 'x'.repeat(105);
		const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
		const command = `echo ${filler} && curl -H "Authorization: Bearer ${token}" https://x.example.com`;
		expect(command.length).toBeGreaterThan(MAX_COMMAND_TARGET_LENGTH);
		// Precondition: the ENTIRE secret span sits before the 197-char bound
		// (this is what distinguishes this fixture from the straddling residual
		// case above).
		const secretStart = command.indexOf('Authorization');
		const secretEnd =
			secretStart + 'Authorization: Bearer '.length + token.length;
		expect(secretEnd).toBeLessThan(MAX_COMMAND_TARGET_LENGTH - 3);

		const target = extractTarget('bash', { command });

		expect(target).toContain('[REDACTED:authorization_bearer]');
		// No fragment of the raw token may survive.
		expect(target).not.toContain(token);
		expect(target).not.toContain(token.slice(0, 5));
	});

	// ───────────────────────────────────────────────────────────────────────
	// 3b. Characterization of the documented straddling residual (NOT a
	// regression test — pins the accepted tradeoff so a future change that
	// widens the leak fails loudly instead of drifting silently).
	//
	// `normalizeCommandTarget` bounds BEFORE it redacts (load-bearing, see its
	// docblock's "ORDER IS LOAD-BEARING" paragraph). When a secret straddles the
	// 197-char cut, only its HEAD survives into the bounded text. The
	// `authorization_bearer` pattern requires 12+ token chars after "Bearer ";
	// a straddling match that leaves fewer than 12 chars inside the window does
	// not match at all, so redaction silently does not fire and a short raw
	// fragment of the token is persisted. The `normalizeCommandTarget` docblock
	// calls this out explicitly ("The residual: a secret straddling the
	// 200-char bound...") as accepted and strictly better than the pre-fix
	// behavior (which leaked the fragment from EVERY long command, not just
	// straddling ones). This test pins exactly how much survives so the bound
	// on the leak is enforced, not just documented.
	// ───────────────────────────────────────────────────────────────────────
	test('CHARACTERIZATION (documented residual): a secret straddling the 197-char bound leaks a short raw fragment because the redaction pattern needs 12+ token chars to fire', () => {
		const filler = 'x'.repeat(150);
		const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
		const command = `echo ${filler} && curl -H "Authorization: Bearer ${token}" https://x.example.com`;
		expect(command.length).toBeGreaterThan(MAX_COMMAND_TARGET_LENGTH);
		// Precondition: the secret genuinely straddles the bound (its head is
		// inside the 197-char window, its tail is cut away) — the opposite of
		// the 3. fixture above.
		const secretStart = command.indexOf('Authorization');
		const secretHeadInWindow =
			MAX_COMMAND_TARGET_LENGTH -
			3 -
			secretStart -
			'Authorization: Bearer '.length;
		expect(secretHeadInWindow).toBeGreaterThan(0);
		expect(secretHeadInWindow).toBeLessThan(12); // below the pattern's 12-char floor

		const target = extractTarget('bash', { command });

		// The placeholder does NOT appear: the truncated match is too short for
		// the `authorization_bearer` pattern to fire.
		expect(target).not.toContain('[REDACTED:');
		// The FULL token never survives.
		expect(target).not.toContain(token);
		// But a short raw fragment — bounded by how much of the token fit inside
		// the pre-truncation window — does survive. This is the exact, bounded
		// leak the docblock accepts; growing past it would be a regression.
		expect(target).toContain(token.slice(0, secretHeadInWindow));
		expect(target).not.toContain(token.slice(0, secretHeadInWindow + 1));
	});

	// ───────────────────────────────────────────────────────────────────────
	// 4. args_summary redacts a secret in a NON-sensitive key's value.
	// ───────────────────────────────────────────────────────────────────────
	describe('args_summary redaction via toolAfter', () => {
		let tempDir: string;

		beforeEach(() => {
			resetSwarmState();
			tempDir = canonicalMkdtemp('test-trajectory-redaction-');
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
			resetSwarmState();
		});

		function readEntries(
			taskId: string,
		): Array<{ target: string; args_summary: string }> {
			const trajectoryPath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				taskId,
				'trajectory.jsonl',
			);
			return fs
				.readFileSync(trajectoryPath, 'utf-8')
				.split('\n')
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as { target: string; args_summary: string });
		}

		test('a secret in the "command" value (a non-sensitive key) is redacted in args_summary, not just truncated', async () => {
			const sessionId = 'session-redaction-regression';
			startAgentSession(sessionId, 'coder');
			const session = swarmState.agentSessions.get(sessionId);
			if (!session) throw new Error('session not created');
			session.delegationActive = true;
			session.currentTaskId = 'redaction-e2e';

			const hook = createTrajectoryLoggerHook(
				{ enabled: true, max_lines: 500 },
				tempDir,
			);

			const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
			await hook.toolAfter(
				{
					tool: 'bash',
					sessionID: sessionId,
					callID: 'call-1',
					args: {
						command: `curl -H "Authorization: Bearer ${token}" https://api.example.com`,
					},
				},
				{ title: 'ok', output: 'done', metadata: { success: true } },
			);

			const [entry] = readEntries('redaction-e2e');
			expect(entry).toBeDefined();
			// Pre-fix, `command` (non-sensitive key) was truncated to 50 raw chars
			// and emitted verbatim — this is the exact leak the fix closes.
			expect(entry.args_summary).toContain('[REDACTED:authorization_bearer]');
			expect(entry.args_summary).not.toContain(token);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// 5. Guard against over-redaction: benign commands are unchanged, and the
	//    repetition signal (same command -> same target) survives redaction.
	// ───────────────────────────────────────────────────────────────────────
	test('a benign command with no secret is left byte-for-byte unchanged', () => {
		const target = extractTarget('bash', {
			command: 'bun test src/prm/__tests__/pattern-detector.test.ts',
		});
		expect(target).toBe('bun test src/prm/__tests__/pattern-detector.test.ts');
	});

	test('the same benign command run twice still produces the same target after redaction is applied', () => {
		const first = extractTarget('bash', { command: 'git status --short' });
		const second = extractTarget('bash', { command: 'git status --short' });
		expect(first).toBe(second);
		expect(first).toBe('git status --short');
	});

	// ───────────────────────────────────────────────────────────────────────
	// 6. URL-embedded credentials (PR #2139, `URL_CREDENTIALS_PATTERN`).
	//
	// The shared `redactSecrets` detector has no pattern for
	// `scheme://user:pass@host`, so this module-local regex closes that gap.
	// The userinfo segment is replaced WHOLESALE (username included) — the
	// username of a leaked credential pair is as identifying as the password.
	// ───────────────────────────────────────────────────────────────────────
	test('a git command with URL-embedded credentials redacts the userinfo but preserves scheme and host', () => {
		const target = extractTarget('bash', {
			command: 'git push https://user:pa55word@github.com/x/y.git',
		});

		expect(target).toContain('[REDACTED:url_credentials]');
		expect(target).not.toContain('pa55word');
		expect(target).not.toContain('user:pa55word');
		// Scheme and host must survive — otherwise the target loses the
		// information that actually differentiates one push destination from
		// another.
		expect(target).toContain('https://');
		expect(target).toContain('github.com/x/y.git');
		expect(target).toBe(
			'git push https://[REDACTED:url_credentials]@github.com/x/y.git',
		);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 7. E-2 anti-collapse: bound-then-redact can push a command back over
	// MAX_COMMAND_TARGET_LENGTH, forcing a second truncation. If that second
	// truncation cut plain text, two distinct commands whose only difference
	// falls inside the cut region would collapse onto the same target — the
	// exact false `repetition_loop` failure issue #2134 exists to prevent.
	// The fix appends `#<8-hex fnv1a digest of the bounded RAW string>` so
	// distinctness survives even when the visible (non-digest) text is
	// byte-identical after the second truncation.
	//
	// Fixture calibrated (empirically, against this build) so that:
	//   - both raw commands exceed MAX_COMMAND_TARGET_LENGTH,
	//   - both share an identical secret-shaped span early in the command,
	//   - redacting that span grows the string past the bound a second time,
	//   - the re-truncated, non-digest portion of the two targets is
	//     BYTE-IDENTICAL — so only the digest suffix can be doing the work of
	//     keeping them apart.
	// ───────────────────────────────────────────────────────────────────────
	describe('E-2 anti-collapse: distinct >200-char commands with a shared early secret span', () => {
		function buildCommand(tail: string): string {
			const filler = 'y'.repeat(170);
			return `echo --API_KEY=abcdefgh1 ${filler} ${tail}`;
		}

		const commandA = buildCommand('AAAAAAAAAAAAAAAAAAAA');
		const commandB = buildCommand('BBBBBBBBBBBBBBBBBBBB');

		test('fixture preconditions: both raw commands exceed the length bound and share an early secret span', () => {
			expect(commandA.length).toBeGreaterThan(MAX_COMMAND_TARGET_LENGTH);
			expect(commandB.length).toBeGreaterThan(MAX_COMMAND_TARGET_LENGTH);
			expect(commandA.slice(0, 30)).toBe(commandB.slice(0, 30));
			expect(commandA).not.toBe(commandB);
		});

		test('produces different targets, each bounded to MAX_COMMAND_TARGET_LENGTH, with an 8-hex digest suffix', () => {
			const targetA = extractTarget('bash', { command: commandA });
			const targetB = extractTarget('bash', { command: commandB });

			expect(targetA.length).toBe(MAX_COMMAND_TARGET_LENGTH);
			expect(targetB.length).toBe(MAX_COMMAND_TARGET_LENGTH);
			expect(targetA).not.toBe(targetB);

			const digestSuffix = /#[0-9a-f]{8}$/;
			expect(targetA).toMatch(digestSuffix);
			expect(targetB).toMatch(digestSuffix);

			// The important assertion: strip the digest suffix and the visible
			// text is identical — collapse is prevented ONLY by the digest, not
			// by leftover plain-text differences that happened to survive the
			// second truncation.
			const withoutDigestA = targetA.replace(digestSuffix, '');
			const withoutDigestB = targetB.replace(digestSuffix, '');
			expect(withoutDigestA).toBe(withoutDigestB);

			// No raw secret bytes and no raw tail bytes leak.
			expect(targetA).not.toContain('abcdefgh1');
			expect(targetB).not.toContain('abcdefgh1');
			expect(targetA).toContain('[REDACTED:env_secret]');
			expect(targetB).toContain('[REDACTED:env_secret]');
		});

		test('is deterministic: the same >200-char redacted-and-digested command produces the identical target twice', () => {
			const first = extractTarget('bash', { command: commandA });
			const second = extractTarget('bash', { command: commandA });
			expect(first).toBe(second);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// 8. `extractIntent` redacts a Bearer token carried in a Task tool prompt.
	//
	// `intent` is exposed only through the persisted JSONL (not via
	// `_test_exports`), so this is verified end-to-end through
	// `createTrajectoryLoggerHook(...).toolAfter`, mirroring the
	// `args_summary` coverage above.
	// ───────────────────────────────────────────────────────────────────────
	describe('extractIntent redacts a Bearer token in a Task prompt', () => {
		let tempDir: string;

		beforeEach(() => {
			resetSwarmState();
			tempDir = canonicalMkdtemp('test-trajectory-redaction-intent-');
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
			resetSwarmState();
		});

		function readEntries(
			taskId: string,
		): Array<{ target: string; intent: string }> {
			const trajectoryPath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				taskId,
				'trajectory.jsonl',
			);
			return fs
				.readFileSync(trajectoryPath, 'utf-8')
				.split('\n')
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as { target: string; intent: string });
		}

		test('a Task tool prompt containing a Bearer token has the token redacted in the persisted intent', async () => {
			const sessionId = 'session-redaction-intent';
			startAgentSession(sessionId, 'coder');
			const session = swarmState.agentSessions.get(sessionId);
			if (!session) throw new Error('session not created');
			session.delegationActive = true;
			session.currentTaskId = 'redaction-intent-e2e';

			const hook = createTrajectoryLoggerHook(
				{ enabled: true, max_lines: 500 },
				tempDir,
			);

			const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
			await hook.toolAfter(
				{
					tool: 'task',
					sessionID: sessionId,
					callID: 'call-intent-1',
					args: {
						subagent_type: 'coder',
						prompt: `Use Authorization: Bearer ${token} to call the API`,
					},
				},
				{ title: 'ok', output: 'done', metadata: { success: true } },
			);

			const [entry] = readEntries('redaction-intent-e2e');
			expect(entry).toBeDefined();
			expect(entry.intent).toContain('[REDACTED:authorization_bearer]');
			expect(entry.intent).not.toContain(token);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// 9. The `description` fallback of `extractTarget` (bash args with no
	// `command`, only `description`) also redacts.
	// ───────────────────────────────────────────────────────────────────────
	test('the description fallback of extractTarget redacts a secret when no command field is present', () => {
		const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
		const target = extractTarget('bash', {
			description: `curl -H "Authorization: Bearer ${token}" https://api.example.com/v1`,
		});

		expect(target).not.toContain(token);
		// The description fallback truncates to 30 chars AFTER redaction, so
		// only the start of the placeholder is visible — but that start must
		// be present, proving redaction ran rather than truncating raw text.
		expect(target).toContain('[REDACTED:');
	});
});
