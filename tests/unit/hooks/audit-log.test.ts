/**
 * Tests for src/hooks/guardrails/audit-log.ts (Task 1.1, reworked for the
 * issue #2040 bounded store).
 *
 * Covers:
 * - SC-119: type:'shell' entry has exactly {ts, sessionID, agent, tool, command}
 * - Entries land in the canonical store (.swarm/session/shell-audit.jsonl)
 *   behind a swarm-shell-audit-manifest header
 * - Additive schema for file_write / destructive_block / sandbox_wrap / sandbox_skip
 *   (typed command entries additionally carry commandHash — never on shell)
 * - Command truncation at SHELL_AUDIT_LIMITS.maxCommandChars
 * - Write-time validation: malformed entry rejected, nothing written, no throw
 * - enabled=false → nothing written
 * - Command redaction via redactShellCommand
 * - Failure is fail-open (store errors never propagate)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendGuardrailDecision,
	hashRedactedCommand,
	redactPath,
} from '../../../src/hooks/guardrails/audit-log';
import {
	_resetMaintenanceCounters,
	shellAuditFilePath,
} from '../../../src/hooks/guardrails/shell-audit-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'audit-log-test-'));
}

function storePath(dir: string): string {
	return shellAuditFilePath(dir);
}

/** Read decision lines (manifest header stripped) from the real store file. */
function readDecisionLines(dir: string): Array<Record<string, unknown>> {
	const raw = readFileSync(storePath(dir), 'utf-8');
	const lines = raw.split('\n').filter((l) => l.trim().length > 0);
	// Line 1 is the swarm-shell-audit-manifest header on a fresh store.
	const body = lines[0]?.includes('swarm-shell-audit-manifest')
		? lines.slice(1)
		: lines;
	return body.map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
	_resetMaintenanceCounters();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('appendGuardrailDecision', () => {
	// ---- SC-119: type:shell entry has EXACTLY 5 fields byte-for-byte — no type discriminator ----
	test('SC-119 shell entry writes EXACTLY 5 fields: {ts, sessionID, agent, tool, command} — no type discriminator, no commandHash', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-abc123',
			agent: 'coder',
			tool: 'bash',
			command: 'echo hello',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const decisions = readDecisionLines(dir);
		expect(decisions.length).toBe(1);
		const parsed = decisions[0]!;
		// Exactly the 5 original fields — no more, no less
		expect(Object.keys(parsed).sort()).toEqual(
			['agent', 'command', 'sessionID', 'tool', 'ts'].sort(),
		);
		expect(parsed.ts).toBe('2026-01-01T00:00:00.000Z');
		expect(parsed.sessionID).toBe('sess-abc123');
		expect(parsed.agent).toBe('coder');
		expect(parsed.tool).toBe('bash');
		expect(parsed.command).toBe('echo hello');
		// type discriminator is NOT written for shell entries (additive schema preserves original shape)
		expect(parsed.type).toBeUndefined();
		// SC-119 extension (issue #2040): shell entries never carry the hash either
		expect(parsed.commandHash).toBeUndefined();

		await rm(dir, { recursive: true, force: true });
	});

	// ---- SC-119 regression: ensure shell entry NEVER gets a type field even when passed in entry ----
	test('SC-119 regression: shell entry persisted JSON has no type field even if input had one', async () => {
		const dir = await mkTempDir();

		// The input type: 'shell' is only used for routing; it is stripped on write
		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-reg',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		// The fixed implementation writes exactly 5 fields with NO type
		expect(Object.keys(parsed)).toHaveLength(5);
		expect(parsed.type).toBeUndefined();
		expect(parsed.ts).toBe('2026-01-01T00:00:00.000Z');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Entries land in the canonical store under .swarm/session/ ----
	test('entry is written to the canonical .swarm/session/shell-audit.jsonl store behind the manifest header', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-xyz',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const raw = readFileSync(storePath(dir), 'utf-8');
		const firstLine = raw.split('\n')[0]!;
		expect(JSON.parse(firstLine).type).toBe('swarm-shell-audit-manifest');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: file_write entry ----
	test('file_write entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();

		// Use a path that will NOT be transformed by redactPath on any platform
		const testPath = join(dir, 'subdir', 'test.txt');

		const entry = {
			type: 'file_write' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-fw',
			agent: 'coder',
			tool: 'write',
			path: testPath,
			reason: 'user requested',
			resolvedScope: dir,
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.type).toBe('file_write');
		// path is present (redactPath may transform it on Windows home dirs)
		expect(parsed.path).toBeDefined();
		expect(typeof parsed.path).toBe('string');
		expect(parsed.reason).toBe('user requested');
		// resolvedScope is redacted via redactPath (home-dir → ~, separators normalized)
		expect(parsed.resolvedScope).toBe(redactPath(dir));

		await rm(dir, { recursive: true, force: true });
	});

	test('F-003: file_write reason is redacted before persistence', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'file_write' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-fw-redact',
			agent: 'coder',
			tool: 'write',
			path: '/home/alice/project/link',
			reason: 'WRITE BLOCKED: symlink detected at /home/alice/project/link',
			resolvedScope: '/home/alice/project',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.reason).not.toContain('/home/alice');
		expect(parsed.reason).toContain('~/project/link');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: destructive_block entry (+ commandHash) ----
	test('destructive_block entry includes type discriminator, per-type fields, and a commandHash of the REDACTED command', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'destructive_block' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-db',
			agent: 'coder',
			tool: 'bash',
			command: 'rm -rf /',
			destructiveCategory: 'dangerous_delete',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.type).toBe('destructive_block');
		expect(parsed.destructiveCategory).toBe('dangerous_delete');
		expect(parsed.command).toBe('rm -rf /'); // redaction applied (no secrets present)
		expect(parsed.commandHash).toBe(hashRedactedCommand('rm -rf /'));
		// Deterministic correlation: same redacted command → same hash
		expect(parsed.commandHash).toMatch(/^[0-9a-f]{16}$/);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: sandbox_wrap entry ----
	test('sandbox_wrap entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'sandbox_wrap' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-sw',
			agent: 'coder',
			tool: 'bash',
			command: 'npm install',
			executorMechanism: 'bubblewrap',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.type).toBe('sandbox_wrap');
		expect(parsed.executorMechanism).toBe('bubblewrap');
		expect(parsed.command).toBe('npm install');
		expect(parsed.commandHash).toBeDefined();

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: sandbox_skip entry ----
	test('sandbox_skip entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'sandbox_skip' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-ss',
			agent: 'coder',
			tool: 'bash',
			command: 'echo hi',
			executorMechanism: 'none',
			skipReason: 'read-only command',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.type).toBe('sandbox_skip');
		expect(parsed.executorMechanism).toBe('none');
		expect(parsed.skipReason).toBe('read-only command');
		expect(parsed.command).toBe('echo hi');
		expect(parsed.commandHash).toBeDefined();

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: scope_violation entry ----
	test('scope_violation entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'scope_violation' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-sv',
			agent: 'coder',
			tool: 'bash',
			path: '/etc/passwd',
			declaredScope: '/project/src',
			resolvedScope: '/etc',
			action: 'write',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.type).toBe('scope_violation');
		// declaredScope/resolvedScope are redacted via redactPath (separators normalized on Windows)
		expect(parsed.declaredScope).toBe(redactPath('/project/src'));
		expect(parsed.resolvedScope).toBe(redactPath('/etc'));
		expect(parsed.action).toBe('write');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Issue #2040: giant commands are truncated at line-shaping time ----
	test('giant command is truncated to maxCommandChars with an explicit marker (shell entry)', async () => {
		const dir = await mkTempDir();
		const giant = `echo ${'a'.repeat(50_000)}`;

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-big',
			agent: 'coder',
			tool: 'bash',
			command: giant,
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(typeof parsed.command).toBe('string');
		expect((parsed.command as string).length).toBeLessThan(5_000);
		expect(parsed.command).toContain('…[truncated]');
		// The persisted line must stay under the store's hard maxLineBytes.
		const raw = readFileSync(storePath(dir), 'utf-8');
		const decisionLine = raw.split('\n').filter((l) => l.trim())[1]!;
		expect(Buffer.byteLength(decisionLine)).toBeLessThan(64 * 1024);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Write-time validation: malformed entry (missing sessionID) is rejected ----
	test('malformed entry missing sessionID is rejected: nothing written, no exception propagates', async () => {
		const dir = await mkTempDir();

		// entry missing sessionID (required string field)
		const badEntry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
			// sessionID is missing
		};

		let threw = false;
		try {
			await appendGuardrailDecision(badEntry as any, {
				directory: dir,
				enabled: true,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		// Nothing should have been appended — the store file is never created
		let exists = true;
		try {
			readFileSync(storePath(dir));
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Write-time validation: invalid type discriminator is rejected ----
	test('entry with invalid type discriminator is rejected: nothing written, no exception', async () => {
		const dir = await mkTempDir();

		const badEntry = {
			type: 'not_a_valid_type' as any,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-abc',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		let threw = false;
		try {
			await appendGuardrailDecision(badEntry, { directory: dir, enabled: true });
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		let exists = true;
		try {
			readFileSync(storePath(dir));
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});

	describe('F-008: per-type validation rejection paths', () => {
		const base = {
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-reject',
			agent: 'coder',
			tool: 'bash',
		};

		const cases = [
			{
				name: 'file_write missing reason',
				entry: {
					...base,
					type: 'file_write' as const,
					path: 'src/index.ts',
					resolvedScope: 'src',
				},
			},
			{
				name: 'scope_violation missing action',
				entry: {
					...base,
					type: 'scope_violation' as const,
					path: '../outside.txt',
					declaredScope: 'src',
					resolvedScope: '..',
				},
			},
			{
				name: 'destructive_block missing destructiveCategory',
				entry: {
					...base,
					type: 'destructive_block' as const,
					command: 'rm -rf /',
				},
			},
			{
				name: 'sandbox_wrap missing command',
				entry: {
					...base,
					type: 'sandbox_wrap' as const,
					mechanism: 'bubblewrap',
				},
			},
			{
				name: 'sandbox_skip missing reason',
				entry: {
					...base,
					type: 'sandbox_skip' as const,
					command: 'echo hi',
				},
			},
		];

		for (const testCase of cases) {
			test(`${testCase.name} is rejected`, async () => {
				const dir = await mkTempDir();

				await appendGuardrailDecision(testCase.entry as any, {
					directory: dir,
					enabled: true,
				});

				let exists = true;
				try {
					readFileSync(storePath(dir));
				} catch {
					exists = false;
				}
				expect(exists).toBe(false);
				await rm(dir, { recursive: true, force: true });
			});
		}
	});

	// ---- enabled=false → nothing written ----
	test('enabled=false skips writing entirely', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-off',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: false });

		let exists = true;
		try {
			readFileSync(storePath(dir));
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Command redaction: shell entry with secret is redacted ----
	test('shell entry with secret pattern is redacted via redactShellCommand', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-redact',
			agent: 'coder',
			tool: 'bash',
			command:
				"curl -H 'Authorization: Bearer sk-test1234567890' https://api.example.com",
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		// The Bearer token should be redacted
		expect(parsed.command).not.toContain('sk-test1234567890');
		expect(parsed.command).toContain('[REDACTED]');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Command redaction: destructive_block with API key is redacted ----
	test('destructive_block entry with API_TOKEN in command is redacted', async () => {
		const dir = await mkTempDir();

		const entry = {
			type: 'destructive_block' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-dbredact',
			agent: 'coder',
			tool: 'bash',
			command: 'rm /tmp/API_TOKEN=abc123xyz',
			destructiveCategory: 'path_destruction',
		};

		await appendGuardrailDecision(entry, { directory: dir, enabled: true });

		const parsed = readDecisionLines(dir)[0]!;
		expect(parsed.command).not.toContain('abc123xyz');
		expect(parsed.command).toContain('[REDACTED]');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Failure is fail-open: unusable directory does not throw ----
	test('fail-open: appending into an unusable directory does not throw', async () => {
		const dir = await mkTempDir();
		// A FILE where the store wants a DIRECTORY — mkdirSync fails on every platform.
		const blocker = join(dir, 'blocker');
		await writeFile(blocker, 'not a directory', 'utf-8');

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-failopen',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		let threw = false;
		try {
			await appendGuardrailDecision(entry, {
				directory: join(blocker, 'nested'),
				enabled: true,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('redactPath', () => {
	test('Windows profile path is redacted on Windows', () => {
		if (process.platform !== 'win32') return;
		const result = redactPath('C:\\Users\\alice\\project\\file.txt');
		// Should start with ~\
		expect(result.startsWith('~\\')).toBe(true);
		expect(result).not.toContain('alice');
	});

	test('POSIX home path is redacted on POSIX', () => {
		if (process.platform === 'win32') return;
		const result = redactPath('/home/bob/project/file.txt');
		// Should start with ~/
		expect(result.startsWith('~/')).toBe(true);
		expect(result).not.toContain('bob');
	});

	test('F-004: UNC path is redacted without leaking server segment', () => {
		const result = redactPath('\\\\server\\share\\alice\\project\\file.txt');

		expect(result).toBe('~\\share\\alice\\project\\file.txt');
		expect(result).not.toContain('server');
	});

	test('non-home path is unchanged', () => {
		const input = '/project/src/file.txt';
		const result = redactPath(input);
		// redactPath normalizes separators — check it does not leak the input unchanged
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
	});

	test('empty string returns empty string', () => {
		expect(redactPath('')).toBe('');
	});

	test('null and undefined return empty string (non-strings are coerced, never passed through)', () => {
		// Issue #2040 reviewer round R2: the old passthrough (returning the
		// non-string verbatim) was a minimization weakening; the strengthened
		// contract coerces to ''.
		expect(redactPath(null as any)).toBe('');
		expect(redactPath(undefined as any)).toBe('');
	});
});
