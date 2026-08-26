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

	// Property test (Stage B round 4): four prior rounds each found a
	// leak from a single control/whitespace byte at a different
	// inter-token position. Instead of one regression test per bypass,
	// enumerate every single-byte and adjacent-pair insertion across every
	// pattern family and assert the secret never survives.
	it('never leaks a secret for any single or adjacent-pair fill-byte insertion across every credential pattern family', () => {
		const SECRET = 'hunter2xyz';
		const FILL_BYTES = ['\x1b', '\x00', '\x7f', '\t', '\r', '\n'];
		const TEMPLATES = [
			(s: string) => `authorization=Bearer ${s}`,
			(s: string) => `authorization: Bearer ${s}`,
			(s: string) => `token=${s}`,
			(s: string) => `secret=${s}`,
			(s: string) => `password=${s}`,
			(s: string) => `api_key=${s}`,
			(s: string) => `API_KEY=${s}`,
			(s: string) => `MY_AUTH=${s}`,
			(s: string) => `X_TOKEN=${s}`,
		];

		const leaks: string[] = [];
		for (const template of TEMPLATES) {
			const base = template(SECRET);
			for (let i = 0; i <= base.length; i++) {
				for (const b of FILL_BYTES) {
					const single = base.slice(0, i) + b + base.slice(i);
					const out =
						invocationFailureTestExports.sanitizeFailureEvidenceDisplay(single);
					if (out.includes(SECRET)) {
						leaks.push(
							`single@${i} byte=${JSON.stringify(b)}: ${JSON.stringify(base)} -> ${JSON.stringify(out)}`,
						);
					}
					for (let j = i; j <= base.length; j++) {
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

		expect(leaks.slice(0, 10)).toEqual([]);
	});
});
