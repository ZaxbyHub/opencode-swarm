/**
 * Retired-skill injectability tests (issue #2966).
 *
 * `validateSkillReference` previously checked path shape, containment,
 * existence, frontmatter, and audience — but not the retirement lifecycle
 * markers that discovery and routing already respected, so an explicit
 * `SKILLS: file:` reference to a retired generated skill validated and the
 * delegation proceeded carrying stale (sometimes inverted) instructions.
 *
 * This suite pins: the validator arms (retired/stale/unmapped/control,
 * precedence, sanitization, symlink policy), the flipped end-to-end
 * reproduction through `validateExplicitSkillReferencesBefore` over ALL 19
 * historical retired slugs, the consumer-safe replacement map, and the
 * reconciled repository tree census.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as gate,
	RETIRED_SKILL_REPLACEMENTS,
	validateExplicitSkillReferencesBefore,
} from '../../../src/hooks/skill-propagation-gate';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import {
	delegationWith,
	GATE_CONFIG,
	RETIRED_SLUGS,
	validate,
	writeSkillDir,
} from './_retired-injection-fixtures';

const realGate = { ...gate };

/**
 * Capability probe for FILE symlinks (the cross-directory arms need the
 * lexical dir and the realpath dir to differ, which only a file symlink can
 * produce). Used to register those arms as honest skips on hosts without
 * symlink privilege instead of silently passing with zero assertions
 * (#2966 review LO-1 / reviewer round F2).
 */
const canFileSymlink = (() => {
	const probeDir = canonicalMkdtemp('symlink-probe-');
	try {
		fs.symlinkSync(probeDir, path.join(probeDir, 'probe'), 'file');
		return true;
	} catch {
		return false;
	} finally {
		removeTreeWithRetry(probeDir);
	}
})();

let scratch: string;

beforeEach(() => {
	scratch = canonicalMkdtemp('retired-injection-');
});

afterEach(() => {
	Object.assign(gate, realGate);
	removeTreeWithRetry(scratch);
});

