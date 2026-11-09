/**
 * PR #3598 rounds 5 and 6: pins the rules added for the fifth and sixth
 * automated review passes, kept apart from
 * swarm-pr-feedback-drive-to-merge.test.ts, which sits at the 500-line
 * test-file cap. Each assertion is anchored to the section that must carry the
 * rule, so moving or deleting it fails even when the words survive elsewhere
 * in the file.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRIVE = '.opencode/skills/swarm-pr-feedback/references/drive-to-merge.md';
const DISPOSITIONS =
	'.opencode/skills/swarm-pr-feedback/references/followup-dispositions.md';
const RETRO = '.claude/skills/session-retrospective/SKILL.md';

function read(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), 'utf-8');
}

/** Text from the exact heading line to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
	const lines = text.split(/\r?\n/);
	const start = lines.indexOf(heading);
	if (start === -1) throw new Error(`heading not found: ${heading}`);
	const level = heading.match(/^#+/)?.[0].length ?? 0;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const match = lines[i].match(/^(#+) /);
		if (match && match[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

describe('follow-up dispositions: Priority item without a critic', () => {
	const critic = section(
		read(DISPOSITIONS),
		'## Critic review before the user sees it',
	);

	test('the lead rule points to the critic-unavailable exception', () => {
		expect(critic).toContain(
			'(for a Priority item whose critic is unavailable, see "Priority items" below)',
		);
		// No sibling bullet may reintroduce the "hold it as an ASK" fallback.
		expect(critic).not.toContain('becomes an ASK');
	});

	test('the Priority items bullet is exactly: kill/downgrade asks, unavailable files', () => {
		// The whole bullet is pinned, so an added "becomes an ASK" line or a
		// reworded fallback fails here, not just a deleted sentence.
		const lines = critic.split(/\r?\n/);
		const start = lines.indexOf('- **Priority items.**');
		expect(start).toBeGreaterThanOrEqual(0);
		const body: string[] = [];
		for (const line of lines.slice(start + 1)) {
			if (!line.startsWith('  ')) break;
			body.push(line);
		}
		expect(body).toEqual([
			'  - A critic kill or downgrade of a Priority `FILE` item turns it into an `ASK` for the user.',
			'  - When the critic is unavailable, the Priority item is still filed: it is already verified (gate 1), and holding it as an `ASK` that may go unanswered would drop a verified wedge, fail-open, security, or data-loss defect. State "not critic-reviewed" next to the item in the issue body and in its ledger row (a note, not a GitHub label), and list it in the final report for the user to review.',
		]);
	});
});

describe('drive-to-merge: Priority filing and monitoring ceiling', () => {
	const merge = read(DRIVE);

	test('step 4 files a Priority item even when the critic is unavailable', () => {
		const publish = section(
			merge,
			'### 4. Publish, then make the dispositions true',
		);
		expect(publish).toContain(
			'When the critic is unavailable, file them anyway, with "not critic-reviewed" stated in the issue body and the ledger row',
		);
	});

	test('the final report lists Priority items filed without critic review', () => {
		expect(section(merge, '### 9. Final report')).toContain(
			'- each Priority item filed without critic review (marked "not critic-reviewed"), for the user to review;',
		);
	});

	test('a queue that keeps rebuilding without merging still ends monitoring', () => {
		const start = merge.indexOf('**Monitoring ceiling.**');
		const end = merge.indexOf('Merged means', start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const ceiling = merge.slice(start, end);
		expect(ceiling).toContain(
			'- a single queue entry is still unmerged four times the duration of a normal full CI run after it was enqueued, even while new check runs keep appearing',
		);
		expect(ceiling).toContain('Stopping monitoring never dequeues the PR.');
	});
});

describe('session-retrospective: OpenCode session lookup', () => {
	test('the OpenCode row selects this session and stays read-only and scoped', () => {
		const history = section(
			read(RETRO),
			'## 1. Reconstruct the session from its history',
		);
		const row = history
			.split(/\r?\n/)
			.find((line) => line.startsWith('| OpenCode |'));
		expect(row).toBeDefined();
		expect(row).toContain('open read-only');
		expect(row).toContain(
			'scope every message and part query to one session id',
		);
		expect(row).toContain(
			'First list the tables (`sqlite_master`): versions differ',
		);
		expect(row).toContain(
			"Use the harness's own session id when it exposes one.",
		);
		expect(row).toContain(
			"`parent_id` null whose `directory` is the working directory (stored with forward slashes, so compare it that way on Windows) and whose `time_created` falls in this conversation's time range",
		);
		expect(row).toContain(
			'when both families exist, compare the newest `time_created` in `session` and in `session_v2` (small tables) and use the more recent family.',
		);
		expect(row).toContain(
			'With `message` and `part`, select `message` rows by `session_id` ordered by `time_created, id`, join `part` on `message_id` ordered by `id`, and parse each `data` JSON.',
		);
		expect(row).toContain(
			'With `session_message`, select rows by `session_id` ordered by `seq`.',
		);
		expect(row).toContain(
			"keep the one whose first user message matches this conversation's",
		);
		expect(row).toContain('Report extraction coverage.');
	});
});

describe('drive-to-merge: affirmative authorization and one PR identity', () => {
	const merge = read(DRIVE);

	test('only a request to merge authorizes it, never a mention', () => {
		const who = section(merge, '### Who can authorize what');
		expect(who).toContain('**The merge must be asked for, never inferred.**');
		expect(who).toContain(
			"Quote the user's authorizing words in the closure ledger, bound to the merged head.",
		);
		expect(who).toContain(
			'A question, a negation, a hypothetical, or a quoted mention of merging ("should we merge?", "why didn\'t you merge?", "don\'t merge yet") is not a request and never authorizes a merge.',
		);
		for (const adapter of [
			'.claude/skills/swarm-pr-feedback/SKILL.md',
			'.agents/skills/swarm-pr-feedback/SKILL.md',
		]) {
			expect(read(adapter)).toContain(
				'a question, negation, hypothetical, or quoted mention of merging,',
			);
		}
	});

	test('every gh and GraphQL call is bound to the resolved PR identity', () => {
		const intake = section(
			merge,
			'### 1. Intake: everything, freshly enumerated',
		);
		expect(intake).toContain(
			'**One PR identity.** Resolve the PR once into owner, repository, and number',
		);
		expect(intake).toContain(
			'pass `--repo <owner>/<repo>` to every `gh pr`, `gh run`, and `gh repo` call this run makes, including the ones the skill body, its references, and `swarm-ci-monitor` show without it, and the same owner and repository to GraphQL.',
		);
		const step7 = section(merge, '### 7. Merge and monitor until merged');
		expect(step7).toContain(
			'`gh pr merge <N> --repo <owner>/<repo> --match-head-commit <SHA>`',
		);
		expect(step7).toContain(
			'`gh pr view <N> --repo <owner>/<repo> --json headRefOid,',
		);
		expect(step7).toContain(
			'`gh pr view <N> --repo <owner>/<repo> --json state,mergedAt,mergeCommit`',
		);
		expect(step7).toContain(
			'`gh repo view <owner>/<repo> --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`',
		);
		expect(step7).toContain(
			're-enqueue with the merge command above (bound to the PR identity and `--match-head-commit`)',
		);
		expect(step7).toContain(
			'after fetching `<base>` from the remote that points at `<owner>/<repo>`',
		);
		// Every gh pr/run/repo command shown in the reference carries a repo
		// binding on the same line (inline code spans and fenced lines alike).
		const unbound = merge
			.split(/\r?\n/)
			.flatMap(
				(line) => line.match(/gh (pr|run|repo) [a-z]+ (?:(?!gh )[^`])*/g) ?? [],
			)
			.filter((cmd) => !/--repo |gh repo view <owner>\/<repo>/.test(cmd));
		expect(unbound).toEqual([]);
	});
});

