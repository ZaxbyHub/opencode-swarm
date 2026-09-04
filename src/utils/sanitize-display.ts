/**
 * Strip ASCII control characters (C0 range + DEL) from a string that is
 * interpolated into a single-line user-facing message (#2493 review F-11).
 * A char-code loop instead of a control-character regex: lint/suspicious/
 * noControlCharactersInRegex rejects `[\u0000-\u001f]`-style patterns.
 */
export function stripControlCharacters(input: string): string {
	let out = '';
	for (const ch of input) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) continue;
		out += ch;
	}
	return out;
}