describe('validator arms', () => {
	test('retired marker, mapped slug: invalid, reason names the replacement', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/gate-attribution', {
			kind: 'retired',
			payload: JSON.stringify({
				retiredAt: '2026-07-02T00:00:00.000Z',
				reason: 'superseded by bundled canon',
			}),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/gate-attribution/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
		expect(result.reason).toContain('gate-attribution');
		expect(result.reason).toContain('superseded by bundled canon');
		expect(result.reason).toContain(
			'file:.swarm/bundled-skills/gate-attribution/SKILL.md',
		);
	});

	test('stale marker: invalid with the stale state', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/some-stale-skill', {
			kind: 'stale',
			payload: 'source knowledge archived',
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/some-stale-skill/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('stale');
		expect(result.reason).toContain('source knowledge archived');
	});

	test('unmapped retired slug: invalid with the actionable generic instruction', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/never-mapped', {
			kind: 'retired',
			payload: JSON.stringify({ retiredAt: '2026-07-02T00:00:00.000Z' }),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/never-mapped/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('skill_generate');
		expect(result.reason).toContain('skill_inspect');
	});

	test('no-marker control: valid (no regression on live skills)', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/live-skill');
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/live-skill/SKILL.md',
		);
		expect(result.valid).toBe(true);
	});

	test('both markers in one directory: retired precedence', () => {
		const dir = writeSkillDir(
			scratch,
			'.opencode/skills/generated/both-markers',
			{
				kind: 'stale',
				payload: 'stale text',
			},
		);
		fs.writeFileSync(
			path.join(dir, 'retired.marker'),
			JSON.stringify({ retiredAt: '2026-07-02T00:00:00.000Z' }),
			'utf-8',
		);
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/both-markers/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
		expect(result.reason).not.toContain('stale text');
	});

	test('marker payload control characters, bidi, and oversize are sanitized and bounded', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/hostile-marker', {
			kind: 'retired',
			payload: JSON.stringify({
				retiredAt: '2026-07-02T00:00:00.000Z',
				// C0 newline/tab + C1 (U+009B) + bidi override (U+202E) + oversize.
				reason: 'evil\u202emulti\tline\n\u009b' + 'x'.repeat(400),
			}),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/hostile-marker/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).not.toMatch(/[\n\r\t\u0080-\u009f\u202a-\u202e]/u);
		// Aggregate bound: the joined detail is truncated ONCE to 160 chars.
		expect(result.reason?.length ?? 0).toBeLessThan(320);
	});

	test('marker detail is bounded to the aggregate 160-char cap with an ellipsis', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/bounded-marker', {
			kind: 'retired',
			payload: JSON.stringify({ reason: 'y'.repeat(300) }),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/bounded-marker/SKILL.md',
		);
		expect(result.valid).toBe(false);
		const detail = result.reason ?? '';
		expect(detail).toContain('…');
		// reason = prefix + "(<detail>)" + suffix; the detail itself is exactly
		// 160 chars including the ellipsis (aggregate single-truncate).
		const start = detail.indexOf('(');
		const end = detail.lastIndexOf(')');
		expect(end - start - 1).toBe(160);
	});

	test('oversize marker file is refused without reading (cap-before-read)', () => {
		const dir = writeSkillDir(
			scratch,
			'.opencode/skills/generated/huge-marker',
			{ kind: 'retired' },
		);
		fs.writeFileSync(
			path.join(dir, 'retired.marker'),
			JSON.stringify({ reason: 'z'.repeat(9000) }),
			'utf-8',
		);
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/huge-marker/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
		// Generic message: no marker payload leaked.
		expect(result.reason).not.toContain('zzz');
	});

	test('slug-shaped directory names never resolve inherited map members', () => {
		writeSkillDir(scratch, '.opencode/skills/generated/constructor', {
			kind: 'retired',
			payload: JSON.stringify({ retiredAt: '2026-07-02T00:00:00.000Z' }),
		});
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/constructor/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).not.toContain('native code');
		expect(result.reason).not.toContain('[object Object]');
		expect(result.reason).toContain('skill_generate');
	});

	test.skipIf(!canFileSymlink)(
		'symlinked marker file is blocked with the generic message (content never read through the link)',
		() => {
			const dir = writeSkillDir(
				scratch,
				'.opencode/skills/generated/symlinked-marker',
			);
			const target = path.join(scratch, 'outside-marker-payload.txt');
			fs.writeFileSync(target, 'SECRET-OUT-OF-ROOT-PAYLOAD', 'utf-8');
			fs.symlinkSync(target, path.join(dir, 'retired.marker'), 'file');
			const result = validate(
				scratch,
				'file:.opencode/skills/generated/symlinked-marker/SKILL.md',
			);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain('retired');
			expect(result.reason).not.toContain('SECRET-OUT-OF-ROOT-PAYLOAD');
		},
	);

	test('unreadable marker payload still fails closed with the generic message', () => {
		const dir = writeSkillDir(scratch, '.opencode/skills/generated/unreadable');
		fs.writeFileSync(path.join(dir, 'retired.marker'), 'not-json{', 'utf-8');
		// readFileSync is seam'd to THROW for this one file only
		const realRead = gate.readFileSync;
		gate.readFileSync = ((p: unknown, ...rest: unknown[]) => {
			if (typeof p === 'string' && p.endsWith('retired.marker')) {
				throw new Error('EACCES');
			}
			return (realRead as (a: unknown, ...b: unknown[]) => string)(p, ...rest);
		}) as typeof fs.readFileSync;
		const result = validate(
			scratch,
			'file:.opencode/skills/generated/unreadable/SKILL.md',
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('retired');
	});

	test('alias whose TARGET directory is retired is blocked (realpath policy)', () => {
		const target = writeSkillDir(
			scratch,
			'.opencode/skills/generated/retired-real',
			{
				kind: 'retired',
				payload: JSON.stringify({
					retiredAt: '2026-07-02T00:00:00.000Z',
					reason: 'retired via junction target',
				}),
			},
		);
		// A directory junction needs no symlink privilege on Windows (and is a
		// plain symlink on POSIX), so this arm EXECUTES on every CI platform:
		// the lexical directory is the alias, the realpath directory is the
		// retired target, and the realpath-side marker must block.
		const aliasDir = path.join(scratch, '.opencode/skills/alias-junction');
		fs.symlinkSync(target, aliasDir, 'junction');
		const result = validate(
			scratch,
			'file:.opencode/skills/alias-junction/SKILL.md',
		);
		expect(result.valid).toBe(false);
		// The refusal names the LEXICAL slug (what the architect referenced)…
		expect(result.reason).toContain('alias-junction');
		// …classifies it as retired, and carries the target-side marker detail.
		expect(result.reason).toContain('retired');
		expect(result.reason).toContain('retired via junction target');
	});

	test.skipIf(!canFileSymlink)(
		'marker on the LEXICAL directory blocks even when the target differs',
		() => {
			const target = writeSkillDir(
				scratch,
				'.opencode/skills/generated/live-target',
			);
			const aliasDir = path.join(scratch, '.opencode/skills/lexically-retired');
			fs.mkdirSync(aliasDir, { recursive: true });
			fs.writeFileSync(path.join(aliasDir, 'retired.marker'), '{}', 'utf-8');
			fs.symlinkSync(
				path.join(target, 'SKILL.md'),
				path.join(aliasDir, 'SKILL.md'),
				'file',
			);
			const result = validate(
				scratch,
				'file:.opencode/skills/lexically-retired/SKILL.md',
			);
			expect(result.valid).toBe(false);
			// The refusal names the LEXICAL slug whose directory carries the
			// marker (the file-symlink target itself is a live directory).
			expect(result.reason).toContain('lexically-retired');
			expect(result.reason).toContain('retired');
		},
	);

	// Cross-directory COMPETING marker states need the lexical dir and the
	// realpath dir to be different directories carrying different markers,
	// which only a FILE symlink can produce. These arms execute on POSIX CI
	// (file symlinks are unprivileged there); on Windows they are registered
	// as honest SKIPS rather than silently passing with zero assertions
	// (#2966 review LO-1 / PRR-001).
	test.skipIf(process.platform === 'win32')(
		'cross-directory precedence: lexical retired beats real stale (state wins over side)',
		() => {
			const target = writeSkillDir(
				scratch,
				'.opencode/skills/generated/real-stale',
				{ kind: 'stale', payload: 'stale on the real side' },
			);
			const aliasDir = path.join(scratch, '.opencode/skills/lex-retired');
			fs.mkdirSync(aliasDir, { recursive: true });
			fs.writeFileSync(
				path.join(aliasDir, 'retired.marker'),
				JSON.stringify({ retiredAt: '2026-07-02T00:00:00.000Z' }),
				'utf-8',
			);
			fs.symlinkSync(
				path.join(target, 'SKILL.md'),
				path.join(aliasDir, 'SKILL.md'),
				'file',
			);
			const result = validate(
				scratch,
				'file:.opencode/skills/lex-retired/SKILL.md',
			);
			expect(result.valid).toBe(false);
			// retired wins over stale ACROSS directories (PRR-001).
			expect(result.reason).toContain('is retired');
			expect(result.reason).not.toContain('stale on the real side');
		},
	);

	test.skipIf(process.platform === 'win32')(
		'cross-directory precedence: real retired beats lexical stale (tie and state rules)',
		() => {
			const target = writeSkillDir(
				scratch,
				'.opencode/skills/generated/real-retired',
				{
					kind: 'retired',
					payload: JSON.stringify({
						retiredAt: '2026-07-02T00:00:00.000Z',
						reason: 'retired on the real side',
					}),
				},
			);
			const aliasDir = path.join(scratch, '.opencode/skills/lex-stale');
			fs.mkdirSync(aliasDir, { recursive: true });
			fs.writeFileSync(
				path.join(aliasDir, 'stale.marker'),
				'stale on the lexical side',
				'utf-8',
			);
			fs.symlinkSync(
				path.join(target, 'SKILL.md'),
				path.join(aliasDir, 'SKILL.md'),
				'file',
			);
			const result = validate(
				scratch,
				'file:.opencode/skills/lex-stale/SKILL.md',
			);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain('is retired');
			// Detail comes from the side that supplied the winning marker state.
			expect(result.reason).toContain('retired on the real side');
			expect(result.reason).not.toContain('stale on the lexical side');
		},
	);
});

