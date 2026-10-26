/**
 * Shared Windows-executor wrapper declaration predicates (#3145).
 *
 * The wrapper-detection regexes lived as four byte-identical copies
 * (resolveWindowsWriteAuthority, the gate's detect() closure, and both
 * explain-service branches). Byte-divergence between those copies was the
 * exact defect class of review rounds 5-7 (one copy drifting flipped
 * explain-vs-gate verdicts), so this module is now the single definition.
 *
 * Switch tolerance (PRR-002): cmd.exe accepts switches between the binary
 * and /c — `cmd /d /s /c copy a b`, `cmd /q /c`, `cmd /v:on /c`. The
 * previous bare-`/c` regexes let every switch form fall through the
 * authority ladder to the POSIX-only reading, which has no `copy`/`move`
 * vocabulary — an out-of-scope write admitted. The same tolerance applies
 * to the PowerShell wrapper strips (PRR-009): `powershell -NoProfile
 * -Command "…"` must unwrap for the (now-authoritative) Windows reading to
 * see the payload.
 */

/** cmd.exe switches that may appear before /c or /k (optionally :on/:off). */
const CMD_SWITCH = String.raw`\/[a-z](?::(?:on|off))?`;

/** Statement-position cmd /c declaration (switch-tolerant). */
export const CMD_WRAPPER_DECLARATION = new RegExp(
	String.raw`(?:^|[;|&\n])\s*cmd(?:\.exe)?\s+(?:${CMD_SWITCH}\s+)*\/c(?:\s|$)`,
	'i',
);

/** Statement-position powershell/pwsh -Command declaration. */
export const PS_WRAPPER_DECLARATION =
	/(?:^|[;|&\n])\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-command(?:\s|$)/i;

/** Loose powershell phrase (segment start or pipe) used by the ladder. */
export const PS_WRAPPER_LOOSE = /(?:^|\|)\s*(?:powershell|pwsh)(?:\.exe)?\s+-/i;

/**
 * True when the command explicitly declares a Windows executor at a
 * statement boundary: a cmd /c wrapper (any switches) or a
 * powershell/pwsh -Command wrapper.
 */
export function declaresWindowsWrapper(command: string): boolean {
	return (
		CMD_WRAPPER_DECLARATION.test(command) ||
		PS_WRAPPER_DECLARATION.test(command)
	);
}

/** Same declaration, additionally accepting the pipe-adjacent loose form. */
export function declaresWindowsWrapperLoose(command: string): boolean {
	return declaresWindowsWrapper(command) || PS_WRAPPER_LOOSE.test(command);
}

/**
 * Leading prefix that positions a cmd builtin (copy/move): an if-exist
 * guard, a switch-tolerant `cmd … /c`, or call/start. Anchored variants of
 * the cmd copy/move matchers compose this so `cmd /d /s /c copy a b` is
 * detected like bare `cmd /c copy a b`.
 */
export const CMD_BUILTIN_PREFIX = new RegExp(
	String.raw`(?:(?:^|\s)(?:if\s+(?:not\s+)?exist\s+(?:"[^"]*"|\S+)\s+)|(?:^|[;|&\n])\s*cmd(?:\.exe)?\s+(?:${CMD_SWITCH}\s+)*\/c\s+|(?:^|\s)(?:call|start)\s+)*`,
	'i',
);

/** Strip pattern for a cmd /c or /k wrapper with any switches. */
export const CMD_STRIP_PREFIX = new RegExp(
	String.raw`^cmd(?:\.exe)?\s+(?:${CMD_SWITCH}\s+)*\/[ck]\s+`,
	'i',
);

/** Strip pattern for a powershell/pwsh -Command/-c wrapper with switches. */
export const PS_STRIP_PREFIX =
	/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-(?:command|c)\s+/i;

/**
 * Observed host shell for the OpenCode 2 `shell` tool (#3346).
 *
 * The v2 host resolves the shell a `shell`-tool command actually executes
 * (user-configured shell, else `$SHELL` when compatible+executable, else on
 * win32 the first of pwsh → powershell → Git Bash → COMSPEC, else a POSIX
 * fallback) and REPORTS it to plugins through the
 * `@opencode/plugin` v2 `ctx.shell.hook("create.before", …)` payload
 * (`{ command, cwd, timeout, shell, env }`; hook added upstream 2026-07-29,
 * present across the vendored 2.0.26/2.0.29 pin). `registerV2ShellHooks`
 * (src/host/v2/hooks.ts) records that authoritative observation here; the
 * write gate (`resolveWindowsWriteAuthority` call site in
 * guardrails/tool-before.ts) and `/swarm guardrail explain`
 * (guardrail-explain-service.ts) read it so both key cmd/powershell grammar
 * inheritance on the shell the host actually runs instead of the platform.
 *
 * Authoritative hook observations ONLY — no environment seeding (plan-critic
 * r2: a seeded `$SHELL` value treated as authoritative could null the win32
 * fallback and fail the gate open on the first call, and synchronous PATH
 * probing would run before any registration timeout exists). Before the
 * first report the resolver falls back to the platform-keyed interim from
 * #3326, which is never wider than the pre-#3346 behavior. The v1 host has
 * no `shell` tool dispatch and never writes this store.
 */
let observedHostShell: string | undefined;

/** Record the host-reported shell for the `shell` tool (latest wins). */
export function recordObservedHostShell(shell: string): void {
	if (typeof shell !== 'string' || shell.trim() === '') return;
	observedHostShell = shell;
}

/** The host-reported shell for the `shell` tool, when one has been observed. */
export function getObservedHostShell(): string | undefined {
	return observedHostShell;
}

/** Test seam: clear the observed host shell. */
export function resetObservedHostShell(): void {
	observedHostShell = undefined;
}

/**
 * Classify a host-reported shell path into the grammar family the write
 * detectors should apply for the `shell` tool: a PowerShell-family binary
 * (powershell/pwsh) or cmd.exe keeps a Windows grammar eligible; ANY other
 * basename (bash, zsh, sh, dash, ksh, fish, nu, …) is a POSIX-family
 * executor. Separator-independent basename: the host may report a Windows
 * path while the gate evaluates under an injected POSIX platform (and vice
 * versa), so `path.basename` — which is separator-bound to the host — is
 * never used here (mirrors `basenameAnySep` in shell-write-detect.ts).
 */
export function hostShellGrammarFamily(hostShell: string): 'windows' | 'posix' {
	const leaf = hostShell.split(/[\\/]/).filter(Boolean).pop() ?? hostShell;
	const name = leaf.replace(/\.exe$/i, '').toLowerCase();
	return name === 'powershell' || name === 'pwsh' || name === 'cmd'
		? 'windows'
		: 'posix';
}
