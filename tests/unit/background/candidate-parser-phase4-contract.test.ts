import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ArtifactInput,
	type ParseFlags,
	parseAndPersist,
	parseCandidates,
} from '../../../src/background/candidate-parser';

const tempDirs: string[] = [];
const digest = createHash('sha256').update('phase4').digest('hex');
const microHeader =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';
const baseHeader =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
const microRow =
	'M-1 | subprocess | HIGH | safety | src/a.ts:1 | unsafe child | invariant 3 | direct evidence | 0.95';

function input(
	text: string,
	overrides: Partial<ArtifactInput> = {},
): ArtifactInput {
	return {
		output_ref: `L1:${'a'.repeat(64)}:${'b'.repeat(64)}:${digest}`,
		batchId: 'micro-batch',
		laneId: 'subprocess-lane',
		agent: 'mega_explorer',
		role: 'explorer',
		digest,
		text,
		artifact_status: 'ok',
		source: 'dispatch_lanes',
		produced_at: '2026-07-13T00:00:00.000Z',
		...overrides,
	};
}

function flags(overrides: Record<string, unknown> = {}): ParseFlags {
	return {
		accept_partial: false,
		accept_degraded: false,
		degraded: false,
		row_format_version: 1,
		producer: 'swarm-pr-review',
		...overrides,
	} as unknown as ParseFlags;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('candidate parser Phase 4 contract', () => {
	test('expected micro family maps a canonical row without positional ambiguity', () => {
		const result = parseCandidates(
			input(`${microHeader}\n${microRow}`),
			flags({ expected_family: 'micro_lane' }),
		);
		expect(result.error_code).toBeUndefined();
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			candidate_id: 'M-1',
			row_format_family: 'micro_lane',
			lane: null,
			micro_lane: 'subprocess',
			invariant_violated: 'invariant 3',
			evidence_summary: 'direct evidence',
			confidence: '0.95',
		});
	});

	test('recognized micro header controls legacy callers when expected_family is absent', () => {
		const result = parseCandidates(
			input(`${microHeader}\n${microRow}`),
			flags(),
		);
		expect(result.candidates[0]?.row_format_family).toBe('micro_lane');
	});

	test('strips one marker from prompt-compatible data rows', () => {
		const result = parseCandidates(
			input(`${microHeader}\n[CANDIDATE] | ${microRow}`),
			flags({ expected_family: 'micro_lane' }),
		);
		expect(result.candidates[0]?.candidate_id).toBe('M-1');
		expect(result.candidates[0]?.confidence).toBe('0.95');
		expect(result.diagnostics.duplicate_id_count).toBe(0);
	});

	test('fails closed when expected family conflicts with a recognized header', () => {
		const result = parseCandidates(
			input(
				`${baseHeader}\nB-1 | runtime | HIGH | bug | src/a.ts:1 | claim | evidence | impact | 0.9`,
			),
			flags({ expected_family: 'micro_lane' }),
		);
		expect(result.error_code).toBe('expected-family-mismatch');
		expect(result.candidates).toEqual([]);
	});

	test('parses and persists exactly one provenance-bearing CLEAN attestation', () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'phase4-clean-')));
		tempDirs.push(root);
		const result = parseAndPersist(
			input(
				`${microHeader}\n[CLEAN] | subprocess | checked changed subprocess paths | no invariant violations`,
			),
			flags({
				expected_family: 'micro_lane',
				expected_micro_lane: 'subprocess',
			}),
			{ projectRoot: root },
		) as ReturnType<typeof parseAndPersist> & {
			clean_attestation?: Record<string, unknown>;
		};

		expect(result.candidates).toEqual([]);
		expect(result.clean_attestation).toMatchObject({
			record_type: 'clean_attestation',
			row_format_family: 'micro_lane',
			source_output_ref: input('').output_ref,
			source_batch_id: 'micro-batch',
			source_lane_id: 'subprocess-lane',
			source_digest: digest,
			micro_lane: 'subprocess',
			coverage_scope: 'checked changed subprocess paths',
			evidence: 'no invariant violations',
		});
		expect(
			(
				result.invocation_envelope as unknown as {
					clean_attestation_count: number;
				}
			).clean_attestation_count,
		).toBe(1);

		const sidecar = join(
			root,
			'.swarm',
			'lane-results',
			createHash('sha256').update('micro-batch').digest('hex'),
			'candidates.jsonl',
		);
		expect(existsSync(sidecar)).toBe(true);
		const records = readFileSync(sidecar, 'utf-8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.record_type)).toEqual([
			'invocation',
			'clean_attestation',
		]);
	});

	test('rejects CLEAN when any other row is malformed', () => {
		const result = parseCandidates(
			input(
				`${microHeader}\nmalformed orphan row\n[CLEAN] | subprocess | scope | evidence`,
			),
			flags({
				expected_family: 'micro_lane',
				expected_micro_lane: 'subprocess',
			}),
		);
		expect(result.error_code).toBe('untrusted-clean-attestation');
		expect(result.clean_attestation).toBeUndefined();
		expect(result.diagnostics.malformed_rows).toBe(1);
		expect(result.diagnostics.parse_errors).toBeGreaterThan(0);
	});

	test('rejects CLEAN whose lane identity differs from dispatch provenance', () => {
		const result = parseCandidates(
			input(`${microHeader}\n[CLEAN] | wrong-lane | scope | evidence`),
			flags({
				expected_family: 'micro_lane',
				expected_micro_lane: 'subprocess',
			}),
		);
		expect(result.error_code).toBe('expected-micro-lane-mismatch');
		expect(result.clean_attestation).toBeUndefined();
	});

	test('rejects candidate rows whose lane identity differs from dispatch provenance', () => {
		const result = parseCandidates(
			input(`${microHeader}\n${microRow}`),
			flags({
				expected_family: 'micro_lane',
				expected_micro_lane: 'different-lane',
			}),
		);
		expect(result.candidates).toEqual([]);
		expect(result.diagnostics.parse_error_details[0]).toMatchObject({
			field: 'micro_lane',
		});
	});

	for (const [name, text, family, overrides] of [
		[
			'duplicate CLEAN sentinels',
			`${microHeader}\n[CLEAN] | subprocess | scope | evidence\n[CLEAN] | subprocess | scope | evidence`,
			'micro_lane',
			{},
		],
		[
			'candidates plus CLEAN',
			`${microHeader}\n${microRow}\n[CLEAN] | subprocess | scope | evidence`,
			'micro_lane',
			{},
		],
		[
			'CLEAN under base family',
			`${baseHeader}\n[CLEAN] | runtime | scope | evidence`,
			'base_explorer',
			{},
		],
		[
			'degraded CLEAN source',
			`${microHeader}\n[CLEAN] | subprocess | scope | evidence`,
			'micro_lane',
			{ degraded: true, accept_degraded: true },
		],
	] as const) {
		test(`rejects ${name}`, () => {
			const result = parseCandidates(
				input(text),
				flags({ expected_family: family, ...overrides }),
			) as ReturnType<typeof parseCandidates> & {
				clean_attestation?: unknown;
			};
			expect(result.error_code).toBeDefined();
			expect(result.clean_attestation).toBeUndefined();
		});
	}

	test('rejects CLEAN from an incomplete transcript even when partial candidates are allowed', () => {
		const result = parseCandidates(
			input(`${microHeader}\n[CLEAN] | subprocess | scope | evidence`, {
				transcriptIncomplete: true,
			}),
			flags({
				accept_partial: true,
				expected_family: 'micro_lane',
				expected_micro_lane: 'subprocess',
			}),
		);

		expect(result.error_code).toBe('untrusted-clean-attestation');
		expect(result.clean_attestation).toBeUndefined();
		expect(result.diagnostics.parse_error_details).toContainEqual(
			expect.objectContaining({
				field: 'clean_attestation',
				message:
					'CLEAN attestation cannot come from a degraded or partial artifact',
			}),
		);
	});

	test('header-only zero output remains unattested', () => {
		const result = parseCandidates(
			input(microHeader),
			flags({ expected_family: 'micro_lane' }),
		) as ReturnType<typeof parseCandidates> & { clean_attestation?: unknown };
		expect(result.candidates).toEqual([]);
		expect(result.clean_attestation).toBeUndefined();
	});
});
