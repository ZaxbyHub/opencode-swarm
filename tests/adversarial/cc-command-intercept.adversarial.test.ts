import { describe, expect, test } from 'bun:test';
import { createCcCommandInterceptHook } from '../../src/hooks/cc-command-intercept';

function createMessage(text: string) {
	return {
		messages: [
			{
				info: { role: 'assistant', agent: 'mega_coder' },
				parts: [{ type: 'text', text }],
			},
		],
	};
}

describe('ADVERSARIAL: cc-command-intercept hook evasion tests', () => {
	describe('ATTACK VECTOR: Case variation evasion', () => {
		test('/PLAN (uppercase) is detected and corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/PLAN the approach');

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});

		test('/Plan (mixed case) is detected and corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/Plan is what I need');

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});

		test('/pLaN (random case) is detected and corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/pLaN the next steps');

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});
	});

	describe('ATTACK VECTOR: Whitespace padding evasion', () => {
		test('leading whitespace: "  /plan" is detected and corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('  /plan the approach');

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});

		test('trailing whitespace: "/plan " is detected and corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/plan ');

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});

		test('both leading and trailing whitespace: "  /plan  " is detected and corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('  /plan  ');

			await hook.messagesTransform({}, output);

			expect(output.messages![0].parts[0].text).toContain('/swarm plan');
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
		});
	});

	describe('ATTACK VECTOR: Inline backtick evasion', () => {
		test('single-backtick inline: `/plan` is NOT detected (inline code)', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('Use `/plan` to view the plan');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's inline code
			expect(output.messages![0].parts[0].text).toBe(
				'Use `/plan` to view the plan',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('single-backtick inline with text: `check /plan first` is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('`/plan` is the correct syntax');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's inline code
			expect(output.messages![0].parts[0].text).toBe(
				'`/plan` is the correct syntax',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});
	});

	describe('ATTACK VECTOR: Comment evasion', () => {
		test('// comment with /plan is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('// /plan the next sprint');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's a comment
			expect(output.messages![0].parts[0].text).toBe(
				'// /plan the next sprint',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('# comment with /plan is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('# /plan the next sprint');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's a comment
			expect(output.messages![0].parts[0].text).toBe('# /plan the next sprint');
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});
	});

	describe('ATTACK VECTOR: URL false positive', () => {
		test('URL containing /plan is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('https://example.com/plan?ref=current');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's a URL
			expect(output.messages![0].parts[0].text).toBe(
				'https://example.com/plan?ref=current',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('HTTP URL containing /plan is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('http://example.com/plan');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's a URL
			expect(output.messages![0].parts[0].text).toBe('http://example.com/plan');
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});
	});

	describe('ATTACK VECTOR: Multi-command message', () => {
		test('both /plan and /reset are caught independently (separate lines)', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/plan the sprint\n/reset everything');

			await hook.messagesTransform({}, output);

			// Both should be handled: /plan corrected, /reset blocked
			const text = output.messages![0].parts[0].text;
			expect(text).toContain('/swarm plan');
			expect(text).toContain(
				'[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan',
			);
			expect(text).toContain('[CC_COMMAND_INTERCEPT] BLOCKED: /reset');
			expect(text).toContain('this wipes conversation context');
		});

		test('multiple /plan variants on separate lines are all corrected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/PLAN first\n/plan second\n/Plan third');

			await hook.messagesTransform({}, output);

			const text = output.messages![0].parts[0].text;
			// All three should be corrected to /swarm plan
			expect(text).toContain('/swarm plan');
			// Should have three correction notices
			const matches = text.match(
				/\[CC_COMMAND_INTERCEPT\] Corrected \/plan → \/swarm plan/g,
			);
			expect(matches).toHaveLength(3);
		});

		test('mixed case /PLAN and /RESET on separate lines are both caught', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/PLAN the work\n/RESET the context');

			await hook.messagesTransform({}, output);

			const text = output.messages![0].parts[0].text;
			expect(text).toContain('/swarm plan');
			expect(text).toContain('[CC_COMMAND_INTERCEPT] BLOCKED: /reset');
		});
	});

	describe('ATTACK VECTOR: Corrected form bypass', () => {
		test('/swarm plan is NOT detected (already corrected form)', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('Use /swarm plan to view the plan');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's the correct form
			expect(output.messages![0].parts[0].text).toBe(
				'Use /swarm plan to view the plan',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('/swarm plan (uppercase) is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/SWARM PLAN the work');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's the correct form (case-insensitive check)
			expect(output.messages![0].parts[0].text).toBe('/SWARM PLAN the work');
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('/swarm reset is NOT detected (already corrected form)', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('Use /swarm reset to restart');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - it's the correct form
			expect(output.messages![0].parts[0].text).toBe(
				'Use /swarm reset to restart',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});
	});

	describe('ATTACK VECTOR: Code fence evasion', () => {
		test('triple-backtick block containing /reset is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('```\n/reset everything\n```');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - /reset is inside a code fence
			expect(output.messages![0].parts[0].text).toBe(
				'```\n/reset everything\n```',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('triple-backtick block containing /plan is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('```\n/plan the next sprint\n```');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - /plan is inside a code fence
			expect(output.messages![0].parts[0].text).toBe(
				'```\n/plan the next sprint\n```',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('fenced code with /plan on same line as fence is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('``` /plan\ncheck it\n```');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - /plan is on fence line (still in fence context)
			expect(output.messages![0].parts[0].text).toBe(
				'``` /plan\ncheck it\n```',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('triple-backtick block containing /checkpoint is NOT detected', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('```\n/checkpoint save my-state\n```');

			await hook.messagesTransform({}, output);

			// Should NOT be modified - /checkpoint is inside a code fence
			expect(output.messages![0].parts[0].text).toBe(
				'```\n/checkpoint save my-state\n```',
			);
			expect(output.messages![0].parts[0].text).not.toContain(
				'[CC_COMMAND_INTERCEPT]',
			);
		});

		test('/checkpoint outside fence is hard-blocked like /reset and /clear', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage('/checkpoint save my-state');

			await hook.messagesTransform({}, output);

			// /checkpoint is registered as CRITICAL in conflict-registry and must be
			// hard-blocked like /reset and /clear.
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] BLOCKED: /checkpoint',
			);
			expect(output.messages![0].parts[0].text).toContain(
				'this wipes conversation context',
			);
		});

		test('normal text after fence close is still checked', async () => {
			const hook = createCcCommandInterceptHook();
			const output = createMessage(
				'```\n/reset inside fence\n```\n/reset outside fence',
			);

			await hook.messagesTransform({}, output);

			// Only the second /reset should be blocked
			expect(output.messages![0].parts[0].text).toContain(
				'```\n/reset inside fence\n```',
			);
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] BLOCKED: /reset',
			);
			// Inside fence /reset should be preserved (not blocked)
			expect(output.messages![0].parts[0].text).toContain(
				'/reset inside fence',
			);
			// Outside fence /reset should be blocked
			expect(output.messages![0].parts[0].text).toContain(
				'[CC_COMMAND_INTERCEPT] BLOCKED: /reset',
			);
			// Verify the blocked message doesn't include the argument
			expect(output.messages![0].parts[0].text).not.toContain('everything');
		});
	});
});
