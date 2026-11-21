/**
 * #3844 fold-in (owner-directed; closes #3899): the six deferred persisted-
 * evidence boundaries now redact at their write sites — completion-verify
 * blocked-task fields, the drift/hallucination/mutation evidence summaries,
 * the core-events writer's free-text carriers, and the gate-evidence
 * passthrough extras. Each leg asserts token ABSENCE from the durable
 * artifact plus benign byte-identity. Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	appendCoreEventSync,
	appendCoreEventsSync,
} from '../../../src/events/core-events';
import { withTaskEvidenceTransaction } from '../../../src/gate-evidence';
import { completion_verify } from '../../../src/tools/completion-verify';
import { write_drift_evidence } from '../../../src/tools/write-drift-evidence';
import { write_hallucination_evidence } from '../../../src/tools/write-hallucination-evidence';
import { write_mutation_evidence } from '../../../src/tools/write-mutation-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TOKEN = `ghp_${'k'.repeat(30)}`;
const SISTER = `sk-ant-${'m'.repeat(24)}`;

function ctx(directory: string) {
	return { directory, sessionID: 'foldin-3844' } as never;
}

describe('#3844 fold-in: six persisted-evidence boundaries (#3899 AC1-6)', () => {
	test('AC1: completion-verify persists blocked tasks redacted, result keeps raw', async () => {
		const dir = canonicalMkdtemp('foldin-3844-cv-');
		const planDir = path.join(dir, '.swarm');
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'one',
						tasks: [
							{
								id: 't1',
								// The plan description is MODEL-AUTHORED — the
								// quoted file path it names (with a token pasted
								// in) is what lands in blocked_tasks.file_path.
								description: `implement \`src/${TOKEN}.ts\` wiring`,
								status: 'completed',
							},
						],
					},
				],
			}),
			'utf8',
		);
		const out = JSON.parse(
			(await completion_verify.execute({ phase: 1 }, ctx(dir))) as string,
		) as { blockedTasks: Array<{ file_path: string }> };
		// The in-memory result keeps the parsed (raw) path.
		expect(out.blockedTasks[0]?.file_path.includes(TOKEN)).toBe(true);
		const bundle = readFileSync(
			path.join(planDir, 'evidence', '1', 'completion-verify.json'),
			'utf8',
		);
		expect(bundle.includes(TOKEN)).toBe(false); // durable copy redacted
		expect(bundle).toContain('[REDACTED:github]');
		// Benign structural content survives byte-identically.
		expect(bundle).toContain('"task_id": "t1"');
	}, 60_000);

	test('AC2: drift evidence summary redacted in the durable artifact', async () => {
		const dir = canonicalMkdtemp('foldin-3844-drift-');
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const out = (await write_drift_evidence.execute(
			{
				phase: 1,
				verdict: 'NEEDS_REVISION',
				summary: `drift verdict prose mentioning ${TOKEN} inline`,
				working_directory: dir,
			},
			ctx(dir),
		)) as string;
		expect(out).toContain('"success": true');
		const file = readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', 'drift-verifier.json'),
			'utf8',
		);
		expect(file.includes(TOKEN)).toBe(false);
		expect(file).toContain('[REDACTED:github]');
		// normalizeVerdict2 maps NEEDS_REVISION -> "rejected" (benign intact).
		expect(file).toContain('"verdict": "rejected"');
	}, 60_000);

	test('AC3: hallucination evidence summary redacted in the durable artifact', async () => {
		const dir = canonicalMkdtemp('foldin-3844-hall-');
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const out = (await write_hallucination_evidence.execute(
			{
				phase: 1,
				verdict: 'NEEDS_REVISION',
				summary: `hallucination scan saw ${TOKEN} in prose`,
				findings: [],
				working_directory: dir,
			},
			ctx(dir),
		)) as string;
		expect(out).toContain('"success": true');
		const file = readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', 'hallucination-guard.json'),
			'utf8',
		);
		expect(file.includes(TOKEN)).toBe(false);
		expect(file).toContain('[REDACTED:github]');
		expect(file).toContain('"verdict": "rejected"');
	}, 60_000);

	test('AC4: mutation evidence summary redacted in the durable artifact', async () => {
		const dir = canonicalMkdtemp('foldin-3844-mut-');
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const out = (await write_mutation_evidence.execute(
			{
				phase: 1,
				verdict: 'PASS',
				killRate: 0.9,
				summary: `mutation gate notes reference ${SISTER} once`,
				working_directory: dir,
			},
			ctx(dir),
		)) as string;
		expect(out).toContain('"success": true');
		const file = readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', 'mutation-gate.json'),
			'utf8',
		);
		expect(file.includes(SISTER)).toBe(false);
		expect(file).toContain('[REDACTED:anthropic]');
		expect(file).toContain('"killRate": 0.9'); // benign numeric intact
	}, 60_000);

	test('AC5: core-events writer redacts free-text carriers by default; structure unchanged', () => {
		const dir = canonicalMkdtemp('foldin-3844-ev-');
		appendCoreEventSync(dir, {
			type: 'provider_failure',
			sessionId: 's-1',
			detail: `provider said ${TOKEN} in its error body`,
			message: `fallback message with ${SISTER} too`,
			description: `observation description quoting ${TOKEN} (round-9 carrier)`,
			attempt: 3,
			nested: { note: 'structural payload stays reachable' },
		});
		const line = readFileSync(path.join(dir, '.swarm', 'events.jsonl'), 'utf8');
		expect(line.includes(TOKEN)).toBe(false);
		expect(line.includes(SISTER)).toBe(false);
		expect(line).toContain('[REDACTED:github]');
		expect(line).toContain('[REDACTED:anthropic]');
		// Structural identity preserved: ids, numbers, nested objects verbatim.
		expect(line).toContain('"sessionId":"s-1"');
		expect(line).toContain('"attempt":3');
		expect(line).toContain(
			'"nested":{"note":"structural payload stays reachable"}',
		);
	}, 60_000);

	test('AC5: BATCH writer redacts the same carriers; benign batch lines byte-identical; authority dedupe on originals', () => {
		const dir = canonicalMkdtemp('foldin-3844-evbatch-');
		// Round-9 finding leg 1: the batch writer previously serialized raw.
		appendCoreEventsSync(dir, [
			{
				type: 'provider_failure',
				sessionId: 's-b1',
				detail: `batch detail carrying ${TOKEN}`,
				description: `batch description carrying ${SISTER}`,
				attempt: 1,
			},
			{
				type: 'provider_failure',
				sessionId: 's-b2',
				detail: 'benign batch detail',
				attempt: 2,
			},
		]);
		const lines = readFileSync(path.join(dir, '.swarm', 'events.jsonl'), 'utf8')
			.split('\n')
			.filter(
				(l) =>
					l.length > 0 && !l.includes('swarm-events-manifest'),
			);
		expect(lines).toHaveLength(2);
		const first = lines[0] as string;
		expect(first.includes(TOKEN)).toBe(false);
		expect(first.includes(SISTER)).toBe(false);
		expect(first).toContain('[REDACTED:github]');
		expect(first).toContain('[REDACTED:anthropic]');
		// Benign batch line round-trips byte-identically.
		expect(lines[1]).toBe(
			'{"type":"provider_failure","sessionId":"s-b2","detail":"benign batch detail","attempt":2}',
		);
		// Authority dedupe still keys on the ORIGINAL events: a second,
		// token-bearing-but-same-key append is SKIPPED, and the persisted
		// line count stays 2 (the first, redacted copy won).
		appendCoreEventsSync(
			dir,
			[
				{
					type: 'coder_retry_circuit_breaker',
					sessionId: 's-auth',
					taskId: '1.1',
					retryEpoch: 0,
					action: 'sounding_board_consultation',
					detail: `retry detail with ${TOKEN}`,
				},
			],
			{ dedupeOnAuthorityKey: true },
		);
		appendCoreEventsSync(
			dir,
			[
				{
					type: 'coder_retry_circuit_breaker',
					sessionId: 's-auth',
					taskId: '1.1',
					retryEpoch: 0,
					action: 'sounding_board_consultation',
					detail: 'different raw detail, same authority key',
				},
			],
			{ dedupeOnAuthorityKey: true },
		);
		const after = readFileSync(path.join(dir, '.swarm', 'events.jsonl'), 'utf8')
			.split('\n')
			.filter(
				(l) =>
					l.length > 0 && !l.includes('swarm-events-manifest'),
			);
		expect(after).toHaveLength(3); // 2 provider + ONE deduped authority line
		expect(after.join('\n').includes(TOKEN)).toBe(false);
	}, 60_000);

	test('AC6: gate-evidence passthrough extras redacted at persist; in-memory untouched', async () => {
		const dir = canonicalMkdtemp('foldin-3844-gate-');
		mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
		await withTaskEvidenceTransaction(dir, '1.1', 'reviewer', async (tx) => {
			await tx.save({
				taskId: '1.1',
				required_gates: ['review'],
				gates: {
					review: {
						sessionId: 'sess-raw-id',
						timestamp: '2026-11-21T00:00:00.000Z',
						agent: 'reviewer',
						// council-specific passthrough extras carrying a secret
						verdict: `APPROVED with caveat about ${TOKEN}`,
						vetoedBy: `critic quote mentioning ${SISTER}`,
					},
				},
			});
		});
		const file = readFileSync(
			path.join(dir, '.swarm', 'evidence', '1.1.json'),
			'utf8',
		);
		expect(file.includes(TOKEN)).toBe(false);
		expect(file.includes(SISTER)).toBe(false);
		expect(file).toContain('[REDACTED:github]');
		expect(file).toContain('[REDACTED:anthropic]');
		// Declared structural fields pass through verbatim.
		expect(file).toContain('"sessionId": "sess-raw-id"');
		expect(file).toContain('"timestamp": "2026-11-21T00:00:00.000Z"');
		expect(file).toContain('"agent": "reviewer"');
		// Benign prose inside the redacted extras survives byte-identically.
		expect(file).toContain('APPROVED with caveat about');
	}, 60_000);
});
