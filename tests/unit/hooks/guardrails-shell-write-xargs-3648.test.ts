/**
 * #3648 item 2 (D2 / frozen check C03): `xargs [flags] <verb> …` feeds the
 * verb STDIN-SUPPLIED operands — statically unknowable — so a write/delete
 * verb behind xargs withdraws fail-closed through the existing dynamic
 * marker. xargs's own getopt is walked (value-taking shorts consume a glued
 * tail or the next word), an UNKNOWN option falls back to scanning every
 * remaining word for a write verb (deny-direction over-deny), and with no
 * write verb in the verb position the composition stays admitted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D2: xargs-fed write/delete verbs withdraw fail-closed', () => {
	test(
		'echo ../x | xargs rm -rf is denied under blockDestructive',
		async () => {
			const r = await gate('echo ../x | xargs rm -rf', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'bare xargs rm -rf is denied under blockDestructive',
		async () => {
			const r = await gate('xargs rm -rf', { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'find .. | xargs rm -rf is denied under blockDestructive',
		async () => {
			const r = await gate('find .. | xargs rm -rf', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'xargs -I{} cp src/a {} is denied (write verb behind a value-taking option)',
		async () => {
			// `-I` takes a value (glued `{}` here), so the first non-option
			// word is `cp` — a write verb whose stdin-fed destination is
			// unknowable. The withdrawal must fire.
			const r = await gate('xargs -I{} cp src/a {}');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'xargs -n 5 rm -rf ../x is denied (-n consumes its 5)',
		async () => {
			const r = await gate('xargs -n 5 rm -rf ../x', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'echo ok | xargs grep foo stays admitted (no write verb)',
		async () => {
			const r = await gate('echo ok | xargs grep foo');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'echo ok | xargs echo rm stays admitted (rm is an ARGUMENT of echo)',
		async () => {
			// The scan-fallback over-deny applies ONLY to unknown options;
			// this leg exercises the normal path — the verb word is `echo`
			// (not a write verb) and `rm` is merely its argument, so the
			// composition is admitted.
			const r = await gate('echo ok | xargs echo rm');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'xargs with an unknown option falls back to the word scan and denies rm',
		async () => {
			const r = await gate('xargs --unknown-flag rm x', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		'4.5 review: flags after a value-taking option still reach the verb',
		async () => {
			const a = await gate('echo ../x | xargs -n 5 -0 rm -rf', {
				blockDestructive: true,
			});
			expect(a.verdict).toBe('BLOCKED');
			const b = await gate('xargs -I{} -t cp src/a {}');
			expect(b.verdict).toBe('BLOCKED');
			const c = await gate('xargs --replace tee ../esc');
			expect(c.verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		'4.5 r2: -e/-l optional-glued options never consume the verb',
		async () => {
			const a = await gate('xargs -e tee ../esc');
			expect(a.verdict).toBe('BLOCKED');
			const b = await gate('xargs -l tee ../esc');
			expect(b.verdict).toBe('BLOCKED');
			const c = await gate('echo src/a | xargs -e rm ../x', {
				blockDestructive: true,
			});
			expect(c.verdict).toBe('BLOCKED');
		},
		T,
	);
	// Hermes round-3 coverage note: the remaining GNU value-taking shorts
	// (-P parallelism, -d delimiter, -s max-chars) get grammar legs of their
	// own (they ride the same 'adEILnPs' consumption path proven by -n; this
	// pins it against a future table edit).
	test(
		'hermes-r3: -P/-d/-s detached values are consumed before verb detection',
		async () => {
			const a = await gate('echo ../x | xargs -P 4 rm -rf', {
				blockDestructive: true,
			});
			expect(a.verdict).toBe('BLOCKED');
			const b = await gate('xargs -P4 cp src/a ../esc');
			expect(b.verdict).toBe('BLOCKED');
			const c = await gate('echo ../x | xargs -d \\n cp src/a');
			expect(c.verdict).toBe('BLOCKED');
			const d = await gate('echo ../x | xargs -s 4096 rm -rf', {
				blockDestructive: true,
			});
			expect(d.verdict).toBe('BLOCKED');
		},
		T,
	);
});
