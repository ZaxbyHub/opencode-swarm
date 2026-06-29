import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetSwarmState } from '../../../src/state';
import {
	getPrimaryText,
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

describe('delegation gate hook — core', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('no-op when disabled', async () => {
		const config = makeConfig({ hooks: { delegation_gate: false } });
		const hook = createDelegationGateHook(config, process.cwd());

		const messages = makeMessages(
			'coder\nTASK: Add validation\nFILE: src/test.ts',
			'architect',
		);
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		expect(getPrimaryText(messages)).toBe(originalText);
	});

	it('ignores non-coder delegations', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Long message without coder TASK: pattern - use null sessionID to skip preamble
		const longText =
			'TASK: Review this very long task description ' + 'a'.repeat(5000);
		const messages = makeMessages(longText, 'architect', null);

		await hook.messagesTransform({}, messages);

		// User message text should be unchanged
		const userMsg = messages.messages.find((m) => m.info?.role === 'user');
		expect(userMsg?.parts[0].text).toBe(longText);
	});

	it('ignores non-architect agents', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Coder delegation from non-architect agent - should be skipped entirely
		const longText = 'coder\nTASK: ' + 'a'.repeat(5000);
		const messages = makeMessages(longText, 'coder');
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		// Non-architect agents should result in no modification
		expect(getPrimaryText(messages)).toBe(originalText);
	});

	it('no warning when delegation is small and clean', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const cleanText =
			'coder\nTASK: Add validation\nFILE: src/test.ts\nINPUT: Validate email format';
		const messages = makeMessages(cleanText, 'architect', null);
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		expect(getPrimaryText(messages)).toBe(originalText);
	});
});
