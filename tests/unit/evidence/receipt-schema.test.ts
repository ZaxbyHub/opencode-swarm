import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	canonicalReceiptJson,
	computeReceiptHash,
	ensureReceiptBounds,
	isValidReceiptUnitId,
	MAX_RECEIPT_ARTIFACTS,
	MAX_RECEIPT_GATES,
	MAX_RECEIPT_JSON_BYTES,
	RECEIPT_FORMAT_VERSION,
	ReceiptGateRecordSchema,
	VerificationReceiptSchema,
} from '../../../src/evidence/receipt';
import { toPortableRelativePath } from '../../../src/tools/phase-complete/snapshot-identity';

function makeGate(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		gate_id: 'snapshot_identity',
		outcome: 'pass',
		responsible_actor: 'architect',
		evidence_refs: ['plan-structure:abc'],
		...overrides,
	};
}

function makeReceipt(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const base = {
		format_version: RECEIPT_FORMAT_VERSION,
		kind: 'phase',
		unit_id: '1',
		generated_at: '2026-11-02T00:00:00.000Z',
		plugin_version: '7.0.0',
		snapshot: { plan_structure: 'a'.repeat(64) },
		gates: [makeGate()],
		artifacts: [
			{
				path: '.swarm/evidence/receipts/phase-1-abc.json',
				sha256: 'b'.repeat(64),
				bytes: 10,
			},
		],
		report_hash: 'c'.repeat(64),
	};
	const merged = { ...base, ...overrides };
	return { ...merged, receipt_hash: computeReceiptHash(merged) };
}

