/**
 * PR #3948 (and its swarm-pr-review findings F-1..F-5) — pins the pure helpers
 * behind the timeout diagnostic dump in scripts/repro-2910-v2-host.mjs:
 * `formatCaptureTail` (per-stream tail, bounded, control-stripped,
 * secret-scrubbed, fixed line prefix) and `redact` (home-path user name).
 *
 * The module import is INERT (main() is guarded by invokedAsMain()), so these
 * pure-function tests neither install nor run the pinned host.
 */

import { describe, expect, test } from 'bun:test';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	formatCaptureTail,
	redact,
	redactLogLine,
} from '../../../scripts/repro-2910-v2-host.mjs';

const PREFIX = '[repro-2910-v2-host]';

function mkLines(label: string, n: number): string {
	return Array.from({ length: n }, (_, i) => `${label}-${i + 1}`).join('\n');
}

describe('formatCaptureTail', () => {
	test('tails each stream separately and bounds the line count', () => {
		const lines: string[] = formatCaptureTail({
			out: mkLines('o', 100),
			err: mkLines('e', 100),
		});
		const o = lines.filter((l) => l.startsWith(`${PREFIX}   stdout: `));
		const e = lines.filter((l) => l.startsWith(`${PREFIX}   stderr: `));
		expect(o.length).toBe(30);
		expect(e.length).toBe(30);
		// the LAST lines of each stream are shown, not the first
		expect(o.at(-1)).toContain('o-100');
		expect(e.at(-1)).toContain('e-100');
		expect(o[0]).toContain('o-71');
		// stdout is never crowded out by a chatty stderr
		expect(lines.join('\n')).toContain('o-100');
		// headers disclose that the streams are not interleaved
		expect(lines.join('\n')).toContain('not interleaved');
	});

	test('prefers the preserved stream tail and discloses truncation', () => {
		const lines: string[] = formatCaptureTail({
			out: 'HEAD-ONLY-LINE',
			err: '',
			outTail: 'true-end-1\ntrue-end-2',
			errTail: '',
			outTruncated: true,
			errTruncated: false,
		});
		const text = lines.join('\n');
		expect(text).toContain('true-end-2');
		expect(text).not.toContain('HEAD-ONLY-LINE');
		expect(text).toContain('capture exceeded');
	});

	test('a lone CR is a line break and ::commands never start a line', () => {
		const lines: string[] = formatCaptureTail({
			out: 'progress\r::error::spoofed\r\nnext',
			err: '',
		});
		for (const l of lines) {
			expect(l.startsWith(PREFIX)).toBe(true);
			expect(l).not.toContain('\r');
		}
		// the spoof attempt became its own, prefixed, line
		expect(lines).toContain(`${PREFIX}   stdout: ::error::spoofed`);
	});

	test('strips ANSI and C0 control characters', () => {
		const lines: string[] = formatCaptureTail({
			out: '\u001b[31mred\u001b[0m\u0007bell\u0000nul',
			err: '',
		});
		expect(lines).toContain(`${PREFIX}   stdout: redbellnul`);
	});

	test('scrubs token shapes and caps line length', () => {
		const lines: string[] = formatCaptureTail({
			out: [
				'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
				'Authorization: Bearer abcdefghijklmnop1234',
				'OPENAI sk-abcdefghijklmnopqrstuvwx',
				'x'.repeat(1000),
			].join('\n'),
			err: '',
		});
		const text = lines.join('\n');
		expect(text).not.toContain('ghp_abcdef');
		expect(text).not.toContain('abcdefghijklmnop1234');
		expect(text).not.toContain('sk-abcdef');
		expect(text).toContain('<redacted>');
		const long = lines.find((l) => l.includes('xxxxxxxxxx')) as string;
		expect(long.length).toBeLessThanOrEqual(
			`${PREFIX}   stdout: `.length + 300,
		);
	});

	test('empty captures yield only headers', () => {
		const lines: string[] = formatCaptureTail({ out: '', err: '' });
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain('last 0 of 0');
	});

	test('scrubs github_pat_, npm_, key=value and uppercase forms', () => {
		const text = formatCaptureTail({
			out: [
				`github_pat_${'A'.repeat(30)}`,
				`npm_${'a'.repeat(30)}`,
				'password=hunter2hunter2',
				'api_key: "abcdef123456"',
				'PASSWORD=UPPERSECRET99',
				'BEARER abcdefghijkl',
			].join('\n'),
			err: '',
		}).join('\n');
		expect(text).not.toContain('github_pat_AAAA');
		expect(text).not.toContain('npm_aaaa');
		expect(text).not.toMatch(/hunter2hunter2|abcdef123456|UPPERSECRET99/);
		expect(text).not.toContain('abcdefghijkl');
	});

	test('redacts home paths inside the tail pipeline', () => {
		const text = formatCaptureTail({
			out: 'C:\\Users\\bob\\x',
			err: '',
		}).join('\n');
		expect(text).not.toContain('bob');
		expect(text).toContain('<user>');
	});

	test('stderr uses its own preserved tail and truncation marker', () => {
		const lines: string[] = formatCaptureTail({
			out: '',
			err: 'HEAD',
			errTail: 'true-end',
			errTruncated: true,
		});
		const text = lines.join('\n');
		expect(text).toContain('stderr: true-end');
		expect(text).not.toContain('HEAD');
		const header = lines.find((l) =>
			l.includes('captured stderr tail'),
		) as string;
		expect(header).toContain('of 1+ non-empty');
		expect(header).toContain('capture exceeded');
	});

	test('header reports the pre-slice total', () => {
		const lines: string[] = formatCaptureTail({
			out: mkLines('o', 100),
			err: '',
		});
		const header = lines.find((l) =>
			l.includes('captured stdout tail'),
		) as string;
		expect(header).toContain('last 30 of 100');
	});

	test('a token straddling the 300-char cut is scrubbed before slicing', () => {
		const text = formatCaptureTail({
			out: `${'x'.repeat(290)} ghp_${'a'.repeat(30)}`,
			err: '',
		}).join('\n');
		expect(text).not.toContain('ghp_aaaa');
	});

	test('keeps tab, strips DEL and private-parameter ANSI', () => {
		const lines: string[] = formatCaptureTail({
			out: 'a\tb\x7fc\x1b[?25lz',
			err: '',
		});
		expect(lines).toContain(`${PREFIX}   stdout: a\tbcz`);
	});
});

