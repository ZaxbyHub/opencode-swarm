import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	_internals,
	detectUserGlobalSkillStaleness,
	SKILL_CONTRACT_DIGEST_KEY,
	skillContractDigest,
	splitSkillFrontmatter,
} from '../../../scripts/drift-check';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2859 (F6): advisory staleness detection between repo-canonical
 * PR-workflow skills and user-global copies. All fixtures build their own
 * temp HOME (via the `_internals.resolveUserGlobalHome` seam) — the real user
 * profile is never read or written.
 */

const originalHome = _internals.resolveUserGlobalHome;
const tempRoots: string[] = [];

afterEach(() => {
	_internals.resolveUserGlobalHome = originalHome;
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

function makeTempRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	tempRoots.push(root);
	return root;
}

function writeSkill(
	root: string,
	relativePath: string,
	body: string,
	stamp?: string,
): void {
	const full = join(root, relativePath);
	mkdirSync(join(full, '..'), { recursive: true });
	const frontmatter = [
		'---',
		'name: swarm-pr-review',
		'audience: swarm-plugin',
	];
	if (stamp) frontmatter.splice(1, 0, `${SKILL_CONTRACT_DIGEST_KEY}: ${stamp}`);
	writeFileSync(full, `${frontmatter.join('\n')}\n---\n${body}`, 'utf8');
}

describe('detectUserGlobalSkillStaleness (issue #2859 F6)', () => {
	test('fires a notice naming both paths when a user-global copy is stale', () => {
		const repo = makeTempRoot('sw2859-repo-');
		const home = makeTempRoot('sw2859-home-');
		const body = '# canonical body\n\nguidance\n';
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			body,
			skillContractDigest(body),
		);
		writeSkill(home, '.opencode/skills/swarm-pr-review/SKILL.md', '# stale\n');
		_internals.resolveUserGlobalHome = () => home;

		const findings = detectUserGlobalSkillStaleness(repo);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('notice');
		expect(findings[0].message).toContain('swarm-pr-review');
		expect(findings[0].message).toContain(
			join(home, '.opencode', 'skills', 'swarm-pr-review', 'SKILL.md'),
		);
		expect(findings[0].message).toContain('repository copy');
		expect(findings[0].message).toContain('delete the stale user-global copy');
	});

	test('silent when the user-global copy matches the repo canonical', () => {
		const repo = makeTempRoot('sw2859-repo-');
		const home = makeTempRoot('sw2859-home-');
		const body = '# canonical body\n';
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			body,
			skillContractDigest(body),
		);
		writeSkill(home, '.opencode/skills/swarm-pr-review/SKILL.md', body);
		_internals.resolveUserGlobalHome = () => home;

		expect(detectUserGlobalSkillStaleness(repo)).toEqual([]);
	});

	test('silent when no user-global copy exists', () => {
		const repo = makeTempRoot('sw2859-repo-');
		const emptyHome = makeTempRoot('sw2859-home-');
		const body = '# canonical body\n';
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			body,
			skillContractDigest(body),
		);
		_internals.resolveUserGlobalHome = () => emptyHome;

		expect(detectUserGlobalSkillStaleness(repo)).toEqual([]);
	});

	test('repo-side stamp/body mismatch is a warning', () => {
		const repo = makeTempRoot('sw2859-repo-');
		const home = makeTempRoot('sw2859-home-');
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			'# body\n',
			'000000000000',
		);
		_internals.resolveUserGlobalHome = () => home;

		const findings = detectUserGlobalSkillStaleness(repo);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('warning');
		expect(findings[0].message).toContain('stamp-skill-contracts');
	});

	test('checks the .claude user-global tree as well', () => {
		const repo = makeTempRoot('sw2859-repo-');
		const home = makeTempRoot('sw2859-home-');
		const body = '# canonical body\n';
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-feedback/SKILL.md',
			body,
			skillContractDigest(body),
		);
		writeSkill(home, '.claude/skills/swarm-pr-feedback/SKILL.md', '# stale\n');
		_internals.resolveUserGlobalHome = () => home;

		const findings = detectUserGlobalSkillStaleness(repo);
		expect(findings).toHaveLength(1);
		expect(findings[0].message).toContain('swarm-pr-feedback');
	});

	test('real repo: stamps are correct and the detector is clean on the live tree', () => {
		const emptyHome = makeTempRoot('sw2859-emptyhome-');
		tempRoots.push(emptyHome);
		_internals.resolveUserGlobalHome = () => emptyHome;

		// The detector itself must be clean on the real repository (stamps
		// correct, no user-global copies under the isolated home). The broader
		// zero-non-notice runSyncDetectors assertion lives in
		// drift-check.test.ts and is NOT duplicated here: it is sensitive to
		// pre-existing local-environment findings (e.g. the required-check-
		// contract capture check) that this issue does not own.
		expect(detectUserGlobalSkillStaleness()).toEqual([]);
	});
});

describe('skillContractDigest helpers (issue #2859 F6)', () => {
	test('digest excludes frontmatter and normalizes line endings', () => {
		const body = '# title\r\n\r\ncontent\r\n';
		const a = splitSkillFrontmatter(`---\nname: x\n---\n${body}`);
		// PR #3387 follow-up (FB-028): splitSkillFrontmatter is now
		// CRLF-tolerant and returns LF-normalized slices — a CRLF file gets
		// real frontmatter instead of an empty split, and every digest
		// consumer normalizes the body anyway, so hashes are unchanged.
		expect(a.frontmatter).toBe('---\nname: x\n---\n');
		expect(a.body).toBe(body.replace(/\r\n/g, '\n'));
		const b = splitSkillFrontmatter(
			`---\nname: x\n---\n${body.replace(/\r\n/g, '\n')}`,
		);
		expect(skillContractDigest(a.body)).toBe(skillContractDigest(b.body));
	});

	test('a CRLF file yields real frontmatter slices (FB-028)', () => {
		const split = splitSkillFrontmatter('---\r\nname: x\r\n---\r\nbody\r\n');
		expect(split.frontmatter).toBe('---\nname: x\n---\n');
		expect(split.body).toBe('body\n');
	});

	test('a file without frontmatter is all body', () => {
		const { frontmatter, body } = splitSkillFrontmatter('# plain\n');
		expect(frontmatter).toBe('');
		expect(body).toBe('# plain\n');
	});
});
