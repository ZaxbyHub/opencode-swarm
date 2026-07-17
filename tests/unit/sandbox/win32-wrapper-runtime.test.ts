import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	WindowsSandboxExecutor,
} from '../../../src/sandbox/win32/restricted-environment-executor';

const isWindows = process.platform === 'win32';
const realProbe = _internals.probeWindowsSandbox;
const originalPath = process.env.PATH;
const originalSystemRoot = process.env.SystemRoot;

function validatedSystemRoot(): string {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot)) {
		return 'C:\\Windows';
	}
	return path.win32.normalize(systemRoot).replace(/[\\/]+$/, '');
}

function powershellPath(): string {
	return path.win32.join(
		validatedSystemRoot(),
		'System32',
		'WindowsPowerShell',
		'v1.0',
		'powershell.exe',
	);
}

function executeThroughOpenCodeShape(command: string, tempDir?: string) {
	const executor = new WindowsSandboxExecutor([], tempDir);
	const wrapped = executor.wrapCommand(command, [], tempDir);
	const result = spawnSync(
		powershellPath(),
		['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped],
		{
			cwd: process.cwd(),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 10_000,
			windowsHide: true,
		},
	);
	return { result, wrapped };
}

function decodeWrapperScript(wrapped: string): string {
	const match = /-EncodedCommand\s+([A-Za-z0-9+/=]+)(?:;|\s|$)/.exec(wrapped);
	expect(match).not.toBeNull();
	return Buffer.from(match?.[1] ?? '', 'base64').toString('utf16le');
}

beforeEach(() => {
	_internals.probeWindowsSandbox = () => true;
});

afterEach(() => {
	_internals.probeWindowsSandbox = realProbe;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = originalSystemRoot;
});

describe('Windows fallback wrapper transport', () => {
	test.skipIf(!isWindows)(
		'executes through the real outer PowerShell shape without flattening lines',
		() => {
			const { result, wrapped } = executeThroughOpenCodeShape('echo first');
			const script = decodeWrapperScript(wrapped);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('first');
			expect(result.stderr).toBe('');
			expect(script).toContain('\n');
			expect(script).toContain(
				"$ProgressPreference = 'SilentlyContinue';\ntry {",
			);
			expect(wrapped).toStartWith("& '");
			expect(wrapped).toContain(
				'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			);
			expect(wrapped).toContain(' -EncodedCommand ');
		},
	);

	test.skipIf(!isWindows)('executes every CRLF-delimited command', () => {
		const { result } = executeThroughOpenCodeShape('echo first\r\necho second');
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('first');
		expect(result.stdout).toContain('second');
	});

	test.skipIf(!isWindows)('executes every LF-delimited command', () => {
		const { result } = executeThroughOpenCodeShape('echo first\necho second');
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('first');
		expect(result.stdout).toContain('second');
	});

	test.skipIf(!isWindows)(
		'does not expose a percent-expanded temp path to cmd call reparsing',
		() => {
			const expansionName = 'SWARM_F003_C3D4';
			const originalExpansion = process.env[expansionName];
			const tempDir = path.join(os.tmpdir(), `%${expansionName}%`);
			mkdirSync(tempDir, { recursive: true });
			process.env[expansionName] = 'x" & echo F003_INJECTED & rem "';
			try {
				const { result } = executeThroughOpenCodeShape(
					'echo intended-first\r\necho intended-second',
					tempDir,
				);
				expect(result.error).toBeUndefined();
				expect(result.status).toBe(0);
				expect(result.stdout).toContain('intended-first');
				expect(result.stdout).toContain('intended-second');
				expect(result.stdout).not.toContain('F003_INJECTED');
			} finally {
				if (originalExpansion === undefined) delete process.env[expansionName];
				else process.env[expansionName] = originalExpansion;
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!isWindows)(
		'preserves multiline execution from temp paths containing legal cmd metacharacters',
		() => {
			const tempDir = path.join(os.tmpdir(), 'swarm-! caret^ amp&');
			mkdirSync(tempDir, { recursive: true });
			try {
				const { result } = executeThroughOpenCodeShape(
					'echo metachar-first\r\necho metachar-second',
					tempDir,
				);
				expect(result.error).toBeUndefined();
				expect(result.status).toBe(0);
				expect(result.stdout).toContain('metachar-first');
				expect(result.stdout).toContain('metachar-second');
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!isWindows)(
		'preserves developer tools and separately transports quotes and Unicode',
		() => {
			const command = `node -e "process.stdout.write('snowman ☃; hash #')"`;
			const { result } = executeThroughOpenCodeShape(command);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toBe('snowman ☃; hash #');
			expect(result.stderr).toBe('');
		},
	);

	test.skipIf(!isWindows)(
		'escapes apostrophes in temp and override values',
		() => {
			const tempDir = path.join(os.tmpdir(), "swarm-O'Brien temp");
			const executor = new WindowsSandboxExecutor([], tempDir);
			const wrapped = executor.wrapCommand(
				'echo %SWARM_QUOTE_TEST%',
				[],
				tempDir,
				{
					SWARM_QUOTE_TEST: "O'Brien",
				},
			);
			const script = decodeWrapperScript(wrapped);
			const result = spawnSync(
				powershellPath(),
				['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped],
				{
					cwd: process.cwd(),
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: 10_000,
					windowsHide: true,
				},
			);

			expect(script).toContain("swarm-O''Brien temp");
			expect(script).toContain("$env:SWARM_QUOTE_TEST = 'O''Brien'");
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("O'Brien");
		},
	);

	test.skipIf(!isWindows)('propagates the exact cmd.exe exit code', () => {
		const { result } = executeThroughOpenCodeShape('exit /b 37');

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(37);
	});

	test('uses separate Base64 command transport and absolute cmd.exe', () => {
		const executor = new WindowsSandboxExecutor();
		const command = `echo "quoted" & echo O'Brien`;
		const script = decodeWrapperScript(executor.wrapCommand(command, []));
		const commandBase64 = Buffer.from(command, 'utf8').toString('base64');

		expect(script).toContain(`[Convert]::FromBase64String('${commandBase64}')`);
		expect(script).toContain('\\System32\\cmd.exe');
		expect(script).toContain("('call \"' + $batchName + '\"')");
		expect(script).not.toContain("('call \"' + $batchPath + '\"')");
		expect(script).toContain('/d /v:off /s /c');
		expect(script).toContain('$LASTEXITCODE');
		expect(script).not.toContain(command);
	});

	test('preserves CRLF and special characters in the inner command payload', () => {
		const command = `echo first\r\necho "second & # O'Brien"`;
		const script = decodeWrapperScript(
			new WindowsSandboxExecutor().wrapCommand(command, []),
		);
		const commandBase64 = Buffer.from(command, 'utf8').toString('base64');

		expect(script).toContain(`[Convert]::FromBase64String('${commandBase64}')`);
		expect(Buffer.from(commandBase64, 'base64').toString('utf8')).toBe(command);
	});

	test.skipIf(!isWindows)(
		'preserves stdout, stderr, and a nonzero exit',
		() => {
			const { result } = executeThroughOpenCodeShape(
				'echo stdout-value & echo stderr-value 1>&2 & exit /b 23',
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(23);
			expect(result.stdout).toContain('stdout-value');
			expect(result.stderr).toContain('stderr-value');
		},
	);

	test.skipIf(!isWindows)(
		'executes validated PowerShell-native commands',
		() => {
			const { result } = executeThroughOpenCodeShape(
				"Get-Date -Date '2026-07-17' -Format yyyy-MM-dd",
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe('2026-07-17');
			expect(result.stderr).toBe('');
		},
	);

	test.skipIf(!isWindows)(
		'retains installed Python, Node, and Git tools',
		() => {
			const cases = [
				['python', 'python --version'],
				['node', 'node --version'],
				['git', 'git --version'],
			] as const;
			let executed = 0;

			for (const [tool, command] of cases) {
				const available =
					spawnSync('where.exe', [tool], {
						cwd: process.cwd(),
						stdio: 'ignore',
						timeout: 5_000,
						windowsHide: true,
					}).status === 0;
				if (!available) continue;
				executed += 1;
				const { result } = executeThroughOpenCodeShape(command);
				expect(result.status).toBe(0);
			}

			expect(executed).toBeGreaterThan(0);
		},
	);
});

describe('Windows fallback PATH filtering', () => {
	test('keeps syntactically valid local tool paths without filesystem probes', () => {
		process.env.SystemRoot = 'D:\\WinNT';
		process.env.PATH = [
			'D:\\WinNT\\System32\\',
			'C:\\Program Files\\nodejs\\',
			'Z:\\definitely-does-not-exist\\bin',
			'c:\\program files\\NODEJS',
		].join(';');
		const pathValue = new WindowsSandboxExecutor().getEnvOverrides().PATH;

		expect(pathValue).toBe(
			'D:\\WinNT\\System32;D:\\WinNT;C:\\Program Files\\nodejs;Z:\\definitely-does-not-exist\\bin',
		);
	});

	test('rejects current, relative, UNC, device, quoted, and metacharacter entries', () => {
		process.env.SystemRoot = 'C:\\Windows';
		process.env.PATH = [
			'',
			'.',
			'C:relative',
			'relative\\bin',
			'\\\\server\\share',
			'\\\\?\\C:\\device',
			'"C:\\quoted"',
			'C:\\bad&path',
			'C:\\bad|path',
			'C:\\bad%PATH%',
			"C:\\bad'quote",
			'C:\\bad:stream',
			'C:\\safe (x86)\\bin\\',
		].join(';');
		const pathValue = new WindowsSandboxExecutor().getEnvOverrides().PATH;

		expect(pathValue).toBe(
			'C:\\Windows\\System32;C:\\Windows;C:\\safe (x86)\\bin',
		);
	});
});
