import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Track warn calls via module-level mock
const warnCalls: string[] = [];

// mock.module must be called at top level, before any imports that use the module
mock.module('../../src/utils/logger', () => ({
	warn: (...args: unknown[]) => {
		warnCalls.push(args.map((a) => String(a)).join(' '));
	},
	log: mock(() => {}),
	error: mock(() => {}),
}));

afterEach(() => mock.restore());

import { createCcCommandInterceptHook } from '../../src/hooks/cc-command-intercept';

type MessageWithParts = {
	info: {
		role: string;
		agent?: string;
		sessionID?: string;
		[key: string]: unknown;
	};
	parts: Array<{ type: 'text'; text?: string; [key: string]: unknown }>;
};

function makeOutput(messages: MessageWithParts[]): {
	messages?: MessageWithParts[];
} {
	return { messages };
}

function makeMsg(
	role = 'user',
	agent = 'test-agent',
	parts: MessageWithParts['parts'] = [],
): MessageWithParts {
	return { info: { role, agent }, parts };
}

function lastWarn(): string | undefined {
	return warnCalls[warnCalls.length - 1];
}

describe('cc-command-intercept hook', () => {
	beforeEach(() => {
		warnCalls.length = 0;
	});

	describe('bare /plan → /swarm plan correction (CRITICAL non-destructive)', () => {
		test('correction is applied and note is appended', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [
					{ type: 'text', text: '/plan the approach' },
				]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});

		test('/PLAN (uppercase) is corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: '/PLAN the work' }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
		});

		test('/Plan (mixed case) is corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [
					{ type: 'text', text: '/Plan is what I need' },
				]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
		});
	});

	describe('bare /reset is blocked (CRITICAL destructive)', () => {
		test('BLOCKED message is inserted and line is replaced', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [
					{ type: 'text', text: '/reset everything' },
				]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] BLOCKED: /reset',
			);
			expect(output.messages![0].parts[0].text).toContain(
				'this wipes conversation context',
			);
		});

		test('original /reset line is replaced (not just modified)', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: '/reset' }]),
			]);

			await hook.messagesTransform({}, output);

			// The blocked message replaces the original line
			expect(output.messages![0].parts[0].text).not.toBe('/reset');
			expect(output.messages![0].parts[0].text).toContain('BLOCKED');
		});
	});

	describe('bare /clear is blocked (CRITICAL destructive)', () => {
		test('BLOCKED message is inserted', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: '/clear' }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] BLOCKED: /clear',
			);
			expect(output.messages![0].parts[0].text).toContain(
				'this wipes conversation context',
			);
		});
	});

	describe('/status triggers logger.warn (HIGH, non-blocking)', () => {
		test('logger.warn is called with CC_COMMAND_INTERCEPT message', async () => {
			const hook = createCcCommandInterceptHook();
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: '/status check' }]),
			]);

			await hook.messagesTransform({}, output);

			const warnMsg = lastWarn();
			expect(warnMsg).toBeDefined();
			expect(warnMsg).toContain('[CC_COMMAND_INTERCEPT]');
			expect(warnMsg).toContain('/status');
		});

		test('original /status line is NOT modified (non-blocking)', async () => {
			const hook = createCcCommandInterceptHook();
			const original = '/status check';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			// HIGH severity does not modify text
			expect(output.messages![0].parts[0].text).toBe(original);
		});
	});

	describe('/swarm plan is NOT detected (properly namespaced)', () => {
		test('no modification, no warn for /swarm plan', async () => {
			const hook = createCcCommandInterceptHook();
			const original = '/swarm plan shows tasks';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(original);
			expect(warnCalls.length).toBe(0);
		});

		test('/SWARM PLAN (uppercase) is not modified', async () => {
			const hook = createCcCommandInterceptHook();
			const original = '/SWARM PLAN shows tasks';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(original);
		});
	});

	describe('inside ``` code block, /plan is NOT detected', () => {
		test('no correction inside fenced code block', async () => {
			const hook = createCcCommandInterceptHook();
			const codeBlock = '```\n/plan\n```';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: codeBlock }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(codeBlock);
			expect(output.messages![0].parts[0].text).not.toContain('/swarm plan');
		});

		test('no warn inside fenced code block', async () => {
			const hook = createCcCommandInterceptHook();
			const codeBlock = '```\n/plan\n```';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: codeBlock }]),
			]);

			await hook.messagesTransform({}, output);

			expect(warnCalls.length).toBe(0);
		});
	});

	describe('URL like https://example.com/plan is NOT detected', () => {
		test('URL line is passed through unchanged', async () => {
			const hook = createCcCommandInterceptHook();
			const url = 'https://example.com/plan';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: url }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(url);
			expect(warnCalls.length).toBe(0);
		});

		test('URL with http (non-https) is also passed through', async () => {
			const hook = createCcCommandInterceptHook();
			const url = 'http://example.com/plan';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: url }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(url);
		});
	});

	describe('line starting with // comment is NOT detected', () => {
		test('// /plan comment passes through unchanged', async () => {
			const hook = createCcCommandInterceptHook();
			const comment = '// /plan is for planning';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: comment }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(comment);
			expect(warnCalls.length).toBe(0);
		});

		test('# /plan hash comment also passes through', async () => {
			const hook = createCcCommandInterceptHook();
			const comment = '# /plan is for planning';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: comment }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(comment);
		});
	});

	describe('idempotency: applying twice produces same result as once', () => {
		test('second application does not double-correct', async () => {
			const hook = createCcCommandInterceptHook();
			const input = '/plan the work';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: input }]),
			]);

			// First pass
			await hook.messagesTransform({}, output);
			const afterFirst = output.messages![0].parts[0].text;

			// Second pass — text now contains [CC_COMMAND_INTERCEPT] annotation
			await hook.messagesTransform({}, output);
			const afterSecond = output.messages![0].parts[0].text;

			// Should be identical — second pass is a no-op
			expect(afterSecond!).toBe(afterFirst!);
			// Should not have a second "[CC_COMMAND_INTERCEPT] Corrected" line
			const correctedMatches = (afterSecond ?? '').match(
				/Corrected \/plan → \/swarm plan/g,
			);
			expect(correctedMatches).toHaveLength(1);
		});
	});

	describe('architect messages are skipped', () => {
		test('message from architect agent is not processed', async () => {
			const hook = createCcCommandInterceptHook();
			const original = '/plan the work';
			const output = makeOutput([
				makeMsg('user', 'architect', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(original);
			expect(warnCalls.length).toBe(0);
		});

		test('empty agent string is skipped', async () => {
			const hook = createCcCommandInterceptHook();
			const original = '/plan the work';
			const output = makeOutput([
				makeMsg('user', '', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(original);
		});
	});

	describe('inline code (backtick-wrapped) is NOT detected', () => {
		test('`/plan` inline code passes through', async () => {
			const hook = createCcCommandInterceptHook();
			const inline = 'Use `/plan` in your markdown';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: inline }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(inline);
			expect(warnCalls.length).toBe(0);
		});
	});

	describe('config options', () => {
		test('blockDestructive: false allows /reset through without blocking', async () => {
			const hook = createCcCommandInterceptHook({ blockDestructive: false });
			const original = '/reset everything';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			// With blockDestructive=false, /reset is treated as a CC command reference (warn only)
			expect(output.messages![0].parts[0].text).toBe(original);
		});

		test('intercept: [] skips all processing', async () => {
			const hook = createCcCommandInterceptHook({ intercept: [] });
			const original = '/plan the work';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toBe(original);
			expect(warnCalls.length).toBe(0);
		});

		test('logIntercepts: false suppresses warn for HIGH severity', async () => {
			const hook = createCcCommandInterceptHook({ logIntercepts: false });
			const original = '/status check';
			const output = makeOutput([
				makeMsg('user', 'my-agent', [{ type: 'text', text: original }]),
			]);

			await hook.messagesTransform({}, output);

			expect(warnCalls.length).toBe(0);
		});
	});
});
