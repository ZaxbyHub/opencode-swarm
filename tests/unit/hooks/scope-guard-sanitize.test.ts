import { describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/hooks/scope-guard';

const { sanitizePath } = _internals;

// Helper to create a string with a given char code
function charStr(code: number): string {
	return String.fromCharCode(code);
}

describe('sanitizePath — C0 control character hardening', () => {
	// All 32 C0 controls (0x00–0x1F) plus DEL (0x7F)
	const C0_CONTROLS: Array<{ name: string; code: number }> = [
		{ name: 'NUL', code: 0x00 },
		{ name: 'SOH', code: 0x01 },
		{ name: 'STX', code: 0x02 },
		{ name: 'ETX', code: 0x03 },
		{ name: 'EOT', code: 0x04 },
		{ name: 'ENQ', code: 0x05 },
		{ name: 'ACK', code: 0x06 },
		{ name: 'BEL', code: 0x07 },
		{ name: 'BS', code: 0x08 },
		{ name: 'TAB', code: 0x09 },
		{ name: 'LF', code: 0x0a },
		{ name: 'VT', code: 0x0b },
		{ name: 'FF', code: 0x0c },
		{ name: 'CR', code: 0x0d },
		{ name: 'SO', code: 0x0e },
		{ name: 'SI', code: 0x0f },
		{ name: 'DLE', code: 0x10 },
		{ name: 'DC1', code: 0x11 },
		{ name: 'DC2', code: 0x12 },
		{ name: 'DC3', code: 0x13 },
		{ name: 'DC4', code: 0x14 },
		{ name: 'NAK', code: 0x15 },
		{ name: 'SYN', code: 0x16 },
		{ name: 'ETB', code: 0x17 },
		{ name: 'CAN', code: 0x18 },
		{ name: 'EM', code: 0x19 },
		{ name: 'SUB', code: 0x1a },
		{ name: 'ESC', code: 0x1b },
		{ name: 'FS', code: 0x1c },
		{ name: 'GS', code: 0x1d },
		{ name: 'RS', code: 0x1e },
		{ name: 'US', code: 0x1f },
	];

	test.each(
		C0_CONTROLS,
	)('C0 control $name (0x${code.toString(16).padStart(2, "0")}) → replaced with _', ({
		code,
	}) => {
		const input = `prefix${charStr(code)}suffix`;
		const expected = 'prefix_suffix';
		expect(sanitizePath(input)).toBe(expected);
	});

	test('DEL (0x7F) → replaced with _', () => {
		const input = `prefix${charStr(0x7f)}suffix`;
		expect(sanitizePath(input)).toBe('prefix_suffix');
	});

	test('Null byte (0x00) embedded in path → replaced with _', () => {
		// NUL specifically called out in the original hardening spec
		const input = `/home/user/file${charStr(0x00)}.txt`;
		expect(sanitizePath(input)).toBe('/home/user/file_.txt');
	});

	test('LF (0x0A) → replaced with _', () => {
		const input = `/home/user/${charStr(0x0a)}file.txt`;
		expect(sanitizePath(input)).toBe('/home/user/_file.txt');
	});

	test('CR (0x0D) → replaced with _', () => {
		const input = `/home/user/${charStr(0x0d)}file.txt`;
		expect(sanitizePath(input)).toBe('/home/user/_file.txt');
	});

	test('BS (0x08) backspace → replaced with _', () => {
		const input = `/home/${charStr(0x08)}user/file.txt`;
		expect(sanitizePath(input)).toBe('/home/_user/file.txt');
	});

	test('TAB (0x09) → replaced with _', () => {
		const input = `/home\tuser/file.txt`;
		expect(sanitizePath(input)).toBe('/home_user/file.txt');
	});

	test('VT (0x0B) vertical tab → replaced with _', () => {
		const input = `/home/${charStr(0x0b)}user/file.txt`;
		expect(sanitizePath(input)).toBe('/home/_user/file.txt');
	});

	test('FF (0x0C) form feed → replaced with _', () => {
		const input = `/home/${charStr(0x0c)}user/file.txt`;
		expect(sanitizePath(input)).toBe('/home/_user/file.txt');
	});

	test('ESC (0x1B) → replaced with _', () => {
		// ESC is within C0 range but explicitly checked per spec
		const input = `/home/${charStr(0x1b)}user/file.txt`;
		expect(sanitizePath(input)).toBe('/home/_user/file.txt');
	});

	test('Mixed control chars in one path — all replaced', () => {
		// Mix of NUL, LF, CR, DEL
		const input = `${charStr(0x00)}${charStr(0x0a)}${charStr(0x0d)}${charStr(0x7f)}`;
		expect(sanitizePath(input)).toBe('____');
	});

	test('Normal path with no control chars → unchanged', () => {
		const input = '/home/user/project/src/index.ts';
		expect(sanitizePath(input)).toBe('/home/user/project/src/index.ts');
	});

	test('Path with only safe ASCII printable chars → unchanged', () => {
		const input = 'src/hooks/scope-guard.ts';
		expect(sanitizePath(input)).toBe('src/hooks/scope-guard.ts');
	});

	test('Unicode characters outside control range → preserved', () => {
		const input = '/home/用户/项目/文件.ts';
		expect(sanitizePath(input)).toBe('/home/用户/项目/文件.ts');
	});

	test('ANSI CSI sequence stripped after control char removal', () => {
		// ESC [ 31 m  (red color code)
		const input = `/home/${charStr(0x1b)}[31muser/file.txt`;
		// ESC → _, then ANSI CSI stripped
		expect(sanitizePath(input)).toBe('/home/_user/file.txt');
	});

	test('Multiple ANSI CSI sequences stripped', () => {
		// ESC is replaced with _; CSI sequences ([1;2;3m, [4;5m) are stripped from result
		const input = `/home/${charStr(0x1b)}[1;2;3muser${charStr(0x1b)}[4;5mfile.txt`;
		// ESC→_, then CSI codes stripped: /home/ _ [1;2;3m user _ [4;5m file.txt → /home/_user_file.txt
		expect(sanitizePath(input)).toBe('/home/_user_file.txt');
	});

	test('Leading control characters stripped', () => {
		const input = `${charStr(0x00)}/home/user/file.txt`;
		expect(sanitizePath(input)).toBe('_/home/user/file.txt');
	});

	test('Trailing control characters stripped', () => {
		const input = `/home/user/file.txt${charStr(0x1f)}`;
		expect(sanitizePath(input)).toBe('/home/user/file.txt_');
	});

	test('All control characters replaced in sequence — no survivors', () => {
		// Every character in the input is a control char
		const allControls = C0_CONTROLS.map((c) => charStr(c.code)).join('');
		const delOnly = charStr(0x7f);
		const input = allControls + delOnly;
		const result = sanitizePath(input);
		// 32 C0 + 1 DEL = 33 underscores
		expect(result).toBe('_'.repeat(33));
	});
});
