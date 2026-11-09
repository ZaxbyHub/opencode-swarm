/**
 * #3617 review PRR-006/PRR-010 + post-push automation review: diagnostic
 * identity strings must not be able to break or visually reorder a log line.
 */
import { describe, expect, test } from 'bun:test';
import {
	MAX_DIAGNOSTIC_SCOPE_LENGTH,
	sanitizeDiagnosticScope,
} from '../../../src/utils/diagnostic-scope';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('sanitizeDiagnosticScope', () => {
	test('strips C0/C1 controls and DEL', () => {
		const input = `a${cp(0x0a)}b${cp(0x0d)}c${cp(0x1b)}d${cp(0x7f)}e${cp(0x85)}f`;
		expect(sanitizeDiagnosticScope(input)).toBe('abcdef');
	});

	test('strips the Unicode line and paragraph separators', () => {
		expect(sanitizeDiagnosticScope(`a${cp(0x2028)}b${cp(0x2029)}c`)).toBe(
			'abc',
		);
	});

	test('strips bidi overrides/isolates and zero-width format characters', () => {
		const formats = [
			0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff,
		];
		for (const code of formats) {
			expect([code, sanitizeDiagnosticScope(`x${cp(code)}y`)]).toEqual([
				code,
				'xy',
			]);
		}
	});

	test('keeps ordinary identity text, including non-ASCII letters and emoji', () => {
		const ok = `mega_local/coder Ünïcødé 名前 ${cp(0x1f600)}`;
		expect(sanitizeDiagnosticScope(ok)).toBe(ok);
	});

	test('bounds by code points and never splits a surrogate pair', () => {
		const emoji = cp(0x1f600);
		const out = sanitizeDiagnosticScope(emoji.repeat(250));
		expect(Array.from(out)).toHaveLength(MAX_DIAGNOSTIC_SCOPE_LENGTH);
		expect(out).toBe(emoji.repeat(MAX_DIAGNOSTIC_SCOPE_LENGTH));
	});
});
