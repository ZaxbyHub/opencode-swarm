/**
 * Tests for task 2.1: guardrail decision-log capture wired into the toolBefore hook.
 *
 * Verifies that when the toolBefore handler blocks a tool invocation, it also
 * appends a typed decision entry to the caller-supplied audit path via
 * appendGuardrailDecision.
 *
 * Covered block types:
 *   - destructive_block  — bash/shell with a destructive command
 *   - scope_violation    — bash/shell write targeting a path outside declared scope
 *   - file_write         — write tool targeting a path agent has no authority over
 *
 * sandbox_wrap / sandbox_skip are not deterministically unit-testable here
 * because they require a live platform executor (bwrap/nsjail) to be available,
 * and the sandbox probe is skipped when no executor is found. They are covered
 * by integration tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

/** Build the toolBefore input shape. */
function makeInput(
	sessionID = 'test-session',
	tool = 'read',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

/**
 * Circuit-breaker-free config so gate limits don't interfere with individual
 * tool calls. Also explicitly enables shell_audit_log.
 * idle_timeout_minutes is set to 60 (not 0) to prevent the circuit breaker
 * from firing immediately on first call (0 >= 0 would trigger).
 */
function nullConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 0,
		max_duration_minutes: 0,
		idle_timeout_minutes: 60,
		max_repetitions: 999,
		max_consecutive_errors: 999,
		warning_threshold: 1.0,
		shell_audit_log: true,
		profiles: undefined,
	};
}

/**
 * Read every JSON line from auditPath and parse into objects.
 * Returns an empty array if the file does not exist.
 */
