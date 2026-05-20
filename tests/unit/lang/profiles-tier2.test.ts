/**
 * Tier 2 Language Profile Registry Tests
 * Tests for Java, Kotlin, C#, C/C++, and Swift profiles
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import {
	LANGUAGE_REGISTRY,
	type LanguageProfile,
	LanguageRegistry,
} from '../../../src/lang/profiles';

// Create a test registry isolated from the global one
const TEST_REGISTRY = new LanguageRegistry();

describe('Tier 2 Language Profile Registry - Verification Tests', () => {
	beforeAll(() => {
		// Re-register all profiles into test registry to ensure fresh state
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		for (const profile of allProfiles) {
			TEST_REGISTRY.register({ ...profile });
		}
	});

	it('1. getTier(2) returns exactly 5 profiles', () => {
		const tier2Profiles = TEST_REGISTRY.getTier(2);
		expect(tier2Profiles).toHaveLength(5);
	});

	it('2. getTier(1) still returns exactly 4 profiles (Tier 1 unchanged)', () => {
		const tier1Profiles = TEST_REGISTRY.getTier(1);
		expect(tier1Profiles).toHaveLength(4);
	});

	it('3. LANGUAGE_REGISTRY.getAll() returns exactly 9 profiles total', () => {
		const allProfiles = TEST_REGISTRY.getAll();
		expect(allProfiles).toHaveLength(12);
	});

	it('4. getByExtension(".java") returns java profile', () => {
		const javaProfile = TEST_REGISTRY.getByExtension('.java');
		expect(javaProfile).toBeDefined();
		expect(javaProfile?.id).toBe('java');
	});

	it('5. getByExtension(".kt") returns kotlin profile', () => {
		const ktProfile = TEST_REGISTRY.getByExtension('.kt');
		expect(ktProfile).toBeDefined();
		expect(ktProfile?.id).toBe('kotlin');
	});

	it('6. getByExtension(".kts") returns kotlin profile', () => {
		const ktsProfile = TEST_REGISTRY.getByExtension('.kts');
		expect(ktsProfile).toBeDefined();
		expect(ktsProfile?.id).toBe('kotlin');
	});

	it('7. getByExtension(".cs") returns csharp profile', () => {
		const csProfile = TEST_REGISTRY.getByExtension('.cs');
		expect(csProfile).toBeDefined();
		expect(csProfile?.id).toBe('csharp');
	});

	it('7b. csharp profile treeSitter.grammarId is "csharp" (no underscore — required by sanitizeLanguageId)', () => {
		const csharpProfile = TEST_REGISTRY.getById('csharp');
		expect(csharpProfile?.treeSitter.grammarId).toBe('csharp');
	});

	it('7c. csharp profile treeSitter.wasmFile uses hyphen (matches actual file tree-sitter-c-sharp.wasm)', () => {
		const csharpProfile = TEST_REGISTRY.getById('csharp');
		expect(csharpProfile?.treeSitter.wasmFile).toBe('tree-sitter-c-sharp.wasm');
	});

	it('8. getByExtension(".cpp") returns cpp profile', () => {
		const cppProfile = TEST_REGISTRY.getByExtension('.cpp');
		expect(cppProfile).toBeDefined();
		expect(cppProfile?.id).toBe('cpp');
	});

	it('9. getByExtension(".h") returns cpp profile', () => {
		const hProfile = TEST_REGISTRY.getByExtension('.h');
		expect(hProfile).toBeDefined();
		expect(hProfile?.id).toBe('cpp');
	});

	it('10. getByExtension(".swift") returns swift profile', () => {
		const swiftProfile = TEST_REGISTRY.getByExtension('.swift');
		expect(swiftProfile).toBeDefined();
		expect(swiftProfile?.id).toBe('swift');
	});

	it('11. All 5 Tier 2 profiles have >= 3 coderConstraints', () => {
		const tier2Profiles = TEST_REGISTRY.getTier(2);
		for (const profile of tier2Profiles) {
			expect(profile.prompts.coderConstraints.length).toBeGreaterThanOrEqual(3);
		}
	});

	it('12. All 5 Tier 2 profiles have >= 3 reviewerChecklist items', () => {
		const tier2Profiles = TEST_REGISTRY.getTier(2);
		for (const profile of tier2Profiles) {
			expect(profile.prompts.reviewerChecklist.length).toBeGreaterThanOrEqual(
				3,
			);
		}
	});

	it('13. No extension collision between Tier 1 (.ts .js .py .rs .go) and Tier 2 extensions', () => {
		const tier1Profiles = TEST_REGISTRY.getTier(1);
		const tier1Extensions = new Set<string>();
		for (const profile of tier1Profiles) {
			for (const ext of profile.extensions) {
				tier1Extensions.add(ext);
			}
		}

		const tier2Profiles = TEST_REGISTRY.getTier(2);
		for (const profile of tier2Profiles) {
			for (const ext of profile.extensions) {
				expect(tier1Extensions.has(ext)).toBe(false);
			}
		}
	});

	it('14. C/C++ profile covers all 6 extensions: .c .h .cpp .hpp .cc .cxx', () => {
		const cppProfile = TEST_REGISTRY.getById('cpp');
		expect(cppProfile).toBeDefined();
		const expectedExtensions = ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'];
		expect(cppProfile?.extensions).toEqual(
			expect.arrayContaining(expectedExtensions),
		);
		expect(cppProfile?.extensions).toHaveLength(6);
	});

	it('15. Java and Kotlin audit.command is null; C# audit.command is non-null', () => {
		const javaProfile = TEST_REGISTRY.getById('java');
		const kotlinProfile = TEST_REGISTRY.getById('kotlin');
		const csharpProfile = TEST_REGISTRY.getById('csharp');

		expect(javaProfile?.audit.command).toBeNull();
		expect(kotlinProfile?.audit.command).toBeNull();
		expect(csharpProfile?.audit.command).not.toBeNull();
		expect(csharpProfile?.audit.command).toBeTruthy();
	});
});

describe('Tier 2 Language Profile Registry - Adversarial Tests', () => {
	it('16. getByExtension(".JAVA") returns undefined (case-sensitive)', () => {
		const javaProfile = TEST_REGISTRY.getByExtension('.JAVA');
		expect(javaProfile).toBeUndefined();
	});

	it('17. getByExtension(".CPP") returns undefined (case-sensitive)', () => {
		const cppProfile = TEST_REGISTRY.getByExtension('.CPP');
		expect(cppProfile).toBeUndefined();
	});

	it('18. getByExtension(".TS") returns undefined still (unchanged by Tier 2 registrations)', () => {
		const tsProfile = TEST_REGISTRY.getByExtension('.TS');
		expect(tsProfile).toBeUndefined();
	});

	it('19. register() throws on duplicate id (id: "java")', () => {
		// Create a fresh registry for this test
		const isolatedRegistry = new LanguageRegistry();

		// Register original java profile
		const originalJava: LanguageProfile = {
			id: 'java',
			displayName: 'Java Original',
			tier: 2,
			extensions: ['.java'],
			treeSitter: {
				grammarId: 'java',
				wasmFile: 'tree-sitter-java.wasm',
				commentNodes: ['line_comment', 'block_comment'],
			},
			build: { detectFiles: ['pom.xml'], commands: [] },
			test: { detectFiles: ['pom.xml'], frameworks: [] },
			lint: { detectFiles: ['pom.xml'], linters: [] },
			audit: { detectFiles: ['pom.xml'], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: 'java', semgrepSupport: 'ga' },
			prompts: {
				coderConstraints: ['original constraint'],
				reviewerChecklist: ['original checklist'],
			},
		};

		isolatedRegistry.register(originalJava);
		expect(isolatedRegistry.getById('java')?.displayName).toBe('Java Original');

		// Behavior change (Phase 1 of language-agnostic refactor): the registry
		// now throws on duplicate id registration. The previous silent-overwrite
		// behavior allowed a misregistered aux profile to silently replace a
		// primary profile. See src/lang/profiles.ts:LanguageRegistry.register.
		const newJava: LanguageProfile = {
			id: 'java',
			displayName: 'Java Overwritten',
			tier: 2,
			extensions: ['.kt'], // different extension to isolate the id-collision check
			treeSitter: {
				grammarId: 'java',
				wasmFile: 'tree-sitter-java.wasm',
				commentNodes: ['line_comment', 'block_comment'],
			},
			build: { detectFiles: [], commands: [] },
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		expect(() => isolatedRegistry.register(newJava)).toThrow(
			/profile id "java" registered twice/,
		);

		// Original profile remains intact.
		const retrieved = isolatedRegistry.getById('java');
		expect(retrieved?.displayName).toBe('Java Original');
		expect(retrieved?.prompts.coderConstraints).toEqual([
			'original constraint',
		]);
	});
});
