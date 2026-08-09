/**
 * delegation-ledger.test.ts
 *
 * Tests for delegation-ledger hook (Task 3.2):
 * 1. toolAfter records entries in ledgerBySession
 * 2. onArchitectResume generates DELEGATION SUMMARY when non-architect tool calls exist
 * 3. onArchitectResume is no-op when no entries exist
 * 4. Success is false when output starts with 'Error:'
 * 5. Success is true for normal output
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureAgentSession, resetSwarmState } from '../state';
import { createDelegationLedgerHook } from './delegation-ledger';

const CODER_SESSION_ID = 'test-session-coder';
const ARCHITECT_SESSION_ID = 'test-session-architect';
const WORKSPACE_DIR = '/workspace';

describe('delegation-ledger hook (Task 3.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 1: toolAfter records entries in ledgerBySession
	// ─────────────────────────────────────────────────────────────
	it('1. toolAfter records entries in ledgerBySession', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Record a tool call
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-1',
				args: { path: '/workspace/src/hooks/scope-guard.ts' },
			},
			{
				title: 'edit',
				output: 'File modified successfully',
				metadata: {},
			},
		);

		// The hook stores entries internally via ledgerBySession
		// We verify this indirectly via onArchitectResume generating a summary
		expect(advisories.length).toBe(0); // No summary yet (architect hasn't resumed)

		// Trigger architect resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		// Now we should have a delegation summary
		expect(advisories.length).toBe(1);
		expect(advisories[0].message).toContain('DELEGATION SUMMARY');
		expect(advisories[0].message).toContain('Tool calls: 1');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 2: onArchitectResume generates DELEGATION SUMMARY
	// ─────────────────────────────────────────────────────────────
	it('2. onArchitectResume generates DELEGATION SUMMARY when non-architect tool calls exist', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Record multiple tool calls from a coder
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-1',
				args: { path: '/workspace/src/hooks/scope-guard.ts' },
			},
			{ title: 'edit', output: 'ok', metadata: {} },
		);

		await hook.toolAfter(
			{
				tool: 'read',
				sessionID: CODER_SESSION_ID,
				callID: 'call-2',
				args: { path: '/workspace/src/hooks/delegation-ledger.ts' },
			},
			{ title: 'read', output: 'file content', metadata: {} },
		);

		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-3',
				args: { path: '/workspace/src/hooks/loop-detector.ts' },
			},
			{ title: 'edit', output: 'ok', metadata: {} },
		);

		// Trigger architect resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		expect(advisories.length).toBe(1);
		const summary = advisories[0].message;
		expect(summary).toContain('DELEGATION SUMMARY');
		expect(summary).toContain('Tool calls: 3');
		expect(summary).toContain('Files modified:');
		expect(summary).toContain('Files read:');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 3: onArchitectResume is no-op when no entries exist
	// ─────────────────────────────────────────────────────────────
	it('3. onArchitectResume is no-op when no entries exist', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Don't record any tool calls

		// Trigger architect resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		// No summary should be generated
		expect(advisories.length).toBe(0);
	});

	// ─────────────────────────────────────────────────────────────
	// Test 4: Success is false when output starts with 'Error:'
	// ─────────────────────────────────────────────────────────────
	it('4. Success is false when output starts with Error:', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Record a failed tool call
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-1',
				args: { path: '/workspace/src/hooks/scope-guard.ts' },
			},
			{ title: 'edit', output: 'Error: permission denied', metadata: {} },
		);

		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-2',
				args: { path: '/workspace/src/hooks/loop-detector.ts' },
			},
			{ title: 'edit', output: 'error: file not found', metadata: {} },
		);

		// Trigger architect resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		expect(advisories.length).toBe(1);
		const summary = advisories[0].message;
		// Should indicate 2 failed calls
		expect(summary).toContain('2 failed');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 5: Success is true for normal output
	// ─────────────────────────────────────────────────────────────
	it('5. Success is true for normal output', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Record successful tool calls
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-1',
				args: { path: '/workspace/src/hooks/scope-guard.ts' },
			},
			{ title: 'edit', output: 'File modified successfully', metadata: {} },
		);

		await hook.toolAfter(
			{
				tool: 'bash',
				sessionID: CODER_SESSION_ID,
				callID: 'call-2',
				args: { command: 'echo hello' },
			},
			{ title: 'bash', output: 'hello', metadata: {} },
		);

		// Trigger architect resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		expect(advisories.length).toBe(1);
		const summary = advisories[0].message;
		// Should NOT show any failures
		expect(summary).not.toContain('failed');
		// But should show 2 tool calls
		expect(summary).toContain('Tool calls: 2');
	});

	// ─────────────────────────────────────────────────────────────
	// Additional edge cases
	// ─────────────────────────────────────────────────────────────

	it('clears ledger after generating summary', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-1',
				args: { path: '/workspace/src/hooks/scope-guard.ts' },
			},
			{ title: 'edit', output: 'ok', metadata: {} },
		);

		// First resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);
		expect(advisories.length).toBe(1);
		expect(advisories[0].message).toContain('Tool calls: 1');

		// Second resume with same ledger (should be empty now)
		hook.onArchitectResume(ARCHITECT_SESSION_ID);
		// No new advisories since ledger was cleared
		expect(advisories.length).toBe(1);
	});

	it('skips architect session tool calls', async () => {
		// Set up architect session
		ensureAgentSession(ARCHITECT_SESSION_ID, 'Architect');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Record tool call from architect's own session
		await hook.toolAfter(
			{
				tool: 'read',
				sessionID: ARCHITECT_SESSION_ID,
				callID: 'call-1',
				args: { path: '/workspace/src/hooks/scope-guard.ts' },
			},
			{ title: 'read', output: 'content', metadata: {} },
		);

		// Trigger architect resume
		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		// No summary since architect's own calls are excluded
		expect(advisories.length).toBe(0);
	});

	it('extracts file path from args.filePath', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: CODER_SESSION_ID,
				callID: 'call-1',
				args: { filePath: '/workspace/src/hooks/delegation-ledger.ts' },
			},
			{ title: 'edit', output: 'ok', metadata: {} },
		);

		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		expect(advisories.length).toBe(1);
		expect(advisories[0].message).toContain('delegation-ledger.ts');
	});

	// ─────────────────────────────────────────────────────────────
	// Issue #1976 B9: per-session ledger entry cap + disclosure
	// (invariant 8 bounded-memory remediation)
	// ─────────────────────────────────────────────────────────────
	it('B9: caps per-session entries at 200 and discloses dropped calls in the summary', async () => {
		ensureAgentSession(CODER_SESSION_ID, 'coder');

		const advisories: Array<{ sessionId: string; message: string }> = [];
		const hook = createDelegationLedgerHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(sessionId, message) => {
				advisories.push({ sessionId, message });
			},
		);

		// Record 210 tool calls for ONE session — exceeds the 200-entry cap.
		for (let i = 0; i < 210; i++) {
			await hook.toolAfter(
				{
					tool: 'edit',
					sessionID: CODER_SESSION_ID,
					callID: `cap-call-${i}`,
					args: { path: `/workspace/src/file-${i}.ts` },
				},
				{
					title: 'edit',
					output: 'ok',
					metadata: {},
				},
			);
		}

		hook.onArchitectResume(ARCHITECT_SESSION_ID);

		expect(advisories.length).toBe(1);
		// The summary is built from the capped (keep-latest 200) entry list, so
		// the retained tool-call count is 200…
		expect(advisories[0].message).toContain('Tool calls: 200');
		// …and the disclosure reports that 10 older calls were dropped by the cap.
		expect(advisories[0].message).toContain('10 earlier call(s) omitted');
		expect(advisories[0].message).toContain('per-session ledger cap');
	});
});
