/**
 * PR #3598 round 5: pins the rules added for the fifth automated review pass,
 * kept apart from swarm-pr-feedback-drive-to-merge.test.ts, which sits at the
 * 500-line test-file cap. Each assertion is anchored to the section that must
 * carry the rule, so moving or deleting it fails even when the words survive
 * elsewhere in the file.
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
