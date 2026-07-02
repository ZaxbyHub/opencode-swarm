/**
 * PR auto-subscribe hook tests (src/hooks/pr-auto-subscribe.ts).
 *
 * Covers: gh pr create detection + PR URL extraction, config/session/tool
 * gating, canonical URL reconstruction, bounded output scanning, and
 * fail-open behavior when subscribe throws.
 *
 * Uses the _internals DI seam — no mock.module.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrMonitorConfig } from '../../../src/config/schema';
import {
	_internals,
	createPrAutoSubscribeHook,
	extractPrUrl,
} from '../../../src/hooks/pr-auto-subscribe';

const TEST_DIR = path.join(os.tmpdir(), 'pr-auto-subscribe-test');

function makeConfig(overrides: Record<string, unknown> = {}): PrMonitorConfig {
	return {
		enabled: true,
		auto_subscribe_on_pr_create: true,
		max_subscriptions: 20,
		...overrides,
	} as PrMonitorConfig;
}

function makeBashCall(command: string, output: string) {
	return {
		input: {
			tool: 'bash',
			sessionID: 'sess-1',
			args: { command },
		},
		output: { output },
	};
}

const PR_OUTPUT = [
	'Creating pull request for feature-branch into main in owner/repo',
	'',
	'https://github.com/owner/repo/pull/155',
].join('\n');

let savedSubscribe: typeof _internals.subscribe;
let savedLog: typeof _internals.log;
let mockSubscribe: ReturnType<typeof mock>;

beforeEach(() => {
	savedSubscribe = _internals.subscribe;
	savedLog = _internals.log;
	mockSubscribe = mock(() => Promise.resolve({}));
	_internals.subscribe = mockSubscribe as typeof _internals.subscribe;
	_internals.log = mock(() => {}) as typeof _internals.log;
});

afterEach(() => {
	_internals.subscribe = savedSubscribe;
	_internals.log = savedLog;
});

// ── extractPrUrl ─────────────────────────────────────────────────────

describe('extractPrUrl', () => {
	test('extracts the first PR URL and canonicalizes it', () => {
		const info = extractPrUrl(PR_OUTPUT);
		expect(info).toEqual({
			repoFullName: 'owner/repo',
			prNumber: 155,
			prUrl: 'https://github.com/owner/repo/pull/155',
		});
	});

	test('uses only the FIRST URL when multiple are present', () => {
		const info = extractPrUrl(
			'https://github.com/a/b/pull/1 then https://github.com/c/d/pull/2',
		);
		expect(info?.repoFullName).toBe('a/b');
		expect(info?.prNumber).toBe(1);
	});

	test('returns null when no PR URL is present', () => {
		expect(extractPrUrl('no url here')).toBeNull();
		expect(extractPrUrl('https://github.com/owner/repo/issues/12')).toBeNull();
	});

	test('strips trailing junk via canonical reconstruction', () => {
		const info = extractPrUrl('https://github.com/owner/repo/pull/42#comment');
		expect(info?.prUrl).toBe('https://github.com/owner/repo/pull/42');
	});

	test('rejects unsafe PR numbers', () => {
		expect(
			extractPrUrl('https://github.com/o/r/pull/99999999999999999999'),
		).toBeNull();
	});

	test('ignores a URL beyond the 64KB scan bound', () => {
		const padded = `${'x'.repeat(65 * 1024)}\nhttps://github.com/owner/repo/pull/9`;
		expect(extractPrUrl(padded)).toBeNull();
	});
});

// ── toolAfter behavior ───────────────────────────────────────────────

describe('createPrAutoSubscribeHook — toolAfter', () => {
	test('subscribes on gh pr create with a PR URL in the output', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall(
			'gh pr create --title "feat" --body "..."',
			PR_OUTPUT,
		);

		await hook.toolAfter(input, output);

		expect(mockSubscribe).toHaveBeenCalledTimes(1);
		expect(mockSubscribe).toHaveBeenCalledWith(TEST_DIR, {
			sessionID: 'sess-1',
			prNumber: 155,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/155',
			maxSubscriptions: 20,
		});
	});

	test('accepts the shell tool name too', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);
		input.tool = 'shell';

		await hook.toolAfter(input, output);
		expect(mockSubscribe).toHaveBeenCalledTimes(1);
	});

	test('no-op when pr_monitor.enabled is false', async () => {
		const hook = createPrAutoSubscribeHook(
			TEST_DIR,
			makeConfig({ enabled: false }),
		);
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);

		await hook.toolAfter(input, output);
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('no-op when auto_subscribe_on_pr_create is false', async () => {
		const hook = createPrAutoSubscribeHook(
			TEST_DIR,
			makeConfig({ auto_subscribe_on_pr_create: false }),
		);
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);

		await hook.toolAfter(input, output);
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('no-op when sessionID is missing or blank', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);
		(input as { sessionID?: string }).sessionID = '   ';

		await hook.toolAfter(input, output);
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('no-op for non-bash tools', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);
		input.tool = 'write';

		await hook.toolAfter(input, output);
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('no-op when the command does not contain gh pr create', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall('gh pr view 155', PR_OUTPUT);

		await hook.toolAfter(input, output);
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('no-op when the output contains no PR URL', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall(
			'gh pr create',
			'error: could not create PR',
		);

		await hook.toolAfter(input, output);
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('no-op when the output is not a string', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input } = makeBashCall('gh pr create', '');

		await hook.toolAfter(input, { output: { some: 'object' } });
		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	test('reads the command from output.args when input.args is absent', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());

		await hook.toolAfter(
			{ tool: 'bash', sessionID: 'sess-1' },
			{ args: { command: 'gh pr create --fill' }, output: PR_OUTPUT },
		);
		expect(mockSubscribe).toHaveBeenCalledTimes(1);
	});

	test('fail-open: subscribe rejection never throws out of the hook', async () => {
		mockSubscribe.mockImplementation(() =>
			Promise.reject(new Error('PR subscription limit reached: 20/20')),
		);
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);

		await expect(hook.toolAfter(input, output)).resolves.toBeUndefined();
	});

	test('idempotency is delegated to subscribe(): repeated calls pass the same composite key inputs', async () => {
		const hook = createPrAutoSubscribeHook(TEST_DIR, makeConfig());
		const { input, output } = makeBashCall('gh pr create', PR_OUTPUT);

		await hook.toolAfter(input, output);
		await hook.toolAfter(input, output);

		expect(mockSubscribe).toHaveBeenCalledTimes(2);
		expect(mockSubscribe.mock.calls[0]).toEqual(mockSubscribe.mock.calls[1]);
	});
});
