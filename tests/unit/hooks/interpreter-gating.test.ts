import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	createGuardrailsHooks,
	redactShellCommand,
} from '../../../src/hooks/guardrails';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

const SESSION = 'interp-test-session';

function makeConfig(overrides?: Partial<GuardrailsConfig>): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		no_op_warning_threshold: 15,
		max_coder_revisions: 5,
		runaway_output_max_turns: 5,
		shell_audit_log: false, // disable by default to keep tests fast
		...overrides,
	};
}

function makeHooks(dir: string, overrides?: Partial<GuardrailsConfig>) {
	return createGuardrailsHooks(dir, undefined, makeConfig(overrides));
}

async function waitForExistingFile(filePath: string): Promise<string> {
	for (let i = 0; i < 20; i++) {
		if (fs.existsSync(filePath)) return filePath;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return filePath;
}

async function waitForJsonlLines(
	filePath: string,
	minLines: number,
): Promise<string[]> {
	for (let i = 0; i < 20; i++) {
		if (fs.existsSync(filePath)) {
			const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
			if (lines.length >= minLines) return lines;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!fs.existsSync(filePath)) return [];
	return fs.readFileSync(filePath, 'utf-8').trim().split('\n');
}

function shellAuditEntries(filePath: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, 'utf-8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter(
			(entry) =>
				(entry.type === undefined || entry.type === 'shell') &&
				typeof entry.tool === 'string' &&
				typeof entry.command === 'string',
		);
}

// ─── redactShellCommand ───────────────────────────────────────────────────────

describe('redactShellCommand', () => {
	it('redacts TOKEN env-var assignment', () => {
		const result = redactShellCommand('export TOKEN=abc123secret');
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('abc123secret');
	});

	it('redacts SECRET env-var assignment', () => {
		const result = redactShellCommand('MY_SECRET=xyz789 ./run.sh');
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('xyz789');
	});

	it('redacts PASSWORD env-var assignment', () => {
		const result = redactShellCommand('PASSWORD=mysecretpass docker run');
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('mysecretpass');
	});

	it('redacts API_KEY env-var assignment', () => {
		const result = redactShellCommand('API_KEY=key-a1b2c3d4e5 node server.js');
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('key-a1b2c3d4e5');
	});

	it('redacts --token=value CLI flag', () => {
		const result = redactShellCommand(
			'curl --token=mytoken123 https://example.com',
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('mytoken123');
	});

	it('redacts --password value CLI flag (space separator)', () => {
		const result = redactShellCommand(
			'mysql --password secretpassword -u root',
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('secretpassword');
	});

	it('redacts Bearer token', () => {
		const result = redactShellCommand(
			'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://api.example.com',
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
	});

	it('redacts curl -H Authorization header', () => {
		const result = redactShellCommand(
			"-H 'Authorization: Bearer mysupersecrettoken' https://api.example.com",
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('mysupersecrettoken');
	});

	it('does not redact innocuous commands', () => {
		const cmd = 'echo $HOME && ls -la /tmp';
		expect(redactShellCommand(cmd)).toBe(cmd);
	});

	it('does not redact SHORT_VAR= assignments (no secret keyword)', () => {
		const cmd = 'DEBUG=true NODE_ENV=production node app.js';
		expect(redactShellCommand(cmd)).toBe(cmd);
	});

	it('redacts multiple secrets in one command', () => {
		const cmd = 'TOKEN=abc123 PASSWORD=pw456 node deploy.js';
		const result = redactShellCommand(cmd);
		expect(result).not.toContain('abc123');
		expect(result).not.toContain('pw456');
		expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it('redacts short Bearer token in -H Authorization header (no fragment leak)', () => {
		// Short token "abc" — only 3 chars, does not hit Bearer {4,} regex.
		// Header regex must still redact it fully without leaving "earer abc" fragments.
		const result = redactShellCommand(
			'curl -H "Authorization: Bearer abc" https://example.com',
		);
		expect(result).not.toContain('abc');
		expect(result).not.toContain('earer');
		expect(result).toContain('[REDACTED]');
	});

	it('returns empty string gracefully for non-string input (null/undefined)', () => {
		// Defensive guard: exported function may be called with wrong types at runtime.
		expect(redactShellCommand(null as unknown as string)).toBe('');
		expect(redactShellCommand(undefined as unknown as string)).toBe('');
	});

	it('redacts OPENCODE_KEY env-var assignment', () => {
		const result = redactShellCommand(
			'OPENCODE_KEY=sk-oc-abc123 node server.js',
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('sk-oc-abc123');
	});

	it('redacts custom x-*-key curl header', () => {
		const result = redactShellCommand(
			'curl -H "x-opencode-key: sk-oc-abc123" https://api.opencode.ai',
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('sk-oc-abc123');
	});

	it('redacts non-X-prefix header ending in -key', () => {
		const result = redactShellCommand(
			'curl -H "Opencode-Key: sk-oc-abc123" https://api.opencode.ai',
		);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain('sk-oc-abc123');
	});
});

// ─── Interpreter gating ───────────────────────────────────────────────────────

describe('interpreter gating', () => {
	let tmpDir: string;

	beforeEach(() => {
		resetSwarmState();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-gate-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('allows bash when interpreter_allowed_agents is not set (default)', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { interpreter_allowed_agents: undefined });
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c1' },
				{ args: { command: 'echo hello' } },
			),
		).resolves.toBeUndefined();
	});

	it('allows bash for agent listed in interpreter_allowed_agents', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect', 'coder'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c2' },
				{ args: { command: 'echo hello' } },
			),
		).resolves.toBeUndefined();
	});

	it('blocks bash for agent NOT in interpreter_allowed_agents', async () => {
		startAgentSession(SESSION, 'reviewer');
		swarmState.activeAgent.set(SESSION, 'reviewer');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect', 'coder'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c3' },
				{ args: { command: 'echo hello' } },
			),
		).rejects.toThrow('BLOCKED');
	});

	it('gating error message names the blocked agent and the allowed list', async () => {
		startAgentSession(SESSION, 'reviewer');
		swarmState.activeAgent.set(SESSION, 'reviewer');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c4' },
				{ args: { command: 'echo hi' } },
			),
		).rejects.toThrow(/"architect"/);
	});

	it('gating is case-insensitive for agent role comparison', async () => {
		startAgentSession(SESSION, 'Coder');
		swarmState.activeAgent.set(SESSION, 'Coder');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['coder'], // lowercase config, mixed-case agent
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c5' },
				{ args: { command: 'echo hello' } },
			),
		).resolves.toBeUndefined();
	});

	it('does not block non-bash tools (e.g. read) regardless of gating config', async () => {
		startAgentSession(SESSION, 'reviewer');
		swarmState.activeAgent.set(SESSION, 'reviewer');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'read', callID: 'c6' },
				{ args: { filePath: '/tmp/test.ts' } },
			),
		).resolves.toBeUndefined();
	});

	it('blocks "shell" tool (not just "bash") when gating is configured', async () => {
		startAgentSession(SESSION, 'explorer');
		swarmState.activeAgent.set(SESSION, 'explorer');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'shell', callID: 'c7' },
				{ args: { command: 'ls /tmp' } },
			),
		).rejects.toThrow('BLOCKED');
	});

	it('empty array [] blocks ALL agents including architect', async () => {
		startAgentSession(SESSION, 'architect');
		swarmState.activeAgent.set(SESSION, 'architect');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: [], // foot-gun: empty list = no one allowed
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c8' },
				{ args: { command: 'echo hi' } },
			),
		).rejects.toThrow('BLOCKED');
	});

	it('unknown agent role (no activeAgent set) is treated as blocked when gating is configured', async () => {
		// Do NOT set activeAgent — it will default to 'unknown'
		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect', 'coder'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'c9' },
				{ args: { command: 'echo hi' } },
			),
		).rejects.toThrow('BLOCKED');
	});
});