describe('end-to-end explicit gate (the flipped reproduction)', () => {
	test('all 19 historical retired slugs are blocked with guidance', async () => {
		for (const slug of RETIRED_SLUGS) {
			writeSkillDir(scratch, `.opencode/skills/generated/${slug}`, {
				kind: 'retired',
				payload: JSON.stringify({
					retiredAt: '2026-07-02T00:00:00.000Z',
				}),
			});
		}
		for (const slug of RETIRED_SLUGS) {
			const result = await validateExplicitSkillReferencesBefore(
				scratch,
				delegationWith(`file:.opencode/skills/generated/${slug}/SKILL.md`),
				GATE_CONFIG,
			);
			expect(result.blocked, `${slug}: not blocked`).toBe(true);
			// Quoted form: only the inner retirementMessage emits `"slug"`, so
			// this is not satisfied by the echoed reference alone (LO-2).
			expect(result.reason, `${slug}: reason missing`).toContain(`"${slug}"`);
			const replacement = RETIRED_SKILL_REPLACEMENTS[slug];
			if (replacement !== undefined) {
				expect(result.reason, `${slug}: replacement missing`).toContain(
					replacement,
				);
			} else {
				expect(result.reason, `${slug}: generic guidance missing`).toContain(
					'skill_generate',
				);
			}
		}
	});

	test('live control: an explicit reference to a live skill is NOT blocked', async () => {
		writeSkillDir(scratch, '.opencode/skills/generated/live-skill');
		const result = await validateExplicitSkillReferencesBefore(
			scratch,
			delegationWith('file:.opencode/skills/generated/live-skill/SKILL.md'),
			GATE_CONFIG,
		);
		expect(result.blocked).toBe(false);
	});
});