function readAuditLog(auditPath: string): Record<string, unknown>[] {
	if (!fsSync.existsSync(auditPath)) return [];
	return fsSync
		.readFileSync(auditPath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

/** Count entries of a given type in the audit log. */
function countEntriesByType(
	entries: Record<string, unknown>[],
	type: string,
): number {
	return entries.filter((e) => e.type === type).length;
}

async function waitForAuditEntries(
	auditPath: string,
	expectedCount = 1,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	let delayMs = 10;
	while (Date.now() - start < timeoutMs) {
		if (fsSync.existsSync(auditPath)) {
			const entries = readAuditLog(auditPath);
			if (entries.length >= expectedCount) return;
		}
		await Bun.sleep(delayMs);
		delayMs = Math.min(delayMs * 2, 100);
	}
	const entries = readAuditLog(auditPath);
	throw new Error(
		`Timed out waiting for ${expectedCount} audit entries; saw ${entries.length}`,
	);
}

async function waitForAuditEntryType(
	auditPath: string,
	type: string,
	expectedCount = 1,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	let delayMs = 10;
	while (Date.now() - start < timeoutMs) {
		if (fsSync.existsSync(auditPath)) {
			const entries = readAuditLog(auditPath);
			if (countEntriesByType(entries, type) >= expectedCount) return;
		}
		await Bun.sleep(delayMs);
		delayMs = Math.min(delayMs * 2, 100);
	}
	const entries = readAuditLog(auditPath);
	throw new Error(
		`Timed out waiting for ${expectedCount} ${type} audit entries; saw ${countEntriesByType(entries, type)}`,
	);
}

async function waitForAuditEntry(
	auditPath: string,
	predicate: (entry: Record<string, unknown>) => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	let delayMs = 10;
	while (Date.now() - start < timeoutMs) {
		if (fsSync.existsSync(auditPath)) {
			const entries = readAuditLog(auditPath);
			if (entries.some(predicate)) return;
		}
		await Bun.sleep(delayMs);
		delayMs = Math.min(delayMs * 2, 100);
	}
	throw new Error('Timed out waiting for matching audit entry');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('guardrail decision-log capture (task 2.1)', () => {
	let tempDir: string;
	let auditPath: string;

	beforeEach(() => {
		resetSwarmState();
		// Temp dir for this test — the hook writes its audit file here
		tempDir = fsSync.realpathSync(
			fsSync.mkdtempSync(path.join(os.tmpdir(), 'guardrail-capture-test-')),
		);
		// The hook always writes to .swarm/session/shell-audit.jsonl under the passed directory
		auditPath = path.join(tempDir, '.swarm', 'session', 'shell-audit.jsonl');
	});

	afterEach(async () => {
		// Best-effort cleanup guard if a test failed before its own wait.
		if (fsSync.existsSync(auditPath)) {
			await waitForAuditEntries(auditPath, 1, 200).catch(() => {});
		}
		resetSwarmState();
		try {
			fsSync.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	// -------------------------------------------------------------------------
	// destructive_block — fork bomb
	// -------------------------------------------------------------------------
	describe('destructive_block', () => {
		it('throws the block error AND appends a destructive_block JSONL entry', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-dest', 'coder');
			swarmState.activeAgent.set('s-dest', 'coder');

			// Fork bomb is a blocked destructive command that does not overlap
			// shell write-scope analysis.
			await expect(
				hooks.toolBefore(makeInput('s-dest', 'bash', 'call-dest'), {
					args: { command: ':(){ :|:& };:' },
				}),
			).rejects.toThrow(/BLOCKED/i);

			await waitForAuditEntryType(auditPath, 'destructive_block');

			// Verify audit entry was appended
			const entries = readAuditLog(auditPath);
			expect(
				countEntriesByType(entries, 'destructive_block'),
			).toBeGreaterThanOrEqual(1);

			// The entry must carry the required fields
			const entry = entries.find((e) => e.type === 'destructive_block');
			expect(entry).toBeDefined();
			expect(typeof entry!.ts).toBe('string');
			expect(entry!.sessionID).toBe('s-dest');
			expect(entry!.agent).toBe('coder');
			expect(entry!.tool).toBe('bash');
			expect(entry!.command).toContain(':(){ :|:& };:');
			expect(typeof entry!.destructiveCategory).toBe('string');
		});

		it('still throws when a second destructive command is issued (no swallowing)', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-dest2', 'coder');
			swarmState.activeAgent.set('s-dest2', 'coder');

			// First destructive command — should throw
			await expect(
				hooks.toolBefore(makeInput('s-dest2', 'bash', 'call-dest2a'), {
					args: { command: ':(){ :|:& };:' },
				}),
			).rejects.toThrow(/BLOCKED/i);

			// Second destructive command — should ALSO throw (not swallowed)
			await expect(
				hooks.toolBefore(makeInput('s-dest2', 'bash', 'call-dest2b'), {
					args: { command: ': () { :|:& };:' },
				}),
			).rejects.toThrow(/BLOCKED/i);

			await waitForAuditEntryType(auditPath, 'destructive_block', 2);

			// Both should appear as separate audit entries
			const entries = readAuditLog(auditPath);
			expect(
				countEntriesByType(entries, 'destructive_block'),
			).toBeGreaterThanOrEqual(2);
		});
	});

	// -------------------------------------------------------------------------
	// scope_violation — bash write targeting a path outside declared scope
	//
	// The scope_violation is reached when:
	//   1. checkShellWriteScope runs (bash/shell with detected writes)
	//   2. checkFileAuthorityWithRules passes (path is allowed for the agent)
	//   3. isInDeclaredScope returns false (path outside declared scope)
	//
	// On Windows, absolute Unix paths like /tmp/out.txt resolve outside the cwd
	// and are caught by checkFileAuthorityWithRules (file_write), not scope_violation.
	// We use a relative sibling directory (lib/) that is inside the cwd but
	// outside the declared scope (src/).
	// -------------------------------------------------------------------------
	describe('scope_violation', () => {
		it('throws a scope_violation error AND appends a scope_violation JSONL entry', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			// Use test_engineer because:
			// - test_engineer has blockedPrefix ['src/'] but can write to lib/
			//   (lib/ is not in blockedPrefix, blockedZones, or allowedGlobs)
			// - With declaredScope=['src/'], writing to lib/ passes authority
			//   but fails the isInDeclaredScope check → scope_violation
			startAgentSession('s-scope', 'test_engineer');
			swarmState.activeAgent.set('s-scope', 'test_engineer');

			installActiveScopeBinding({
				directory: tempDir,
				childSessionId: 's-scope',
				taskId: '1.1',
				files: ['src/'],
			});

			// echo hello > lib/output.txt — inside cwd, but outside declaredScope src/
			// Authority check passes (lib/ is not blocked for test_engineer).
			// Scope check fails: lib/output.txt is not in declaredScope.
			await expect(
				hooks.toolBefore(makeInput('s-scope', 'bash', 'call-scope'), {
					args: { command: 'echo hello > lib/output.txt' },
				}),
			).rejects.toThrow();

			await waitForAuditEntryType(auditPath, 'scope_violation');

			const entries = readAuditLog(auditPath);

			// The scope_violation must be present (not file_write)
			const scopeEntry = entries.find((e) => e.type === 'scope_violation');
			expect(scopeEntry).toBeDefined();
			expect(scopeEntry!.sessionID).toBe('s-scope');
			expect(scopeEntry!.agent).toBe('test_engineer');
			expect(scopeEntry!.tool).toBe('bash');
			expect(typeof scopeEntry!.path).toBe('string');
			expect(scopeEntry!.declaredScope).toBeTruthy();
			expect(scopeEntry!.resolvedScope).toBeTruthy();
			expect(scopeEntry!.action).toBe('bash');
		});
	});

	// -------------------------------------------------------------------------
	// file_write — write tool targeting a path the agent has no authority over
	//
	// NOTE: We use biome.jsonc (a config file in architect's blockedGlobs) instead
	// of .swarm/plan.md. The latter is caught by handlePlanAndScopeProtection()
	// (line 1929) which runs BEFORE the isWriteTool audit block (line 1933+),
	// so it throws "PLAN STATE VIOLATION" without reaching appendGuardrailDecision.
	// Using biome.jsonc triggers checkFileAuthorityWithRules (line 2020) which
	// DOES call appendGuardrailDecision before throwing.
	// -------------------------------------------------------------------------
	describe('file_write (write tool authority denial)', () => {
		it('throws WRITE_BLOCKED AND appends a file_write JSONL entry', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			// architect: biome.jsonc is in blockedGlobs (**/biome.jsonc)
			startAgentSession('s-file', 'architect');
			swarmState.activeAgent.set('s-file', 'architect');

			// Attempt to write to biome.jsonc — architect has blockedGlobs for this
			await expect(
				hooks.toolBefore(makeInput('s-file', 'write', 'call-file'), {
					args: { filePath: 'biome.jsonc' },
				}),
			).rejects.toThrow(/WRITE BLOCKED|not authorised|blocked/i);

			await waitForAuditEntryType(auditPath, 'file_write');

			const entries = readAuditLog(auditPath);
			expect(countEntriesByType(entries, 'file_write')).toBeGreaterThanOrEqual(
				1,
			);

			const entry = entries.find((e) => e.type === 'file_write');
			expect(entry).toBeDefined();
			expect(entry!.sessionID).toBe('s-file');
			expect(entry!.agent).toBe('architect');
			expect(entry!.tool).toBe('write');
			expect(entry!.path).toBe('biome.jsonc');
			expect(typeof entry!.reason).toBe('string');
			expect(typeof entry!.resolvedScope).toBe('string');
		});
	});

	// -------------------------------------------------------------------------
	// shell audit entries are still appended (shell path unchanged)
	//
	// NOTE: shell entries are written in a legacy 5-field shape
	// {ts, sessionID, agent, tool, command} WITHOUT a `type` discriminator
	// (audit-log.ts:305-307). So we check by presence of sessionID + tool + command
	// rather than countEntriesByType(entries, 'shell').
	// -------------------------------------------------------------------------
	describe('shell audit entries still appended', () => {
		it('appends a shell entry for a non-destructive bash command', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-shell', 'coder');
			swarmState.activeAgent.set('s-shell', 'coder');

			// Non-destructive command — should NOT throw
			await hooks.toolBefore(makeInput('s-shell', 'bash', 'call-shell'), {
				args: { command: 'echo hello' },
			});

			await waitForAuditEntry(
				auditPath,
				(e) =>
					e.sessionID === 's-shell' &&
					e.agent === 'coder' &&
					e.tool === 'bash' &&
					!e.type,
			);

			const entries = readAuditLog(auditPath);
			// shell entries have no `type` field (legacy 5-field shape)
			const shellEntry = entries.find(
				(e) =>
					e.sessionID === 's-shell' &&
					e.agent === 'coder' &&
					e.tool === 'bash' &&
					// @ts-ignore — type field absent on shell entries by design
					!e.type,
			);
			expect(shellEntry).toBeDefined();
			expect(typeof shellEntry!.ts).toBe('string');
			expect(shellEntry!.sessionID).toBe('s-shell');
			expect(shellEntry!.agent).toBe('coder');
			expect(shellEntry!.tool).toBe('bash');
		});

		it('destructive command fires BOTH a shell entry AND a destructive_block entry', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-dup', 'coder');
			swarmState.activeAgent.set('s-dup', 'coder');

			// A destructive command — throws, but shell entry fires first in handler
			await expect(
				hooks.toolBefore(makeInput('s-dup', 'bash', 'call-dup'), {
					args: { command: ':(){ :|:& };:' },
				}),
			).rejects.toThrow(/BLOCKED/i);

			await waitForAuditEntry(
				auditPath,
				(e) =>
					e.sessionID === 's-dup' &&
					e.agent === 'coder' &&
					e.tool === 'bash' &&
					!e.type,
			);
			await waitForAuditEntryType(auditPath, 'destructive_block');

			const entries = readAuditLog(auditPath);

			// shell entry (no type field — legacy 5-field shape)
			const shellEntry = entries.find(
				(e) =>
					e.sessionID === 's-dup' &&
					e.agent === 'coder' &&
					// @ts-ignore — type field absent on shell entries by design
					!e.type,
			);
			expect(shellEntry).toBeDefined();

			// destructive_block entry (has type: 'destructive_block')
			expect(countEntriesByType(entries, 'destructive_block')).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Original block error is still thrown (capture does not swallow the block)
	// -------------------------------------------------------------------------
	describe('block error propagation (capture does not swallow the block)', () => {
		it('destructive_block throws the original block error', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-propagate', 'coder');
			swarmState.activeAgent.set('s-propagate', 'coder');

			// The error message must contain the specific block reason
			await expect(
				hooks.toolBefore(makeInput('s-propagate', 'bash', 'call-prop'), {
					args: { command: 'git reset --hard' },
				}),
			).rejects.toThrow(/BLOCKED.*git reset/i);
		});

		it('scope_violation throws (error type is not swallowed by the capture)', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-propagate2', 'test_engineer');
			swarmState.activeAgent.set('s-propagate2', 'test_engineer');

			installActiveScopeBinding({
				directory: tempDir,
				childSessionId: 's-propagate2',
				taskId: '1.1',
				files: ['src/'],
			});

			// The error must be thrown (not swallowed by the audit capture)
			await expect(
				hooks.toolBefore(makeInput('s-propagate2', 'bash', 'call-prop2'), {
					args: { command: 'echo hello > lib/output.txt' },
				}),
			).rejects.toThrow();
		});

		it('file_write throws the authority denial error', async () => {
			const hooks = createGuardrailsHooks(tempDir, nullConfig());

			startAgentSession('s-propagate3', 'architect');
			swarmState.activeAgent.set('s-propagate3', 'architect');

			await expect(
				hooks.toolBefore(makeInput('s-propagate3', 'write', 'call-prop3'), {
					args: { filePath: '.swarm/plan.md' },
				}),
			).rejects.toThrow(/WRITE BLOCKED|not authorised|blocked/i);
		});
	});

	// -------------------------------------------------------------------------
	// sandbox_wrap / sandbox_skip — not deterministically unit-testable here
	// -------------------------------------------------------------------------
	describe('sandbox_wrap / sandbox_skip', () => {
		it.todo(
			'NOT UNIT-TESTABLE in this suite — requires a live platform executor ' +
				'(bwrap/nsjail) to be available. The sandbox probe is skipped when ' +
				'no executor is found, making this non-deterministic. Covered by ' +
				'integration tests.',
		);
	});

	// -------------------------------------------------------------------------
	// Direct appendGuardrailDecision call — sanity check that the audit mechanism
	// works when called directly (bypasses the toolBefore handler void-fire-and-forget)
	// -------------------------------------------------------------------------
	describe('appendGuardrailDecision direct call sanity check', () => {
		it('writes a file_write entry to the audit path when called directly', async () => {
			// Direct import to bypass the void fire-and-forget in toolBefore
			const { appendGuardrailDecision } = await import(
				'../../../src/hooks/guardrails/audit-log.js'
			);

			await appendGuardrailDecision(
				{
					type: 'file_write',
					ts: new Date().toISOString(),
					sessionID: 'direct-test',
					agent: 'architect',
					tool: 'write',
					path: '.swarm/plan.md',
					reason: 'blocked',
					resolvedScope: '',
				},
				{ auditPath, enabled: true },
			);

			await waitForAuditEntryType(auditPath, 'file_write');

			const entries = readAuditLog(auditPath);
			expect(countEntriesByType(entries, 'file_write')).toBeGreaterThanOrEqual(
				1,
			);

			const entry = entries.find((e) => e.type === 'file_write');
			expect(entry).toBeDefined();
			expect(entry!.agent).toBe('architect');
			expect(entry!.tool).toBe('write');
		});
	});
});
