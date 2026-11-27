/**
 * #3915 F1 repo legs — the redaction-composition contract at the three
 * council write boundaries, beyond the frozen AC files:
 *
 *  (a) response-raw negative: the tool RESPONSE still carries the RAW model
 *      prose for the calling agent — redaction is a PERSISTED-boundary
 *      composition only (redactEvidenceText / redactEvidenceDeep are applied
 *      to the serialized entry, never to the synthesis the response embeds).
 *  (b) schema preservation: the persisted artifacts still parse and retain
 *      their expected fields/types after redaction (redactEvidenceDeep
 *      preserves structural identity; enum/bool/digest fields are untouched).
 *  (c) required-fix prose persistence: a token inside a CouncilFinding prose
 *      field of requiredFixes is redacted on disk (Round-3 blocker leg —
 *      requiredFixes and advisoryFindings are BOTH CouncilFinding[] with
 *      model-authored prose).
 *
 * These legs drive the REAL write paths (executeWriteFinalCouncilEvidence /
 * submit_phase_council_verdicts.execute / writeCouncilEvidence) exactly like
 * the frozen AC files; they add the persisted-shape and raw-response
 * assertions the frozen byte-scan files do not carry.
 *
 * Synthetic tokens only (ghp_ / sk-ant- shapes; no real credentials).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeCouncilEvidence } from '../../../src/council/council-evidence-writer';
import type { CouncilMemberVerdict } from '../../../src/council/types';
import { executeWriteFinalCouncilEvidence } from '../../../src/tools/write-final-council-evidence';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

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
			title: 'Council Redaction Composition Test Plan',
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

function writeCouncilConfig(dir: string): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);
}

/**
 * Pre-seed a passing mutation-gate entry so the phase writer's mutation-gap
 * probe does not promote a HIGH mutation_gap finding into requiredFixes
 * (which would both block the write and pollute the requiredFixes shape
 * under test).
 */
function writePassingMutationGate(dir: string, phaseNumber: number): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phaseNumber));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
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

/** Walk every file under dir; return relative paths containing any needle. */
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

