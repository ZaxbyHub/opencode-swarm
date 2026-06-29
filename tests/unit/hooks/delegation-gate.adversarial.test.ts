import { describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	getPrimaryText,
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

// ============================================
// Adversarial Tests for qaSkipCount Reset (Attack Vectors)
// ============================================
describe('adversarial: qaSkipCount reset edge cases', () => {
	// 1. Chain manipulation: coder-named-reviewer should NOT be confused for 'coder'
	it('mega_reviewer_coder should NOT be detected as coder (attack vector)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Chain with "mega_reviewer_coder" - should NOT match as coder
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer_coder', timestamp: 3 }, // Not a real coder
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should NOT reset - mega_reviewer_coder is not a coder target
		expect(session.qaSkipCount).toBe(2);
	});

	// 2. Empty delegationChain - no crash, no reset
	it('empty delegationChain should not crash and not reset', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Empty chain
		swarmState.delegationChains.set('test-session', []);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		// Should not throw
		await hook.toolAfter(toolAfterInput, {});

		// Should NOT reset - no coder in chain
		expect(session.qaSkipCount).toBe(2);
	});

	// 3. Chain with coder as LAST entry (no reviewer/test_engineer after it) - no reset
	it('coder as last entry with no QA after should NOT reset', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Chain ends with coder - no QA after
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'local_coder', timestamp: 3 }, // Last entry is coder
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should NOT reset - coder is last, no QA after
		expect(session.qaSkipCount).toBe(2);
	});

	// 4. Multiple coders: coder1 → reviewer → coder2 → test_engineer - should NOT reset
	// Only ONE of BOTH seen after LAST coder
	it('coder1 → reviewer → coder2 → test_engineer should NOT reset (only one of BOTH after last coder)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Two coders, but QA is split across them
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 }, // reviewer after coder1
			{ from: 'architect', to: 'local_coder', timestamp: 4 }, // coder2
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 5 }, // test_engineer after coder2
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should NOT reset - after coder2 (last coder), only test_engineer seen, no reviewer
		expect(session.qaSkipCount).toBe(2);
	});

	// 5. Multiple coders, both complete: coder1 → reviewer → test_engineer → coder2 → reviewer → test_engineer
	// SHOULD reset (both present after last coder)
	it('coder1 → reviewer → test_engineer → coder2 → reviewer → test_engineer SHOULD reset', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Two coders with full QA for each
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			{ from: 'architect', to: 'local_coder', timestamp: 5 },
			{ from: 'local_coder', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'local_reviewer', timestamp: 7 },
			{ from: 'architect', to: 'local_test_engineer', timestamp: 8 },
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should reset - after coder2 (last coder), BOTH reviewer AND test_engineer present
		expect(session.qaSkipCount).toBe(0);
		expect(session.qaSkipTaskIds).toEqual([]);
	});

	// 6. Agent name variants: mega_coder, local_coder, paid_coder all detected as 'coder'
	it('mega_coder should be detected as coder target', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should reset - mega_coder detected as coder
		expect(session.qaSkipCount).toBe(0);
	});

	it('local_coder should be detected as coder target', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'local_coder', timestamp: 1 },
			{ from: 'local_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should reset - local_coder detected as coder
		expect(session.qaSkipCount).toBe(0);
	});

	it('paid_coder should be detected as coder target', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'paid_coder', timestamp: 1 },
			{ from: 'paid_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.1', '1.2'];

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should reset - paid_coder detected as coder
		expect(session.qaSkipCount).toBe(0);
	});

	// 7. Null/undefined session - no crash
	it('undefined session should not crash in toolAfter', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// No session set up
		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'non-existent-session',
			callID: 'call-123',
		};
		// Should not throw
		await hook.toolAfter(toolAfterInput, {});
		// Test passes if no exception thrown
	});

	it('null sessionID should not crash in toolAfter', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: '', // Empty string
			callID: 'call-123',
		};
		// Should not throw
		await hook.toolAfter(toolAfterInput, {});
		// Test passes if no exception thrown
	});

	// Additional edge case: delegationChain is undefined
	it('undefined delegationChain should not crash', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Ensure session exists but has no delegation chain
		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		// Don't set delegationChain - it's undefined by default

		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		// Should not throw
		await hook.toolAfter(toolAfterInput, {});
		// Should NOT reset
		expect(session.qaSkipCount).toBe(2);
	});

	// Edge case: tool is not Task - should not trigger reset logic
	it('non-Tool tool should not trigger reset logic', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.2', '1.3'];

		// Use a non-Tool tool
		const toolAfterInput = {
			tool: 'tool.read',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		await hook.toolAfter(toolAfterInput, {});

		// Should NOT reset - wrong tool type
		expect(session.qaSkipCount).toBe(2);
	});
});
