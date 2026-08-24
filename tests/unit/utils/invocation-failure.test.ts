import { describe, expect, test } from 'bun:test';
import {
	type ClassifyFailureInput,
	classifyInvocationFailure,
	policyDenialFailure,
} from '../../../src/utils/invocation-failure.js';

const shell = (
	over: Partial<ClassifyFailureInput> = {},
): ClassifyFailureInput => ({
	channel: 'error',
	toolKind: 'shell',
	...over,
});

describe('classifyInvocationFailure — shell family', () => {
	test('exit 127 is classified missing-command (structured exit-code proof)', () => {
		const result = classifyInvocationFailure(
			shell({ channel: 'exit_code', exitCode: 127 }),
		);
		expect(result?.category).toBe('shell_missing_command');
		expect(result?.retryClass).toBe('operator_action');
		expect(result?.source).toBe('exit_code');
	});

	test('spawn ENOENT in the ERROR channel is classified missing-command', () => {
		const result = classifyInvocationFailure(
			shell({ errorSignal: 'Error: spawn git.exe ENOENT' }),
		);
		expect(result?.category).toBe('shell_missing_command');
	});

	test('PowerShell CommandNotFoundException is classified missing-command', () => {
		const result = classifyInvocationFailure(
			shell({
				errorSignal:
					'CommandNotFoundException: rg is not recognized as the name of a cmdlet',
			}),
		);
		expect(result?.category).toBe('shell_missing_command');
	});

	test('a failing command whose OUTPUT contains "command not found" is NOT missing-command (no output channel input)', () => {
		// The classifier has no output channel: output text can never be passed.
		const result = classifyInvocationFailure(
			shell({ channel: 'error', errorSignal: 'Error: process exited 1' }),
		);
		expect(result?.category).not.toBe('shell_missing_command');
	});

	test('a non-shell tool with a generic error does not classify as shell missing-command', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			toolKind: 'other',
			errorSignal: 'read failed: some log said command not found',
		});
		expect(result?.family).not.toBe('shell');
	});

	test('parse-error signature in error channel → shell_parse_error (repair_then_retry)', () => {
		const result = classifyInvocationFailure(
			shell({ errorSignal: 'ParserError: MissingEndCurlyBrace at line 3' }),
		);
		expect(result?.category).toBe('shell_parse_error');
		expect(result?.retryClass).toBe('repair_then_retry');
	});

	test('[sandbox] BLOCKED in error channel → shell_sandbox_wrapper, do_not_retry, high risk', () => {
		const result = classifyInvocationFailure(
			shell({ errorSignal: '[sandbox] BLOCKED: wrapper failed to provision' }),
		);
		expect(result?.category).toBe('shell_sandbox_wrapper');
		expect(result?.retryClass).toBe('do_not_retry');
		expect(result?.risk).toBe('high');
	});

	test('plain non-zero exit is shell_nonzero_exit, not a fatal category', () => {
		const result = classifyInvocationFailure(
			shell({ channel: 'exit_code', exitCode: 2 }),
		);
		expect(result?.category).toBe('shell_nonzero_exit');
	});
});

describe('classifyInvocationFailure — filesystem family', () => {
	test('EBUSY native code → fs_busy_lock with bounded retry_same', () => {
		const result = classifyInvocationFailure({
			channel: 'native_code',
			nativeCode: 'EBUSY',
		});
		expect(result?.category).toBe('fs_busy_lock');
		expect(result?.retryClass).toBe('retry_same');
	});

	test('EPERM and EACCES → operator_action', () => {
		for (const code of ['EPERM', 'EACCES']) {
			const result = classifyInvocationFailure({
				channel: 'native_code',
				nativeCode: code,
			});
			expect(result?.category).toBe('fs_permission');
			expect(result?.retryClass).toBe('operator_action');
		}
	});

	test('ENOSPC and EDQUOT → fs_no_space / operator_action (never transient)', () => {
		for (const code of ['ENOSPC', 'EDQUOT']) {
			const result = classifyInvocationFailure({
				channel: 'native_code',
				nativeCode: code,
			});
			expect(result?.category).toBe('fs_no_space');
			expect(result?.retryClass).toBe('operator_action');
		}
	});

	test('EROFS → fs_readonly / operator_action', () => {
		const result = classifyInvocationFailure({
			channel: 'native_code',
			nativeCode: 'EROFS',
		});
		expect(result?.category).toBe('fs_readonly');
	});

	test('fs codes are recognized from the error channel too', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: "EACCES: permission denied, open '.swarm/x'",
		});
		expect(result?.category).toBe('fs_permission');
	});
});

