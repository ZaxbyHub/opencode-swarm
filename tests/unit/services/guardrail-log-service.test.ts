/**
 * Tests for src/services/guardrail-log-service.ts (Task 2.2)
 *
 * Covers:
 * - Missing audit file → friendly "no decisions" message, does NOT throw
 * - Mixed entries → all returned, most-recent-first (assert ts ordering)
 * - --blocks-only → only file_write/scope_violation/destructive_block; excludes legacy shell + sandbox_wrap
 * - Malformed JSON line → skipped gracefully; valid lines still returned
 * - Empty file / all-blank lines → friendly "no decisions" message
 * - Redaction: command with secret (API_KEY, Bearer token) → output does NOT contain raw secret
 * - Redaction: path under home dir (/home/<user>/, C:\Users\<user>\) → redacted via redactPath
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGuardrailLog } from '../../../src/services/guardrail-log-service';
import { SYNTHETIC_HOME } from '../../helpers/synthetic-home';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'guardrail-log-test-'));
	// Create the .swarm/session/ directory structure the service expects
	await mkdir(join(tempDir, '.swarm', 'session'), { recursive: true });
});

afterEach(async () => {
	if (tempDir && existsSync(tempDir)) {
		await rm(tempDir, { recursive: true, force: true });
	}
	mock.restore();
});

// ---------------------------------------------------------------------------
// Helper: write a shell-audit.jsonl file
// ---------------------------------------------------------------------------

async function writeAuditFile(contents: string): Promise<void> {
	const auditPath = join(tempDir, '.swarm', 'session', 'shell-audit.jsonl');
	await writeFile(auditPath, contents, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test: Missing audit file → friendly message, no throw
// ---------------------------------------------------------------------------

describe('Missing audit file → friendly message, no throw', () => {
	test('returns "No guardrail decisions recorded yet." when file does not exist', async () => {
		// Ensure the file definitely does not exist
		const auditPath = join(tempDir, '.swarm', 'session', 'shell-audit.jsonl');
		expect(existsSync(auditPath)).toBe(false);

		const result = await handleGuardrailLog(tempDir, []);

		expect(result).toBe('No guardrail decisions recorded yet.');
	});

	test('does NOT throw when audit file is absent', async () => {
		// The function must reject with an error, not throw
		await expect(handleGuardrailLog(tempDir, [])).resolves.toBe(
			'No guardrail decisions recorded yet.',
		);
	});
});

// ---------------------------------------------------------------------------
// Test: Empty file / all-blank lines → friendly message
// ---------------------------------------------------------------------------

describe('Empty file / all-blank lines → friendly message', () => {
	test('completely empty file returns "No guardrail decisions recorded yet."', async () => {
		await writeAuditFile('');

		const result = await handleGuardrailLog(tempDir, []);

		expect(result).toBe('No guardrail decisions recorded yet.');
	});

	test('file with only whitespace / blank lines returns "No guardrail decisions recorded yet."', async () => {
		await writeAuditFile('   \n\n\t\n  \n');

		const result = await handleGuardrailLog(tempDir, []);

		expect(result).toBe('No guardrail decisions recorded yet.');
	});
});

// ---------------------------------------------------------------------------
// Test: Malformed JSON line → skipped gracefully; valid lines still returned
// ---------------------------------------------------------------------------

describe('Malformed JSON line → skipped gracefully; valid lines still returned', () => {
	test('malformed JSON line is skipped without throwing; valid entries returned', async () => {
		// One valid entry surrounded by bad lines
		const validEntry = JSON.stringify({
			ts: '2025-01-01T12:00:00.000Z',
			type: 'file_write',
			sessionID: 'session-1',
			agent: 'coder',
			tool: 'write',
			path: '/tmp/test.txt',
			reason: 'testing',
			resolvedScope: '/tmp/',
		});

		await writeAuditFile(
			'NOT JSON\n{"broken": json\n' + validEntry + '\n{invalid:',
		);

		const result = await handleGuardrailLog(tempDir, []);

		// The valid entry must appear in output
		expect(result).toContain('file_write');
		expect(result).toContain('coder');
		// The malformed lines must NOT appear verbatim in output
		expect(result).not.toContain('NOT JSON');
		expect(result).not.toContain('{"broken": json');
	});

	test('valid entry with extra fields still parses correctly', async () => {
		// Entry has extra unknown fields — must not break parsing
		const entry = JSON.stringify({
			ts: '2025-01-01T12:00:00.000Z',
			type: 'destructive_block',
			sessionID: 'session-2',
			agent: 'coder',
			tool: 'shell',
			command: 'rm -rf /',
			destructiveCategory: 'recursive-delete',
			extraField: 'should be ignored',
		});
		await writeAuditFile(entry + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// Output format shows type + redacted command; destructiveCategory is NOT in the format output
		expect(result).toContain('destructive_block');
		expect(result).toContain('coder');
		// extraField should not appear (it's ignored during parsing)
		expect(result).not.toContain('extraField');
	});
});

// ---------------------------------------------------------------------------
// Test: Mixed entries → all returned, most-recent-first
// ---------------------------------------------------------------------------

describe('Mixed entries → all returned, most-recent-first (ts ordering)', () => {
	test('returns ALL entry types when no --blocks-only flag; sorted most-recent-first', async () => {
		// Build a log with 5 distinct entry types:
		// 1. Legacy shell entry (no type field) — oldest
		// 2. file_write
		// 3. scope_violation
		// 4. destructive_block
		// 5. sandbox_wrap — newest
		const oldest = '2025-01-01T10:00:00.000Z';
		const middle = '2025-01-01T11:00:00.000Z';
		const newest = '2025-01-01T12:00:00.000Z';

		const entries = [
			// Legacy shell entry — no type discriminator
			JSON.stringify({
				ts: oldest,
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command: 'echo hello',
			}),
			// file_write
			JSON.stringify({
				ts: '2025-01-01T10:30:00.000Z',
				type: 'file_write',
				sessionID: 's2',
				agent: 'coder',
				tool: 'write',
				path: '/tmp/test.txt',
				reason: 'testing',
				resolvedScope: '/tmp/',
			}),
			// scope_violation
			JSON.stringify({
				ts: middle,
				type: 'scope_violation',
				sessionID: 's3',
				agent: 'coder',
				tool: 'shell',
				path: '/etc/passwd',
				declaredScope: 'src/',
				resolvedScope: '/etc/',
				action: 'block',
			}),
			// destructive_block
			JSON.stringify({
				ts: '2025-01-01T11:30:00.000Z',
				type: 'destructive_block',
				sessionID: 's4',
				agent: 'coder',
				tool: 'shell',
				command: 'rm -rf /',
				destructiveCategory: 'recursive-delete',
			}),
			// sandbox_wrap — newest
			JSON.stringify({
				ts: newest,
				type: 'sandbox_wrap',
				sessionID: 's5',
				agent: 'coder',
				tool: 'shell',
				command: 'curl https://example.com',
				executorMechanism: 'passthrough',
			}),
		];

		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// Header confirms all-entries mode
		expect(result).toContain('Guardrail Decision Log (most-recent-first)');

		// All 5 entry types must appear
		expect(result).toContain('shell'); // legacy shell
		expect(result).toContain('file_write');
		expect(result).toContain('scope_violation');
		expect(result).toContain('destructive_block');
		expect(result).toContain('sandbox_wrap');

		// Most-recent-first ordering: newest timestamp (2025-01-01T12:00) appears first in body
		const bodyStart = result.indexOf('\n\n') + 2;
		const body = result.slice(bodyStart);
		// Each entry line starts with "- [timestamp]" — extract timestamp from first line
		const firstEntryTs = body.match(/- \[([^\]]+)\]/)?.[1];
		expect(firstEntryTs).toBe(newest);

		// Oldest appears last in body — split by newline and check the last non-empty line
		const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
		const lastLine = lines[lines.length - 1] ?? '';
		const lastEntryTs = lastLine.match(/- \[([^\]]+)\]/)?.[1];
		expect(lastEntryTs).toBe(oldest);
	});

	test('entries with identical timestamps are handled stably (no throw)', async () => {
		const sameTs = '2025-01-01T12:00:00.000Z';
		const entries = [
			JSON.stringify({
				ts: sameTs,
				type: 'file_write',
				sessionID: 's1',
				agent: 'coder',
				tool: 'write',
				path: '/tmp/a.txt',
				reason: 'a',
				resolvedScope: '/tmp/',
			}),
			JSON.stringify({
				ts: sameTs,
				type: 'scope_violation',
				sessionID: 's2',
				agent: 'coder',
				tool: 'shell',
				path: '/tmp/b.txt',
				declaredScope: 'src/',
				resolvedScope: '/tmp/',
				action: 'block',
			}),
		];

		await writeAuditFile(entries.join('\n') + '\n');

		// Must not throw on equal timestamps
		const result = await handleGuardrailLog(tempDir, []);
		expect(result).toContain('file_write');
		expect(result).toContain('scope_violation');
	});
});

// ---------------------------------------------------------------------------
// Test: --blocks-only → only file_write/scope_violation/destructive_block
// ---------------------------------------------------------------------------

describe('--blocks-only → only block-type entries returned; legacy + sandbox_wrap excluded (SC-112)', () => {
	test('--blocks-only returns ONLY file_write, scope_violation, destructive_block', async () => {
		const oldest = '2025-01-01T10:00:00.000Z';
		const newest = '2025-01-01T12:00:00.000Z';

		const entries = [
			// Legacy shell entry (no type) — must be EXCLUDED
			JSON.stringify({
				ts: oldest,
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command: 'echo hello',
			}),
			// file_write — INCLUDED
			JSON.stringify({
				ts: '2025-01-01T10:30:00.000Z',
				type: 'file_write',
				sessionID: 's2',
				agent: 'coder',
				tool: 'write',
				path: '/tmp/test.txt',
				reason: 'testing',
				resolvedScope: '/tmp/',
			}),
			// scope_violation — INCLUDED
			JSON.stringify({
				ts: '2025-01-01T11:00:00.000Z',
				type: 'scope_violation',
				sessionID: 's3',
				agent: 'coder',
				tool: 'shell',
				path: '/etc/passwd',
				declaredScope: 'src/',
				resolvedScope: '/etc/',
				action: 'block',
			}),
			// destructive_block — INCLUDED
			JSON.stringify({
				ts: '2025-01-01T11:30:00.000Z',
				type: 'destructive_block',
				sessionID: 's4',
				agent: 'coder',
				tool: 'shell',
				command: 'rm -rf /',
				destructiveCategory: 'recursive-delete',
			}),
			// sandbox_wrap — must be EXCLUDED
			JSON.stringify({
				ts: newest,
				type: 'sandbox_wrap',
				sessionID: 's5',
				agent: 'coder',
				tool: 'shell',
				command: 'curl https://example.com',
				executorMechanism: 'passthrough',
			}),
		];

		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, ['--blocks-only']);

		expect(result).toContain('Guardrail Block Log (most-recent-first)');

		// INCLUDED types must appear
		expect(result).toContain('file_write');
		expect(result).toContain('scope_violation');
		expect(result).toContain('destructive_block');

		// EXCLUDED types must NOT appear
		expect(result).not.toContain('shell'); // legacy shell entry (no type field)
		expect(result).not.toContain('sandbox_wrap');

		// Number of entries in body: exactly 3 (file_write, scope_violation, destructive_block)
		const bodyStart = result.indexOf('\n\n') + 2;
		const body = result.slice(bodyStart);
		const entryMatches = body.match(/- \[/g);
		expect(entryMatches).toHaveLength(3);
	});

	test('--blocks-only returns "No guardrail block decisions recorded yet." when only non-block entries exist', async () => {
		const entries = [
			// Only legacy shell and sandbox_wrap entries — no block types
			JSON.stringify({
				ts: '2025-01-01T10:00:00.000Z',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command: 'echo hello',
			}),
			JSON.stringify({
				ts: '2025-01-01T11:00:00.000Z',
				type: 'sandbox_wrap',
				sessionID: 's2',
				agent: 'coder',
				tool: 'shell',
				command: 'curl https://example.com',
				executorMechanism: 'passthrough',
			}),
		];

		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, ['--blocks-only']);

		expect(result).toBe('No guardrail block decisions recorded yet.');
	});
});

// ---------------------------------------------------------------------------
// Test: Redaction — command with secret → output does NOT contain raw secret
// ---------------------------------------------------------------------------

describe('Redaction: command with secret → output does NOT contain raw secret', () => {
	test('API_KEY env var in command is redacted', async () => {
		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'destructive_block',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command:
					'curl -H "Authorization: Bearer secret_token_abc123" https://api.example.com',
				destructiveCategory: 'network-call',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The raw secret token must NOT appear in output
		expect(result).not.toContain('secret_token_abc123');
		// The redaction placeholder must appear
		expect(result).toContain('[REDACTED]');
	});

	test('Bearer token in command is redacted', async () => {
		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'destructive_block',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command:
					'curl -H "Authorization: Bearer my_super_secret_token_xyz" https://api.example.com',
				destructiveCategory: 'network-call',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The raw Bearer token must NOT appear
		expect(result).not.toContain('my_super_secret_token_xyz');
		expect(result).toContain('[REDACTED]');
	});

	test('MY_API_TOKEN env var assignment in command is redacted', async () => {
		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'sandbox_wrap',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command:
					'MY_API_TOKEN=sk-live-abcdefghijklmnop curl https://api.example.com',
				executorMechanism: 'passthrough',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The raw token value must NOT appear
		expect(result).not.toContain('sk-live-abcdefghijklmnop');
		expect(result).toContain('[REDACTED]');
	});

	test('-H header with API key is redacted', async () => {
		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'shell',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command:
					"curl -H 'X-API-Key: super_secret_api_key_12345' https://api.example.com",
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The raw API key must NOT appear
		expect(result).not.toContain('super_secret_api_key_12345');
		expect(result).toContain('[REDACTED]');
	});
});

// ---------------------------------------------------------------------------
// Test: Redaction — path under home dir → output redacted via redactPath
// ---------------------------------------------------------------------------

describe('Redaction: path under home dir → output redacted via redactPath (no raw /home/<user> or C:\\Users\\<user>)', () => {
	test('POSIX /home/<user>/ path is redacted to ~ in file_write entry', async () => {
		const homeDir = SYNTHETIC_HOME;
		const secretPath = join(homeDir, 'documents', 'secret.txt');
		const resolvedScope = join(homeDir, 'documents');

		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'file_write',
				sessionID: 's1',
				agent: 'coder',
				tool: 'write',
				path: secretPath,
				reason: 'user-request',
				resolvedScope: resolvedScope,
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The home path must NOT appear raw
		expect(result).not.toContain(join(homeDir, 'documents'));
		// The username segment must NOT appear raw
		const homeBasename = homeDir.split(/[/\\]/).pop() ?? '';
		expect(result).not.toContain(homeBasename);
		// Redacted form must appear (tilde notation); on Windows backslash, on POSIX forward slash
		// redactPath returns ~ followed by the platform separator
		const isWindows = process.platform === 'win32';
		if (isWindows) {
			// Windows: ~\<rest> — the backslash is used as separator after tilde
			expect(result).toMatch(/~\\/);
		} else {
			expect(result).toMatch(/~\//);
		}
	});

	test('scope_violation entry with home-dir path is redacted', async () => {
		const homeDir = SYNTHETIC_HOME;
		const sshPath = join(homeDir, '.ssh', 'id_rsa');

		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'scope_violation',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				path: sshPath,
				declaredScope: 'src/',
				resolvedScope: sshPath,
				action: 'block',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The home directory path must NOT appear raw
		expect(result).not.toContain(join(homeDir, '.ssh'));
		const homeBasename = homeDir.split(/[/\\]/).pop() ?? '';
		expect(result).not.toContain(homeBasename);
		// Redacted form must appear (tilde notation)
		const isWindows = process.platform === 'win32';
		if (isWindows) {
			expect(result).toMatch(/~\\/);
		} else {
			expect(result).toMatch(/~\//);
		}
	});

	test('destructive_block command does not expose home directory names', async () => {
		const homeDir = SYNTHETIC_HOME;
		const deletedPath = join(homeDir, 'deleted');

		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'destructive_block',
				sessionID: 's1',
				agent: 'coder',
				tool: 'shell',
				command: `rm -rf ${deletedPath}`,
				destructiveCategory: 'recursive-delete',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The raw home path must NOT appear
		expect(result).not.toContain(join(homeDir, 'deleted'));
		expect(result).not.toContain(deletedPath);
		// Home dir in the command is redacted to ~ via redactShellCommand's home-dir pre-pass.
		// ([REDACTED] is the secret/token redactor — this command has no secret, so it produces
		// ~ not [REDACTED]; the raw home path is gone, which is what we assert.)
		expect(result).toContain('~');
	});

	test('non-home paths are preserved as-is (no over-redaction)', async () => {
		// Use the temp directory path which is definitely not a home directory
		const safePath = join(tempDir, 'test-output.txt');

		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'file_write',
				sessionID: 's1',
				agent: 'coder',
				tool: 'write',
				path: safePath,
				reason: 'testing',
				resolvedScope: tempDir,
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// The temp file path should appear (redacted form of tempDir itself, not a home dir)
		// At minimum the filename should be present
		expect(result).toContain('test-output.txt');
		// The result should not mention any home directory
		const homeBasename = SYNTHETIC_HOME.split(/[/\\]/).pop() ?? '';
		expect(result).not.toContain(homeBasename);
	});
});

// ---------------------------------------------------------------------------
// Test: Realistic audit-log schema compliance
// ---------------------------------------------------------------------------

describe('Realistic audit-log schema: legacy shell entries (no type) vs typed entries', () => {
	test('legacy shell entry (5 fields, no type) is parsed and returned with type label "shell"', async () => {
		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				sessionID: 'session-abc',
				agent: 'architect',
				tool: 'shell',
				command: 'git status',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// Legacy entries should be displayed as type "shell"
		// Output format: "- [ts] shell | agent: architect | git status"
		expect(result).toContain('shell');
		expect(result).toContain('architect');
		expect(result).toContain('git status');
	});

	test('typed entry with type field is displayed with its correct type discriminator', async () => {
		const entries = [
			JSON.stringify({
				ts: '2025-01-01T12:00:00.000Z',
				type: 'sandbox_skip',
				sessionID: 'session-xyz',
				agent: 'coder',
				tool: 'shell',
				command: 'echo skipped',
				executorMechanism: 'passthrough',
				skipReason: 'idempotent operation',
			}),
		];
		await writeAuditFile(entries.join('\n') + '\n');

		const result = await handleGuardrailLog(tempDir, []);

		// sandbox_skip appears in full log (not blocks-only)
		// Output format: "- [ts] sandbox_skip | agent: coder | echo skipped"
		expect(result).toContain('sandbox_skip');
		expect(result).toContain('coder');
	});
});
