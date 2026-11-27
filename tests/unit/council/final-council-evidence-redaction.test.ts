/**
 * #3915 AC1 — RED at base, GREEN after the fix.
 *
 * The final-council evidence writer (`src/tools/write-final-council-evidence.ts`)
 * serializes the model-authored free-text fields of the evidence entry (the
 * project summary, the unified feedback markdown, and the member verdict
 * prose) into `.swarm/evidence/final-council.json` with ZERO redaction calls
 * in its write path (the atomic temp+rename serialization around lines
 * 406-420). This test drives the REAL write path through
 * `executeWriteFinalCouncilEvidence` — plan fixture plus a full five-member
 * quorum — and asserts that no file under the produced `.swarm/evidence` tree
 * persists the raw synthetic token.
 *
 * Prior buggy behavior at base: the entry is `JSON.stringify`-serialized
 * verbatim at the cited write site, so a credential pasted by a council
 * member into its verdict prose (or by the architect into the project
 * summary) reaches the durable evidence artifact in the clear. The evidence
 * path already has a shipped redaction helper (`redactEvidenceText`,
 * PR #3905) that this writer must compose.
 *
 * Synthetic tokens only (ghp_ / sk-ant- shapes; no real credentials).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CouncilMemberVerdict } from '../../../src/council/types';
import { executeWriteFinalCouncilEvidence } from '../../../src/tools/write-final-council-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GH = `ghp_${'w'.repeat(30)}`;
const ANT = `sk-ant-${'b'.repeat(24)}`;

const MEMBERS = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

function verdict(
	agent: (typeof MEMBERS)[number],
	overrides: Partial<CouncilMemberVerdict> = {},
): CouncilMemberVerdict {
	return {
		agent,
		verdict: 'APPROVE',
		confidence: 0.9,
		findings: [],
		criteriaAssessed: ['project-scope'],
		criteriaUnmet: [],
		durationMs: 25,
		...overrides,
	};
}

function writePlanFixture(tempDir: string): void {
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Final Council Redaction Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'completed',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Test task',
						},
					],
				},
			],
		}),
	);
}

/**
 * Walk every file under `dir`; return the relative paths of files whose
 * bytes contain any needle. Walks the REAL tree so any sibling artifact the
 * writer adds under `.swarm/evidence` is covered too.
 */
function findTokenFilesUnder(dir: string, needles: string[]): string[] {
	const offenders: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else {
				const text = fs.readFileSync(full, 'utf8');
				if (needles.some((needle) => text.includes(needle))) {
					offenders.push(path.relative(dir, full));
				}
			}
		}
	}
	return offenders;
}

describe('#3915 AC1 — final-council evidence redaction (real write path)', () => {
	test('AC1: a synthetic credential in the project summary is not persisted under .swarm/evidence', async () => {
		const dir = canonicalMkdtemp('ac1-final-council-summary-');
		writePlanFixture(dir);
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: `All planned project phases are complete. Ops handoff notes quote ${GH}`,
				verdicts: MEMBERS.map((member) => verdict(member)),
			},
			dir,
		);
		// The call itself must succeed (five-member quorum, plan present) —
		// a setup failure here is not the defect under test.
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(fs.existsSync(path.join(dir, '.swarm', 'evidence'))).toBe(true);
		const offenders = findTokenFilesUnder(
			path.join(dir, '.swarm', 'evidence'),
			[GH],
		);
		// RED at base: final-council.json persists the raw ghp_ token.
		expect(offenders).toEqual([]);
	}, 60_000);

	test('AC1: a synthetic credential in a member finding prose is not persisted under .swarm/evidence', async () => {
		const dir = canonicalMkdtemp('ac1-final-council-finding-');
		writePlanFixture(dir);
		// One MEDIUM (advisory, non-blocking) CONCERNS finding keeps the write
		// on the success path while carrying model-authored prose into the
		// serialized entry (unifiedFeedbackMd + memberVerdicts +
		// advisoryFindings).
		const verdicts = MEMBERS.map((member) =>
			member === 'test_engineer'
				? verdict(member, {
						verdict: 'CONCERNS',
						findings: [
							{
								severity: 'MEDIUM',
								category: 'maintainability',
								location: 'src/example.ts:12',
								detail: `Advisory concern: rotate the leaked key ${ANT} before project close.`,
								evidence: `probe transcript quoting ${GH}`,
							},
						],
					})
				: verdict(member),
		);
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 2,
				projectSummary: 'All phases complete with advisory concerns only.',
				verdicts,
			},
			dir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.blockingConcernsCount ?? 0).toBe(0);
		const offenders = findTokenFilesUnder(
			path.join(dir, '.swarm', 'evidence'),
			[GH, ANT],
		);
		// RED at base: the verdict prose persists both raw tokens.
		expect(offenders).toEqual([]);
	}, 60_000);
});
