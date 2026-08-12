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

async function expectBlocked(command: string): Promise<void> {
	const config = defaultConfig();
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
	const input = makeBashInput('test-session');
	const output = makeBashOutput(command);
	await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
}

async function expectAllowed(command: string): Promise<void> {
	const config = defaultConfig();
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
	const input = makeBashInput('test-session');
	const output = makeBashOutput(command);
	await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
}

describe('wrapper unwrapping and normalization — adversarial', () => {
	beforeEach(() => {
		TEST_DIR = canonicalMkdtemp('destructive-wrapper-');
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	describe('cmd /c wrapper — cmd.exe shell dispatch', () => {
		test('cmd /c "rmdir /s /q C:\\target" → BLOCKED', async () => {
			await expectBlocked('cmd /c "rmdir /s /q C:\\target"');
		});

		test('cmd /c "del /s /q C:\\target" → BLOCKED', async () => {
			await expectBlocked('cmd /c "del /s /q C:\\target"');
		});

		test('cmd /C rmdir /s /q important_files → BLOCKED (uppercase /C)', async () => {
			await expectBlocked('cmd /C rmdir /s /q important_files');
		});

		test('CMD /c "rmdir /s /q C:\\target" → BLOCKED (uppercase CMD)', async () => {
			await expectBlocked('CMD /c "rmdir /s /q C:\\target"');
		});

		test('cmd.exe /c "rmdir /s /q C:\\target" → BLOCKED (.exe suffix)', async () => {
			await expectBlocked('cmd.exe /c "rmdir /s /q C:\\target"');
		});

		test('cmd /k "rmdir /s node_modules" → ALLOWED (safe target inside /k wrapper)', async () => {
			await expectAllowed('cmd /k "rmdir /s node_modules"');
		});

		test('cmd /c "rmdir /s /q dist" → ALLOWED (safe target)', async () => {
			await expectAllowed('cmd /c "rmdir /s /q dist"');
		});

		test('cmd /c rmdir /s /q important_files (no quotes around inner) → BLOCKED', async () => {
			await expectBlocked('cmd /c rmdir /s /q important_files');
		});
	});

	// -------------------------------------------------------------------------
	// K2.6 data-loss incident literal command — must be blocked
	// -------------------------------------------------------------------------
	describe('K2.6 data-loss incident literal command', () => {
		test('exact K2.6 incident string → BLOCKED', async () => {
			// The exact command from the K2.6 incident that caused data loss
			const incidentCommand =
				'cmd /c "rmdir /q /s "C:\\opencode\\doc_qa_app\\DocumentQA-v2.0.0-Portable\\DocumentQA""';
			await expectBlocked(incidentCommand);
		});
	});

	// -------------------------------------------------------------------------
	// powershell -Command wrapper
	// -------------------------------------------------------------------------
	describe('powershell -Command wrapper', () => {
		test('powershell -Command "Remove-Item -Recurse C:\\target" → BLOCKED', async () => {
			await expectBlocked(
				'powershell -Command "Remove-Item -Recurse C:\\target"',
			);
		});

		test('powershell -command "Remove-Item -Recurse C:\\target" → BLOCKED (lowercase -command)', async () => {
			await expectBlocked(
				'powershell -command "Remove-Item -Recurse C:\\target"',
			);
		});

		test('powershell -c "Remove-Item -Recurse C:\\target" → BLOCKED (-c short form)', async () => {
			await expectBlocked('powershell -c "Remove-Item -Recurse C:\\target"');
		});

		test('POWERSHELL -c "Remove-Item -Recurse C:\\target" → BLOCKED (uppercase POWERSHELL)', async () => {
			await expectBlocked('POWERSHELL -c "Remove-Item -Recurse C:\\target"');
		});

		test('powershell.exe -Command "Remove-Item -Recurse C:\\target" → BLOCKED (.exe suffix)', async () => {
			await expectBlocked(
				'powershell.exe -Command "Remove-Item -Recurse C:\\target"',
			);
		});

		test('pwsh -Command "Remove-Item C:\\target -Recurse" → BLOCKED (pwsh, flags after path)', async () => {
			await expectBlocked('pwsh -Command "Remove-Item C:\\target -Recurse"');
		});

		test('pwsh -c "ri -r C:\\path" → BLOCKED (ri alias with short -r)', async () => {
			await expectBlocked('pwsh -c "ri -r C:\\path"');
		});

		test('pwsh -c "Remove-Item -r /important" → BLOCKED (pwsh short -r on POSIX path)', async () => {
			await expectBlocked('pwsh -c "Remove-Item -r /important"');
		});

		test('PWSH -Command "Remove-Item -Recurse C:\\target" → BLOCKED (uppercase PWSH)', async () => {
			await expectBlocked('PWSH -Command "Remove-Item -Recurse C:\\target"');
		});
	});

	// -------------------------------------------------------------------------
	// powershell -EncodedCommand (base64 UTF-16LE decode + check)
	// -------------------------------------------------------------------------
	describe('powershell -EncodedCommand base64 decode', () => {
		test('powershell -EncodedCommand <Remove-Item -Recurse C:\\target> → BLOCKED', async () => {
			// Generate base64 programmatically — UTF-16LE encoding as PowerShell uses
			const encoded = Buffer.from(
				'Remove-Item -Recurse C:\\target',
				'utf16le',
			).toString('base64');
			await expectBlocked(`powershell -EncodedCommand ${encoded}`);
		});

		test('powershell -encodedcommand <Remove-Item -Recurse C:\\target> → BLOCKED (lowercase flag)', async () => {
			const encoded = Buffer.from(
				'Remove-Item -Recurse C:\\target',
				'utf16le',
			).toString('base64');
			await expectBlocked(`powershell -encodedcommand ${encoded}`);
		});

		test('powershell -enc <Remove-Item -Recurse C:\\target> → BLOCKED (-enc short form)', async () => {
			const encoded = Buffer.from(
				'Remove-Item -Recurse C:\\target',
				'utf16le',
			).toString('base64');
			await expectBlocked(`powershell -enc ${encoded}`);
		});

		test('powershell -e <Remove-Item -Recurse C:\\target> → BLOCKED (-e shortest alias)', async () => {
			const encoded = Buffer.from(
				'Remove-Item -Recurse C:\\target',
				'utf16le',
			).toString('base64');
			await expectBlocked(`powershell -e ${encoded}`);
		});

		test('pwsh -EncodedCommand <Remove-Item -Recurse C:\\target> → BLOCKED (pwsh binary)', async () => {
			const encoded = Buffer.from(
				'Remove-Item -Recurse C:\\target',
				'utf16le',
			).toString('base64');
			await expectBlocked(`pwsh -EncodedCommand ${encoded}`);
		});

		test('powershell -enc <safe "dir C:\\temp"> → ALLOWED', async () => {
			// A benign command encoded in base64 must not be blocked
			const encoded = Buffer.from('dir C:\\temp', 'utf16le').toString('base64');
			await expectAllowed(`powershell -enc ${encoded}`);
		});

		test('powershell -EncodedCommand <rm -rf /important> → BLOCKED (POSIX rm encoded in PS)', async () => {
			const encoded = Buffer.from('rm -rf /important', 'utf16le').toString(
				'base64',
			);
			await expectBlocked(`powershell -EncodedCommand ${encoded}`);
		});
	});

	// -------------------------------------------------------------------------
	// bash/sh -c wrapper
	// -------------------------------------------------------------------------
	describe('bash/sh -c wrapper', () => {
		test('bash -c "rm -rf /important" → BLOCKED', async () => {
			await expectBlocked('bash -c "rm -rf /important"');
		});

		test('sh -c "rm -rf /" → BLOCKED', async () => {
			await expectBlocked('sh -c "rm -rf /"');
		});

		test('bash -c "rmdir /s /q C:\\target" → BLOCKED (Windows rmdir inside bash -c)', async () => {
			await expectBlocked('bash -c "rmdir /s /q C:\\target"');
		});

		test('zsh -c "rm -rf /important" → BLOCKED', async () => {
			await expectBlocked('zsh -c "rm -rf /important"');
		});

		test('bash -c "rm -rf node_modules" → ALLOWED (safe target)', async () => {
			await expectAllowed('bash -c "rm -rf node_modules"');
		});

		test('bash -c "echo hello" → ALLOWED', async () => {
			await expectAllowed('bash -c "echo hello"');
		});
	});

	// -------------------------------------------------------------------------
	// sudo wrapper
	// -------------------------------------------------------------------------
	describe('sudo wrapper', () => {
		test('sudo rm -rf /important → BLOCKED', async () => {
			await expectBlocked('sudo rm -rf /important');
		});

		test('sudo rmdir /s /q C:\\target → BLOCKED', async () => {
			await expectBlocked('sudo rmdir /s /q C:\\target');
		});

		test('sudo rm -rf / → BLOCKED (root filesystem)', async () => {
			await expectBlocked('sudo rm -rf /');
		});

		test('sudo bash -c "rm -rf /important" → BLOCKED (sudo + bash -c nesting)', async () => {
			await expectBlocked('sudo bash -c "rm -rf /important"');
		});

		test('sudo rm -rf node_modules → ALLOWED (safe target)', async () => {
			await expectAllowed('sudo rm -rf node_modules');
		});
	});

	// -------------------------------------------------------------------------
	// WSL cross-OS bridge
	// -------------------------------------------------------------------------
	describe('WSL cross-OS bridge', () => {
		test('wsl -e rm -rf /mnt/c/opencode → BLOCKED (rm -rf inside wsl)', async () => {
			await expectBlocked('wsl -e rm -rf /mnt/c/opencode');
		});

		test('wsl -- rmdir /s /q C:\\target → BLOCKED (rmdir via wsl --)', async () => {
			await expectBlocked('wsl -- rmdir /s /q C:\\target');
		});

		test('wsl.exe -e rm -rf /mnt/c/opencode → BLOCKED (.exe suffix)', async () => {
			await expectBlocked('wsl.exe -e rm -rf /mnt/c/opencode');
		});

		test('wsl -e rm -rf / → BLOCKED (root via wsl)', async () => {
			await expectBlocked('wsl -e rm -rf /');
		});

		test('wsl -e echo hello → ALLOWED (safe command through wsl)', async () => {
			await expectAllowed('wsl -e echo hello');
		});

		test('WSL.EXE -e rm -rf /mnt/c/opencode → BLOCKED (uppercase WSL.EXE)', async () => {
			await expectBlocked('WSL.EXE -e rm -rf /mnt/c/opencode');
		});

		test('WSL -- rm -rf /important → BLOCKED (uppercase WSL with --)', async () => {
			await expectBlocked('WSL -- rm -rf /important');
		});
	});

	// -------------------------------------------------------------------------
	// Uppercase sudo/nohup wrappers
	// -------------------------------------------------------------------------
	describe('uppercase prefix wrappers (SUDO, NOHUP)', () => {
		test('SUDO rm -rf /important → BLOCKED (uppercase SUDO)', async () => {
			await expectBlocked('SUDO rm -rf /important');
		});

		test('NOHUP rm -rf /important → BLOCKED (uppercase NOHUP)', async () => {
			await expectBlocked('NOHUP rm -rf /important');
		});

		test('SUDO Remove-Item -Recurse /important → BLOCKED (uppercase SUDO + PS)', async () => {
			await expectBlocked('SUDO Remove-Item -Recurse /important');
		});
	});

	// -------------------------------------------------------------------------
	// Normalization: PowerShell backtick escape
	// -------------------------------------------------------------------------
	describe('PowerShell backtick escape normalization', () => {
		test('R`e`m`o`v`e`-`I`t`e`m -Recurse C:\\target → BLOCKED (backtick per-char escape)', async () => {
			await expectBlocked('R`e`m`o`v`e`-`I`t`e`m -Recurse C:\\target');
		});

		test('`r`m -`r`f /important → BLOCKED (rm with backtick escapes)', async () => {
			await expectBlocked('`r`m -`r`f /important');
		});

		test('R`e`m`o`v`e`-`I`t`e`m -`R C:\\target → BLOCKED (short -R flag also backtick escaped)', async () => {
			await expectBlocked('R`e`m`o`v`e`-`I`t`e`m -`R C:\\target');
		});

		test('r`m`d`i`r /s /q important_files → BLOCKED (rmdir with backtick escapes)', async () => {
			await expectBlocked('r`m`d`i`r /s /q important_files');
		});
	});

	// -------------------------------------------------------------------------
	// Normalization: cmd.exe caret escape
	// -------------------------------------------------------------------------
	describe('cmd.exe caret escape normalization', () => {
		test('^r^m^d^i^r /s /q important_files → BLOCKED (carets collapsed → rmdir /s /q)', async () => {
			await expectBlocked('^r^m^d^i^r /s /q important_files');
		});

		test('^r^m -^r^f /important → BLOCKED (rm with caret escapes)', async () => {
			await expectBlocked('^r^m -^r^f /important');
		});

		test('^r^m^d^i^r /s /q node_modules → ALLOWED (safe target after caret collapse)', async () => {
			await expectAllowed('^r^m^d^i^r /s /q node_modules');
		});

		test('^e^c^h^o hello → ALLOWED (benign command with carets)', async () => {
			await expectAllowed('^e^c^h^o hello');
		});
	});

	// -------------------------------------------------------------------------
	// Normalization: quote-splice evasion
	// -------------------------------------------------------------------------
	describe('quote-splice evasion normalization', () => {
		test('r""m""dir /s important_files → BLOCKED (doubled-quote splice collapses to rmdir)', async () => {
			await expectBlocked('r""m""dir /s important_files');
		});

		test('r""m -r""f /important → BLOCKED (rm with quote splicing)', async () => {
			await expectBlocked('r""m -r""f /important');
		});

		test('r""m""dir /s node_modules → ALLOWED (safe target after quote collapse)', async () => {
			await expectAllowed('r""m""dir /s node_modules');
		});

		// PowerShell single-quote splice: R''e''m''o''v''e''-''I''t''e''m
		// PS treats '' as empty quoted string, so concatenation produces Remove-Item.
		test("R''e''m''o''v''e''-''I''t''e''m -Recurse important_files → BLOCKED (single-quote splice)", async () => {
			await expectBlocked(
				"R''e''m''o''v''e''-''I''t''e''m -Recurse important_files",
			);
		});

		test("r''m''dir /s important_files → BLOCKED (single-quote splice collapses to rmdir)", async () => {
			await expectBlocked("r''m''dir /s important_files");
		});
	});

	// -------------------------------------------------------------------------
	// Normalization: NFKC fullwidth Unicode characters
	// -------------------------------------------------------------------------
	describe('NFKC fullwidth Unicode normalization', () => {
		test('ｒｍ　－ｒｆ　／ → BLOCKED (NFKC normalizes fullwidth chars to rm -rf /)', async () => {
			// ｒ=U+FF52, ｍ=U+FF4D, 　=U+3000, －=U+FF0D, ｒ=U+FF52, ｆ=U+FF46, 　=U+3000, ／=U+FF0F
			await expectBlocked('\uFF52\uFF4D\u3000\uFF0D\uFF52\uFF46\u3000\uFF0F');
		});

		test('ｒｍｄｉｒ　／ｓ　／ｑ　important_files → BLOCKED (fullwidth rmdir /s /q)', async () => {
			// ｒ=FF52, ｍ=FF4D, ｄ=FF44, ｉ=FF49, ｒ=FF52, 　=3000, ／=FF0F, ｓ=FF53, 　=3000, ／=FF0F, ｑ=FF51
			await expectBlocked(
				'\uFF52\uFF4D\uFF44\uFF49\uFF52\u3000\uFF0F\uFF53\u3000\uFF0F\uFF51\u3000important_files',
			);
		});
	});

	// -------------------------------------------------------------------------
	// Compound commands — each segment independently checked
	// -------------------------------------------------------------------------
	describe('compound command splitting — per-segment checking', () => {
		test('echo hello && rmdir /s important_files → BLOCKED (rmdir in second && segment)', async () => {
			await expectBlocked('echo hello && rmdir /s important_files');
		});

		test('echo hello; rm -rf / → BLOCKED (rm in second ; segment)', async () => {
			await expectBlocked('echo hello; rm -rf /');
		});

		test('ls && echo done → ALLOWED (neither segment is destructive)', async () => {
			await expectAllowed('ls && echo done');
		});

		test('echo safe | rm -rf /important → BLOCKED (rm in piped segment)', async () => {
			await expectBlocked('echo safe | rm -rf /important');
		});

		test('rm -rf /important || echo fallback → BLOCKED (rm in first || segment)', async () => {
			await expectBlocked('rm -rf /important || echo fallback');
		});

		test('ls; echo done; cat file.txt → ALLOWED (all safe segments)', async () => {
			await expectAllowed('ls; echo done; cat file.txt');
		});

		test('echo hello && powershell -c "Remove-Item -Recurse C:\\target" → BLOCKED (wrapped cmd in second segment)', async () => {
			await expectBlocked(
				'echo hello && powershell -c "Remove-Item -Recurse C:\\target"',
			);
		});

		test('echo a && echo b && rmdir /s important_files → BLOCKED (rmdir in third segment)', async () => {
			await expectBlocked('echo a && echo b && rmdir /s important_files');
		});
	});

	// -------------------------------------------------------------------------
	// Multi-layer wrapper nesting (wrapper inside wrapper)
	// -------------------------------------------------------------------------
	describe('multi-layer wrapper nesting', () => {
		test('sudo bash -c "rm -rf /important" → BLOCKED (sudo → bash -c nesting)', async () => {
			await expectBlocked('sudo bash -c "rm -rf /important"');
		});

		test('sudo powershell -Command "Remove-Item -Recurse C:\\target" → BLOCKED (sudo → powershell)', async () => {
			await expectBlocked(
				'sudo powershell -Command "Remove-Item -Recurse C:\\target"',
			);
		});

		test('wsl -e bash -c "rm -rf /mnt/c/data" → BLOCKED (wsl → bash nesting)', async () => {
			await expectBlocked('wsl -e bash -c "rm -rf /mnt/c/data"');
		});
	});

	// -------------------------------------------------------------------------
	// Whitespace and flag ordering edge cases
	// -------------------------------------------------------------------------
	describe('whitespace and flag ordering edge cases', () => {
		test('rmdir  /s  /q  C:\\target → BLOCKED (extra internal spaces)', async () => {
			await expectBlocked('rmdir  /s  /q  C:\\target');
		});

		test('rmdir /q /s C:\\target → BLOCKED (reversed /q /s flag order)', async () => {
			await expectBlocked('rmdir /q /s C:\\target');
		});

		test('rm  -rf  /important → BLOCKED (extra spaces between flag and path)', async () => {
			await expectBlocked('rm  -rf  /important');
		});

		test('rm -fr /important → BLOCKED (-fr reversed flag order)', async () => {
			await expectBlocked('rm -fr /important');
		});

		test('rm -f -r /important → BLOCKED (split flags -f -r)', async () => {
			await expectBlocked('rm -f -r /important');
		});

		test('rm -r -f /important → BLOCKED (reversed split flags -r -f)', async () => {
			await expectBlocked('rm -r -f /important');
		});

		test('cmd /c  rmdir /s /q important_files → BLOCKED (extra space after /c)', async () => {
			await expectBlocked('cmd /c  rmdir /s /q important_files');
		});

		test('RMDIR /S /Q C:\\target → BLOCKED (all-uppercase RMDIR /S /Q)', async () => {
			await expectBlocked('RMDIR /S /Q C:\\target');
		});

		test('Rmdir /S /Q C:\\target → BLOCKED (mixed-case Rmdir)', async () => {
			await expectBlocked('Rmdir /S /Q C:\\target');
		});

		test('Remove-Item -RECURSE C:\\target → BLOCKED (uppercase -RECURSE flag)', async () => {
			await expectBlocked('Remove-Item -RECURSE C:\\target');
		});

		test('REMOVE-ITEM -Recurse C:\\target → BLOCKED (uppercase cmdlet name)', async () => {
			await expectBlocked('REMOVE-ITEM -Recurse C:\\target');
		});
	});

	// -------------------------------------------------------------------------
	// block_destructive_commands: false — must bypass ALL wrapper/normalization checks
	// -------------------------------------------------------------------------
	describe('block_destructive_commands: false — bypass all checks', () => {
		test('rm -rf / allowed when block_destructive_commands is false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const command = 'rm -rf /';
			const input = makeBashInput('test-session');
			const output = makeBashOutput(command);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('cmd /c "rmdir /s /q C:\\target" allowed when block_destructive_commands is false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const command = 'cmd /c "rmdir /s /q C:\\target"';
			const input = makeBashInput('test-session');
			const output = makeBashOutput(command);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('powershell -EncodedCommand <Remove-Item> allowed when block_destructive_commands is false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const encoded = Buffer.from(
				'Remove-Item -Recurse C:\\target',
				'utf16le',
			).toString('base64');
			const command = `powershell -EncodedCommand ${encoded}`;
			const input = makeBashInput('test-session');
			const output = makeBashOutput(command);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('K2.6 incident string allowed when block_destructive_commands is false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const command =
				'cmd /c "rmdir /q /s "C:\\opencode\\doc_qa_app\\DocumentQA-v2.0.0-Portable\\DocumentQA""';
			const input = makeBashInput('test-session');
			const output = makeBashOutput(command);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});
});