describe('redact', () => {
	test('masks the user segment in the common forms', () => {
		expect(redact('C:\\Users\\bob\\x')).toBe('C:\\Users\\<user>\\x');
		expect(redact('/Users/alice/x')).toBe('/Users/<user>/x');
		expect(redact('C:\\\\Users\\\\bob\\\\x')).toBe(
			'C:\\\\Users\\\\<user>\\\\x',
		);
	});

	test('stays verdict-neutral: key=value evidence tokens survive', () => {
		// redact() runs over the whole capture classifyHostRun scans, so it must
		// never absorb or reshape evidence tokens.
		const line =
			'cwd=/Users/runner event.type=agent.updated dir=/tmp/x home=/home/runner/y';
		expect(redact(line)).toBe(
			'cwd=/Users/<user> event.type=agent.updated dir=/tmp/x home=/home/runner/y',
		);
	});

	test('is idempotent', () => {
		const once = redact('C:\\Users\\bob\\x /Users/alice');
		expect(redact(once)).toBe(once);
	});
});

describe('redactLogLine (print-time only)', () => {
	test('masks a space-containing name followed by a separator or quote', () => {
		expect(redactLogLine('C:\\Users\\John Smith\\AppData')).toBe(
			'C:\\Users\\<user>\\AppData',
		);
		expect(redactLogLine('"C:\\Users\\John Smith"')).toBe(
			'"C:\\Users\\<user>"',
		);
	});

	test('masks the home segment in any case and /home/<user>', () => {
		expect(redactLogLine('c:\\users\\carol\\x')).toBe('c:\\users\\<user>\\x');
		expect(redactLogLine('/home/runner/work')).toBe('/home/<user>/work');
	});

	test('does not swallow free text or key=value tokens', () => {
		expect(redactLogLine('open /Users/alice failed with code 1')).toBe(
			'open /Users/<user> failed with code 1',
		);
		expect(
			redactLogLine('cwd=/Users/runner event.type=agent.updated dir=/tmp/x'),
		).toBe('cwd=/Users/<user> event.type=agent.updated dir=/tmp/x');
		expect(
			redactLogLine('service=x home=/home/runner data=/home/runner/.local'),
		).toBe('service=x home=/home/<user> data=/home/<user>/.local');
	});

	test('documented residual: a spaced name with no following separator keeps its later words', () => {
		// Deliberate trade-off: taking a multi-word name with no separator or
		// quote after it would swallow free text. CI runner account names
		// (runner / runneradmin) contain no spaces, so this is accepted.
		expect(redactLogLine('/Users/John Smith went home')).toBe(
			'/Users/<user> Smith went home',
		);
	});

	test('is idempotent', () => {
		const once = redactLogLine('C:\\Users\\John Smith\\x /home/runner/y');
		expect(redactLogLine(once)).toBe(once);
	});

	test('formatCaptureTail applies it to tail lines', () => {
		const text = formatCaptureTail({
			out: 'C:\\Users\\John Smith\\x',
			err: '',
		}).join('\n');
		expect(text).not.toContain('Smith');
	});
});

