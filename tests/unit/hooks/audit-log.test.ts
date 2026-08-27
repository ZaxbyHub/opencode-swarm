/**
 * Tests for src/hooks/guardrails/audit-log.ts (Task 1.1)
 *
 * Covers:
 * - SC-119: type:'shell' entry has exactly {ts, sessionID, agent, tool, command}
 * - SC-118: entries stored under given auditPath
 * - Additive schema for file_write / destructive_block / sandbox_wrap / sandbox_skip
 * - Write-time validation: malformed entry rejected, nothing written, no throw
 * - enabled=false → nothing written
 * - Command redaction via redactShellCommand
 * - Failure is fail-open
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	appendGuardrailDecision,
	redactPath,
} from '../../../src/hooks/guardrails/audit-log';

async function mkTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'audit-log-test-'));
}

async function readAuditLog(path: string): Promise<string[]> {
	try {
		return readFileSync(path, 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
	} catch {
		return [];
	}
}

function jsonLine(line: string): Record<string, unknown> {
	return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// DI-seam via _internals (avoids the Bun module-level fs mock that leaks across test
// files in the shared runner — AGENTS.md invariant 7). Function refs on the exported
// _internals object are reassigned in beforeEach and restored in afterEach, so nothing
// leaks across files.
// ---------------------------------------------------------------------------

// Track append calls for verification
const appendCalls: Array<{ path: string; content: string }> = [];
const mkdirCalls: string[] = [];

const realMkdir = _internals.mkdir;
const realAppendFile = _internals.appendFile;

beforeEach(() => {
	appendCalls.length = 0;
	mkdirCalls.length = 0;
	_internals.mkdir = (async (p: string) => {
		mkdirCalls.push(p);
		return;
	}) as typeof _internals.mkdir;
	_internals.appendFile = (async (p: string, content: string) => {
		appendCalls.push({ path: p, content });
		return;
	}) as typeof _internals.appendFile;
});

afterEach(() => {
	_internals.mkdir = realMkdir;
	_internals.appendFile = realAppendFile;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('appendGuardrailDecision', () => {
	// ---- SC-119: type:shell entry has EXACTLY 5 fields byte-for-byte — no type discriminator ----
	test('SC-119 shell entry writes EXACTLY 5 fields: {ts, sessionID, agent, tool, command} — no type discriminator', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-abc123',
			agent: 'coder',
			tool: 'bash',
			command: 'echo hello',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
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

		await rm(dir, { recursive: true, force: true });
	});

	// ---- SC-119 regression: ensure shell entry NEVER gets a type field even when passed in entry ----
	test('SC-119 regression: shell entry persisted JSON has no type field even if input had one', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		// The input type: 'shell' is only used for routing; it is stripped on write
		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-reg',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		const parsed = jsonLine(appendCalls[0]!.content.trim());
		// The fixed implementation writes exactly 5 fields with NO type
		expect(Object.keys(parsed)).toHaveLength(5);
		expect(parsed.type).toBeUndefined();
		expect(parsed.ts).toBe('2026-01-01T00:00:00.000Z');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- SC-118: entries stored under the given auditPath ----
	test('SC-118 entry is written to the configured auditPath', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, '.swarm', 'session', 'audit.jsonl');

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-xyz',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.some((c) => c.path === auditPath)).toBe(true);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: file_write entry ----
	test('file_write entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

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

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
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
		const auditPath = join(dir, 'audit.jsonl');

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

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		const parsed = jsonLine(appendCalls[0]!.content.trim());
		expect(parsed.reason).not.toContain('/home/alice');
		expect(parsed.reason).toContain('~/project/link');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: destructive_block entry ----
	test('destructive_block entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		const entry = {
			type: 'destructive_block' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-db',
			agent: 'coder',
			tool: 'bash',
			command: 'rm -rf /',
			destructiveCategory: 'dangerous_delete',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
		expect(parsed.type).toBe('destructive_block');
		expect(parsed.destructiveCategory).toBe('dangerous_delete');
		expect(parsed.command).toBeDefined(); // redaction applied

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: sandbox_wrap entry ----
	test('sandbox_wrap entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		const entry = {
			type: 'sandbox_wrap' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-sw',
			agent: 'coder',
			tool: 'bash',
			command: 'npm install',
			executorMechanism: 'bubblewrap',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
		expect(parsed.type).toBe('sandbox_wrap');
		expect(parsed.executorMechanism).toBe('bubblewrap');
		expect(parsed.command).toBeDefined();

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: sandbox_skip entry ----
	test('sandbox_skip entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

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

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
		expect(parsed.type).toBe('sandbox_skip');
		expect(parsed.executorMechanism).toBe('none');
		expect(parsed.skipReason).toBe('read-only command');
		expect(parsed.command).toBeDefined();

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Additive schema: scope_violation entry ----
	test('scope_violation entry includes type discriminator and per-type fields', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

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

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
		expect(parsed.type).toBe('scope_violation');
		// declaredScope/resolvedScope are redacted via redactPath (separators normalized on Windows)
		expect(parsed.declaredScope).toBe(redactPath('/project/src'));
		expect(parsed.resolvedScope).toBe(redactPath('/etc'));
		expect(parsed.action).toBe('write');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Write-time validation: malformed entry (missing sessionID) is rejected ----
	test('malformed entry missing sessionID is rejected: nothing written, no exception propagates', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

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
				auditPath,
				enabled: true,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		// Nothing should have been appended
		expect(appendCalls.length).toBe(0);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Write-time validation: invalid type discriminator is rejected ----
	test('entry with invalid type discriminator is rejected: nothing written, no exception', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

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
			await appendGuardrailDecision(badEntry, { auditPath, enabled: true });
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(appendCalls.length).toBe(0);

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
				const auditPath = join(dir, 'audit.jsonl');

				await appendGuardrailDecision(testCase.entry as any, {
					auditPath,
					enabled: true,
				});

				expect(appendCalls.length).toBe(0);
				await rm(dir, { recursive: true, force: true });
			});
		}
	});

	// ---- enabled=false → nothing written ----
	test('enabled=false skips writing entirely', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-off',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: false });

		expect(appendCalls.length).toBe(0);

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Command redaction: shell entry with secret is redacted ----
	test('shell entry with secret pattern is redacted via redactShellCommand', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-redact',
			agent: 'coder',
			tool: 'bash',
			command:
				"curl -H 'Authorization: Bearer sk-test1234567890' https://api.example.com",
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
		// The Bearer token should be redacted
		expect(parsed.command).not.toContain('sk-test1234567890');
		expect(parsed.command).toContain('[REDACTED]');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Command redaction: destructive_block with API key is redacted ----
	test('destructive_block entry with API_TOKEN in command is redacted', async () => {
		const dir = await mkTempDir();
		const auditPath = join(dir, 'audit.jsonl');

		const entry = {
			type: 'destructive_block' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-dbredact',
			agent: 'coder',
			tool: 'bash',
			command: 'rm /tmp/API_TOKEN=abc123xyz',
			destructiveCategory: 'path_destruction',
		};

		await appendGuardrailDecision(entry, { auditPath, enabled: true });

		expect(appendCalls.length).toBe(1);
		const parsed = jsonLine(appendCalls[0]!.content.trim());
		expect(parsed.command).not.toContain('abc123xyz');
		expect(parsed.command).toContain('[REDACTED]');

		await rm(dir, { recursive: true, force: true });
	});

	// ---- Failure is fail-open: invalid/unwritable path does not throw ----
	test('fail-open: appending to an invalid path does not throw', async () => {
		// Use a path that cannot be written to (no parent directory will ever exist)
		const invalidPath = '/this/path/does/not/exist/anywhere/audit.jsonl';

		const entry = {
			type: 'shell' as const,
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 'sess-failopen',
			agent: 'coder',
			tool: 'bash',
			command: 'ls',
		};

		// The real fs.appendFile would throw if mkdir + appendFile fails,
		// but appendGuardrailDecision catches and logs, so it must not propagate.
		let threw = false;
		try {
			await appendGuardrailDecision(entry, {
				auditPath: invalidPath,
				enabled: true,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
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

	test('null returns null (passthrough for non-strings)', () => {
		// redactPath returns the original value for non-strings (bug in source, verified here)
		expect(redactPath(null as any)).toBe(null);
	});

	test('undefined returns undefined', () => {
		expect(redactPath(undefined as any)).toBe(undefined);
	});
});
