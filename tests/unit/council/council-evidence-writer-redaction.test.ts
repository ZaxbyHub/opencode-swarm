/**
 * #3915 AC3 — RED at base, GREEN after the fix.
 *
 * The task-level council evidence writer (`src/council/council-evidence-writer.ts`)
 * serializes the council synthesis record into `.swarm/evidence/{taskId}.json`
 * under `gates.council` with ZERO redaction calls in its write path (the
 * `atomicWriteFile(filePath, JSON.stringify(updated, null, 2))` at line 211).
 *
 * Enumerating the writer's serialized shape: the ONLY model-authored free
 * text it persists is the synthesis `swarmId` mirrored as
 * `gates.council.sessionId` (the remaining fields are enum verdict values,
 * booleans/numbers, digest fields, and the caller-supplied attemptId), so the
 * synthetic credential rides the swarmId. This test drives the REAL write
 * path (`writeCouncilEvidence` + the shared evidence lock + atomicWriteFile)
 * and asserts the raw persisted artifact never contains the token.
 *
 * Prior buggy behavior at base: the record is `JSON.stringify`-serialized
 * verbatim, so a credential carried by the synthesis free text reaches the
 * durable evidence artifact in the clear. The evidence path already has a
 * shipped redaction helper (`redactEvidenceText`, PR #3905) that this writer
 * must compose.
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
} from 'node:fs';
import * as path from 'node:path';
import { writeCouncilEvidence } from '../../../src/council/council-evidence-writer';
import type { CouncilSynthesis } from '../../../src/council/types';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const GH = `ghp_${'w'.repeat(30)}`;
const ANT = `sk-ant-${'b'.repeat(24)}`;

function makeSynthesis(
	overrides: Partial<CouncilSynthesis> = {},
): CouncilSynthesis {
	return {
		taskId: '1.1',
		swarmId: 'swarm-1',
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
		...overrides,
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

describe('#3915 AC3 — task-level council evidence redaction (real write path)', () => {
	test('AC3: a synthetic credential in the synthesis swarmId is not persisted under .swarm/evidence', async () => {
		const dir = canonicalMkdtemp('ac3-council-writer-');
		try {
			await writeCouncilEvidence(
				dir,
				makeSynthesis({
					swarmId: `swarm-alpha handoff notes quote ${GH}`,
				}),
			);
			// The write itself must succeed — gates.council is the synthesis
			// record under test; its absence would be a setup failure, not the
			// defect.
			const evidencePath = path.join(dir, '.swarm', 'evidence', '1.1.json');
			expect(existsSync(evidencePath)).toBe(true);
			const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
			expect(evidence.gates.council).toBeDefined();
			expect(evidence.gates.council.verdict).toBe('APPROVE');
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH],
			);
			// RED at base: gates.council.sessionId persists the raw ghp_ token.
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);

	test('AC3: a later REJECT round over the same task never reintroduces the raw token', async () => {
		const dir = canonicalMkdtemp('ac3-council-writer-round2-');
		try {
			mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
			await writeCouncilEvidence(
				dir,
				makeSynthesis({
					swarmId: `swarm-beta probe log quotes ${ANT}`,
					roundNumber: 1,
					overallVerdict: 'REJECT',
				}),
			);
			await writeCouncilEvidence(
				dir,
				makeSynthesis({
					swarmId: `swarm-beta remediated, re-review transcript had ${GH}`,
					roundNumber: 2,
					overallVerdict: 'APPROVE',
				}),
			);
			const evidencePath = path.join(dir, '.swarm', 'evidence', '1.1.json');
			expect(existsSync(evidencePath)).toBe(true);
			const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
			// The latest round wins the council gate entry.
			expect(evidence.gates.council.roundNumber).toBe(2);
			expect(evidence.gates.council.verdict).toBe('APPROVE');
			const offenders = findTokenFilesUnder(
				path.join(dir, '.swarm', 'evidence'),
				[GH, ANT],
			);
			// RED at base: round-1's raw sessionId was already persisted (and
			// round-2's is persisted verbatim too).
			expect(offenders).toEqual([]);
		} finally {
			removeTreeWithRetry(dir);
		}
	}, 60_000);
});
