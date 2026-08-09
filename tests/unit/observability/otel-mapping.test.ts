/**
 * OTel GenAI / OpenInference mapping versions are pinned independently of
 * `OBSERVABILITY_SCHEMA_VERSION` (issue #2029 item 6).
 */
import { describe, expect, test } from 'bun:test';
import { OBSERVABILITY_SCHEMA_VERSION } from '../../../src/observability/envelope.js';
import {
	mappingForEntry,
	OPENINFERENCE_ATTRIBUTES,
	OPENINFERENCE_MAPPING_VERSION,
	OTEL_GENAI_ATTRIBUTES,
	OTEL_GENAI_MAPPING_VERSION,
} from '../../../src/observability/otel-mapping.js';

describe('OTel mapping versions — pinned independently', () => {
	test('OTEL_GENAI_MAPPING_VERSION is non-empty', () => {
		expect(typeof OTEL_GENAI_MAPPING_VERSION).toBe('string');
		expect(OTEL_GENAI_MAPPING_VERSION.length).toBeGreaterThan(0);
	});

	test('OPENINFERENCE_MAPPING_VERSION is non-empty', () => {
		expect(typeof OPENINFERENCE_MAPPING_VERSION).toBe('string');
		expect(OPENINFERENCE_MAPPING_VERSION.length).toBeGreaterThan(0);
	});

	test('OTEL_GENAI_MAPPING_VERSION is NOT equal to String(OBSERVABILITY_SCHEMA_VERSION)', () => {
		expect(OTEL_GENAI_MAPPING_VERSION).not.toBe(
			String(OBSERVABILITY_SCHEMA_VERSION),
		);
	});

	test('OPENINFERENCE_MAPPING_VERSION is NOT equal to String(OBSERVABILITY_SCHEMA_VERSION)', () => {
		expect(OPENINFERENCE_MAPPING_VERSION).not.toBe(
			String(OBSERVABILITY_SCHEMA_VERSION),
		);
	});

	test('the two external mapping versions are independently pinned from each other too', () => {
		// They need not differ by contract, but this repo's actual pins do — a
		// coincidental equality would mask the "pinned independently" claim if the
		// two constants were accidentally aliased to the same literal/variable.
		expect(OTEL_GENAI_MAPPING_VERSION).not.toBe(OPENINFERENCE_MAPPING_VERSION);
	});
});

describe('mappingForEntry', () => {
	test("'none' returns an empty table", () => {
		const table = mappingForEntry('none');
		expect(Object.keys(table).length).toBe(0);
	});

	test("'genai' returns the non-empty GenAI attribute table", () => {
		const table = mappingForEntry('genai');
		expect(Object.keys(table).length).toBeGreaterThan(0);
		expect(table).toBe(OTEL_GENAI_ATTRIBUTES);
	});

	test("'openinference' returns the non-empty OpenInference attribute table", () => {
		const table = mappingForEntry('openinference');
		expect(Object.keys(table).length).toBeGreaterThan(0);
		expect(table).toBe(OPENINFERENCE_ATTRIBUTES);
	});

	test("'none' table is distinct from both non-empty tables", () => {
		const noneTable = mappingForEntry('none');
		expect(noneTable).not.toBe(OTEL_GENAI_ATTRIBUTES);
		expect(noneTable).not.toBe(OPENINFERENCE_ATTRIBUTES);
	});
});
