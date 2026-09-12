import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The merge-group `detect-release` predicate in ci.yml is the single point
 * of control for the entire required-check set: when it reports a release,
 * every job skips its steps and reports success. It must therefore match the
 * two genuine release-merge subject shapes and nothing else. This test pins
 * the trusted commit lookup and shell predicates in ci.yml and runs positive
 * and negative controls through the subject patterns, so the release fast path
 * cannot drift back to an unanchored full-message or untrusted-identity check.
 */
const CI_YML = fileURLToPath(
	new URL('../../../../.github/workflows/ci.yml', import.meta.url),
);

const EXPECTED_HEAD_SUBJECT_LOOKUP =
	`git -C "$GITHUB_WORKSPACE" show -s --format='%s' "$HEAD_SHA" > "$RELEASE_LOOKUP_FILE"`;

function readWorkflow(): string {
	return readFileSync(CI_YML, 'utf8');
}

function findWorkflowLine(...fragments: string[]): string {
	const line = readWorkflow()
		.split('\n')
		.find((candidate) =>
			fragments.every((fragment) => candidate.includes(fragment)),
		);
	if (!line)
		throw new Error(`workflow line not found for: ${fragments.join(', ')}`);
	return line;
}

function readSubjectPredicate(marker: string): { line: string; regex: RegExp } {
	const line = findWorkflowLine('"$SUBJECT" =~', marker);
	const expression = line.slice(line.indexOf('=~') + 2).trimStart();
	const delimiter = expression.lastIndexOf(' ]]');
	const literal = delimiter >= 0 ? expression.slice(0, delimiter) : undefined;
	if (!literal)
		throw new Error(`could not extract subject predicate for ${marker}`);
	return { line, regex: new RegExp(literal) };
}

describe('ci.yml detect-release predicate (merge-group required-check gate)', () => {
	test('reads the trusted merge-group head subject, not the full message or history', () => {
		const source = readWorkflow();
		expect(source).toContain(EXPECTED_HEAD_SUBJECT_LOOKUP);
		expect(source).not.toContain("--format='%B'");
		expect(
			source.split('\n').some((line) => {
				const trimmed = line.trimStart();
				return !trimmed.startsWith('#') && trimmed.includes('git log');
			}),
		).toBe(false);
	});

	test('merge-group detection requires trusted repository and commit identities', () => {
		const guardLine = findWorkflowLine(
			'"$EVENT" == "merge_group"',
			'"$REPOSITORY"',
		);
		expect(guardLine).toContain('"$REPOSITORY" == "ZaxbyHub/opencode-swarm"');

		const envLine = findWorkflowLine(
			'HEAD_SHA:',
			'github.event.merge_group.head_sha',
		);
		expect(envLine).toContain('github.event.merge_group.head_sha');

		const parentLookupLine = findWorkflowLine(
			'rev-parse "$HEAD_SHA^2"',
			'RELEASE_LOOKUP_FILE',
		);
		expect(parentLookupLine).toContain('rev-parse');

		const botAuthorLine = findWorkflowLine(
			'if [[ "$AUTHOR" ==',
			'"$AUTHOR_EMAIL"',
		);
		expect(botAuthorLine).toContain('"$AUTHOR" == "github-actions[bot]"');
		expect(botAuthorLine).toContain(
			'"$AUTHOR_EMAIL" == "41898282+github-actions[bot]@users.noreply.github.com"',
		);
		expect(findWorkflowLine('BOT_AUTHOR=').trim()).toBe('BOT_AUTHOR=');
		expect(findWorkflowLine('BOT_AUTHOR=1').trim()).toBe('BOT_AUTHOR=1');

		const githubCommitterLine = findWorkflowLine(
			'if [[ "$COMMITTER" ==',
			'"$COMMITTER_EMAIL"',
		);
		expect(githubCommitterLine).toContain('"$COMMITTER" == "GitHub"');
		expect(githubCommitterLine).toContain(
			'"$COMMITTER_EMAIL" == "noreply@github.com"',
		);
		expect(findWorkflowLine('GITHUB_COMMITTER=').trim()).toBe(
			'GITHUB_COMMITTER=',
		);
		expect(findWorkflowLine('GITHUB_COMMITTER=1').trim()).toBe(
			'GITHUB_COMMITTER=1',
		);

		const parentSubjectLine = findWorkflowLine(
			'show -s --format=\'%s\' "$RELEASE_PARENT"',
		);
		expect(parentSubjectLine).toContain("--format='%s'");
		const parentIdentityLine = findWorkflowLine(
			'"$RELEASE_AUTHOR" ==',
			'"$RELEASE_SUBJECT" =~',
		);
		expect(parentIdentityLine).toContain(
			'"$RELEASE_AUTHOR" == "github-actions[bot]"',
		);
		expect(parentIdentityLine).toContain(
			'"$RELEASE_AUTHOR_EMAIL" == "41898282+github-actions[bot]@users.noreply.github.com"',
		);
	});

	test('pull-request branch fast path requires the trusted automation actor', () => {
		const source = readFileSync(CI_YML, 'utf8');
		const line = source
			.split('\n')
			.find(
				(candidate) =>
					candidate.includes('BRANCH') &&
					candidate.includes('release-please--*'),
			);
		if (!line)
			throw new Error(
				'pull-request release branch predicate not found in ci.yml',
			);
		expect(line).toContain('"$EVENT" == "pull_request"');
		expect(line).toContain('"$ACTOR" == "github-actions[bot]"');
	});

	const positiveMergeSubjects = [
		'Merge pull request #2544 from ZaxbyHub/release-please--branches--main--components--opencode-swarm',
	];
	const negativeMergeSubjects = [
		'Merge pull request #2599 from ZaxbyHub/fix-thing',
		'Merge pull request #1 from evil owner/release-please--x',
		'Merge pull request #1 from evil/release-please--x',
		'docs: mention release-please--branches--main in CONTRIBUTING',
	];
	const positiveSquashSubjects = ['chore(main): release 7.164.6'];
	const negativeSquashSubjects = [
		'Revert "chore(main): release 7.164.6"',
		'feat(release): add chore(main): release helper',
		'chore(main): release-please--branches--main',
	];

	test.each(
		positiveMergeSubjects,
	)('matches a genuine release merge subject: %s', (subject) => {
		expect(
			readSubjectPredicate('ZaxbyHub/release-please--').regex.test(subject),
		).toBe(true);
	});

	test.each(
		negativeMergeSubjects,
	)('rejects a non-release merge subject: %s', (subject) => {
		expect(
			readSubjectPredicate('ZaxbyHub/release-please--').regex.test(subject),
		).toBe(false);
	});

	test.each(
		positiveSquashSubjects,
	)('matches a genuine release squash subject: %s', (subject) => {
		expect(readSubjectPredicate('BOT_AUTHOR').regex.test(subject)).toBe(true);
	});

	test.each(
		negativeSquashSubjects,
	)('rejects a non-release squash subject: %s', (subject) => {
		expect(readSubjectPredicate('BOT_AUTHOR').regex.test(subject)).toBe(false);
	});
});