// ─── Shell audit log ──────────────────────────────────────────────────────────

describe('shell audit log', () => {
	let tmpDir: string;

	beforeEach(() => {
		resetSwarmState();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-audit-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function auditLogPath(dir: string): string {
		return path.join(dir, '.swarm', 'session', 'shell-audit.jsonl');
	}

	async function waitForAuditLog(dir: string): Promise<string> {
		return waitForExistingFile(auditLogPath(dir));
	}

	it('writes an audit entry for a bash command when shell_audit_log is true', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'bash', callID: 'a1' },
			{ args: { command: 'echo hello' } },
		);

		const logFile = await waitForExistingFile(
			path.join(tmpDir, '.swarm', 'session', 'shell-audit.jsonl'),
		);
		expect(fs.existsSync(logFile)).toBe(true);
		const entry = shellAuditEntries(logFile)[0];
		expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(entry.sessionID).toBe(SESSION);
		expect(entry.agent).toBe('coder');
		expect(entry.tool).toBe('bash');
		expect(entry.command).toBe('echo hello');
	});

	it('does NOT write an audit entry when shell_audit_log is false', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: false });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'bash', callID: 'a2' },
			{ args: { command: 'echo hello' } },
		);

		expect(fs.existsSync(auditLogPath(tmpDir))).toBe(false);
	});

	it('does NOT write an audit entry for non-bash tools', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'read', callID: 'a3' },
			{ args: { filePath: '/tmp/test.ts' } },
		);

		expect(fs.existsSync(auditLogPath(tmpDir))).toBe(false);
	});

	it('redacts sensitive values in the audit log entry', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'bash', callID: 'a4' },
			{
				args: {
					command:
						'curl -H "Authorization: Bearer supersecrettoken123" https://api.example.com',
				},
			},
		);

		const entry = shellAuditEntries(await waitForAuditLog(tmpDir))[0];
		expect(entry.command).not.toContain('supersecrettoken123');
		expect(entry.command).toContain('[REDACTED]');
	});

	it('appends multiple entries for multiple bash calls', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'bash', callID: 'a5a' },
			{ args: { command: 'echo first' } },
		);
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'bash', callID: 'a5b' },
			{ args: { command: 'echo second' } },
		);

		await waitForJsonlLines(auditLogPath(tmpDir), 2);
		const entries = shellAuditEntries(auditLogPath(tmpDir)).filter((entry) =>
			['echo first', 'echo second'].includes(String(entry.command)),
		);
		expect(entries).toHaveLength(2);
		const commands = entries.map((entry) => entry.command).sort();
		expect(commands).toEqual(['echo first', 'echo second']);
	});

	it('creates .swarm/session/ directory if it does not exist', async () => {
		startAgentSession(SESSION, 'architect');
		swarmState.activeAgent.set(SESSION, 'architect');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'bash', callID: 'a6' },
			{ args: { command: 'ls /tmp' } },
		);

		expect(fs.existsSync(path.join(tmpDir, '.swarm', 'session'))).toBe(true);
	});

	it('audit log records "shell" tool calls too', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'shell', callID: 'a7' },
			{ args: { command: 'pwd' } },
		);

		const entry = shellAuditEntries(await waitForAuditLog(tmpDir))[0];
		expect(entry.tool).toBe('shell');
		expect(entry.command).toBe('pwd');
	});

	it('blocked attempts are also logged (audit runs before enforcement)', async () => {
		startAgentSession(SESSION, 'reviewer');
		swarmState.activeAgent.set(SESSION, 'reviewer');

		const hooks = makeHooks(tmpDir, {
			shell_audit_log: true,
			interpreter_allowed_agents: ['architect'],
		});

		// The call should be blocked, but the audit entry must still be written
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'bash', callID: 'a8' },
				{ args: { command: 'cat /etc/passwd' } },
			),
		).rejects.toThrow('BLOCKED');

		// Audit log exists with the blocked command
		const logFile = await waitForExistingFile(
			path.join(tmpDir, '.swarm', 'session', 'shell-audit.jsonl'),
		);
		expect(fs.existsSync(logFile)).toBe(true);
		const entry = shellAuditEntries(logFile)[0];
		expect(entry.agent).toBe('reviewer');
		expect(entry.command).toBe('cat /etc/passwd');
	});
});

