/**
 * PR #3145 review-fix regression rows.
 *
 * Three merge-blocker families found by the post-publication review and fixed
 * in the same PR:
 * - PRR-001: LF/CR are statement separators; a read-only brace pipeline plus
 *   a trailing write statement must keep the fail-closed parse rejection.
 * - PRR-002: cmd.exe accepts switches before /c (`cmd /d /s /c copy a b`);
 *   wrapper declaration, the copy/move matchers and every wrapper strip must
 *   be switch-tolerant.
 * - PRR-003: when no wrapper declares the executor, the two grammars may
 *   resolve the same construct to different paths; the merge keeps BOTH
 *   readings so the scope check fails closed on whichever escapes.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	CMD_BUILTIN_PREFIX,
	CMD_STRIP_PREFIX,
	declaresWindowsWrapper,
	declaresWindowsWrapperLoose,
} from '../../../../src/hooks/shell-executor-context';
import {
	detectWindowsWrites,
	isPowerShellReadOnlyPipeline,
	mergeWriteAnalyses,
} from '../../../../src/hooks/shell-write-detect';

describe('#3145 PRR-001 — newline/CR separators defeat read-only suppression', () => {
	const LF = String.fromCharCode(10);
	const CR = String.fromCharCode(13);

	it.each([
		['LF', LF],
		['CR', CR],
		['CRLF', `${CR}${LF}`],
	])('%s-separated second statement refuses read-only classification', (_label, sep) => {
		const command = `Get-Content a.md | Where-Object { $_ }${sep}tar -xf x.tar -C ../outside`;
		expect(isPowerShellReadOnlyPipeline(command)).toBe(false);
	});

	it('LF-separated mkdir after a read-only pipeline refuses classification', () => {
		const command = `Get-Content a.md | Where-Object { $_ }${LF}mkdir ../OUTDIR`;
		expect(isPowerShellReadOnlyPipeline(command)).toBe(false);
	});

	it('single-line read-only pipelines still classify positively', () => {
		expect(
			isPowerShellReadOnlyPipeline(
				'Get-Content a.md | Where-Object { $_.Length -gt 5 }',
			),
		).toBe(true);
	});
});

describe('#3145 PRR-002 — cmd.exe switches before /c', () => {
	it.each([
		['cmd /d /c', 'cmd /d /c copy a.md C:\\Windows\\Temp\\escape.md'],
		['cmd /s /c', 'cmd /s /c copy a.md C:\\Windows\\Temp\\escape.md'],
		['cmd /d /s /c', 'cmd /d /s /c copy a.md C:\\Windows\\Temp\\escape.md'],
		['cmd /q /c', 'cmd /q /c move a.md C:\\Windows\\Temp\\escape.md'],
		['cmd /v:on /c', 'cmd /v:on /c move a.md C:\\Windows\\Temp\\escape.md'],
	])('%s declares the cmd executor and the builtin matcher sees the target', (_label, command) => {
		expect(declaresWindowsWrapper(command)).toBe(true);
		const writes = detectWindowsWrites(command, 'cmd');
		expect(
			writes.writes.some(
				(write) =>
					(write.operator === 'copy' || write.operator === 'move') &&
					String(write.path).includes('escape.md'),
			),
		).toBe(true);
	});

	it('bare cmd /c keeps declaring', () => {
		expect(declaresWindowsWrapper('cmd /c copy a b')).toBe(true);
		expect(declaresWindowsWrapper('cmd.exe /c copy a b')).toBe(true);
	});

	it('decoy wrapper phrases still do not declare (boundary preserved)', () => {
		expect(declaresWindowsWrapper('echo cmd /c copy a b > OUT.md')).toBe(false);
		expect(declaresWindowsWrapper('cmd /x /c copy a b')).toBe(true);
	});

	it('copy/move builtin prefix accepts switch forms and rejects decoys', () => {
		expect(
			new RegExp(`^${CMD_BUILTIN_PREFIX.source}copy(?=\\s|$)`, 'i').test(
				'cmd /d /s /c copy a b',
			),
		).toBe(true);
		// `&&`-joined forms reach the matcher as split fragments (the fragment
		// starts at the builtin), so the anchored matcher sees `copy a b`.
		expect(
			new RegExp(`^${CMD_BUILTIN_PREFIX.source}copy(?=\\s|$)`, 'i').test(
				'copy a b',
			),
		).toBe(true);
		expect(
			new RegExp(`^${CMD_BUILTIN_PREFIX.source}copy(?=\\s|$)`, 'i').test(
				'if exist a.md copy a b',
			),
		).toBe(true);
		expect(
			new RegExp(`^${CMD_BUILTIN_PREFIX.source}copy(?=\\s|$)`, 'i').test(
				'echo copy a b',
			),
		).toBe(false);
	});

	it('cmd /k strip stays switch-tolerant', () => {
		expect(CMD_STRIP_PREFIX.test('cmd /d /k echo hi')).toBe(true);
		expect(CMD_STRIP_PREFIX.test('cmd /c echo hi')).toBe(true);
		expect(CMD_STRIP_PREFIX.test('cmdx /c echo hi')).toBe(false);
	});

	it('detectWindowsWrites collapses single-quote artifacts to the clean target (#2500)', () => {
		// The cmd-redirect scanner's single-quote blind spot emits the literal
		// quoted path alongside the PowerShell detector's clean path; the
		// quoted variant must collapse (it failed the scope_validate
		// in-scope check in CI).
		const writes = detectWindowsWrites(
			"Get-Process>'safe/note.md'",
			'powershell',
		);
		expect(writes.writes.map((write) => write.path)).toEqual(['safe/note.md']);
		// A genuinely different quoted target still survives.
		const two = detectWindowsWrites(
			"Get-Process>'safe/note.md' > '../OUTSIDE.md'",
			'powershell',
		);
		expect(two.writes.length).toBe(2);
	});
});

describe('#3145 PRR-003 — path-disagreeing readings both survive the merge', () => {
	it('keeps a supplementary write whose path differs from every authority write', () => {
		const primary = {
			writes: [
				{ category: 'redirect', operator: '>', path: 'src/....OUT2.md' },
			],
			hasWrites: true,
			parseError: false,
		};
		const additional = {
			writes: [
				{ category: 'redirect', operator: '>', path: '..\\..\\OUT2.md' },
			],
			hasWrites: true,
			parseError: false,
		};
		const merged = mergeWriteAnalyses(
			primary as never,
			additional as never,
			true,
			false,
		);
		expect(merged.writes).toHaveLength(2);
	});

	it('collapses true duplicates (same construct and path)', () => {
		const write = { category: 'redirect', operator: '>', path: 'OUT.md' };
		const merged = mergeWriteAnalyses(
			{ writes: [write], hasWrites: true, parseError: false } as never,
			{ writes: [{ ...write }], hasWrites: true, parseError: false } as never,
			true,
			false,
		);
		expect(merged.writes).toHaveLength(1);
	});

	it('with a declared wrapper the authority reading alone governs shared constructs', () => {
		// The C4 frozen shape: the POSIX leg of the unwrapped payload is an
		// unescape artifact (src\out.txt reads as srcout.txt) and must not
		// out-vote the declared executor's reading.
		const primary = {
			writes: [{ category: 'redirect', operator: '>', path: 'srcout.txt' }],
			hasWrites: true,
			parseError: false,
		};
		const additional = {
			writes: [{ category: 'redirect', operator: '>', path: 'src\\out.txt' }],
			hasWrites: true,
			parseError: false,
		};
		const merged = mergeWriteAnalyses(
			primary as never,
			additional as never,
			true,
			true,
		);
		expect(merged.writes).toHaveLength(1);
		expect(merged.writes[0]?.path).toBe('src\\out.txt');
	});
});

describe('#3145 PRR-002 explain parity — switch forms declare through the shared predicate', () => {
	it('loose form accepts pipe-adjacent powershell and switch-form cmd', () => {
		expect(
			declaresWindowsWrapperLoose('type a.md | powershell -Command "x"'),
		).toBe(true);
		expect(declaresWindowsWrapperLoose('cmd /q /c copy a b')).toBe(true);
		expect(declaresWindowsWrapperLoose('echo done')).toBe(false);
	});
});

const u = (p: string) => pathToFileURL(join(process.cwd(), p)).href;

describe('#3145 CI round — quote artifacts and stale-bypass rows re-homed here', () => {
	// The destructive-command-windows baselined suite is over-cap and cannot
	// grow, so the rows that used to encode the pre-PR bypass live here.
	const LF = String.fromCharCode(10);
	let hooks: Awaited<ReturnType<typeof createGuardrailsHooks>>;
	let testDir: string;

	beforeAll(async () => {
		const guardrails = await import(u('src/hooks/guardrails/index.ts'));
		const sandbox = await import(u('src/hooks/guardrails/tool-before.ts'));
		const state = await import(u('src/state.ts'));
		const tmp = await import(u('tests/helpers/tmpdir.ts'));
		testDir = tmp.canonicalMkdtemp('pr3145-gate-');
		guardrails._internals.getSandboxExecutor = async () =>
			({
				mechanism: 'bubblewrap',
				isAvailable: () => true,
				wrapCommand: () => 'wrapped-command',
				getEnvOverrides: () => ({}),
			}) as never;
		guardrails._internals.assessSandboxEnforcement = async () =>
			({
				capability: { identity: 'cap-1', mechanism: 'bubblewrap' },
				requirements: {
					mode: 'advisory',
					require_filesystem: false,
					require_network: false,
					require_process: false,
				},
				satisfied: true,
				missing: [],
				cacheKey: 'cap-1',
				supported: true,
				unsupported: [],
			}) as never;
		sandbox._resetSandboxUnavailableWarningState();
		state.resetSwarmState();
		state.startAgentSession('test-session', 'coder', testDir);
		hooks = guardrails.createGuardrailsHooks(testDir, undefined, {
			enabled: true,
			block_destructive_commands: false,
		} as never);
	});

	it('single-quoted redirect target collapses to the clean path (#2500)', () => {
		const writes = detectWindowsWrites(
			"Get-Process>'safe/note.md'",
			'powershell',
		);
		expect(writes.writes.map((write) => write.path)).toEqual(['safe/note.md']);
	});

	it('caret-escaped `>` is not a redirection for either grammar', () => {
		expect(detectWindowsWrites('echo x ^>outside.txt', 'cmd').writes).toEqual(
			[],
		);
		expect(
			detectWindowsWrites('echo x ^>outside.txt', 'powershell').writes,
		).toEqual([]);
	});

	it('Remove-Item -Recurse on bash is a scope-checked write even with the destructive flag off', async () => {
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'r6-a' } as never,
				{ args: { command: 'Remove-Item -Recurse $env:APPDATA' } } as never,
			),
		).rejects.toThrow(/SCOPE_NOT_DECLARED|WRITE BLOCKED/);
	});

	it('encoded Remove-Item payload stays scope-checked with the destructive flag off', async () => {
		const encoded = Buffer.from(
			'Remove-Item -Recurse C:\\target',
			'utf16le',
		).toString('base64');
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'r6-b64' } as never,
				{
					args: { command: `powershell -EncodedCommand ${encoded}` },
				} as never,
			),
		).rejects.toThrow(/SCOPE_NOT_DECLARED|WRITE BLOCKED/);
	});

	it('in-scope adjacent/append PowerShell redirects stay admitted (#2500)', async () => {
		const { installActiveScopeBinding } = await import(
			u('tests/helpers/active-scope-binding.ts')
		);
		installActiveScopeBinding({
			directory: testDir,
			childSessionId: 'test-session',
			taskId: '1.1',
			files: ['safe/'],
			dispatchCallId: 'r6-scope',
		});
		for (const command of [
			'dir>safe/note.md',
			'Get-Process>>safe/note.md',
			'Get-Process>"safe/note.md"',
		]) {
			await expect(
				hooks.toolBefore(
					{
						tool: 'shell',
						sessionID: 'test-session',
						callID: `r6-in-${command.length}`,
					} as never,
					{ args: { command } } as never,
				),
			).resolves.toBeUndefined();
		}
	});
});
