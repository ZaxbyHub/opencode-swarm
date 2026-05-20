import { describe, expect, test } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import { languageDefinitions } from '../../../src/lang/registry';

/**
 * Phase 1 parity test — guards against future drift between the two language
 * registries:
 *
 *   - `src/lang/profiles.ts` (LANGUAGE_REGISTRY) — 12 high-level language
 *     profiles with build / test / lint / audit / SAST / prompt metadata.
 *     Used by the build-discovery, syntax-check, sast-scan, and (later)
 *     LanguageBackend dispatch paths.
 *   - `src/lang/registry.ts` (languageDefinitions) — 20 fine-grained
 *     tree-sitter parser entries (12 in common with above + 8 split or
 *     parser-only: javascript, c, tsx, css, bash, powershell, ini, regex).
 *     Used by ast-diff, syntax-check's parser-only paths.
 *
 * They serve different concerns and intentionally do NOT have the same
 * id space. This test does not try to unify them; it asserts that:
 *
 *   1. For every language id that appears in BOTH registries, their
 *      tree-sitter `commentNodes` agree. Profiles.ts is the source of truth;
 *      this test catches divergence introduced by editing only one file.
 *   2. Every profile in LANGUAGE_REGISTRY has the new
 *      `treeSitter.commentNodes` field populated as a non-empty array.
 *   3. The asymmetry list is exactly the documented set
 *      (registry-only: javascript, c, tsx, css, bash, powershell, ini, regex).
 *      Adding a new parser entry in registry.ts that isn't a documented
 *      asymmetry (and isn't a profile either) would fail this test —
 *      forcing the contributor to either add a profile or document why.
 */
describe('LANGUAGE_REGISTRY ↔ languageDefinitions parity', () => {
	const profileIds = new Set(LANGUAGE_REGISTRY.getAll().map((p) => p.id));
	const definitionIds = new Set(languageDefinitions.map((d) => d.id));

	test('every production profile populates treeSitter.commentNodes', () => {
		// commentNodes is typed as optional (so tests can construct fixtures
		// without it), but every profile shipped in LANGUAGE_REGISTRY must
		// populate it — drift here means a real production language was
		// added without declaring its tree-sitter comment node names, which
		// breaks comment-stripping in ast-diff / syntax-check.
		for (const profile of LANGUAGE_REGISTRY.getAll()) {
			expect(Array.isArray(profile.treeSitter.commentNodes)).toBe(true);
			expect(profile.treeSitter.commentNodes!.length).toBeGreaterThan(0);
		}
	});

	test('shared ids agree on commentNodes', () => {
		const shared = [...profileIds].filter((id) => definitionIds.has(id));
		expect(shared.length).toBeGreaterThan(0);
		for (const id of shared) {
			const profile = LANGUAGE_REGISTRY.getById(id);
			const definition = languageDefinitions.find((d) => d.id === id);
			expect(profile).toBeDefined();
			expect(definition).toBeDefined();
			expect(profile!.treeSitter.commentNodes).toBeDefined();
			expect([...profile!.treeSitter.commentNodes!].sort()).toEqual(
				[...definition!.commentNodes].sort(),
			);
		}
	});

	test('registry-only ids match the documented asymmetry list', () => {
		const REGISTRY_ONLY_DOCUMENTED = new Set([
			// JS / TS family splits — tree-sitter has separate grammars for these
			// even though the typescript profile covers all six extensions.
			'javascript',
			'tsx',
			// C / C++ split — tree-sitter has separate grammars; the cpp profile
			// covers both for build/test/lint dispatch.
			'c',
			// Parser-only languages — no build/test/lint dispatch is meaningful;
			// they exist to provide a parser for syntax-check / ast-diff.
			'css',
			'bash',
			'powershell',
			'ini',
			'regex',
		]);
		const registryOnly = [...definitionIds].filter((id) => !profileIds.has(id));
		const registryOnlySet = new Set(registryOnly);
		// Set equality
		expect(registryOnlySet.size).toBe(REGISTRY_ONLY_DOCUMENTED.size);
		for (const id of REGISTRY_ONLY_DOCUMENTED) {
			expect(registryOnlySet.has(id)).toBe(true);
		}
	});

	test('profile-only ids match the documented asymmetry list', () => {
		// Profiles that have no parser-registry counterpart at the same id.
		// All profile ids currently have a tree-sitter grammar, so this set
		// should be empty. If it grows, you must either add an entry to
		// registry.ts or document why the profile lacks parser support.
		const PROFILE_ONLY_DOCUMENTED = new Set<string>([]);
		const profileOnly = [...profileIds].filter((id) => !definitionIds.has(id));
		const profileOnlySet = new Set(profileOnly);
		expect(profileOnlySet.size).toBe(PROFILE_ONLY_DOCUMENTED.size);
		for (const id of PROFILE_ONLY_DOCUMENTED) {
			expect(profileOnlySet.has(id)).toBe(true);
		}
	});

	test('LANGUAGE_REGISTRY has 12 profiles', () => {
		// Sanity: locks the profile count so future additions trigger a
		// matching test update. If this fails after adding a language, also
		// update the asymmetry list above and this number.
		expect(LANGUAGE_REGISTRY.getAll().length).toBe(12);
	});

	test('languageDefinitions has 20 entries', () => {
		// Same sanity for the parser registry.
		expect(languageDefinitions.length).toBe(20);
	});
});

