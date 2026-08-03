import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCandidates } from '../../../src/background/candidate-parser';
import { appendToSidecar } from '../../../src/background/candidate-sidecar-store';

let root = '';
const DIGEST = 'b'.repeat(64);

function envelope() {
	return parseCandidates(
		{
			output_ref: 'L1:sidecar:lane:output',
			batchId: 'clean-sidecar-batch',
			laneId: 'clean-sidecar-lane',
			agent: 'local_explorer',
			role: 'explorer',
			digest: DIGEST,
			text: '',
			artifact_status: 'ok',
			source: 'collect_lane_results',
			produced_at: '2026-08-02T00:00:00.000Z',
		},
		{
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
		},
	).invocation_envelope;
}

function commonCleanFields() {
	return {
		record_type: 'clean_attestation' as const,
		row_format_version: 1,
		record_version: { major: 1, minor: 1 },
		source_output_ref: 'L1:sidecar:lane:output',
		source_batch_id: 'clean-sidecar-batch',
		source_lane_id: 'clean-sidecar-lane',
		source_agent: 'local_explorer',
		source_digest: DIGEST,
		extracted_from_partial_source: false as const,
	};
}

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = '';
});

describe('candidate sidecar CLEAN schema parity', () => {
	test.each([
		{
			row_format_family: 'base_explorer' as const,
			lane: 'correctness-state',
		},
		{
			row_format_family: 'micro_lane' as const,
			micro_lane: 'concurrency-state',
		},
	])('accepts substantive $row_format_family attestations', (identity) => {
		root = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'clean-sidecar-schema-')),
		);
		expect(() =>
			appendToSidecar(
				{ projectRoot: root },
				'clean-sidecar-batch',
				envelope(),
				[],
				{
					...commonCleanFields(),
					...identity,
					coverage_scope: 'complete changed-file diff',
					evidence: 'no candidate survived focused review',
				},
			),
		).not.toThrow();
	});

	test('rejects short coverage and evidence even when called directly', () => {
		root = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'clean-sidecar-schema-')),
		);
		expect(() =>
			appendToSidecar(
				{ projectRoot: root },
				'clean-sidecar-batch',
				envelope(),
				[],
				{
					...commonCleanFields(),
					row_format_family: 'base_explorer',
					lane: 'correctness-state',
					coverage_scope: 'short',
					evidence: 'too short',
				},
			),
		).toThrow(/coverage_scope|evidence/);
	});
});
