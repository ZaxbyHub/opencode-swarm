import { describe, expect, test } from 'bun:test';
import {
	CANDIDATE_FIELDS,
	CANDIDATE_HEADERS,
	CLEAN_TEMPLATES,
	formatCandidateHeader,
	formatCleanTemplate,
} from '../../../src/background/candidate-contract.js';

describe('candidate contract formatters', () => {
	test.each([
		'base_explorer',
		'micro_lane',
	] as const)('formats the canonical %s header from CANDIDATE_FIELDS', (family) => {
		const expectedFields = CANDIDATE_FIELDS[family].map((field) =>
			field === 'file_line' ? 'file:line' : field,
		);
		const expected = ['[CANDIDATE]', ...expectedFields].join(' | ');

		expect(formatCandidateHeader(family)).toBe(expected);
		expect(CANDIDATE_HEADERS[family]).toBe(expected);
	});

	test.each([
		['base_explorer', '[CLEAN] | lane | coverage_scope | evidence'],
		['micro_lane', '[CLEAN] | micro_lane | coverage_scope | evidence'],
	] as const)('formats the canonical %s CLEAN template', (family, expected) => {
		expect(formatCleanTemplate(family)).toBe(expected);
		expect(CLEAN_TEMPLATES[family]).toBe(expected);
	});
});