describe('classifyInvocationFailure — git family', () => {
	test('merge conflict → git_conflict / repair_then_retry, NOT generic permanent', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: 'CONFLICT (content): Merge conflict in src/a.ts',
		});
		expect(result?.category).toBe('git_conflict');
		expect(result?.retryClass).toBe('repair_then_retry');
		expect(result?.family).toBe('git');
	});

	test('index.lock → git_lock_busy / bounded retry_same', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: "fatal: Unable to create '.git/index.lock': File exists.",
		});
		expect(result?.category).toBe('git_lock_busy');
		expect(result?.retryClass).toBe('retry_same');
	});

	test('git timeout → git_timeout / retry_same', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: 'error: git fetch timed out after 30000ms',
		});
		expect(result?.category).toBe('git_timeout');
	});

	test('git missing executable → git_unavailable / operator_action', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: 'Error: spawn git ENOENT',
		});
		expect(result?.category).toBe('git_unavailable');
	});
});

describe('classifyInvocationFailure — provider family (dispatch channel ONLY)', () => {
	test('quota error on provider_dispatch → provider_quota / retry_fallback', () => {
		const result = classifyInvocationFailure({
			channel: 'provider_dispatch',
			errorSignal: '429 You exceeded your current quota of 50 requests',
		});
		expect(result?.category).toBe('provider_quota');
		expect(result?.retryClass).toBe('retry_fallback');
	});

	test('the SAME quota text on a tool error channel is NOT provider quota', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: 'quota exceeded for /dev/sda',
		});
		expect(result?.family).not.toBe('provider');
	});

	test('429 without quota tokens → provider_rate_limit / retry_same', () => {
		const result = classifyInvocationFailure({
			channel: 'provider_dispatch',
			errorSignal: 'HTTP 429 too many requests',
		});
		expect(result?.category).toBe('provider_rate_limit');
		expect(result?.retryClass).toBe('retry_same');
	});

	test('503 → provider_server / retry_same', () => {
		const result = classifyInvocationFailure({
			channel: 'provider_dispatch',
			errorSignal: 'HTTP 503 service unavailable',
		});
		expect(result?.category).toBe('provider_server');
	});

	test('401 → provider_auth_config / operator_action', () => {
		const result = classifyInvocationFailure({
			channel: 'provider_dispatch',
			errorSignal: '401 invalid api key',
		});
		expect(result?.category).toBe('provider_auth_config');
		expect(result?.retryClass).toBe('operator_action');
	});

	test('content policy → provider_content_policy / retry_fallback', () => {
		const result = classifyInvocationFailure({
			channel: 'provider_dispatch',
			errorSignal: 'request rejected by safety system content filter',
		});
		expect(result?.category).toBe('provider_content_policy');
	});
});

describe('classifyInvocationFailure — abort family', () => {
	test('TimeoutError name → abort_or_deadline, distinct from rejection categories', () => {
		const result = classifyInvocationFailure({
			channel: 'abort',
			errorSignal: 'TimeoutError: The operation timed out.',
		});
		expect(result?.category).toBe('abort_or_deadline');
		expect(result?.family).toBe('abort');
	});
});

describe('policy denials', () => {
	test('policyDenialFailure is do_not_retry and never feeds provider retry counters', () => {
		const result = policyDenialFailure('SCOPE_NOT_DECLARED', 'action-1');
		expect(result.family).toBe('policy');
		expect(result.retryClass).toBe('do_not_retry');
		expect(result.source).toBe('gate');
		expect(result.actionId).toBe('action-1');
	});
});

describe('residual', () => {
	test('returns null for unmatched signal — caller owns the general_permanent residual', () => {
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: 'something odd happened',
		});
		expect(result).toBeNull();
	});

	test('evidence snippets are bounded to 200 chars', () => {
		const long = 'x'.repeat(5_000);
		const result = classifyInvocationFailure({
			channel: 'error',
			errorSignal: `EPERM: ${long}`,
		});
		expect(result?.evidence.signalSnippet?.length ?? 0).toBeLessThanOrEqual(
			201,
		);
	});
});
