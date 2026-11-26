/**
 * #3915 AC2 — RED at base, GREEN after the fix.
 *
 * The phase-council verdict writer (`src/tools/submit-phase-council-verdicts.ts`)
 * serializes the model-authored free text of the phase-council entry (the
 * architect-submitted phaseSummary and the collected member verdict prose)
 * into `.swarm/evidence/<phase>/phase-council.json` with ZERO redaction calls
 * in its write path (`writeFileSync(tempFile, JSON.stringify(content...))` at
 * line 460). This test drives the REAL tool execute path with council
 * enabled, a passing mutation-gate pre-seed, and a full five-member quorum,
 * and asserts that no file under the produced `.swarm/evidence` tree persists
 * the raw synthetic token.
 *
 * Prior buggy behavior at base: the verdict content is `JSON.stringify`-
 * serialized verbatim, so a credential pasted into the phase summary or a
 * member's finding prose reaches the durable verdict artifact in the clear.
 *
 * Synthetic tokens only (ghp_ / sk-ant- shapes; no real credentials).
 */
import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
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

function writeCouncilConfig(dir: string): void {
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);
}

/**
 * Pre-seed a passing mutation-gate entry so the writer's mutation-gap probe
 * does not promote a HIGH mutation_gap finding (which would block the write
 * before the verdict serialization under test is ever reached).
 */
function writePassingMutationGate(dir: string, phaseNumber: number): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phaseNumber));
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(
		path.join(evidenceDir, 'mutation-gate.json'),
		JSON.stringify({
			entries: [
				{
					type: 'mutation-gate',
					verdict: 'pass',
					timestamp: '2026-01-01T00:00:00.000Z',
				},
			],
		}),
	);
}

function makeVerdict(
	agent: (typeof MEMBERS)[number],
	findings: Array<{
		severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
		category: string;
		location: string;
		detail: string;
		evidence: string;
	}> = [],
) {
	return {
		agent,
		verdict: 'APPROVE',
		confidence: 0.9,
		findings,
		criteriaAssessed: ['project-scope'],
		criteriaUnmet: [],
		durationMs: 10,
	};
}

/** Walk every file under dir; return relative paths containing any needle. */
function findTokenFilesUnder(dir: string, needles: string[]): string[] {
	const offenders: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else {
				const text = readFileSync(full, 'utf8');
				if (needles.some((needle) => text.includes(needle))) {
					offenders.push(path.relative(dir, full));
				}
			}
		}
	}
	return offenders;
}

describe('#3915 AC2 — phase-council verdict redaction (real write path)', () => {
	test('AC2: a synthetic credential in the phase summary is not persisted under .swarm/evidence', async () => {
		const dir = canonicalMkdtemp('ac2-phase-council-summary-');
		try {
			writeCouncilConfig(dir);
			writePassingMutationGate(dir, 1);
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			const result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 1,
					swarmId: 'test',
					phaseSummary: `Phase 1 complete. Deployment log excerpt quotes ${ANT}`,
					verdicts: MEMBERS.map((member) => makeVerdict(member)),
					working_directory: dir,
				},
				{ directory: dir },
			);
			const parsed = JSON.parse(result);
			// The call itself must succeed (council enabled, mutation gate
			// passing, five-member quorum) — a setup failure is not the defect.
			expect(parsed.success).toBe(true);
			expect(
				existsSync(
					path.join(dir, '.swarm', 'evidence', '1', 'phase-council.json'),
				),
			).toBe(true);
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[ANT],
			);
			// RED at base: phase-council.json persists the raw sk-ant- token.
			expect(offenders).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test('AC2: a synthetic credential in a member finding prose is not persisted under .swarm/evidence', async () => {
		const dir = canonicalMkdtemp('ac2-phase-council-finding-');
		try {
			writeCouncilConfig(dir);
			writePassingMutationGate(dir, 2);
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			const verdicts = MEMBERS.map((member) =>
				member === 'reviewer'
					? makeVerdict(member, [
							{
								severity: 'MEDIUM',
								category: 'maintainability',
								location: 'src/example.ts:12',
								detail: `Advisory: the smoke-test transcript quotes ${GH}`,
								evidence: `probe output quoting ${ANT}`,
							},
						])
					: makeVerdict(member),
			);
			const result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 2,
					swarmId: 'test',
					phaseSummary: 'Phase 2 complete with one advisory finding.',
					verdicts,
					working_directory: dir,
				},
				{ directory: dir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH, ANT],
			);
			// RED at base: the finding prose persists both raw tokens.
			expect(offenders).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
