import { describe, expect, it } from 'bun:test';
import {
	classifyProviderFailure,
	createCancellationFailure,
	createDeadlineFailure,
	createFilesystemFailure,
	createGitFailure,
	createPolicyFailure,
	createValidationFailure,
} from '../../../src/failures/invocation-failure';

describe('invocation failure classification matrix', () => {
	const providerCases = [
		[
			{ message: '429 Too Many Requests', status: 429 },
			'provider.rate_limit',
			'retry_same',
		],
		[
			{ message: 'insufficient_quota for this account', status: 402 },
			'provider.quota_billing',
			'retry_fallback',
		],
		[
			{ message: '503 Service Unavailable', status: 503 },
			'provider.unavailable',
			'retry_same',
		],
		[
			{ message: 'context length exceeded for this request' },
			'provider.context_window',
			'do_not_retry',
		],
		[
			{ message: 'content policy violation: blocked' },
			'provider.content_policy',
			'do_not_retry',
		],
		[
			{ name: 'AbortError', message: 'AbortError: request aborted' },
			'provider.cancelled',
			'do_not_retry',
		],
		[
			{ message: '401 Unauthorized', status: 401 },
			'provider.authentication_configuration',
			'operator_action',
		],
	] as const;

	for (const [input, category, retryClass] of providerCases) {
		it(`classifies provider ${category}`, () => {
			const record = classifyProviderFailure(input, {
				tool: 'Task',
				args: { subagent_type: 'coder', taskId: '1.2' },
			});

			expect(record.source).toBe('provider');
			expect(record.category).toBe(category);
			expect(record.retryClass).toBe(retryClass);
			expect(record.action?.role).toBe('coder');
		});
	}

	it('keeps shell-only command text out of provider classification', () => {
		const record = classifyProviderFailure({
			message: 'bash: line 1: missing-tool: command not found',
		});

		expect(record.category).toBe('provider.unknown');
		expect(record.retryClass).toBe('do_not_retry');
	});

	it('covers filesystem, git, policy, validation, cancellation, and deadline constructors', () => {
		const records = [
			createFilesystemFailure({
				reason: 'busy_lock',
				display: 'EBUSY: file is locked',
				code: 'EBUSY',
				idempotent: true,
			}),
			createFilesystemFailure({
				reason: 'path_containment',
				display: 'outside workspace root',
				code: 'SCOPE_WORKSPACE_MISMATCH',
			}),
			createGitFailure({
				reason: 'conflict',
				display: 'merge conflict in src/index.ts',
			}),
			createGitFailure({
				reason: 'timeout',
				display: 'git timed out after 5000ms',
				idempotent: true,
			}),
			createPolicyFailure({
				reason: 'gate_denial',
				display: 'SCOPE_NOT_DECLARED: declare scope first',
			}),
			createPolicyFailure({
				reason: 'destructive',
				display: 'destructive command blocked',
			}),
			createValidationFailure({
				display: 'schema validation failed for task result',
				code: 'SCHEMA_INVALID',
			}),
			createCancellationFailure({
				display: 'AbortError: operator cancelled command',
			}),
			createDeadlineFailure({
				display: 'oversight deadline expired',
				code: 'oversight.total_timeout_ms',
				idempotent: true,
			}),
		];

		expect(
			records.map((record) => [record.category, record.retryClass]),
		).toEqual([
			['filesystem.busy_lock', 'retry_same'],
			['filesystem.path_containment', 'do_not_retry'],
			['git.conflict', 'operator_action'],
			['git.timeout', 'retry_same'],
			['policy.gate_denial', 'repair_then_retry'],
			['policy.destructive', 'do_not_retry'],
			['validation.agent_result', 'repair_then_retry'],
			['cancellation.abort', 'do_not_retry'],
			['deadline.expired', 'retry_same'],
		]);
	});

	it('requires an explicit idempotency declaration for transient operation retries', () => {
		expect(
			createFilesystemFailure({
				reason: 'busy_lock',
				display: 'EBUSY',
			}).retryClass,
		).toBe('do_not_retry');
		expect(
			createGitFailure({ reason: 'timeout', display: 'timed out' }).retryClass,
		).toBe('do_not_retry');
		expect(createDeadlineFailure({ display: 'expired' }).retryClass).toBe(
			'do_not_retry',
		);
	});
});
