/**
 * Phase 1 PR Monitor — onSubscriptionCreated callback + input validation tests.
 *
 * Tests task 2.2: subscribe() triggers onSubscriptionCreated for new and
 * existing subscriptions, and rejects invalid inputs.
 *
 * Uses real temp directories with real file I/O.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PR_SUBSCRIPTIONS_FILE,
	type PrSubscriptionRecord,
	setOnSubscriptionCreated,
	subscribe,
} from '../../../src/background/pr-subscriptions';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pr-sub-cb-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm', 'pr-monitor'), { recursive: true });
	return real;
}

describe('pr-subscriptions — onSubscriptionCreated callback', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempProject();
		// Reset the module-level callback between every test to avoid leakage
		setOnSubscriptionCreated(
			null as unknown as (
				directory: string,
				record: PrSubscriptionRecord,
			) => void,
		);
	});

	afterEach(() => {
		setOnSubscriptionCreated(
			null as unknown as (
				directory: string,
				record: PrSubscriptionRecord,
			) => void,
		);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('subscribe() triggers onSubscriptionCreated for new subscription', async () => {
		const calls: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		setOnSubscriptionCreated((directory, record) => {
			calls.push({ directory, record });
		});

		const record = await subscribe(dir, {
			sessionID: 'sess_cb_1',
			prNumber: 1,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/1',
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]!.directory).toBe(dir);
		expect(calls[0]!.record.correlationId).toBe('sess_cb_1::owner/repo::1');
		expect(calls[0]!.record.prNumber).toBe(1);
		expect(calls[0]!.record.status).toBe('active');
		expect(calls[0]!.record).toEqual(record);
	});

	test('subscribe() triggers onSubscriptionCreated for existing active subscription', async () => {
		const calls: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		setOnSubscriptionCreated((directory, record) => {
			calls.push({ directory, record });
		});

		// First subscription
		const first = await subscribe(dir, {
			sessionID: 'sess_cb_2',
			prNumber: 2,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/2',
		});

		// Same correlationId — idempotent re-subscribe
		const second = await subscribe(dir, {
			sessionID: 'sess_cb_2',
			prNumber: 2,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/2',
		});

		// Callback should have fired both times
		expect(calls).toHaveLength(2);
		expect(calls[0]!.record.correlationId).toBe(second.correlationId);
		expect(calls[1]!.record.correlationId).toBe(second.correlationId);
		// Returns the same existing record both times
		expect(first.correlationId).toBe(second.correlationId);
		expect(first.createdAt).toBe(second.createdAt);
	});

	test('setOnSubscriptionCreated replaces previous callback', async () => {
		const firstCalls: Array<{
			directory: string;
			record: PrSubscriptionRecord;
		}> = [];
		const secondCalls: Array<{
			directory: string;
			record: PrSubscriptionRecord;
		}> = [];

		setOnSubscriptionCreated((directory, record) => {
			firstCalls.push({ directory, record });
		});

		// Replace with second callback BEFORE any subscribe calls
		setOnSubscriptionCreated((directory, record) => {
			secondCalls.push({ directory, record });
		});

		// Now subscribe — only the second callback should fire
		await subscribe(dir, {
			sessionID: 'sess_cb_3',
			prNumber: 3,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/3',
		});

		await subscribe(dir, {
			sessionID: 'sess_cb_4',
			prNumber: 4,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/4',
		});

		// First callback was replaced before any subscription — never fired
		expect(firstCalls).toHaveLength(0);
		// Second callback received both subscriptions
		expect(secondCalls).toHaveLength(2);
		expect(secondCalls[0]!.record.prNumber).toBe(3);
		expect(secondCalls[1]!.record.prNumber).toBe(4);
	});
});

describe('pr-subscriptions — subscribe() input validation', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempProject();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('subscribe() rejects empty sessionID', async () => {
		await expect(
			subscribe(dir, {
				sessionID: '',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/sessionID is required/i);
	});

	test('subscribe() rejects whitespace-only sessionID', async () => {
		await expect(
			subscribe(dir, {
				sessionID: '   ',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/sessionID is required/i);
	});

	test('subscribe() rejects empty repoFullName', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_valid',
				prNumber: 1,
				repoFullName: '',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/repoFullName is required/i);
	});

	test('subscribe() rejects empty prUrl', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_valid',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: '',
			}),
		).rejects.toThrow(/prUrl is required/i);
	});

	test('subscribe() rejects non-positive prNumber (zero)', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_valid',
				prNumber: 0,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/0',
			}),
		).rejects.toThrow(/prNumber is required.*positive integer/i);
	});

	test('subscribe() rejects non-positive prNumber (negative)', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_valid',
				prNumber: -5,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/-5',
			}),
		).rejects.toThrow(/prNumber is required.*positive integer/i);
	});

	test('subscribe() rejects non-integer prNumber', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_valid',
				// @ts-expect-error — intentional float for runtime validation test
				prNumber: 1.5,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/prNumber is required.*positive integer/i);
	});

	test('subscribe() rejects empty directory', async () => {
		await expect(
			subscribe('', {
				sessionID: 'sess_valid',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/directory is required/i);
	});

	test('subscribe() rejects whitespace-only directory', async () => {
		await expect(
			subscribe('   ', {
				sessionID: 'sess_valid',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/directory is required/i);
	});
});