describe('receipt schema and canonical hashing', () => {
	test('minimal and maximal receipts round-trip through the schema', () => {
		const minimal = VerificationReceiptSchema.parse(makeReceipt());
		expect(minimal.format_version).toBe('1.0.0');
		expect(minimal.receipt_hash).toHaveLength(64);
		const maximal = VerificationReceiptSchema.parse(
			makeReceipt({
				gates: Array.from({ length: 8 }, (_unused, index) =>
					makeGate({
						gate_id: `gate-${index}`,
						outcome: 'not_applicable',
						code: 'G00',
						command: 'bun test x',
						exit_code: 0,
						output_digest: 'd'.repeat(64),
						detail_digest: 'e'.repeat(64),
					}),
				),
				snapshot: {
					plan_structure: 'a'.repeat(64),
					policy: 'f'.repeat(64),
					phase_evidence: '1'.repeat(64),
				},
			}),
		);
		expect(maximal.gates).toHaveLength(8);
	});

	test('canonicalReceiptJson is key-order independent (determinism)', () => {
		const left = { z: 1, a: { y: [2, { b: 1, a: 2 }], x: 's' }, m: 3 };
		const right = { m: 3, a: { x: 's', y: [2, { a: 2, b: 1 }] }, z: 1 };
		expect(canonicalReceiptJson(left)).toBe(canonicalReceiptJson(right));
		expect(canonicalReceiptJson(left)).toBe(
			JSON.stringify({ a: { x: 's', y: [2, { a: 2, b: 1 }] }, m: 3, z: 1 }),
		);
	});

	test('receipt_hash excludes itself: recomputing over the parsed receipt minus receipt_hash reproduces it', () => {
		const receipt = makeReceipt();
		const { receipt_hash: _hash, ...rest } = receipt;
		expect(computeReceiptHash(rest)).toBe(receipt.receipt_hash);
	});

	test('raw-object hashing: an unknown added field changes receipt_hash (no silent Zod strip)', () => {
		const receipt = makeReceipt();
		const tampered = { ...receipt, extra_field: 'added' };
		const { receipt_hash: _h, ...rest } = tampered;
		expect(computeReceiptHash(rest)).not.toBe(receipt.receipt_hash);
	});

	test('path normalization: backslash and forward forms produce identical portable paths', () => {
		const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
		const sep = process.platform === 'win32' ? '\\' : '/';
		const portable = toPortableRelativePath(
			root,
			`${root}${sep}a${sep}b${sep}c.json`,
		);
		expect(portable).toBe('a/b/c.json');
	});

	test('path normalization is byte-exact without case-folding', () => {
		const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
		const sep = process.platform === 'win32' ? '\\' : '/';
		const upper = toPortableRelativePath(root, `${root}${sep}A.json`);
		const lower = toPortableRelativePath(root, `${root}${sep}a.json`);
		expect(upper).not.toBe(lower);
		expect(canonicalReceiptJson({ p: upper })).not.toBe(
			canonicalReceiptJson({ p: lower }),
		);
	});

	test('truthfulness: a task-kind record with no durable command omits command/exit_code/output_digest keys entirely', () => {
		const record = ReceiptGateRecordSchema.parse(makeGate());
		expect('command' in record).toBe(false);
		expect('exit_code' in record).toBe(false);
		expect('output_digest' in record).toBe(false);
	});

	test('unit id grammar rejects traversal-shaped and oversized ids', () => {
		expect(isValidReceiptUnitId('phase', '1')).toBe(true);
		expect(isValidReceiptUnitId('task', '1.1')).toBe(true);
		expect(isValidReceiptUnitId('task', 'a-b_C.d')).toBe(true);
		expect(isValidReceiptUnitId('phase', '1x')).toBe(false);
		expect(isValidReceiptUnitId('task', '../escape')).toBe(false);
		expect(isValidReceiptUnitId('task', '..\\escape')).toBe(false);
		expect(isValidReceiptUnitId('task', 'C:\\x')).toBe(false);
		expect(isValidReceiptUnitId('task', '\\\\srv\\share')).toBe(false);
		expect(isValidReceiptUnitId('task', '.hidden')).toBe(false);
		expect(isValidReceiptUnitId('task', '')).toBe(false);
		expect(isValidReceiptUnitId('task', 'x'.repeat(65))).toBe(false);
	});

	test('bound: gate count at 64 passes and 65 throws (MAX_RECEIPT_GATES)', () => {
		const gates = Array.from({ length: MAX_RECEIPT_GATES }, () => makeGate());
		expect(() => ensureReceiptBounds({ gates, artifacts: [] })).not.toThrow();
		expect(() =>
			ensureReceiptBounds({
				gates: [...gates, makeGate()],
				artifacts: [],
			}),
		).toThrow('RECEIPT_GATE_LIMIT');
	});

	test('bound: artifact count at 512 passes and 513 throws (MAX_RECEIPT_ARTIFACTS)', () => {
		const artifacts = Array.from(
			{ length: MAX_RECEIPT_ARTIFACTS },
			(_unused, index) => ({
				path: `a/${index}.json`,
				sha256: createHash('sha256').update(String(index)).digest('hex'),
				bytes: 1,
			}),
		);
		expect(() => ensureReceiptBounds({ gates: [], artifacts })).not.toThrow();
		expect(() =>
			ensureReceiptBounds({
				gates: [],
				artifacts: [...artifacts, artifacts[0]],
			}),
		).toThrow('RECEIPT_ARTIFACT_LIMIT');
	});

	test('bound: receipt JSON at the 256 KiB cap passes and over it throws', () => {
		const atCap = makeReceipt({
			snapshot: { plan_structure: 'a'.repeat(64) },
			gates: [
				makeGate({
					evidence_refs: Array.from(
						{ length: 4200 },
						(_unused, index) => `ref-${index}-${'r'.repeat(50)}`,
					),
				}),
			],
		});
		const sizeAtCap = Buffer.byteLength(canonicalReceiptJson(atCap));
		expect(sizeAtCap).toBeLessThanOrEqual(MAX_RECEIPT_JSON_BYTES);
		expect(() => ensureReceiptBounds(atCap as never)).not.toThrow();
		const overCap = makeReceipt({
			gates: [
				makeGate({
					evidence_refs: Array.from(
						{ length: 4600 },
						(_unused, index) => `ref-${index}-${'r'.repeat(50)}`,
					),
				}),
			],
		});
		expect(Buffer.byteLength(canonicalReceiptJson(overCap))).toBeGreaterThan(
			MAX_RECEIPT_JSON_BYTES,
		);
		expect(() => ensureReceiptBounds(overCap as never)).toThrow(
			'RECEIPT_JSON_BYTE_LIMIT',
		);
	});
});
