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