describe('LanguageRegistry duplicate-registration guards', () => {
	test('throws on duplicate non-parserOnly extension claims', () => {
		const { LanguageRegistry } = require('../../../src/lang/profiles');
		const reg = new LanguageRegistry();
		reg.register({
			id: 'a',
			displayName: 'A',
			tier: 1,
			extensions: ['.foo'],
			treeSitter: { grammarId: 'a', wasmFile: 'a.wasm', commentNodes: ['c'] },
			build: { detectFiles: [], commands: [] },
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		});
		expect(() =>
			reg.register({
				id: 'b',
				displayName: 'B',
				tier: 1,
				extensions: ['.foo'],
				treeSitter: { grammarId: 'b', wasmFile: 'b.wasm', commentNodes: ['c'] },
				build: { detectFiles: [], commands: [] },
				test: { detectFiles: [], frameworks: [] },
				lint: { detectFiles: [], linters: [] },
				audit: { detectFiles: [], command: null, outputFormat: 'json' },
				sast: { nativeRuleSet: null, semgrepSupport: 'none' },
				prompts: { coderConstraints: [], reviewerChecklist: [] },
			}),
		).toThrow(/extension ".foo" registered by both/);
	});

	test('throws on duplicate id', () => {
		const { LanguageRegistry } = require('../../../src/lang/profiles');
		const reg = new LanguageRegistry();
		const make = (ext: string) => ({
			id: 'dup',
			displayName: 'Dup',
			tier: 1 as const,
			extensions: [ext],
			treeSitter: {
				grammarId: 'dup',
				wasmFile: 'dup.wasm',
				commentNodes: ['c'],
			},
			build: { detectFiles: [], commands: [] },
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' as const },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' as const },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		});
		reg.register(make('.foo'));
		expect(() => reg.register(make('.bar'))).toThrow(
			/profile id "dup" registered twice/,
		);
	});

	test('register is idempotent for the same profile object reference', () => {
		// Idempotence is a behavioral promise: re-registering the SAME object
		// reference must not throw. This protects against double-registration
		// in module import cycles (rare, but possible) and matches the
		// pre-Phase-1 silent-overwrite semantics for the same-object case.
		// Different-object same-id registration still throws (covered by
		// the duplicate-id test elsewhere).
		const { LanguageRegistry } = require('../../../src/lang/profiles');
		const reg = new LanguageRegistry();
		const profile = {
			id: 'idempotent',
			displayName: 'Idempotent',
			tier: 1 as const,
			extensions: ['.idem'],
			treeSitter: {
				grammarId: 'idem',
				wasmFile: 'idem.wasm',
				commentNodes: ['c'],
			},
			build: { detectFiles: [], commands: [] },
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' as const },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' as const },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};
		reg.register(profile);
		// Same-object re-registration: no throw, no duplicate state.
		expect(() => reg.register(profile)).not.toThrow();
		expect(reg.getById('idempotent')).toBe(profile);
		expect(reg.getByExtension('.idem')?.id).toBe('idempotent');
	});

	test('parserOnly profile may share extension with a non-parserOnly profile', () => {
		const { LanguageRegistry } = require('../../../src/lang/profiles');
		const reg = new LanguageRegistry();
		reg.register({
			id: 'main',
			displayName: 'Main',
			tier: 1,
			extensions: ['.shared'],
			treeSitter: {
				grammarId: 'main',
				wasmFile: 'main.wasm',
				commentNodes: ['c'],
			},
			build: { detectFiles: [], commands: [] },
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		});
		expect(() =>
			reg.register({
				id: 'aux',
				displayName: 'Aux',
				tier: 3,
				extensions: ['.shared'],
				parserOnly: true,
				treeSitter: {
					grammarId: 'aux',
					wasmFile: 'aux.wasm',
					commentNodes: ['c'],
				},
				build: { detectFiles: [], commands: [] },
				test: { detectFiles: [], frameworks: [] },
				lint: { detectFiles: [], linters: [] },
				audit: { detectFiles: [], command: null, outputFormat: 'json' },
				sast: { nativeRuleSet: null, semgrepSupport: 'none' },
				prompts: { coderConstraints: [], reviewerChecklist: [] },
			}),
		).not.toThrow();
		// Extension dispatch still goes to the non-parserOnly profile.
		expect(reg.getByExtension('.shared')?.id).toBe('main');
	});
});
