import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The merge-group `detect-release` predicate in ci.yml is the single point
 * of control for the entire required-check set: when it reports a release,
 * every job skips its steps and reports success. It must therefore match the
 * two genuine release-merge subject shapes and nothing else. This test pins
 * the literal in ci.yml and runs positive and negative controls through it,
 * so the regex cannot drift back to an unanchored full-message grep.
 */
const CI_YML = fileURLToPath(
	new URL('../../../../.github/workflows/ci.yml', import.meta.url),
);

const EXPECTED_PREDICATE =
	"git log -1 --format='%s' | grep -qE '^Merge pull request #[0-9]+ from [^/ ]+/release-please--|^chore\\(main\\): release '";

function readPredicate(): { line: string; regex: RegExp } {
	const source = readFileSync(CI_YML, 'utf8');
	const line = source
		.split('\n')
		.find((l) => l.includes('git log -1 --format=') && l.includes('grep -qE'));
	if (!line)
		throw new Error('detect-release predicate line not found in ci.yml');
	const literal = /grep -qE '([^']+)'/.exec(line)?.[1];
	if (!literal) throw new Error('could not extract the grep literal');
	return { line, regex: new RegExp(literal) };
}

describe('ci.yml detect-release predicate (merge-group required-check gate)', () => {
	test('is anchored to the commit subject, not the full message', () => {
		const { line } = readPredicate();
		expect(line).toContain(EXPECTED_PREDICATE);
		expect(line).not.toContain("--format='%B'");
	});

	const positive = [
		'Merge pull request #2544 from ZaxbyHub/release-please--branches--main--components--opencode-swarm',
		'chore(main): release 7.164.6',
	];
	const negative = [
		'Merge pull request #2599 from ZaxbyHub/fix-thing',
		'Revert "chore(main): release 7.164.6"',
		'feat(release): add chore(main): release helper',
		'Merge pull request #1 from evil owner/release-please--x',
		'docs: mention release-please--branches--main in CONTRIBUTING',
	];

	test.each(positive)('matches a genuine release subject: %s', (subject) => {
		expect(readPredicate().regex.test(subject)).toBe(true);
	});

	test.each(negative)('rejects a non-release subject: %s', (subject) => {
		expect(readPredicate().regex.test(subject)).toBe(false);
	});
});