describe('#3915 F1 repo legs — council redaction composition', () => {
	test('(a) final writer: the response carries the raw finding prose the persisted entry redacts', async () => {
		const dir = canonicalMkdtemp('ac-leg-a-final-response-');
		try {
			writePlanFixture(dir);
			// One MEDIUM (advisory, non-blocking) CONCERNS finding keeps the
			// write on the success path while its prose flows into the
			// response's unifiedFeedbackMd.
			const verdicts = MEMBERS.map((member) =>
				member === 'test_engineer'
					? verdict(member, {
							verdict: 'CONCERNS',
							findings: [
								{
									severity: 'MEDIUM',
									category: 'maintainability',
									location: 'src/example.ts:12',
									detail: `Advisory concern: rotate the leaked key ${GH} before project close.`,
									evidence: 'probe transcript',
								},
							],
						})
					: verdict(member),
			);
			const result = await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'All phases complete with advisory concerns only.',
					verdicts,
				},
				dir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			// RAW-response negative: the unified feedback markdown embedded in
			// the tool response is the RAW synthesis — the persisted-boundary
			// redaction must not mute the calling agent's feedback.
			expect(parsed.unifiedFeedbackMd).toContain(GH);
			expect(result).toContain(GH);
			// ...while the durable copy under .swarm/evidence stays clean.
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH],
			);
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);

	test('(a) phase writer: the response carries the raw phase summary the persisted entry redacts', async () => {
		const dir = canonicalMkdtemp('ac-leg-a-phase-response-');
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
					verdicts: MEMBERS.map((member) => verdict(member)),
					working_directory: dir,
				},
				{ directory: dir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			// The phase summary is echoed raw inside the response's unified
			// feedback markdown — the persisted copy is the redacted one.
			expect(parsed.unifiedFeedbackMd).toContain(ANT);
			expect(result).toContain(ANT);
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[ANT],
			);
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);

	test('(b) final writer: the persisted entry parses and retains its expected fields/types after redaction', async () => {
		const dir = canonicalMkdtemp('ac-leg-b-final-schema-');
		try {
			writePlanFixture(dir);
			const verdicts = MEMBERS.map((member) =>
				member === 'reviewer'
					? verdict(member, {
							verdict: 'CONCERNS',
							findings: [
								{
									severity: 'MEDIUM',
									category: 'maintainability',
									location: 'src/example.ts:12',
									detail: `Advisory concern quoting ${ANT} in prose.`,
									evidence: 'probe transcript',
								},
							],
						})
					: verdict(member),
			);
			const result = await executeWriteFinalCouncilEvidence(
				{
					phase: 2,
					projectSummary: `Project summary quoting ${GH} in prose.`,
					verdicts,
				},
				dir,
			);
			expect(JSON.parse(result).success).toBe(true);
			const evidencePath = path.join(
				dir,
				'.swarm',
				'evidence',
				'final-council.json',
			);
			expect(fs.existsSync(evidencePath)).toBe(true);
			const entry = JSON.parse(
				fs.readFileSync(evidencePath, 'utf-8'),
			).entries.find((e: { type?: string }) => e.type === 'final-council');
			// Structural identity survives redaction: scalars, digests, and
			// rosters keep their fields and types.
			expect(entry.phase).toBe(2);
			expect(entry.verdict).toBe('concerns');
			expect(entry.rawCouncilVerdict).toBe('CONCERNS');
			expect(typeof entry.quorumSize).toBe('number');
			expect(Array.isArray(entry.membersVoted)).toBe(true);
			expect(entry.membersVoted).toHaveLength(5);
			expect(entry.identity_digest).toMatch(/^[a-f0-9]{64}$/);
			expect(typeof entry.policy_digest).toBe('string');
			expect(typeof entry.timestamp).toBe('string');
			expect(typeof entry.attemptId).toBe('string');
			// Redacted free-text fields stay strings of the same shape.
			expect(typeof entry.projectSummary).toBe('string');
			expect(entry.projectSummary).not.toContain(GH);
			expect(Array.isArray(entry.advisoryFindings)).toBe(true);
			expect(entry.advisoryFindings).toHaveLength(1);
			const finding = entry.advisoryFindings[0];
			expect(finding.severity).toBe('MEDIUM');
			expect(finding.category).toBe('maintainability');
			expect(finding.location).toBe('src/example.ts:12');
			expect(typeof finding.detail).toBe('string');
			expect(finding.detail).not.toContain(ANT);
			expect(typeof finding.evidence).toBe('string');
			expect(Array.isArray(entry.advisoryNotes)).toBe(true);
			expect(Array.isArray(entry.memberVerdicts)).toBe(true);
			expect(entry.memberVerdicts).toHaveLength(5);
			for (const memberVerdict of entry.memberVerdicts) {
				expect(typeof memberVerdict.agent).toBe('string');
				expect(['APPROVE', 'CONCERNS', 'REJECT']).toContain(
					memberVerdict.verdict,
				);
				expect(Array.isArray(memberVerdict.findings)).toBe(true);
			}
			expect(typeof entry.unifiedFeedbackMd).toBe('string');
			expect(entry.unifiedFeedbackMd).not.toContain(ANT);
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH, ANT],
			);
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);

	test('(c) phase writer: a token inside a requiredFix CouncilFinding prose field is redacted on disk and the persisted shape is intact', async () => {
		const dir = canonicalMkdtemp('ac-leg-c-phase-required-fix-');
		try {
			writeCouncilConfig(dir);
			writePassingMutationGate(dir, 3);
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			// A REJECT member is a veto member: its CRITICAL/HIGH/MEDIUM
			// findings land in requiredFixes. A MEDIUM finding keeps
			// blockingConcernsCount at 0 (only CONCERNS-member HIGH/CRITICAL
			// promote to blocking), so the write still reaches the durable
			// boundary with a non-empty requiredFixes array.
			const verdicts = MEMBERS.map((member) =>
				member === 'reviewer'
					? verdict(member, {
							verdict: 'REJECT',
							findings: [
								{
									severity: 'MEDIUM',
									category: 'security',
									location: 'src/example.ts:12',
									detail: `Required fix: rotate the leaked key ${GH} before re-submission.`,
									evidence: `probe output quoting ${ANT}`,
								},
							],
						})
					: verdict(member),
			);
			const result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 3,
					swarmId: 'test',
					phaseSummary: 'Phase 3 complete with one required fix.',
					verdicts,
					working_directory: dir,
				},
				{ directory: dir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			const evidencePath = path.join(
				dir,
				'.swarm',
				'evidence',
				'3',
				'phase-council.json',
			);
			expect(fs.existsSync(evidencePath)).toBe(true);
			const entry = JSON.parse(
				fs.readFileSync(evidencePath, 'utf-8'),
			).entries.find((e: { type?: string }) => e.type === 'phase-council');
			// The required fix persisted with its shape intact and its prose
			// redacted (Round-3 blocker: requiredFixes is CouncilFinding[]).
			expect(Array.isArray(entry.requiredFixes)).toBe(true);
			expect(entry.requiredFixes).toHaveLength(1);
			const requiredFix = entry.requiredFixes[0];
			expect(requiredFix.severity).toBe('MEDIUM');
			expect(requiredFix.category).toBe('security');
			expect(requiredFix.location).toBe('src/example.ts:12');
			expect(typeof requiredFix.detail).toBe('string');
			expect(requiredFix.detail).not.toContain(GH);
			expect(typeof requiredFix.evidence).toBe('string');
			expect(requiredFix.evidence).not.toContain(ANT);
			// Rest of the persisted phase-council shape survives redaction.
			expect(entry.phase_number).toBe(3);
			expect(entry.scope).toBe('phase');
			expect(entry.verdict).toBe('REJECT');
			expect(typeof entry.quorumSize).toBe('number');
			expect(typeof entry.phaseSummary).toBe('string');
			expect(Array.isArray(entry.advisoryNotes)).toBe(true);
			expect(Array.isArray(entry.advisoryFindings)).toBe(true);
			expect(typeof entry.roundNumber).toBe('number');
			expect(typeof entry.allCriteriaMet).toBe('boolean');
			expect(typeof entry.attemptId).toBe('string');
			expect(entry.identity_digest).toMatch(/^[a-f0-9]{64}$/);
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH, ANT],
			);
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);

	test('(b) task-level writer: gates.council parses with sessionId redacted and its structural fields intact', async () => {
		const dir = canonicalMkdtemp('ac-leg-b-task-writer-schema-');
		try {
			await writeCouncilEvidence(dir, {
				taskId: '1.1',
				swarmId: `swarm-1 handoff notes quote ${GH}`,
				timestamp: '2026-04-13T00:00:00.000Z',
				overallVerdict: 'APPROVE',
				vetoedBy: null,
				memberVerdicts: [],
				unresolvedConflicts: [],
				requiredFixes: [],
				advisoryFindings: [],
				unifiedFeedbackMd: '',
				roundNumber: 1,
				allCriteriaMet: true,
				quorumSize: 3,
				blockingConcernsCount: 0,
			});
			const evidencePath = path.join(dir, '.swarm', 'evidence', '1.1.json');
			expect(fs.existsSync(evidencePath)).toBe(true);
			const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
			const council = evidence.gates.council;
			expect(council).toBeDefined();
			// The redacted sessionId stays a string; every structural field the
			// consumers read (verdict/roundNumber/quorumSize/allCriteriaMet/
			// agent/timestamp) keeps its type and value.
			expect(typeof council.sessionId).toBe('string');
			expect(council.sessionId).not.toContain(GH);
			expect(council.verdict).toBe('APPROVE');
			expect(council.roundNumber).toBe(1);
			expect(council.quorumSize).toBe(3);
			expect(council.allCriteriaMet).toBe(true);
			expect(council.agent).toBe('architect');
			expect(council.timestamp).toBe('2026-04-13T00:00:00.000Z');
			// Schema-required TaskEvidence fields the writer guarantees.
			expect(evidence.taskId).toBe('1.1');
			expect(Array.isArray(evidence.required_gates)).toBe(true);
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH],
			);
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);
});
