/**
 * cmd.exe rd/rmdir/del recursion-switch grammar (leaf module — no local
 * imports: both the destructive guard (guardrails/destructive-command.ts)
 * and the shell-write detector (shell-write-detect.ts) consume it, and
 * destructive-command already imports from shell-write-detect, so hosting
 * the grammar in either would create a cycle).
 *
 * Modeled from executed cmd.exe ground truth (PR #3499 review round):
 * - cmd scans each UNQUOTED argument for the FIRST `/` — everything from it
 *   to the end of the token is switch text; the text before it is the path.
 *   `rd zzz/s` therefore deletes `zzz` recursively (`rd zzz /s`), and so do
 *   `rd ../s` and `rd ./s`.
 * - A fully double-quoted token is a path; cmd does not scan it for
 *   switches (`rd "/s" x` does not recurse — `"/s"` is a path).
 * - Single quotes are NOT quotes for cmd (`rd 'zzz/s'` splits at the slash).
 * - `^/` caret escapes decode to `/` (normalized by dcNormalizeCommand).
 */

/**
 * Whether slash-separated switch TEXT (the characters after the first
 * unquoted `/` of a cmd.exe argument) parses as a switch cluster: every
 * slash-separated segment is 1–2 ASCII letters — `s`, `S`, `q`, `s/q`,
 * `sq`, `qs`. Multi-letter segments never qualify: `share` and
 * `src/old` are not switch names (real cmd.exe rejects `rd a/share/b` with
 * "Parameter format not correct" — nothing is deletable, so the argument is
 * a plain path operand, and on POSIX it stays an ordinary nested path).
 */
export function dcIsSwitchClusterText(text: string): boolean {
	if (text.length === 0) return false;
	const segments = text.split('/');
	return (
		segments.length > 0 && segments.every((seg) => /^[A-Za-z]{1,2}$/.test(seg))
	);
}

/**
 * Split a cmd.exe argument string into whitespace-delimited tokens, treating
 * ONLY double quotes as quoting. A quoted span may sit mid-token
 * (`del /s"file.txt"` is one token: switch `s` glued to the quoted operand
 * `file.txt`).
 */
