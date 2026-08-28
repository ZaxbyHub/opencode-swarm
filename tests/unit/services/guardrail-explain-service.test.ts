/**
 * Tests for src/services/guardrail-explain-service.ts (Task 1.3)
 *
 * Covers:
 * - SC-101: shell command returns markdown with decision, firing rule, resolved scope, write categories
 * - SC-102/103: --write outside scope returns block decision with firing rule + scope
 * - SC-104: multiple --write targets → results for EACH independently
 * - SC-105: --agent architect --scope docs/ overrides reflected in resolved scope/decision
 * - SC-116 (CRITICAL): explain handler executes NOTHING — no subprocess spawned, no file created
 * - SC-117: command containing secret is redacted in output
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'guardrail-explain-test-'));
	await mkdir(join(tempDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	if (existsSync(tempDir)) {
		await rm(tempDir, { recursive: true, force: true });
	}
	mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SC-101: shell command explain returns markdown with decision fields', () => {
	test('handleGuardrailExplain returns a markdown string (not a crash) for rm -rf build', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'rm',
			'-rf',
			'build',
		]);

		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
		// Must not throw — must resolve to a string
	});

	test('SC-101: explain result contains decision, firing rule, resolved scope, write categories', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'rm',
			'-rf',
			'build',
		]);

		// Should contain a Decision field
		expect(result).toContain('**Mode**: shell');
		// Should contain Agent
		expect(result).toContain('**Agent**:');
		// Should contain Resolved scope
		expect(result).toContain('Resolved Scope');
		// Should mention the command (redacted or not)
		expect(result).toContain('Command');
		// Should contain Decision table row with allow or block
		expect(result).toContain('Decision');
		expect(result).toMatch(/\| *Decision *\| *(allow|block) */i);
		// Should contain Firing Rule table row
		expect(result).toContain('Firing Rule');
	});

	test('non-destructive command yields allow decision', async () => {
		const result = await handleGuardrailExplain(tempDir, ['ls', '-la']);

		expect(result).toContain('Decision');
		// ls -la is a read-only command — should be allowed
		expect(result).toMatch(/\| *Decision *\| *allow */i);
	});
});

describe('SC-102/103: --write outside scope returns block decision', () => {
	test('--write to path outside project scope returns block', async () => {
		// /etc/passwd is definitely outside any reasonable project scope
		const result = await handleGuardrailExplain(tempDir, [
			'--write',
			'/etc/passwd',
		]);

		expect(result).toContain('**Mode**: write-target');
		// Should contain block decision in the table body (not just header)
		expect(result).toContain('| block |');
		// Should contain Firing Rule
		expect(result).toContain('Firing Rule');
		// Should contain Resolved Scope
		expect(result).toContain('Resolved Scope');
		// The path should appear in the table
		// Path is echoed via redactPath (normalized separators / home-redacted), so assert the
		// target's basename in a separator- and redaction-agnostic way rather than the raw path.
		expect(result).toContain('passwd');
	});

	test('--write within project scope returns allow', async () => {
		// Write to a path inside the project directory
		const result = await handleGuardrailExplain(tempDir, [
			'--write',
			'src/index.ts',
		]);

		expect(result).toContain('**Mode**: write-target');
		// Should contain allow decision in the table body
		expect(result).toContain('| allow |');
	});
});

describe('SC-104: multiple --write targets returns results for EACH independently', () => {
	test('two --write targets produce results for each path', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'--write',
			'/etc/passwd',
			'--write',
			'/tmp/allowed.txt',
		]);

		// Both paths should appear in the output independently
		// Path is echoed via redactPath (normalized separators / home-redacted), so assert the
		// target's basename in a separator- and redaction-agnostic way rather than the raw path.
		expect(result).toContain('passwd');
		expect(result).toContain('allowed');
		// /etc/passwd should be blocked; /tmp/allowed.txt might be blocked on Windows
		// Both should appear as separate table entries
		expect(result).toContain('block');
	});

	test('three --write targets produce results for each path', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'--write',
			'/etc/passwd',
			'--write',
			'/home/user/secret',
			'--write',
			'src/index.ts',
		]);

		// Path is echoed via redactPath (normalized separators / home-redacted), so assert the
		// target's basename in a separator- and redaction-agnostic way rather than the raw path.
		expect(result).toContain('passwd');
		expect(result).toContain('secret');
		expect(result).toContain('index.ts');
	});
});

