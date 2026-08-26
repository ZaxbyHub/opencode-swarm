import { describe, expect, it } from 'bun:test';
import {
	classifyToolInvocationFailure,
	_test_exports as invocationFailureTestExports,
} from '../../../src/failures/invocation-failure';
import { classifyToolOutcome } from '../../../src/hooks/guardrails/nontransient-circuit';

describe('tool failure classification', () => {
	it('does not treat quoted command-not-found text as authoritative without structured proof', () => {
		const record = classifyToolInvocationFailure({
			tool: 'bash',
			args: { command: 'grep "command not found" log.txt' },
			output: 'docs say "command not found" can appear here',
			metadata: { exit: 2 },
			correlation: { originalCommand: 'grep "command not found" log.txt' },
		});
		const outcome = classifyToolOutcome(
			{
				tool: 'bash',
				sessionID: 'sess-1',
				callID: 'call-1',
				args: { command: 'grep "command not found" log.txt' },
			},
			{
				title: 'shell',
				output: 'docs say "command not found" can appear here',
				metadata: { exit: 2 },
			},
		);

		expect(record?.category).toBe('shell.exit');
		expect(outcome).toEqual({
			kind: 'failure',
			signal: 'shell exited with code 2',
		});
		expect(record?.evidence.display).not.toContain('docs say');
	});

	it('requires exit 127 or structured ENOENT-style evidence for command-unavailable', () => {
		const shRecord = classifyToolInvocationFailure({
			tool: 'bash',
			args: { command: 'missing-tool' },
			output: '/bin/sh: 1: missing-tool: not found',
			metadata: { exit: 127 },
			correlation: { originalCommand: 'missing-tool' },
		});
		const spawnRecord = classifyToolInvocationFailure({
			tool: 'bash',
			args: { command: 'missing-tool' },
			output: '',
			error: 'Error: spawn missing-tool ENOENT',
			metadata: {},
			correlation: { originalCommand: 'missing-tool' },
		});
		const powerShellRecord = classifyToolInvocationFailure({
			tool: 'bash',
			args: { command: 'missing-tool' },
			output: "'missing-tool' is not recognized as the name of a cmdlet",
			error: 'CommandNotFoundException: missing-tool',
			metadata: { exit: 1 },
			correlation: { originalCommand: 'missing-tool' },
		});

		expect(shRecord?.category).toBe('shell.command_unavailable');
		expect(spawnRecord?.evidence.code).toBe('ENOENT');
		expect(powerShellRecord?.category).toBe('shell.command_unavailable');
	});

	it('maps parser failures to sandbox-wrapper when the wrapper owned the parse', () => {
		const record = classifyToolInvocationFailure({
			tool: 'bash',
			args: { command: 'broken' },
			output: 'ParserError: MissingEndCurlyBrace',
			metadata: { exit: 1 },
			correlation: {
				originalCommand: 'broken',
				sandboxWrapped: true,
			},
		});

		expect(record?.category).toBe('shell.sandbox_wrapper');
		expect(record?.retryClass).toBe('operator_action');
	});

	it('redacts secrets and bounds display evidence', () => {
		const display = invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
			[
				'authorization=Bearer top-secret-token',
				'https://user:secret@example.com/private?token=abc123',
				'API_KEY=abcdefg',
				'x'.repeat(900),
			].join(' '),
		);

		expect(display).toContain('authorization=<redacted>');
		expect(display).toContain('API_KEY=<redacted>');
		expect(display).toContain('<url:');
		expect(display).not.toContain('top-secret-token');
		expect(display).not.toContain('secret@example.com');
		expect(Buffer.byteLength(display, 'utf8')).toBeLessThanOrEqual(512);
	});

	// PR #2363 review (FB-006): this display string is rendered to
	// terminals/logs downstream (e.g. laneTerminalErrorReason in
	// dispatch-lanes.ts) without further escaping. An unstripped ESC/C0
	// sequence in provider-controlled text could spoof terminal output or
	// consume a caller's length budget before the meaningful text.
	it('strips C0 control characters and ESC/ANSI sequences', () => {
		const display = invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
			'\x1b[31mFAKE ERROR\x1b[0m real message\x00\x07',
		);

		expect(display).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(display).toContain('real message');
	});

	it('redacts a secret even when a control byte is embedded inside the keyword or the value', () => {
		const keywordSplit =
			invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
				'author\x1bization=Bearer top-secret-abc123',
			);
		expect(keywordSplit).not.toContain('top-secret-abc123');
		expect(keywordSplit).toContain('authorization=<redacted>');

		const valueSplit =
			invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
				'authorization=Bearer top\x1bsecret-abc123',
			);
		expect(valueSplit).not.toContain('secret-abc123');
	});

	it('redacts a keyword even when a control byte sits between it and unrelated preceding text (no false join)', () => {
		const joined = invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
			'qux\x1btoken=hunter2',
		);
		expect(joined).not.toContain('hunter2');
		expect(joined).toContain('token=<redacted>');
	});

	it('redacts the full value even when a control byte is embedded inside the "Bearer" prefix', () => {
		const display = invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
			'authorization=Be\x1barer topsecret123',
		);
		expect(display).not.toContain('topsecret123');
		expect(display).toContain('authorization=<redacted>');
	});

	// Property test (Stage B rounds 4-6, closeout critic): prior rounds
	// each found a leak from a single fill byte at a different inter-token
	// position, and round 5 found the initial version of this test was
	// partly vacuous — the secret sat at the tail of every template, so
	// insertions landing *inside* the secret itself corrupted the very
	// substring being checked for, making that iteration pass regardless of
	// redaction correctness. Insertion positions are bounded to the
	// key/separator region (up to but not including the secret) so every
	// iteration is a real probe. The fill-byte set covers C0/DEL, C1
	// controls, a Unicode format char (round 5), and default-ignorable code
	// points like variation selectors and Hangul filler (round 6) — every
	// category found to render as invisible while still breaking a `\b`
	// boundary.
	//
	// Closeout critic: the SCREAMING_KV key class used to tolerate vertical
	// whitespace (\n, \r, \v, \f) as fill, which let two unrelated log lines
	// merge into one redaction match (e.g. "AUTH FAILED\nHTTP_STATUS=401"
	// collapsed to "AUTHFAILEDHTTP_STATUS=<redacted>", destroying the
	// failure-reason legibility this PR exists to preserve, and making
	// different status codes produce byte-identical output). Fixed by
	// excluding vertical whitespace from the SCREAMING_KV key class — see
	// SCREAMING_KEY_HORIZONTAL_FILL_CHARS in invocation-failure.ts. That
	// necessarily reopens a narrow, accepted-residual-risk gap symmetrical
	// to it: a vertical-whitespace byte inserted INSIDE a SCREAMING key name
	// itself (not between log lines) now defeats that key's own \b-tolerant
	// matching, the same way any other never-widened Unicode category would
	// (e.g. combining marks, deliberately not covered either — see the FILL
	// doc comment). Never-mangle-multi-line-text was judged to outweigh
	// never-leak-via-a-newline-spliced-into-a-key-name: the latter requires
	// an attacker to embed a raw CR/LF/VT/FF inside what's meant to be a
	// single unbroken identifier, which is a narrower and stranger shape
	// than "two adjacent lines of ordinary log output." SCREAMING-family
	// templates (uppercase keys, matched by SCREAMING_KV_CANDIDATE_PATTERN)
	// are therefore probed with a vertical-whitespace-free fill-byte subset;
	// lowercase credential templates (matched by CREDENTIAL_KV_PATTERN,
	// whose fill gaps are small and fixed-position, not an unbounded
	// multi-word span) are unaffected and keep the full corpus.
	it('never leaks a secret for any single or adjacent-pair fill-byte insertion in the key/separator region, across every credential pattern family', () => {
		const SECRET = 'hunter2xyz';
		const VERTICAL_WHITESPACE_BYTES = new Set(['\r', '\n', '\x0b', '\x0c']);
		const ALL_FILL_BYTES = [
			'\x1b',
			'\x00',
			'\x7f',
			'\t',
			'\r',
			'\n',
			'\x0b',
			'\x0c',
			String.fromCharCode(0x85), // NEL (C1 control)
			String.fromCharCode(0x9b), // CSI (C1 control)
			String.fromCharCode(0x200b), // zero-width space (Unicode format char)
			String.fromCharCode(0xfe0f), // variation selector 16 (Default_Ignorable)
			String.fromCharCode(0x3164), // Hangul Filler (Default_Ignorable)
			String.fromCodePoint(0xe0100), // variation selector supplement (Default_Ignorable)
		];
		const HORIZONTAL_ONLY_FILL_BYTES = ALL_FILL_BYTES.filter(
			(b) => !VERTICAL_WHITESPACE_BYTES.has(b),
		);
		const TEMPLATES = [
			{ make: (s: string) => `authorization=Bearer ${s}`, screaming: false },
			{ make: (s: string) => `authorization: Bearer ${s}`, screaming: false },
			{ make: (s: string) => `token=${s}`, screaming: false },
			{ make: (s: string) => `secret=${s}`, screaming: false },
			{ make: (s: string) => `password=${s}`, screaming: false },
			{ make: (s: string) => `api_key=${s}`, screaming: false },
			{ make: (s: string) => `api-key=${s}`, screaming: false },
			{ make: (s: string) => `API_KEY=${s}`, screaming: true },
			{ make: (s: string) => `MY_AUTH=${s}`, screaming: true },
			{ make: (s: string) => `X_TOKEN=${s}`, screaming: true },
		];

		const leaks: string[] = [];
		for (const template of TEMPLATES) {
			const base = template.make(SECRET);
			const keyRegionEnd = base.indexOf(SECRET);
			const FILL_BYTES = template.screaming
				? HORIZONTAL_ONLY_FILL_BYTES
				: ALL_FILL_BYTES;
			for (let i = 0; i <= keyRegionEnd; i++) {
				for (const b of FILL_BYTES) {
					const single = base.slice(0, i) + b + base.slice(i);
					const out =
						invocationFailureTestExports.sanitizeFailureEvidenceDisplay(single);
					if (out.includes(SECRET)) {
						leaks.push(
							`single@${i} byte=${JSON.stringify(b)}: ${JSON.stringify(base)} -> ${JSON.stringify(out)}`,
						);
					}
					for (let j = i; j <= keyRegionEnd; j++) {
						for (const b2 of FILL_BYTES) {
							const pair =
								base.slice(0, i) + b + base.slice(i, j) + b2 + base.slice(j);
							const out2 =
								invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
									pair,
								);
							if (out2.includes(SECRET)) {
								leaks.push(
									`pair@${i},${j} bytes=${JSON.stringify(b)},${JSON.stringify(b2)}: ${JSON.stringify(base)} -> ${JSON.stringify(out2)}`,
								);
							}
						}
					}
				}
			}
		}

		expect({ count: leaks.length, sample: leaks.slice(0, 10) }).toEqual({
			count: 0,
			sample: [],
		});
	});

	// Closeout critic: SCREAMING_KV's key class used to include \s (all
	// whitespace, including newlines), so two unrelated log lines could
	// merge into one redaction match and collapse distinct failures (e.g.
	// different HTTP status codes) into byte-identical redacted output.
	it('does not merge two unrelated lines of SCREAMING_CASE log text across a newline', () => {
		const distinctOutputs = new Set([
			invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
				'AUTH FAILED\nHTTP_STATUS=401',
			),
			invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
				'AUTH FAILED\nHTTP_STATUS=500',
			),
		]);
		// Different status codes must not collapse to the same output.
		expect(distinctOutputs.size).toBe(2);

		const display = invocationFailureTestExports.sanitizeFailureEvidenceDisplay(
			'AUTH FAILED\nHTTP_STATUS=401',
		);
		// The unrelated preceding line survives un-redacted and un-merged.
		expect(display).toContain('AUTH FAILED');
		expect(display).not.toContain('AUTHFAILED');
	});
});