function dcScanCmdTokens(args: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let inQuote = false;
	for (const ch of args) {
		if (ch === '"') {
			inQuote = !inQuote;
			current += ch;
			continue;
		}
		// cmd.exe splits internal-command arguments on unquoted , ; = as
		// well as whitespace before the switch scan (executed ground truth:
		// rd /s,/q,<path> removes the tree), so those characters are
		// argument boundaries here too. Unquoted cmd delimiters ( ) < > |
		// & are boundaries as well (#3512 review F-1): a delimiter glued to
		// the switch (`(rd x /s)`, `rd x /s>nul`, block-wrapped
		// `if exist x (rd x /S)`) still reaches the switch at execution, and
		// splitting keeps those forms destructive instead of letting `/s)`
		// fail cluster validation. Quoted spans stay protected (a quoted
		// `"/s"` remains a path), and over-splitting an unquoted path only
		// widens the candidate-switch set — the fail-closed direction.
		if (!inQuote && /[\s,;=()<>|&]/.test(ch)) {
			if (current.length > 0) tokens.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

/**
 * Whether any cmd.exe argument token of `args` carries a switch cluster
 * containing at least one of `letters` (case-insensitive). The scan is the
 * executed-ground-truth cmd.exe grammar: quote-aware first-unquoted-`/` per
 * token, switch text up to an optional following quote, and cluster
 * validation — `rd "/s" x` (fully quoted token) and `rmdir src/share/x`
 * (invalid cluster `share/x`) never fire, `rd zzz/s` (glued to the path
 * prefix) does. Unquoted cmd delimiters `( ) < > | &` are argument
 * boundaries (#3512 review F-1): a delimiter glued to the switch
 * (`(rd x /s)`, `rd x /s>nul`) still reaches the switch at execution.
 * Shared by the destructive guard's recursion pass (`letters: 's'`, #3499)
 * and the shared command classifier's windows-recursive-delete rule
 * (`letters: 'sqf'`, #3505) so the two surfaces cannot drift apart.
 */
export function dcHasCmdDeleteSwitch(args: string, letters: string): boolean {
	const wanted = letters.toLowerCase();
	return dcScanCmdTokens(args).some((token) => {
		let inQuote = false;
		let slashIdx = -1;
		for (let i = 0; i < token.length; i += 1) {
			if (token[i] === '"') {
				inQuote = !inQuote;
				continue;
			}
			if (!inQuote && token[i] === '/') {
				slashIdx = i;
				break;
			}
		}
		if (slashIdx < 0) return false;
		const afterSlash = token.slice(slashIdx + 1);
		const quoteIdx = afterSlash.indexOf('"');
		const switchText = (
			quoteIdx >= 0 ? afterSlash.slice(0, quoteIdx) : afterSlash
		).replace(/["']/g, '');
		if (!dcIsSwitchClusterText(switchText)) return false;
		const cluster = switchText.replace(/\//g, '').toLowerCase();
		for (const letter of wanted) {
			if (cluster.includes(letter)) return true;
		}
		return false;
	});
}

/**
 * Parse the argument text of a cmd.exe rd/rmdir/del command for the
 * recursion switch and its deletion targets.
 *
 * - Leading `/` with valid switch letters: pure switch token; a quoted span
 *   glued after the letters (`/s"file.txt"`) is the deletion target.
 * - `/` at index > 0 with valid switch letters containing `s`: the command
 *   recurses over the path prefix (`rd zzz/s` → target `zzz`).
 * - Invalid switch text (`a/share/b` → cmd errors "Parameter format not
 *   correct"): nothing is deletable; the token is a plain path operand and
 *   never fires — on POSIX executors it stays an ordinary nested path.
 * - A fully double-quoted token is a path operand, never a switch.
 * - Unquoted cmd delimiter boundaries (see dcHasCmdDeleteSwitch): a
 *   delimiter glued to the switch never hides it (`(rd x /s)` fires).
 *
 * Returns `fires` (the recursion switch is present) and the deletion
 * targets to evaluate when it fires.
 */
export function dcParseWindowsRecursiveDelete(args: string): {
	fires: boolean;
	targets: string[];
} {
	const tokens = dcScanCmdTokens(args);
	// Pass 1: does any token carry a valid recursion switch?
	const fires = dcHasCmdDeleteSwitch(args, 's');
	const targets: string[] = [];
	for (const token of tokens) {
		// The quote-aware slash scan itself classifies a FULLY quoted token
		// as a path operand (no unquoted `/` inside the quotes). A
		// PARTIALLY quoted token ("a b"/s — quoted path glued to a
		// trailing switch) must fall through to the scan: its unquoted
		// slash after the closing quote is switch text.
		let inQuote = false;
		let slashIdx = -1;
		for (let i = 0; i < token.length; i += 1) {
			if (token[i] === '"') {
				inQuote = !inQuote;
				continue;
			}
			if (!inQuote && token[i] === '/') {
				slashIdx = i;
				break;
			}
		}
		if (slashIdx < 0) {
			// A fully quoted token is a path operand (dequoted).
			targets.push(token.replace(/["']/g, ''));
			continue;
		}
		const afterSlash = token.slice(slashIdx + 1);
		const quoteIdx = afterSlash.indexOf('"');
		// Single quotes are literal cmd characters, not switch text: strip
		// them alongside double quotes before cluster validation (executed
		// cmd.exe: rd 'zzz/s' prompts to recurse over zzz).
		const switchText = (
			quoteIdx >= 0 ? afterSlash.slice(0, quoteIdx) : afterSlash
		).replace(/["']/g, '');
		const prefix = token.slice(0, slashIdx).replace(/["']/g, '').trim();
		if (!dcIsSwitchClusterText(switchText)) {
			// Invalid switch text: cmd.exe itself rejects the argument
			// ('Parameter format not correct'), so nothing is deletable
			// through THIS token — but when a recursion switch fired from
			// another token (rmdir /s plugins/oxlint-plugin-effect), the
			// defense-in-depth posture treats the operand's path prefix as
			// the potential deletion root instead of skipping it.
			if (fires && prefix.length > 0) targets.push(prefix);
			continue;
		}
		if (!switchText.replace(/\//g, '').toLowerCase().includes('s')) {
			// Valid non-recursion cluster (../q): cmd deletes nothing
			// recursively through THIS token, but when a recursion switch
			// fired from another token the operand's path prefix is a
			// potential deletion root — harvest it, so rd dist/s ../q
			// verdict-matches rd dist/s ../s.
			if (fires && prefix.length > 0) targets.push(prefix);
			continue;
		}
		// Deletion target carried by this token: the path prefix before the
		// switch (`rd zzz/s` → `zzz`) and/or the quoted span after the
		// switch letters (`del /s"file.txt"` → `file.txt`).
		if (prefix.length > 0) targets.push(prefix);
		if (quoteIdx >= 0) {
			const rest = afterSlash.slice(quoteIdx).replace(/["']/g, '').trim();
			if (rest.length > 0) targets.push(rest);
		}
	}
	return { fires, targets };
}