// ─── Adversarial fixes ────────────────────────────────────────────────────────

describe('adversarial fixes', () => {
	let tmpDir: string;

	beforeEach(() => {
		resetSwarmState();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-adv-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('case-variant tool name "Bash" is still gated', async () => {
		startAgentSession(SESSION, 'reviewer');
		swarmState.activeAgent.set(SESSION, 'reviewer');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect'],
		});
		// 'Bash' (capital B) must be caught by the normalised check
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'Bash', callID: 'adv1' },
				{ args: { command: 'echo bypass' } },
			),
		).rejects.toThrow('BLOCKED');
	});

	it('case-variant tool name "SHELL" is still gated', async () => {
		startAgentSession(SESSION, 'explorer');
		swarmState.activeAgent.set(SESSION, 'explorer');

		const hooks = makeHooks(tmpDir, {
			interpreter_allowed_agents: ['architect'],
		});
		await expect(
			hooks.toolBefore(
				{ sessionID: SESSION, tool: 'SHELL', callID: 'adv2' },
				{ args: { command: 'id' } },
			),
		).rejects.toThrow('BLOCKED');
	});

	it('case-variant "Bash" tool call is also logged in audit log with correct fields', async () => {
		startAgentSession(SESSION, 'coder');
		swarmState.activeAgent.set(SESSION, 'coder');

		const hooks = makeHooks(tmpDir, { shell_audit_log: true });
		await hooks.toolBefore(
			{ sessionID: SESSION, tool: 'Bash', callID: 'adv3' },
			{ args: { command: 'ls /tmp' } },
		);

		const logFile = await waitForExistingFile(
			path.join(tmpDir, '.swarm', 'session', 'shell-audit.jsonl'),
		);
		expect(fs.existsSync(logFile)).toBe(true);

		const entries = shellAuditEntries(logFile);
		const entry = entries[entries.length - 1];
		expect(entry.tool).toBe('Bash');
		expect(entry.command).toBe('ls /tmp');
		expect(entry.sessionID).toBe(SESSION);
	});
});
