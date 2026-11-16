import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildVerificationReceipt,
	type VerificationReceipt,
} from '../../src/evidence/receipt';
import { stableReportHash } from '../../src/tools/phase-complete/preflight-report';
import { canonicalMkdtemp } from './tmpdir';

/**
 * Shared fixtures for the swarm-pr-feedback review-round suites
 * (receipt-review-round2 / receipt-report-integrity), extracted so each
 * test file stays under the FR-006 500-line cap.
 */

export const STATIC_TIME = '2026-11-02T00:00:00.000Z';

export function makeDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return dir;
}

export function reportBytes(
	phase: number,
	entries: Array<Record<string, unknown>>,
): { reportHash: string; file: string; payload: string } {
	const reportHash = stableReportHash(phase, entries as never);
	return {
		reportHash,
		file: `phase-${phase}-${reportHash}.json`,
		payload: JSON.stringify({
			schemaVersion: 1,
			phase,
			outcome: 'pass',
			reportHash,
			entries,
		}),
	};
}

export function passEntry(id = 'gate_a'): Record<string, unknown> {
	return {
		id,
		code: 'OK',
		outcome: 'pass',
		evidenceRefs: [],
		responsibleActor: 'architect',
		agentsDispatched: [],
		agentsMissing: [],
		warnings: [],
	};
}

export function naEntry(id = 'gate_b'): Record<string, unknown> {
	return { ...passEntry(id), outcome: 'not_applicable' };
}

export async function seedAndReceipt(
	dir: string,
	entries: Array<Record<string, unknown>>,
): Promise<VerificationReceipt> {
	fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec\nFR text\n');
	const { file, payload } = reportBytes(1, entries);
	const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
	fs.mkdirSync(receipts, { recursive: true });
	fs.writeFileSync(path.join(receipts, file), payload);
	return buildVerificationReceipt(dir, 'phase', '1');
}