describe('windowed tails', () => {
	test('truncated + windowed (the run()-shaped combination) drops the partial line', () => {
		const lines: string[] = formatCaptureTail({
			out: '',
			err: '',
			outTail: 'cut-mid-token\nkeep-1\nkeep-2',
			outTruncated: true,
			outWindowed: true,
		});
		const text = lines.join('\n');
		expect(text).not.toContain('cut-mid-token');
		expect(text).toContain('stdout: keep-2');
		const header = lines.find((l) =>
			l.includes('captured stdout tail'),
		) as string;
		expect(header).toContain('capture exceeded');
		expect(header).toContain('of 2+ non-empty');
	});

	test('a window starting on a bare LF keeps the following full line', () => {
		const text = formatCaptureTail({
			out: '',
			err: '',
			outTail: '\nfull-line\nlast',
			outWindowed: true,
		}).join('\n');
		expect(text).toContain('stdout: full-line');
	});

	test('a window with no line break yields no lines', () => {
		const lines: string[] = formatCaptureTail({
			out: '',
			err: '',
			outTail: 'no-newline-here',
			outWindowed: true,
		});
		expect(lines.join('\n')).not.toContain('no-newline-here');
		expect(lines[0]).toContain('of 0+');
	});

	test('strips Unicode C1 controls and line separators', () => {
		const lines: string[] = formatCaptureTail({
			out: 'a\u009bb c',
			err: '',
		});
		expect(lines).toContain(`${PREFIX}   stdout: abc`);
	});

	test('drops the possibly-partial first line and marks the header', () => {
		const lines: string[] = formatCaptureTail({
			out: '',
			err: '',
			outTail: 'ZZZZZZZZZZZZZZZZZZZZ\nline-2\nline-3',
			outWindowed: true,
		});
		const text = lines.join('\n');
		expect(text).not.toContain('ZZZZZZZZ');
		expect(text).toContain('stdout: line-3');
		const header = lines.find((l) =>
			l.includes('captured stdout tail'),
		) as string;
		expect(header).toContain('of 2+ non-empty');
		expect(header).toContain('counted within the last');
	});
});
