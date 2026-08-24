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
			output: 'wrapper returned a parse failure',
			error: 'ParserError: MissingEndCurlyBrace',
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
});
