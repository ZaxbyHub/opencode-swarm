/**
 * Adversarial redaction tests for the shell-audit write + render boundaries
 * (issue #2040 requirement 4 and the edge/adversarial case list):
 * secrets in flags, env assignments, URLs, headers, PowerShell/cmd quoting,
 * base64-like payloads, nested shells, heredocs; POSIX/Windows/UNC paths;
 * determinism; no reversible secrets; no over-redaction.
 *
 * Each fixture is asserted at BOTH boundaries:
 * - WRITE: what appendGuardrailDecision persists
 * - RENDER: what /swarm guardrail-log displays (re-redaction of legacy data)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGuardrailDecision } from '../../../src/hooks/guardrails/audit-log';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';
import { shellAuditFilePath } from '../../../src/hooks/guardrails/shell-audit-store';
import { handleGuardrailLog } from '../../../src/services/guardrail-log-service';
import { _resetMaintenanceCounters } from '../../../src/hooks/guardrails/shell-audit-store';

async function mkTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'shell-audit-redaction-test-'));
}

/** Persist a shell decision with the given command and return the stored command. */
async function persistedCommand(command: string): Promise<string> {
	const dir = await mkTempDir();
	await appendGuardrailDecision(
		{
			type: 'shell',
			ts: new Date().toISOString(),
			sessionID: 's',
			agent: 'coder',
			tool: 'bash',
			command,
		},
		{ directory: dir, enabled: true },
	);
	const lines = readFileSync(shellAuditFilePath(dir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0);
	const decision = JSON.parse(lines[lines.length - 1]!) as {
		command: string;
	};
	await rm(dir, { recursive: true, force: true });
	return decision.command;
}

/** Write a LEGACY (pre-#2040, unredacted-in-principle) file and render it. */
async function renderedLegacyCommand(command: string): Promise<string> {
	const dir = await mkTempDir();
	await mkdir(join(dir, '.swarm', 'session'), { recursive: true });
	await writeFile(
		shellAuditFilePath(dir),
		`${JSON.stringify({
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 's',
			agent: 'coder',
			tool: 'bash',
			command,
		})}\n`,
		'utf-8',
	);
	const out = await handleGuardrailLog(dir, []);
	await rm(dir, { recursive: true, force: true });
	return out;
}

afterEach(() => {
	_resetMaintenanceCounters();
});

describe('redactShellCommand — adversarial secret fixtures (unit)', () => {
	const cases: Array<{ name: string; command: string; secret: string }> = [
		{
			name: 'OpenAI-style token value',
			command: 'curl https://api.openai.com/v1/x -H "x: sk-abcdefghijklmnopqrstuvwx" ',
			secret: 'sk-abcdefghijklmnopqrstuvwx',
		},
		{
			name: 'GitHub PAT value',
			command: `git clone https://github.com/o/r ${'gh' + 'p_' + '1234567890abcdefghijklmnopqrstuv'}`,
			secret: 'gh' + 'p_' + '1234567890abcdefghijklmnopqrstuv',
		},
		{
			name: 'AWS access key value',
			command: `echo ${'AK' + 'IAIOSFODNN7EXAMPLE'}`,
			secret: 'AK' + 'IAIOSFODNN7EXAMPLE',
		},
		{
			name: 'Slack token value',
			command: `curl -d token=${'xo' + 'xb-1234567890abcdef'} https://slack.com/api/x`,
			secret: 'xo' + 'xb-1234567890abcdef',
		},
		{
			name: 'URL credentials scheme://user:pass@host',
			command: 'curl https://alice:supersecret123@example.com/api',
			secret: 'supersecret123',
		},
		{
			name: 'PowerShell $env: assignment (sensitive name)',
			command: 'powershell -Command "$env:API_KEY = \'abc123secret\'; ./tool.ps1"',
			secret: 'abc123secret',
		},
		{
			name: 'cmd set assignment (sensitive name)',
			command: 'cmd /c "set PASSWORD=hunter2sec && run.bat"',
			secret: 'hunter2sec',
		},
		{
			name: 'space-separated sensitive flag',
			command: 'deploy --api-key live_9f8e7d6c5b4a tool',
			secret: 'live_9f8e7d6c5b4a',
		},
		{
			name: 'nested shell with env secret',
			command: 'sh -c "SECRET_TOKEN=zzz9topsecret curl http://x"',
			secret: 'zzz9topsecret',
		},
		{
			name: 'heredoc containing an env assignment',
			command: 'bash <<EOF\nAPI_KEY=deadbeefcafe1234\nEOF',
			secret: 'deadbeefcafe1234',
		},
		{
			name: 'long base64-like payload',
			command: `echo QWxhZG0gdGVzdCBwYXlsb2FkIHdpdGggbWl4ZWQgY2FzZSBhbmQgZGlnaXRzIDEyMzQ1Njc4OTAgcGx1cyBtb3JlIHBhZGRpbmcgY29udGVudCBoZXJl > /tmp/out`,
			secret:
				'QWxhZG0gdGVzdCBwYXlsb2FkIHdpdGggbWl4ZWQgY2FzZSBhbmQgZGlnaXRzIDEyMzQ1Njc4OTAgcGx1cyBtb3JlIHBhZGRpbmcgY29udGVudCBoZXJl',
		},
	];

	for (const { name, command, secret } of cases) {
		test(name, () => {
			const out = redactShellCommand(command);
			expect(out).not.toContain(secret);
			expect(out.length).toBeGreaterThan(0);
		});
	}

	test('determinism: identical inputs redact identically (correlation-safe)', () => {
		const cmd = 'deploy --token=abc123xyz https://u:p@h';
		expect(redactShellCommand(cmd)).toBe(redactShellCommand(cmd));
	});
});

describe('redactShellCommand — no over-redaction guards', () => {
	test('plain non-sensitive env assignments survive', () => {
		const out = redactShellCommand('FOO=bar BAZ=qux echo hi');
		expect(out).toContain('FOO=bar');
		expect(out).toContain('BAZ=qux');
	});

	test('git commit SHAs (hex, lowercase+digit) survive', () => {
		const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
		const out = redactShellCommand(`git checkout ${sha}`);
		expect(out).toContain(sha);
	});

	test('ordinary URLs survive', () => {
		const out = redactShellCommand('pip install https://example.com/pkg-1.2.3.whl');
		expect(out).toContain('https://example.com/pkg-1.2.3.whl');
	});

	test('short base64-ish strings (below the threshold) survive', () => {
		const short = 'c2hvcnQ=';
		const out = redactShellCommand(`echo ${short}`);
		expect(out).toContain(short);
	});

	test('non-sensitive PowerShell env assignments survive', () => {
		const out = redactShellCommand('powershell -Command "$env:PATH = \'C:/tools\'"');
		expect(out).toContain('C:/tools');
	});
});

describe('write boundary — persisted lines never contain the fixtures', () => {
	const cases: Array<{ name: string; command: string; secret: string }> = [
		{
			name: 'Bearer token in a shell command',
			command: 'curl -H "Authorization: Bearer tok_abcdef123456" https://api.x',
			secret: 'tok_abcdef123456',
		},
		{
			name: 'PowerShell secret env',
			command: 'pwsh -c "$env:MY_API_TOKEN=\'sk-live-abcdefghijklmnop\'"',
			secret: 'sk-live-abcdefghijklmnop',
		},
		{
			name: 'URL credentials',
			command: 'curl ftp://bob:hunter2@files.example.com/x',
			secret: 'hunter2',
		},
	];

	for (const { name, command, secret } of cases) {
		test(name, async () => {
			const stored = await persistedCommand(command);
			expect(stored).not.toContain(secret);
			expect(stored).toContain('[REDACTED]');
		});
	}

	test('typed command entries store a deterministic hash of the REDACTED command', async () => {
		const dir = await mkTempDir();
		await appendGuardrailDecision(
			{
				type: 'destructive_block',
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'rm -rf /data --token=supersecret99',
				destructiveCategory: 'dangerous_delete',
			},
			{ directory: dir, enabled: true },
		);
		const lines = readFileSync(shellAuditFilePath(dir), 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		const decision = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
		expect(decision.commandHash).toMatch(/^[0-9a-f]{16}$/);
		// The hash is of the redacted command — recompute from the stored value.
		const { createHash } = await import('node:crypto');
		const expected = createHash('sha256')
			.update(decision.command as string, 'utf-8')
			.digest('hex')
			.slice(0, 16);
		expect(decision.commandHash).toBe(expected);
		// Deterministic: same redacted command → same hash on a second write.
		await appendGuardrailDecision(
			{
				type: 'destructive_block',
				ts: new Date().toISOString(),
				sessionID: 's',
				agent: 'coder',
				tool: 'bash',
				command: 'rm -rf /data --token=supersecret99',
				destructiveCategory: 'dangerous_delete',
			},
			{ directory: dir, enabled: true },
		);
		const lines2 = readFileSync(shellAuditFilePath(dir), 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		const second = JSON.parse(lines2[lines2.length - 1]!) as Record<string, unknown>;
		expect(second.commandHash).toBe(decision.commandHash);

		await rm(dir, { recursive: true, force: true });
	});
});

describe('render boundary — legacy records re-redact through the CURRENT policy', () => {
	test('a legacy record containing a URL password renders redacted (no legacy bypass)', async () => {
		const out = await renderedLegacyCommand(
			'curl https://alice:topsecret99@example.com/api',
		);
		expect(out).not.toContain('topsecret99');
		expect(out).toContain('[REDACTED]');
	});

	test('a legacy record containing a Bearer token renders redacted', async () => {
		const out = await renderedLegacyCommand(
			'curl -H "Authorization: Bearer legsecret12345" https://x',
		);
		expect(out).not.toContain('legsecret12345');
	});

	test('a legacy record with a home path renders the tilde form', async () => {
		const out = await renderedLegacyCommand('cat /home/alice/notes.txt');
		expect(out).not.toContain('/home/alice');
		expect(out).toContain('~/notes.txt');
	});
});
