import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let TEST_DIR = '';

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
		block_destructive_commands: true,
		...overrides,
	};
}

function makeBashInput(sessionID = 'test-session', _command?: string) {
	return { tool: 'bash', sessionID, callID: 'call-1' };
}

function makeBashOutput(command: string) {
	return { args: { command } };
}

describe('Windows cmd.exe destructive command guard (adversarial)', () => {
	beforeEach(() => {
		TEST_DIR = canonicalMkdtemp('destructive-windows-');
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	// rmdir /s — canonical and adversarial variants
	describe('rmdir /s /q — canonical and adversarial variants', () => {
		test('rmdir /s /q C:\\target → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rmdir /s /q C:\\target');
			const output = makeBashOutput('rmdir /s /q C:\\target');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rd /S /Q some-path → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rd /S /Q some-path');
			const output = makeBashOutput('rd /S /Q some-path');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Uppercase command — cmd.exe is case-insensitive
		test('RMDIR /S /Q important_files → BLOCKED (all-caps command)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'RMDIR /S /Q important_files',
			);
			const output = makeBashOutput('RMDIR /S /Q important_files');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Uppercase RD alias
		test('RD /s path → BLOCKED (uppercase RD alias)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'RD /s path');
			const output = makeBashOutput('RD /s path');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Path with spaces (quoted)
		test('rmdir /s /q "C:\\My Documents\\target" → BLOCKED (quoted path with spaces)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'rmdir /s /q "C:\\My Documents\\target"';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Extra whitespace between flags
		test('rmdir  /s  /q  C:\\target → BLOCKED (extra whitespace)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'rmdir  /s  /q  C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix variant
		test('rmdir.exe /s /q C:\\target → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'rmdir.exe /s /q C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Safe target: node_modules → ALLOWED
		test('rmdir /s node_modules → ALLOWED (safe target)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rmdir /s node_modules');
			const output = makeBashOutput('rmdir /s node_modules');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		// Safe target: dist → ALLOWED
		test('rmdir /s /q dist → ALLOWED (safe target)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rmdir /s /q dist');
			const output = makeBashOutput('rmdir /s /q dist');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// del /s /q /f — canonical and adversarial variants
	describe('del /s /q /f — canonical and adversarial variants', () => {
		test('del /s /q /f important_files → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'del /s /q /f important_files',
			);
			const output = makeBashOutput('del /s /q /f important_files');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Uppercase flags
		test('del /S /Q /F C:\\target → BLOCKED (uppercase flags)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'del /S /Q /F C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('del.exe /s /q /f important_files → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'del.exe /s /q /f important_files';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	// ----------------------------------------------------------------
	// Ransomware-grade / disk-level Windows commands
	// ----------------------------------------------------------------
	describe('vssadmin delete — volume shadow copy wipe', () => {
		test('vssadmin delete shadows /all → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'vssadmin delete shadows /all';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*vssadmin delete/i,
			);
		});

		// Uppercase command
		test('VSSADMIN DELETE shadows /all → BLOCKED (uppercase)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'VSSADMIN DELETE shadows /all';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('vssadmin.exe delete shadows /all → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'vssadmin.exe delete shadows /all';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('wbadmin delete catalog — backup wipe', () => {
		test('wbadmin delete catalog → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'wbadmin delete catalog';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*wbadmin delete/i,
			);
		});

		// .exe suffix
		test('wbadmin.exe delete catalog → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'wbadmin.exe delete catalog';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('diskpart — interactive disk partitioner', () => {
		test('diskpart → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'diskpart');
			const output = makeBashOutput('diskpart');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*diskpart/i,
			);
		});

		// Uppercase
		test('DISKPART → BLOCKED (uppercase)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'DISKPART');
			const output = makeBashOutput('DISKPART');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('diskpart.exe → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'diskpart.exe');
			const output = makeBashOutput('diskpart.exe');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('bcdedit /delete — boot configuration wipe', () => {
		test('bcdedit /delete {guid} → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'bcdedit /delete {12345678-1234-1234-1234-123456789abc}';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*bcdedit/i,
			);
		});

		// Uppercase flag
		test('bcdedit /DELETE {guid} → BLOCKED (uppercase flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'bcdedit /DELETE {12345678-1234-1234-1234-123456789abc}';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('bcdedit.exe /delete {guid} → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'bcdedit.exe /delete {12345678-1234-1234-1234-123456789abc}';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('sdelete — Sysinternals secure wipe', () => {
		test('sdelete -p 3 file.txt → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'sdelete -p 3 file.txt';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*sdelete/i,
			);
		});

		// Uppercase command
		test('SDELETE -p 3 file.txt → BLOCKED (uppercase)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'SDELETE -p 3 file.txt';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('sdelete.exe -p 3 file.txt → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'sdelete.exe -p 3 file.txt';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('fsutil reparsepoint delete — symlink/junction wipe', () => {
		test('fsutil reparsepoint delete C:\\link → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'fsutil reparsepoint delete C:\\link';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*fsutil/i,
			);
		});

		// Uppercase subcommands — adversarial: implementation uses case-insensitive regex
		test('FSUTIL REPARSEPOINT DELETE C:\\link → BLOCKED (all-uppercase subcommands)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'FSUTIL REPARSEPOINT DELETE C:\\link';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Mixed case subcommands
		test('fsutil REPARSEPOINT DELETE C:\\link → BLOCKED (mixed case subcommands)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'fsutil REPARSEPOINT DELETE C:\\link';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('fsutil.exe reparsepoint delete C:\\link → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'fsutil.exe reparsepoint delete C:\\link';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('takeown /R — recursive ownership takeover', () => {
		test('takeown /R /F C:\\target → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'takeown /R /F C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*takeown/i,
			);
		});

		// Lowercase /r flag — adversarial: implementation uses /[rR]/ character class
		test('takeown /r /f C:\\target → BLOCKED (lowercase flags)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'takeown /r /f C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('takeown.exe /R /F C:\\target → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'takeown.exe /R /F C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('cipher /w — free-space wipe', () => {
		test('cipher /w:C:\\temp → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'cipher /w:C:\\temp';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*cipher/i,
			);
		});

		// Uppercase flag — adversarial: implementation uses /[wW]/
		test('cipher /W:C:\\temp → BLOCKED (uppercase /W)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'cipher /W:C:\\temp';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('cipher.exe /w:C:\\temp → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'cipher.exe /w:C:\\temp';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('format C: — disk format', () => {
		test('format C: → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'format C:';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*format/i,
			);
		});

		// Uppercase — adversarial: implementation uses case-insensitive /i flag
		test('FORMAT C: → BLOCKED (uppercase)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'FORMAT C:';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Different drive letters — adversarial: pattern uses [A-Za-z]: so all drives covered
		test('format D: → BLOCKED (drive D)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'format D:';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Lowercase drive letter
		test('format c: → BLOCKED (lowercase drive letter)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'format c:';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('robocopy /MIR — mirror delete', () => {
		test('robocopy /MIR empty dest → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'robocopy /MIR empty dest';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*robocopy/i,
			);
		});

		// Lowercase /mir — adversarial: implementation pattern uses (?:MIR|mir) so
		// mixed case like /Mir would slip through; /mir and /MIR are both covered
		test('robocopy src dest /mir → BLOCKED (lowercase /mir)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'robocopy src dest /mir';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('robocopy.exe /MIR empty dest → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'robocopy.exe /MIR empty dest';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('icacls /deny — permission denial', () => {
		test('icacls C:\\path /deny Everyone:(OI)(CI)F → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'icacls C:\\path /deny Everyone:(OI)(CI)F';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/BLOCKED.*icacls/i,
			);
		});

		// Uppercase /DENY — adversarial: implementation uses /deny\b with case-insensitive flag
		test('icacls C:\\path /DENY Everyone:(OI)(CI)F → BLOCKED (uppercase /DENY)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'icacls C:\\path /DENY Everyone:(OI)(CI)F';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// .exe suffix
		test('icacls.exe C:\\path /deny Everyone:(OI)(CI)F → BLOCKED (.exe suffix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'icacls.exe C:\\path /deny Everyone:(OI)(CI)F';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	// ----------------------------------------------------------------
	// Safe Windows commands that must NOT be blocked
	// ----------------------------------------------------------------
	describe('safe Windows read-only commands — must be ALLOWED', () => {
		test('dir /s C:\\path → ALLOWED (read-only listing)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'dir /s C:\\path');
			const output = makeBashOutput('dir /s C:\\path');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('copy /y src dest → ALLOWED (file copy, not delete)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'copy /y src dest');
			const output = makeBashOutput('copy /y src dest');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});
});

// ----------------------------------------------------------------
// PowerShell destructive command guard (adversarial)
// ----------------------------------------------------------------
describe('PowerShell destructive command guard (adversarial)', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});

	describe('Remove-Item -Recurse — canonical and adversarial variants', () => {
		test('Remove-Item -Recurse -Force C:\\target → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Remove-Item -Recurse -Force C:\\target';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('Remove-Item C:\\target -Recurse → BLOCKED (flag after path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Remove-Item C:\\target -Recurse';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// PowerShell is case-insensitive; implementation regex uses /i flag
		test('remove-item -recurse important_files → BLOCKED (all-lowercase PS cmdlet)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'remove-item -recurse important_files';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// REMOVE-ITEM all-caps — adversarial: must be caught by case-insensitive regex
		test('REMOVE-ITEM -RECURSE important_files → BLOCKED (all-uppercase PS cmdlet)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'REMOVE-ITEM -RECURSE important_files';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// -R short form — adversarial: implementation checks /-[Rr]\b/ separately
		test('Remove-Item -R C:\\path → BLOCKED (-R short form)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Remove-Item -R C:\\path';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Path with spaces (quoted) — adversarial: target extractor must handle quotes
		test('Remove-Item -Recurse -Force "C:\\Program Files\\target" → BLOCKED (quoted path with spaces)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Remove-Item -Recurse -Force "C:\\Program Files\\target"';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Safe target: node_modules → ALLOWED
		test('Remove-Item -Recurse node_modules → ALLOWED (safe target)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Remove-Item -Recurse node_modules';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	describe('PS alias ri — short form', () => {
		test('ri -r C:\\path → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'ri -r C:\\path';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Uppercase -R flag
		test('ri -R C:\\path → BLOCKED (uppercase -R)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'ri -R C:\\path';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('PS alias rm — Windows-path context', () => {
		test('rm -r C:\\path → BLOCKED (PS rm alias, Windows path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'rm -r C:\\path';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	describe('Get-ChildItem | Remove-Item -Recurse — pipeline form', () => {
		test('Get-ChildItem C:\\target | Remove-Item -Recurse → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Get-ChildItem C:\\target | Remove-Item -Recurse';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// Extra whitespace around pipe — adversarial: regex uses \|\s* so extra spaces must still match
		test('Get-ChildItem C:\\target  |  Remove-Item -Recurse → BLOCKED (extra whitespace around pipe)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'Get-ChildItem C:\\target  |  Remove-Item -Recurse';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		// gci | ri short aliases — adversarial: implementation has explicit gci/ri pattern
		test('gci C:\\target | ri -Recurse → BLOCKED (gci | ri short aliases)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const cmd = 'gci C:\\target | ri -Recurse';
			const input = makeBashInput('test-session', cmd);
			const output = makeBashOutput(cmd);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});
});

// ----------------------------------------------------------------
// tool: 'shell' must trigger the same blocks as tool: 'bash'
// ----------------------------------------------------------------
describe('tool: shell — must trigger identical blocks', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});

	test('rmdir /s /q C:\\target blocked when tool is shell', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = {
			tool: 'shell',
			sessionID: 'test-session',
			callID: 'call-1',
		};
		const output = makeBashOutput('rmdir /s /q C:\\target');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
	});

	test('Remove-Item -Recurse -Force C:\\target blocked when tool is shell', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = {
			tool: 'shell',
			sessionID: 'test-session',
			callID: 'call-1',
		};
		const output = makeBashOutput('Remove-Item -Recurse -Force C:\\target');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
	});

	test('vssadmin delete shadows /all blocked when tool is shell', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = {
			tool: 'shell',
			sessionID: 'test-session',
			callID: 'call-1',
		};
		const output = makeBashOutput('vssadmin delete shadows /all');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
	});

	test('diskpart blocked when tool is shell', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = {
			tool: 'shell',
			sessionID: 'test-session',
			callID: 'call-1',
		};
		const output = makeBashOutput('diskpart');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
	});

	test('format C: blocked when tool is shell', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = {
			tool: 'shell',
			sessionID: 'test-session',
			callID: 'call-1',
		};
		const output = makeBashOutput('format C:');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
	});
});

// ----------------------------------------------------------------
// block_destructive_commands: false — must allow everything through
// ----------------------------------------------------------------
describe('block_destructive_commands: false — all Windows commands pass through', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});

	test('rmdir /s /q C:\\target allowed when block_destructive_commands is false', async () => {
		const config = defaultConfig({ block_destructive_commands: false });
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput('test-session', 'rmdir /s /q C:\\target');
		const output = makeBashOutput('rmdir /s /q C:\\target');
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});

	test('vssadmin delete shadows /all allowed when block_destructive_commands is false', async () => {
		const config = defaultConfig({ block_destructive_commands: false });
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput('test-session', 'vssadmin delete shadows /all');
		const output = makeBashOutput('vssadmin delete shadows /all');
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});

	test('diskpart allowed when block_destructive_commands is false', async () => {
		const config = defaultConfig({ block_destructive_commands: false });
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput('test-session', 'diskpart');
		const output = makeBashOutput('diskpart');
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});

	test('Remove-Item -Recurse -Force C:\\target allowed when block_destructive_commands is false', async () => {
		const config = defaultConfig({ block_destructive_commands: false });
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput(
			'test-session',
			'Remove-Item -Recurse -Force C:\\target',
		);
		const output = makeBashOutput('Remove-Item -Recurse -Force C:\\target');
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});

	test('format C: allowed when block_destructive_commands is false', async () => {
		const config = defaultConfig({ block_destructive_commands: false });
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput('test-session', 'format C:');
		const output = makeBashOutput('format C:');
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});
});