describe('round 6 closeout: exclusions on always-loaded surfaces and precedence', () => {
	test('the architect constraint and help text exclude questions and mentions', () => {
		expect(read('src/agents/architect.ts')).toContain(
			'request merging this PR (never a question or mention)',
		);
		expect(read('src/commands/registry.ts')).toContain(
			'a question or mention never counts) or you answer yes to its merge question.',
		);
	});

	test('the identity rule takes precedence over swarm-ci-monitor', () => {
		const step7 = section(read(DRIVE), '### 7. Merge and monitor until merged');
		expect(step7).toContain(
			'Three points in this document take precedence over that skill:\n  - the one-PR-identity rule in step 1;',
		);
		expect(step7).toContain('(or `FETCH_HEAD` when fetched by URL)');
	});

	test('the queue re-enqueue hint and ci-monitor Step 4 are bound', () => {
		const intake = read(
			'.opencode/skills/swarm-pr-feedback/references/intake-surfaces.md',
		);
		expect(intake).not.toContain('re-enqueue with gh pr merge <N> --auto');
		const ciMonitor = read('.opencode/skills/swarm-ci-monitor/SKILL.md');
		expect(ciMonitor).toContain(
			'Poll `gh pr view <N> --repo <owner>/<repo> --json state,mergedAt,mergeCommit,mergeStateStatus`',
		);
		expect(ciMonitor).toContain('git rev-parse <remote>/<base-branch>');
		expect(ciMonitor).not.toContain('git fetch origin <base-branch>');
	});
});
