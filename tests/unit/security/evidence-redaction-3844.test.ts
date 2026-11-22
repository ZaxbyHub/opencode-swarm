/**
 * #3844 shared evidence redactor: SUPERSET contract — everything the
 * persisted-store corpus (redactSecrets) covers, plus the display bare-value
 * families, URL credential stripping, and the shared JWS scanner. Benign
 * content preserves byte-identically. Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { redactSecrets } from '../../../src/memory/redaction';
import {
	_internals,
	clampRedactedText,
	redactEvidenceText,
} from '../../../src/security/evidence-redaction';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('#3844 redactEvidenceText superset contract', () => {
	const displayFamilies: Array<[string, string]> = [
		['anthropic', `sk-ant-${'a'.repeat(24)}`],
		['openrouter', `sk-or-${'o'.repeat(24)}`],
		['openai', `sk-${'p'.repeat(24)}`],
		['github', `ghp_${'g'.repeat(24)}`],
		['github-fine', `github_pat_${'h'.repeat(24)}`],
		['aws', 'AKIAABCDEFGHIJ012345'],
		['slack', `xoxb-${'s'.repeat(16)}`],
		['google', `AIza${'k'.repeat(31)}`],
		['groq', `gsk_${'q'.repeat(24)}`],
		['azure', `AccountKey=${'A'.repeat(28)}=`],
	];
	for (const [name, token] of displayFamilies) {
		test(`display family ${name} is redacted`, () => {
			const out = redactEvidenceText(`token ${token} in evidence`);
			expect(out.includes(token)).toBe(false);
			expect(out).toMatch(/\[REDACTED:[a-z0-9_-]+\]/);
		});
	}

	test('redactSecrets parity: everything the memory-site redactor covers stays covered', () => {
		// Representative fixtures from the 14-family memory corpus; each row
		// carries the SECRET substring that must be absent from BOTH outputs.
		const corpus = [
			[
				'bearer',
				'Authorization: Bearer abcd.apitest.signature1234',
				'abcd.apitest.signature1234',
			],
			['github', `token=ghp_${'x'.repeat(30)}`, `ghp_${'x'.repeat(30)}`],
			['aws-key', `aws_secret_access_key = ${'Y'.repeat(40)}`, 'Y'.repeat(40)],
			['slack', `SLACK_TOKEN=xoxp-${'z'.repeat(20)}`, `xoxp-${'z'.repeat(20)}`],
			[
				'jwt',
				`jwt=eyJ${'h'.repeat(16)}.eyJ${'d'.repeat(16)}.${'s'.repeat(16)}`,
				`eyJ${'h'.repeat(16)}.eyJ${'d'.repeat(16)}.${'s'.repeat(16)}`,
			],
			['gitlab', `glpat-${'g'.repeat(20)}`, `glpat-${'g'.repeat(20)}`],
			['stripe', `sk_live_${'s'.repeat(24)}`, `sk_live_${'s'.repeat(24)}`],
			['env', 'MY_SECRET_PASSWORD=supersecretvalue99', 'supersecretvalue99'],
		];
		for (const [name, fixture, secret] of corpus) {
			const baseline = redactSecrets(fixture);
			const superset = redactEvidenceText(fixture);
			// The superset must redact at least as much as the baseline: the
			// SECRET part is absent from both outputs.
			expect(superset.includes(secret)).toBe(false);
			expect(baseline.includes(secret)).toBe(false);
		}
	});

	test('private-key block body is redacted as a whole span', () => {
		const key = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(
			64,
		)}\n${'B'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
		const out = redactEvidenceText(`leaked ${key} in CI log`);
		// The key BODY never survives; do not pin whether markers stay.
		expect(out.includes('A'.repeat(64))).toBe(false);
		expect(out.includes('B'.repeat(64))).toBe(false);
	});

	test('five-part JWE: EVERY segment is redacted (no stranded tail — round-5 regression pin)', () => {
		const parts = [
			`eyJ${'a'.repeat(24)}`,
			`eyJ${'b'.repeat(24)}`,
			'c'.repeat(24),
			'd'.repeat(40),
			'e'.repeat(43),
		];
		const jwe = parts.join('.');
		const out = redactEvidenceText(`leaked ${jwe} in CI log`);
		for (const part of parts) {
			expect(out.includes(part)).toBe(false);
		}
	});

	test('overlap clip: a secret prefix before an eyJ run keeps its family label', () => {
		const jws = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const prefix = `sk-ant-${'q'.repeat(24)}`;
		const out = redactEvidenceText(`saw ${prefix}${jws} inline`);
		expect(out.includes(prefix)).toBe(false); // clipped prefix is redacted
		expect(out.includes(jws)).toBe(false);
	});

	test('overlap: a credential family arm that starts INSIDE a scanner span does not strand its tail', () => {
		// The azure AccountKey value is the third segment of an eyJ-shaped run.
		// The arm match starts inside the scanner span and extends past it, so
		// a policy that DROPS an overlapping arm match would leave the key
		// value in the clear.
		const keyValue = 'Zm9vYmFy+mF6c29tZS1rZXktdmFsdWUtMDAwMDA=';
		const out = redactEvidenceText(
			`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.AccountKey=${keyValue}`,
		);
		expect(out).not.toContain(keyValue);
		expect(out).not.toContain('Zm9vYmFy');
	});

	test('overlap: a short credential family prefix before a scanner span is redacted', () => {
		// The prefix is shorter than the old 12-character clip floor, so a
		// policy that dropped a clipped head would leave it visible.
		const prefix = 'sk-ant-abc_';
		const jws = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const out = redactEvidenceText(`saw ${prefix}${jws} inline`);
		expect(out).not.toContain(prefix);
		expect(out).not.toContain('sk-ant-abc');
	});

	test('overlap: two arms matching the same text emit ONE placeholder', () => {
		// The anthropic and openai arms both match this shape. Two overlapping
		// planned ranges used to be spliced in reverse order, eating the first
		// placeholder and leaving a malformed marker in the output.
		const jws = `eyJ${'g'.repeat(30)}.${'p'.repeat(12)}.${'s'.repeat(30)}`;
		const out = redactEvidenceText(`sk-ant-api03-abcd_${jws}`);
		expect(out).not.toContain('sk-ant-api03');
		expect(out).not.toContain('REDACTED:jwt]REDACTED:');
		expect(out).not.toContain(']REDACTED');
	});

	test('URL userinfo credentials are stripped, host preserved', () => {
		const out = redactEvidenceText(
			'clone https://user:hunter2@example.invalid/repo.git now',
		);
		expect(out).not.toContain('hunter2');
		expect(out).toContain('example.invalid/repo.git');
	});

	test('URL query credential is stripped', () => {
		const out = redactEvidenceText(
			'https://ci.example.invalid/log?access_token=abc123def456&x=1',
		);
		expect(out).not.toContain('abc123def456');
	});

	test('FB-006: the scheme class is GENERIC — a long legal scheme is covered too', () => {
		// RFC 3986 bounds the scheme's SYNTAX, not its length. A bounded
		// scheme class ({0,32}) silently left a longer scheme's userinfo
		// unredacted.
		const longScheme = `x${'y'.repeat(40)}`;
		const out = redactEvidenceText(
			`clone ${longScheme}://user:hunter2@example.invalid/repo.git now`,
		);
		expect(out).not.toContain('hunter2');
		expect(out).toContain('example.invalid/repo.git');
		// The short, everyday schemes stay covered (the control).
		for (const scheme of ['postgres', 'mongodb+srv', 'ssh', 'redis', 'https']) {
			const covered = redactEvidenceText(
				`${scheme}://user:hunter2@example.invalid/x`,
			);
			expect(covered).not.toContain('hunter2');
		}
	});

	test('FB-006: every URL boundary the \\b arm matched is still covered', () => {
		// The linear-scan change must not LOSE coverage. A scheme may be
		// preceded by an ellipsis, a dash, an underscore, a dot-run or
		// nothing at all — each of these was matched by the previous `\b`
		// arm and must stay matched.
		const cases = [
			'clone https://user:hunter2@example.invalid/repo.git now',
			'postgres://user:hunter2@example.invalid/db',
			'mongodb+srv://user:hunter2@example.invalid/db',
			'ssh://user:hunter2@example.invalid/repo',
			'redis://user:hunter2@example.invalid/0',
			'see ...https://user:hunter2@example.invalid/x',
			'see -https://user:hunter2@example.invalid/x',
			'a.b://user:hunter2@example.invalid/x',
			'_https://user:hunter2@example.invalid/x',
			'see https://user:hunter2@example.invalid/x',
			'https://user:hunter2@example.invalid/x',
			'(https://user:hunter2@example.invalid/x)',
			'url=https://user:hunter2@example.invalid/x',
			'see +https://user:hunter2@example.invalid/x',
			'see 1.https://user:hunter2@example.invalid/x',
			'git+https://user:hunter2@example.invalid/x',
		];
		for (const input of cases) {
			const out = redactEvidenceText(input);
			expect(out).not.toContain('hunter2');
			expect(out).toContain('example.invalid');
		}
	});

	test('FB-006: the URL arm scans LINEARLY on colon-free input', () => {
		// A leading \b is not enough: it matches at every word start, so a
		// colon-free run restarted the scheme scan at each word and rescanned
		// the remaining suffix — quadratic (measured: 64 KB of `a.` took
		// 4.2 s). The negative lookbehind rejects the interior positions in
		// O(1). This is the RUNTIME property, not a source shape: the
		// unbounded class took ~17 s on this input, the linear one ~20 ms.
		const colonFree = 'a.'.repeat(64 * 1024);
		const started = performance.now();
		redactEvidenceText(colonFree);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(1000);
	}, 30_000);

	test('FB-30: the AWS secret CONTEXT is redacted (the bare AKIA arm must not shadow it)', () => {
		// The 40-char AWS secret is only recognizable NEXT TO its AKIA id.
		// The evidence path's bare AKIA arm used to consume that anchor
		// first, so redactSecrets' context arm could never fire and the
		// secret survived raw (the memory path redacts the same input).
		const akia = 'AKIAIOSFODNN7EXAMPLE';
		const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
		const out = redactEvidenceText(`id ${akia} secret ${secret}`);
		expect(out).not.toContain(secret);
		expect(out).not.toContain(akia);
		// The interposed prose survives (unlike the memory site's whole-span
		// replacement, which deletes it).
		expect(out).toContain('secret');
	});

	test('FB-30: the AWS context arm never re-inserts a credential from the interposed prose', () => {
		// The arm's RANGE is the secret alone. When it covered the whole span
		// (id + prose + secret) and re-inserted the prose verbatim, every
		// credential inside that prose came back in the clear.
		const groq = `gsk_${'a'.repeat(30)}`;
		const out = redactEvidenceText(
			`AKIAABCDEFGHIJKLMNOP x ${groq} y ${'B'.repeat(40)}`,
		);
		expect(out).not.toContain(groq);
		expect(out).not.toContain('B'.repeat(40));
		expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
	});

	test('the clamp keeps a COMPLETE marker and drops only a half-written one', () => {
		// A COMPLETE marker at the HEAD of an over-long value is real
		// content: the clamp used to treat it as a fragment and emptied the
		// whole field, which then failed the schema's `.min(1)` floor and
		// dropped the finding.
		const withHead = clampRedactedText(
			`[REDACTED:anthropic]${'z '.repeat(200)}`,
			200,
		);
		expect(withHead.length).toBeGreaterThan(0);
		expect(withHead.startsWith('[REDACTED:anthropic]')).toBe(true);
		expect(withHead.length).toBeLessThanOrEqual(200);
		// A cut landing INSIDE a marker drops the fragment.
		const partial = clampRedactedText(`${'z '.repeat(99)}[REDACTED]`, 200);
		expect(partial).not.toContain('[');
		expect(partial.endsWith('[REDACTED')).toBe(false);
		// The training placeholder family behaves the same way.
		const angle = clampRedactedText(`${'z '.repeat(99)}<redacted:github>`, 200);
		expect(angle).not.toContain('<redacted');
	});

	test('handoff sidecar failure ABORTS creation (round-1 fix 1 pin): no artifact when the salt is corrupt', async () => {
		// The unit-level pin of the sidecar-first abort contract:
		// writeReplayIdentityFingerprint with a CORRUPT salt MUST throw (the
		// tool's handoff path catches exactly this to abort creation — the
		// round-1 catch-and-continue would have created the artifact).
		const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
		const dir = canonicalMkdtemp('sw-3844-hoff-');
		const saltPath = path.join(
			dir,
			'.swarm',
			'pr-review',
			'replay-identity.salt',
		);
		mkdirSync(path.dirname(saltPath), { recursive: true });
		writeFileSync(saltPath, 'corrupt-not-hex', 'utf8');
		const { replayFingerprint, writeReplayIdentityFingerprint } = await import(
			'../../../src/security/replay-identity'
		);
		let threw = false;
		try {
			// The handoff path computes the fingerprint FIRST; a corrupt salt
			// makes exactly this call throw, which the tool catches to ABORT.
			const fp = replayFingerprint(dir, 'summary mentioning nothing');
			writeReplayIdentityFingerprint(dir, 'run-x', 'handoff', fp);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(existsSync(path.join(dir, '.swarm', 'pr-review', 'run-x'))).toBe(
			false,
		);
	});

	test('per-project journal dedup (round-1 fix 4 pin): identical corrupt lines journal once per PROJECT', async () => {
		const { mkdirSync, writeFileSync } = await import('node:fs');
		const { readTrainingVault } = await import('../../../src/training/vault');
		const { trainingQuarantinePath } = await import(
			'../../../src/training/paths'
		);
		const dirA = canonicalMkdtemp('sw-3844-dedupA-');
		const dirB = canonicalMkdtemp('sw-3844-dedupB-');
		const corrupt = 'not json at all\n';
		for (const d of [dirA, dirB]) {
			const target = path.join(
				d,
				'.swarm',
				'training',
				'v1',
				'vault',
				'records.jsonl',
			);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, corrupt, 'utf8');
			readTrainingVault(d);
			readTrainingVault(d);
		}
		const journalA = readFileSync(trainingQuarantinePath(dirA), 'utf8');
		const journalB = readFileSync(trainingQuarantinePath(dirB), 'utf8');
		expect(journalA.trim().split('\n')).toHaveLength(1);
		expect(journalB.trim().split('\n')).toHaveLength(1); // B NOT suppressed by A
	});

	test('JWS scanner shapes beyond the bare arms', () => {
		const token = `eyJ${'H'.repeat(1100)}.e30.x`;
		const out = redactEvidenceText(`log had ${token} inside`);
		expect(out.includes('H'.repeat(1100))).toBe(false);
	});

	test('benign content round-trips byte-identical', () => {
		for (const benign of [
			'the quick brown fox jumped over the lazy dog',
			'assertEqual(result.status, 200)',
			'src/hooks/utils.ts:42 — the guard fires before the write',
			'AKIA says nothing without exactly-16 uppercase alnum',
		]) {
			expect(redactEvidenceText(benign)).toBe(benign);
		}
	});

	test('empty input passes the guard unchanged', () => {
		expect(redactEvidenceText('')).toBe('');
	});

	test('fail-closed: an internal failure withholds the text instead of returning it raw', () => {
		// The catch path is unreachable through the public API (a plain string
		// argument cannot make the context corpus throw), so the seam is used
		// to inject the failure. A variant that returned the RAW text on an
		// internal error would fail this assertion.
		const real = _internals.redactSecrets;
		_internals.redactSecrets = () => {
			throw new Error('injected context-corpus failure');
		};
		try {
			const out = redactEvidenceText(
				'credential material that must not survive',
			);
			expect(out).toBe('[REDACTED:evidence-redaction-failed]');
			expect(out).not.toContain('credential material');
		} finally {
			_internals.redactSecrets = real;
		}
	});
});

describe('#3844 the shared redactor is idempotent and covers the training families', () => {
	// The review evidence is redacted at assembly AND at persistence, and the
	// forge queue re-redacts a message on every rewrite. A redactor that is
	// not idempotent grows the value by one character per pass and makes the
	// evidence copy and the receipt copy of one finding DIFFER — which the
	// auto-review evidence integrity check rejects.
	const corpus = [
		'x password=hunter2',
		'the token=abcdef',
		'api_key=XYZ123',
		'Authorization: Bearer abcdefghijklmnopqrst',
		'https://user:pass@example.com/path',
		'see https://example.com/x?token=abc end',
		'"password":"hunter2"',
		`literal ghp_${'g'.repeat(30)} here`,
		`literal sk-ant-${'a'.repeat(24)} here`,
	];

	test('applying the redactor twice changes nothing', () => {
		for (const value of corpus) {
			const once = redactEvidenceText(value);
			expect(redactEvidenceText(once)).toBe(once);
		}
	});

	test('the key/value arm preserves the separator it consumed', () => {
		// The separator used to be part of the match but not of the
		// replacement, so the words were glued together. The fixture puts
		// the key AFTER a word the key class cannot swallow, so the arm
		// starts at the separator (and consumes it) rather than at the
		// string start — the shape that loses the separator.
		expect(redactEvidenceText('value; token=abcdef')).toBe(
			'value; token=[REDACTED]',
		);
		expect(redactEvidenceText('password=hunter2')).toBe('password=[REDACTED]');
	});

	test('the >=80-char mixed-class base64 family is redacted (the training superset contract)', () => {
		const secret = 'Ab3'.repeat(30);
		const out = redactEvidenceText(`blob ${secret} end`);
		expect(out.includes(secret)).toBe(false);
		expect(out).toContain('[REDACTED:base64]');
	});

	test('a hex-only run stays visible (the base64 arm keeps the #3712 guard)', () => {
		const digest = 'a1'.repeat(40);
		expect(redactEvidenceText(`digest ${digest}`)).toBe(`digest ${digest}`);
	});
});