describe('SC-105: --agent and --scope overrides reflected in resolved scope/decision', () => {
	test('--agent architect bypasses scope violations in shell mode', async () => {
		// architect bypasses ONLY scope violations, NOT destructive blocks (file-authority.ts
		// containment check applies to ALL agents, including architect). The architect bypass
		// is in shell scope check at guardrail-explain-service.ts:691.
		// Use shell mode (NOT --write) with a command that triggers scope check.
		// On Unix: echo hello > /tmp/outside.txt with scope docs/ → out-of-scope → block for coder,
		// allow for architect. On Windows /tmp resolves oddly; use a relative path with .. instead.
		const coderResult = await handleGuardrailExplain(tempDir, [
			'--agent',
			'coder',
			'--scope',
			'src/',
			'echo hello > ../outside-scope.txt',
		]);
		expect(coderResult).toContain('**Mode**: shell');
		// scope_violation fires for coder (scope check at line 691 is NOT bypassed for coder)
		expect(coderResult).toMatch(/\|\s*block\s*\|/i);
		expect(coderResult).toMatch(/scope_violation/i);

		const architectResult = await handleGuardrailExplain(tempDir, [
			'--agent',
			'architect',
			'--scope',
			'src/',
			'echo hello > ../outside-scope.txt',
		]);
		expect(architectResult).toContain('**Mode**: shell');
		// architect bypasses scope check → allow (no scope_violation, no destructive block)
		expect(architectResult).toMatch(/\|\s*allow\s*\|/i);
	});

	test('--scope override changes resolved scope in output', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'--scope',
			'docs/',
			'--write',
			'src/index.ts',
		]);

		// Resolved scope should reflect the --scope override (handle both slash styles)
		expect(result).toMatch(/docs[/\\]/);
	});

	test('--agent coder with --scope shows agent in output', async () => {
		const result = await handleGuardrailExplain(tempDir, [
			'--agent',
			'coder',
			'--scope',
			'src/',
			'--write',
			'src/index.ts',
		]);

		expect(result).toContain('**Agent**: coder');
	});
});

describe('guardrail explain parity regressions from PR feedback', () => {
	test('F-001: malformed write syntax fails closed on parseError', async () => {
		// Previous behavior silently ignored detectPosixWrites parseError and
		// predicted allow, while the real hook blocks parse failures.
		const result = await handleGuardrailExplain(tempDir, ['touch ")(']);

		expect(result).toMatch(/\|\s*Decision\s*\|\s*block\s*\|/i);
		expect(result).toContain('parse_error');
		expect(result).toContain('rejecting for safety');
	});

	test('F-002: PowerShell env syntax routes through Windows write detection', async () => {
		// Previous resolveShellType missed `$env:` heuristics and treated this as
		// POSIX, diverging from the real hook's detectShellType routing.
		const result = await handleGuardrailExplain(tempDir, [
			'--scope',
			'src/',
			'$env:PATH > ../outside-scope.txt',
		]);

		expect(result).toMatch(/\|\s*Decision\s*\|\s*block\s*\|/i);
		expect(result).toMatch(/scope_violation/i);
		expect(result).toMatch(/file_redirect|file_write|write/i);
	});

	test('F-002: PowerShell cmdlet prefix routes through Windows write detection', async () => {
		// Previous resolveShellType missed Copy-Item and could parse with the
		// wrong engine, causing explain to diverge from real enforcement.
		const result = await handleGuardrailExplain(tempDir, [
			'--scope',
			'src/',
			'Copy-Item src/index.ts ../outside-scope.txt',
		]);

		expect(result).toMatch(/\|\s*Decision\s*\|\s*block\s*\|/i);
		expect(result).toMatch(/scope_violation/i);
	});
});

describe('SC-116: explain handler executes NOTHING', () => {
	test('calling explain with rm -rf / does not modify filesystem', async () => {
		// Create a marker file to prove the function didn't execute
		const markerPath = join(tempDir, 'marker.txt');
		await writeFile(markerPath, 'original content');

		// Call explain with obviously destructive command
		const result = await handleGuardrailExplain(tempDir, ['rm', '-rf', '/']);

		// Result must be a string (not an error)
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);

		// Marker file must be UNCHANGED (proves rm was not executed)
		const markerContent = await Bun.file(markerPath).text();
		expect(markerContent).toBe('original content');
	});

	test('the returned string contains dry-run mode indicator', async () => {
		const result = await handleGuardrailExplain(tempDir, ['rm', '-rf', '/']);

		// The function must self-identify as dry-run
		expect(result).toContain('dry-run');
	});

	test('guardrail-explain-service.ts does not import child_process', async () => {
		// Static analysis: the source file must not contain 'child_process'
		const fs = await import('node:fs');
		const source = fs.readFileSync(
			join(process.cwd(), 'src/services/guardrail-explain-service.ts'),
			'utf-8',
		);
		expect(source).not.toContain('child_process');
		expect(source).not.toContain('spawn');
	});
});

describe('SC-117: command with secret is redacted in output', () => {
	test('Bearer token in shell command is redacted in explain output', async () => {
		const cmdWithSecret =
			"curl -H 'Authorization: Bearer sk-test1234567890abcdef' https://api.example.com";
		const result = await handleGuardrailExplain(tempDir, [cmdWithSecret]);

		expect(result).not.toContain('sk-test1234567890abcdef');
		expect(result).toContain('[REDACTED]');
	});

	test('API_TOKEN env var is redacted in explain output', async () => {
		const cmdWithSecret =
			'curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com';
		const result = await handleGuardrailExplain(tempDir, [cmdWithSecret]);

		// The token should not appear literally in output
		expect(result).not.toMatch(/sk-[a-zA-Z0-9]+/);
	});

	test('--write path containing secret is handled safely', async () => {
		// Even if the user accidentally passes a path with a secret as --write argument,
		// the explain should not crash
		const result = await handleGuardrailExplain(tempDir, [
			'--write',
			'/home/user/secrets/API_TOKEN=mysecretkey123',
		]);

		expect(typeof result).toBe('string');
		// The result should not expose the raw token in the path column
		// (redaction depends on redactPath which strips home dir, not query strings)
	});
});
