/** Acceptance coverage for issue #2490 / AC11.
 *
 * The manifest is a NEW-SURFACE contract on the baseline.  The test remains
 * deliberately data-driven so adding a supported language does not require a
 * versioned test edit.
 */

import { describe, expect, test } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import { languageDefinitions } from '../../../src/lang/registry';

const DOCUMENTED_PARSER_ONLY = new Set([
	'c',
	'tsx',
	'css',
	'bash',
	'powershell',
	'ini',
	'regex',
]);

function sameSet(actual: Iterable<string>, expected: Iterable<string>): void {
	expect(new Set(actual)).toEqual(new Set(expected));
}

function isRunnableGate(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().length > 0;
	if (!value || typeof value !== 'object') return false;
	const gate = value as Record<string, unknown>;
	return ['command', 'id', 'identifier', 'script'].some(
		(key) =>
			typeof gate[key] === 'string' && (gate[key] as string).trim() !== '',
	);
}

describe('issue #2490 AC11 — analyzer extension and cross-OS coverage', () => {
	test('publishes analyzer identities for every fixture language and OS gates', async () => {
		const module = (await import(
			'../../../tests/fixtures/memory-recall-heldout/manifest.json'
		)) as {
			default?: Record<string, unknown>;
		};
		const manifest = module.default ?? module;
		const languages = manifest.supported_languages;
		const analyzers = manifest.analyzer_extensions;
		expect(Array.isArray(languages)).toBe(true);
		expect((languages as unknown[]).length).toBeGreaterThan(0);
		const authoritativeLanguages = languageDefinitions.map(
			(definition) => definition.id,
		);
		sameSet(languages as string[], authoritativeLanguages);
		const registryIds = new Set(
			LANGUAGE_REGISTRY.getAll().map((profile) => profile.id),
		);
		const parserOnly = authoritativeLanguages.filter(
			(id) => !registryIds.has(id),
		);
		expect(new Set(parserOnly)).toEqual(DOCUMENTED_PARSER_ONLY);
		expect(Array.isArray(analyzers)).toBe(true);
		const dispatchLanguages = LANGUAGE_REGISTRY.getAll()
			.filter((profile) => !profile.parserOnly)
			.map((profile) => profile.id);
		const analyzerLanguages: string[] = [];
		for (const analyzer of analyzers as Array<Record<string, unknown>>) {
			expect(typeof analyzer.language).toBe('string');
			expect((analyzer.language as string).trim()).not.toBe('');
			expect(typeof analyzer.extractor_id).toBe('string');
			expect((analyzer.extractor_id as string).trim()).not.toBe('');
			analyzerLanguages.push(analyzer.language as string);
		}
		sameSet(analyzerLanguages, dispatchLanguages);
		const osGates = manifest.os_gates as Record<string, unknown> | undefined;
		expect(osGates).toBeDefined();
		for (const platform of ['linux', 'macos', 'windows']) {
			expect(isRunnableGate(osGates?.[platform])).toBe(true);
		}
	});
});
