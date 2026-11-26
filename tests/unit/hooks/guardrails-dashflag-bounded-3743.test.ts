/**
 * #3743 (AC7) / #3882: the two dash-flag redaction arms capture the flag name
 * and test the sensitive keyword in the replacer (not the pattern), so a
 * keyword buried in a long flag name is still redacted while the scan stays
 * linear.
 *
 * #3882 regression: the AC7 `{0,64}` bound around the keyword was itself a
 * redaction gap — a generic secret behind a flag name longer than 64 chars
 * escaped both arms and reached the shell-audit log. The arms now use a
 * `{0,200}` name capture (comfortably past any real CLI flag) with the keyword
 * test in the replacer, and the `(?<!-)` anchor: it refuses a `--` inside a
 * dash run (the AC7 quadratic source) while still matching an embedded flag
 * after a letter (`foo--token=x`). The `{0,200}` bound is what keeps the
 * mixed `a--a--a--` no-delimiter case linear (an unbounded `[a-zA-Z-]+` capture
 * re-scans the whole trailing run at every `--` start — a DoS the first #3882
 * attempt reintroduced and this caps).
 *
 * #3893 (AC13 dash legs + AC14, F11/F12): the keyword pre-check re-tests a
 * fill-condensed copy when the raw text misses, and the name reader treats
 * zero-width fill bytes (Cf/DI/Mn/U+2800) as transparent to the keyword
 * classification (emitted bytes unchanged); space-form values that open with
 * a quote are consumed through the MATCHING close quote so quoted multi-word
 * secrets redact whole — mirrored in lockstep at the display site
 * (sanitizeFailureEvidenceDisplay), which previously left dash flags wholly
 * raw. RED at base for every #3893 leg below, GREEN after the fix.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

describe('#3743/#3882 dash-flag redaction: full-name coverage, linear scan', () => {
	test('space-separated dash flag value is redacted', () => {
		expect(redactShellCommand('deploy --api-key live_9f8e7d6c5b4a tool')).toBe(
			'deploy --api-key [REDACTED] tool',
		);
	});

	test('= joined dash flag value is redacted', () => {
		expect(
			redactShellCommand(`run --token=ghp_${'0123456789'.repeat(4)}`),
		).toBe('run --token=[REDACTED]');
	});

	test('(?!--) guard: the next flag is not swallowed as a value', () => {
		const out = redactShellCommand('run --token --other-flag value');
		expect(out).toBe('run --token --other-flag value');
	});

	test('#3882: a >64-char flag name around the keyword still redacts (= form)', () => {
		const prefix = 'a'.repeat(70);
		const out = redactShellCommand(`run --${prefix}token=supersecretvalue123`);
		expect(out).toBe(`run --${prefix}token=[REDACTED]`);
	});

	test('#3882: a >64-char flag name around the keyword still redacts (space form)', () => {
		const suffix = 'a'.repeat(70);
		const out = redactShellCommand(`run --token${suffix} supersecretvalue123`);
		expect(out).toBe(`run --token${suffix} [REDACTED]`);
	});

	test('#3882: hyphenated keyword in a long flag name still redacts', () => {
		const out = redactShellCommand(
			`curl --x-abcdef-abcdef-api-key=supersecretvalue123`,
		);
		expect(out).toBe(`curl --x-abcdef-abcdef-api-key=[REDACTED]`);
	});

	test('#3882: a ~100-char flag name around the keyword still redacts (well past the old 64 gap)', () => {
		const prefix = 'a'.repeat(90);
		const out = redactShellCommand(`run --${prefix}token=supersecretvalue123`);
		expect(out).toBe(`run --${prefix}token=[REDACTED]`);
	});

	test('#3882: a non-keyword long flag name is NOT redacted', () => {
		const prefix = 'a'.repeat(70);
		const out = redactShellCommand(`run --${prefix}verbose keepthis`);
		expect(out).toBe(`run --${prefix}verbose keepthis`);
	});

	test('#3882: an embedded flag after a letter is still redacted (= form, base coverage)', () => {
		// The (?<!-) anchor (not (?<![a-zA-Z-])) keeps this in scope: base's
		// unanchored arms matched `--token` inside `foo--token=x`.
		expect(redactShellCommand('run foo--token=GENERICSECRET123')).toBe(
			'run foo--token=[REDACTED]',
		);
	});

	test('#3882: an embedded flag after a letter is still redacted (space form, base coverage)', () => {
		expect(redactShellCommand('run x--password GENERICSECRET123')).toBe(
			'run x--password [REDACTED]',
		);
	});

	test('#3882: a sensitive flag whose value begins with another flag is redacted', () => {
		// The scanner never consumes a non-keyword flag's value, so an inner
		// `--x-api-key` at the START of a value is still found and redacted.
		expect(redactShellCommand('run --cfg=--x-api-key=GENERICSECRET123')).toBe(
			'run --cfg=--x-api-key=[REDACTED]',
		);
		expect(redactShellCommand('--a=--token=GENERICSECRET123')).toBe(
			'--a=--token=[REDACTED]',
		);
	});

	test('#3882: a sensitive flag embedded in a non-keyword flag value is still redacted', () => {
		// The scanner never consumes a non-keyword flag's value, so an embedded
		// flag — after a value prefix, or nested arbitrarily deep — is still found
		// and redacted (a single-pass global replace would consume and skip it).
		expect(redactShellCommand('--cfg=prefix--x-api-key=GENERICSECRET123')).toBe(
			'--cfg=prefix--x-api-key=[REDACTED]',
		);
		expect(
			redactShellCommand('--nested=--deep=--private-key=GENERICSECRET123'),
		).toBe('--nested=--deep=--private-key=[REDACTED]');
		expect(
			redactShellCommand(
				'--a=x--b=x--c=x--d=x--e=x--private-key=GENERICSECRET123',
			),
		).toBe('--a=x--b=x--c=x--d=x--e=x--private-key=[REDACTED]');
	});

	test('#3882: a multi-whitespace space-form value is redacted', () => {
		// The space-form value scan must consume the WHOLE whitespace run, not one
		// char, or `--token  SECRET` (two spaces) takes the empty-value branch and
		// leaks.
		expect(redactShellCommand('--token  GENERICSECRET123')).toBe(
			'--token  [REDACTED]',
		);
		expect(redactShellCommand('--api-key\tGENERICSECRET123')).toBe(
			'--api-key\t[REDACTED]',
		);
		// A value that is itself the next flag is not redacted as --token's value.
		expect(redactShellCommand('--token --other')).toBe('--token --other');
	});

	test('#3882: underscore-separated keywords in the flag name are redacted', () => {
		// The flag-name reader must include `_` (not just `[a-zA-Z-]`), or
		// `--api_key` / `--private_key` / `--access_key` stop at the underscore,
		// fail the keyword test, and leak their space-form value.
		expect(redactShellCommand('cmd --api_key GENERICSECRET123')).toBe(
			'cmd --api_key [REDACTED]',
		);
		expect(redactShellCommand('cmd --private_key=GENERICSECRET123')).toBe(
			'cmd --private_key=[REDACTED]',
		);
		expect(redactShellCommand('cmd --access_key GENERICSECRET123')).toBe(
			'cmd --access_key [REDACTED]',
		);
		// Control: a non-keyword underscore name is left visible.
		expect(redactShellCommand('cmd --foo_bar GENERICSECRET123')).toBe(
			'cmd --foo_bar GENERICSECRET123',
		);
	});

	test('#3882: a keyword deep inside a long flag name is still redacted', () => {
		// The name is read to its delimiter with no length cap, so the keyword is
		// found regardless of how long the prefix is (the old {0,128} cap missed a
		// keyword past 128 chars).
		expect(
			redactShellCommand('--' + 'a'.repeat(250) + 'token=GENERICSECRET123'),
		).toBe('--' + 'a'.repeat(250) + 'token=[REDACTED]');
		expect(
			redactShellCommand(
				'--' + 'a'.repeat(250) + 'private-key GENERICSECRET123',
			),
		).toBe('--' + 'a'.repeat(250) + 'private-key [REDACTED]');
	});

	test('a 20,000-char dash run completes bounded-linear (< 1s wall clock)', () => {
		const cmd = 'git commit -m "' + '-'.repeat(20_000) + ' message"';
		const t0 = performance.now();
		const out = redactShellCommand(cmd);
		const ms = performance.now() - t0;
		expect(out.length).toBeGreaterThan(0);
		// Generous CI-safe budget (local measured ~2ms; the AC budget is 1s and
		// the base measured 4.5-7.4s).
		expect(ms).toBeLessThan(1000);
	});
});

const ZWSP = '\u200B'; // Cf + Default_Ignorable
const MN_MARK = '\u0301'; // combining acute — Mn, #3893-extended fill class
const BRAILLE_BLANK = '\u2800'; // U+2800, #3893-extended fill class

describe('#3893 AC13: fill-split dash-flag names still classify (keyword view only)', () => {
	// Previous behavior: the pre-check tested RAW text only, so a zero-width
	// byte inside the flag name (`--pass\u200Bword=…`) contained no contiguous
	// keyword and redactDashFlags returned the input untouched; the name
	// reader likewise terminated at the fill byte. Both now see through fill.
	for (const filler of [
		{ name: 'ZWSP (Cf+DI)', char: ZWSP },
		{ name: 'combining acute (Mn)', char: MN_MARK },
		{ name: 'braille blank (U+2800)', char: BRAILLE_BLANK },
	]) {
		test(`ZW fill in the flag name: equals-form value redacted (${filler.name})`, () => {
			const out = redactShellCommand(
				`tool --pass${filler.char}word=SECRETVALUE12345`,
			);
			expect(out).not.toContain('SECRETVALUE12345');
			// Emitted name bytes stay RAW (fill preserved, not deleted).
			expect(out).toContain(`--pass${filler.char}word=[REDACTED]`);
		});
		test(`ZW fill in the flag name: space-form value redacted (${filler.name})`, () => {
			const out = redactShellCommand(
				`tool --api${filler.char}-key SECRETVALUE12345`,
			);
			expect(out).not.toContain('SECRETVALUE12345');
			expect(out).toContain(`--api${filler.char}-key [REDACTED]`);
		});
	}
	test('fill split AFTER the keyword still redacts (name continues through fill)', () => {
		const out = redactShellCommand(`tool --password${ZWSP}=SECRETVALUE12345`);
		expect(out).not.toContain('SECRETVALUE12345');
		expect(out).toContain(`--password${ZWSP}=[REDACTED]`);
	});
	test('a NON-keyword flag with fill inside its name is emitted unchanged', () => {
		const input = `tool --verb${ZWSP}bose keepthisvalue`;
		expect(redactShellCommand(input)).toBe(input);
	});
	test('benign combining accent survives shell OUTPUT (matching-only proof)', () => {
		// #3893 AC11 shell-site leg: the extended fill class lives only in the
		// MATCHING view — decomposed `e\u0301` sequences must survive the output.
		const input = 'decompose cafe\u0301 note\u0301s freely';
		expect(redactShellCommand(input)).toBe(input);
	});
	test('idempotency battery: double-scan equals single-scan', () => {
		const battery = [
			'tool --pass\u200Bword=SECRETVALUE12345',
			'tool --password "first second"',
			"tool --password 'first second'",
			'tool --password "unterminated tail',
			`--token=sk-${'G'.repeat(25)}`,
			`sk-${'G'.repeat(25)}`,
			`TOKEN=sk-${'I'.repeat(25)}`,
			`--password=sk-${'J'.repeat(25)}`,
		];
		for (const b of battery) {
			const once = redactShellCommand(b);
			expect(redactShellCommand(once)).toBe(once);
		}
	});
	test('plain sentence passes through unchanged', () => {
		expect(redactShellCommand('echo hello world')).toBe('echo hello world');
	});
});

describe('#3893 AC14: quote-aware dash values at BOTH sites (F12)', () => {
	test('shell: quoted multi-word value redacts whole (no partial first-word green)', () => {
		const out = redactShellCommand('tool --password "first second"');
		expect(out).not.toContain('second');
		expect(out).not.toContain('first');
		expect(out).toBe('tool --password [REDACTED]');
	});
	test('display mirror: quoted multi-word value redacts whole', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'tool --password "first second"',
		);
		expect(out).not.toContain('second');
		expect(out).not.toContain('first');
		expect(out).toBe('tool --password [REDACTED]');
	});
	test('shell + display: single-quoted value redacts whole', () => {
		const input = "tool --password 'first second'";
		expect(redactShellCommand(input)).toBe('tool --password [REDACTED]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe(
			'tool --password [REDACTED]',
		);
	});
	test('unterminated quote runs to input end and redacts (both sites)', () => {
		const input = 'tool --password "first second';
		expect(redactShellCommand(input)).toBe('tool --password [REDACTED]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe(
			'tool --password [REDACTED]',
		);
	});
	test('mixed quote types respect their own closers (both sites)', () => {
		// A single quote inside a double-quoted value is NOT that value's
		// closer — the span runs to the matching double quote.
		const doubleOuter = 'tool --password "it\'s a multi word secret" tail';
		expect(redactShellCommand(doubleOuter)).toBe(
			'tool --password [REDACTED] tail',
		);
		expect(sanitizeFailureEvidenceDisplay(doubleOuter)).toBe(
			'tool --password [REDACTED] tail',
		);
		const singleOuter = 'tool --password \'say "hi" and more\' tail';
		expect(redactShellCommand(singleOuter)).toBe(
			'tool --password [REDACTED] tail',
		);
		expect(sanitizeFailureEvidenceDisplay(singleOuter)).toBe(
			'tool --password [REDACTED] tail',
		);
	});
	test('equals form is unchanged by the quote awareness (both sites)', () => {
		expect(redactShellCommand('tool --password=firstonly123')).toBe(
			'tool --password=[REDACTED]',
		);
		// Display: the pre-existing credential KV arm already redacted the
		// equals form (with its own `<redacted>` label) BEFORE #3893; the dash
		// mirror runs first and the KV arm relabels its value, so the final
		// display output is byte-identical to the pre-#3893 behavior.
		const display = sanitizeFailureEvidenceDisplay(
			'tool --password=firstonly123',
		);
		expect(display).not.toContain('firstonly123');
		expect(display).toBe('tool --password=<redacted>');
	});
	test('adjacent non-secret flag keeps its value while the password goes (both sites)', () => {
		const input = 'tool --cfg value --password secret1';
		expect(redactShellCommand(input)).toBe(
			'tool --cfg value --password [REDACTED]',
		);
		expect(sanitizeFailureEvidenceDisplay(input)).toBe(
			'tool --cfg value --password [REDACTED]',
		);
	});
	test('fill-split flag name with quoted value redacts at the display mirror too', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'tool --pass\u200Bword "first second"',
		);
		expect(out).not.toContain('first');
		expect(out).not.toContain('second');
		expect(out).toContain('[REDACTED]');
	});
});
