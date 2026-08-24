/**
 * decideChangelogFallback — every exit branch of the bare-release CHANGELOG
 * fallback (NEGPATH-2 from PR review: the exit boundaries are load-bearing
 * and were previously only reachable through gh-backed I/O).
 */

import { describe, expect, test } from 'bun:test';
import { decideChangelogFallback } from '../../../scripts/release-notes-fragments.mjs';

const SECTION = [
	'## [7.146.1](https://github.com/o/r/compare/v7.146.0...v7.146.1) (2026-08-24)',
	'',
	'* fix one ([5c7bb9d](https://github.com/o/r/commit/5c7bb9d9d0e21ad8da4ce79839a8f70991d4cbe3))',
].join('\n');

function harness(opts: {
	section?: string | null;
	size?: number;
	candidates?: number[];
}) {
	const warnings: string[] = [];
	const logs: string[] = [];
	const log = (m: string) => {
		logs.push(m);
		if (m.includes('::warning::')) warnings.push(m);
	};
	return {
		warnings,
		logs,
		run: () =>
			decideChangelogFallback({
				tagName: 'v7.146.1',
				repoRoot: '/repo',
				readChangelog: () => opts.section ?? '',
				statChangelog: () => ({ size: opts.size ?? SECTION.length }),
				resolveCandidates: () => opts.candidates ?? [],
				log,
			}),
	};
}

describe('decideChangelogFallback', () => {
	test('section present, candidates found → exit 0 with candidates', async () => {
		const t = harness({ section: SECTION, candidates: [2317, 2316] });
		const r = await t.run();
		expect(r.exitCode).toBe(0);
		expect(r.candidates).toEqual([2317, 2316]);
		expect(t.warnings).toEqual([]);
	});

	test('section missing → warn + exit 0 (degenerate release)', async () => {
		const t = harness({ section: null });
		const r = await t.run();
		expect(r.exitCode).toBe(0);
		expect(r.candidates).toEqual([]);
		expect(t.warnings.length).toBe(1);
		expect(t.warnings[0]).toContain('no CHANGELOG section');
	});

	test('CHANGELOG unreadable → warn + exit 0', async () => {
		const warnings: string[] = [];
		const r = await decideChangelogFallback({
			tagName: 'v1.0.0',
			repoRoot: '/repo',
			readChangelog: () => {
				throw new Error('ENOENT');
			},
			statChangelog: () => {
				throw new Error('ENOENT');
			},
			resolveCandidates: () => [],
			log: (m) => {
				if (m.includes('::warning::')) warnings.push(m);
			},
		});
		expect(r.exitCode).toBe(0);
		expect(warnings.length).toBe(1);
	});

	test('oversized CHANGELOG → refuse read, warn + exit 0', async () => {
		const t = harness({ section: SECTION, size: 3 * 1024 * 1024 });
		const r = await t.run();
		expect(r.exitCode).toBe(0);
		expect(r.candidates).toEqual([]);
		expect(t.logs.some((l) => l.includes('fallback cap'))).toBe(true);
	});

	test('section present but zero candidates → warn + exit 1 (advisory loud)', async () => {
		const t = harness({ section: SECTION, candidates: [] });
		const r = await t.run();
		expect(r.exitCode).toBe(1);
		expect(t.warnings.length).toBe(1);
		expect(t.warnings[0]).toContain('yielded no PR candidates');
	});

	test('candidate list clamped to the cap (log fires)', async () => {
		const many = Array.from({ length: 80 }, (_, i) => 2000 + i);
		const t = harness({ section: SECTION, candidates: many });
		const r = await t.run();
		expect(r.exitCode).toBe(0);
		expect(r.candidates.length).toBe(50);
		expect(r.candidates[0]).toBe(2000);
		expect(t.logs.some((l) => l.includes('clamping') && l.includes('80'))).toBe(
			true,
		);
	});

	test('tagName without v prefix still resolves the version', async () => {
		let seenSection = '';
		await decideChangelogFallback({
			tagName: '7.146.1',
			repoRoot: '/repo',
			readChangelog: () => {
				seenSection = SECTION;
				return SECTION;
			},
			statChangelog: () => ({ size: SECTION.length }),
			resolveCandidates: (section) => {
				seenSection = section;
				return [1];
			},
			log: () => {},
		});
		expect(seenSection).toContain('7.146.1');
	});
});
