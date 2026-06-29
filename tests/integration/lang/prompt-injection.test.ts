/**
 * Integration tests for language-specific prompt injection behavior
 *
 * Tests verify the behavior of buildLanguageCoderConstraints and buildLanguageReviewerChecklist
 * helpers from src/hooks/system-enhancer.ts using real profile data (not mocks).
 */

import { describe, expect, it } from 'bun:test';
import { getProfileForFile } from '../../../src/lang/detector';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';

/**
 * Re-create buildLanguageCoderConstraints helper from system-enhancer.ts
 * Uses real getProfileForFile to verify actual profile data flows correctly.
 */
function buildCoderConstraintsIntegration(
	taskText: string | null,
): string | null {
	if (!taskText) return null;

	// Extract file paths from task text (e.g. "src/tools/lint.ts")
	const filePaths = taskText.match(/\bsrc\/\S+\.[a-zA-Z0-9]+\b/g) ?? [];
	if (filePaths.length === 0) return null;

	// Collect unique constraints across all task file paths (max 10 total)
	const allConstraints: string[] = [];
	const seenConstraints = new Set<string>();
	let languageLabel = '';

	for (const filePath of filePaths) {
		const profile = getProfileForFile(filePath);
		if (!profile) continue;
		if (!languageLabel) {
			languageLabel = profile.displayName;
		}
		for (const constraint of profile.prompts.coderConstraints) {
			if (!seenConstraints.has(constraint) && allConstraints.length < 10) {
				seenConstraints.add(constraint);
				allConstraints.push(constraint);
			}
		}
	}

	if (allConstraints.length === 0) return null;

	return `[LANGUAGE-SPECIFIC CONSTRAINTS — ${languageLabel}]\n${allConstraints.map((c) => `- ${c}`).join('\n')}`;
}

/**
 * Re-create buildLanguageReviewerChecklist helper from system-enhancer.ts
 * Uses real getProfileForFile to verify actual profile data flows correctly.
 */
function buildReviewerChecklistIntegration(
	taskText: string | null,
): string | null {
	if (!taskText) return null;

	// Extract file paths from task text (e.g. "src/tools/lint.ts")
	const filePaths = taskText.match(/\bsrc\/\S+\.[a-zA-Z0-9]+\b/g) ?? [];
	if (filePaths.length === 0) return null;

	// Collect unique checklist items across all task file paths (max 10 total)
	const allItems: string[] = [];
	const seenItems = new Set<string>();
	let languageLabel = '';

	for (const filePath of filePaths) {
		const profile = getProfileForFile(filePath);
		if (!profile) continue;
		if (!languageLabel) {
			languageLabel = profile.displayName;
		}
		for (const item of profile.prompts.reviewerChecklist) {
			if (!seenItems.has(item) && allItems.length < 10) {
				seenItems.add(item);
				allItems.push(item);
			}
		}
	}

	if (allItems.length === 0) return null;

	return `[LANGUAGE-SPECIFIC REVIEW CHECKLIST — ${languageLabel}]\n${allItems.map((i) => `- [ ] ${i}`).join('\n')}`;
}

describe('Language-specific prompt injection - Integration tests', () => {
	describe('Coder constraints (real profiles)', () => {
		it('Python file path: returns Python constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration(
				'Update src/tools/lint.py',
			);
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — Python]');
			expect(result).toContain(
				'Use type annotations on all function signatures (PEP 484)',
			);
		});

		it('Rust file path: returns Rust constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration('Update src/main.rs');
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — Rust]');
			expect(result).toContain(
				'Prefer owned types over references where ownership is clear',
			);
		});

		it('Go file path: returns Go constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration('Update src/cmd/main.go');
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — Go]');
			expect(result).toContain(
				'Always check and return errors; never discard error return values',
			);
		});

		it('TypeScript file path: returns TypeScript constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration(
				'Update src/tools/lint.ts',
			);
			expect(result).not.toBeNull();
			expect(result).toContain(
				'[LANGUAGE-SPECIFIC CONSTRAINTS — TypeScript / JavaScript]',
			);
			expect(result).toContain(
				'Use strict TypeScript; no implicit any or type assertions without justification',
			);
		});

		it('Kotlin file path: returns Kotlin constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration('Update src/main.kt');
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — Kotlin]');
			expect(result).toContain(
				'Prefer val over var; use data classes for value objects',
			);
		});

		it('Unknown extension (.xyz): returns null when no profile matches', () => {
			const result = buildCoderConstraintsIntegration(
				'Update src/tools/file.xyz',
			);
			expect(result).toBeNull();
		});

		it('Non-src path: returns null when regex does not match (no src/ prefix)', () => {
			const result = buildCoderConstraintsIntegration(
				'Update tests/unit/hooks/test.ts',
			);
			expect(result).toBeNull();
		});

		it('Multi-language task: merges Rust and Go constraints, uses first language (Rust) in header', () => {
			const result = buildCoderConstraintsIntegration(
				'Update src/main.rs and src/utils/helper.go',
			);
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — Rust]');
			// Should include constraints from both profiles
			expect(result).toContain(
				'Prefer owned types over references where ownership is clear',
			); // Rust
			expect(result).toContain(
				'Always check and return errors; never discard error return values',
			); // Go
		});

		it('Null task text: returns null', () => {
			const result = buildCoderConstraintsIntegration(null);
			expect(result).toBeNull();
		});

		it('Empty task text: returns null', () => {
			const result = buildCoderConstraintsIntegration('');
			expect(result).toBeNull();
		});

		it('No file paths in task text: returns null', () => {
			const result = buildCoderConstraintsIntegration(
				'Please refactor the codebase',
			);
			expect(result).toBeNull();
		});
	});

	describe('Reviewer checklist (real profiles)', () => {
		it('TypeScript reviewer: returns TypeScript checklist with correct header and format', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/hooks/system-enhancer.ts',
			);
			expect(result).not.toBeNull();
			expect(result).toContain(
				'[LANGUAGE-SPECIFIC REVIEW CHECKLIST — TypeScript / JavaScript]',
			);
			expect(result).toContain(
				'- [ ] Verify no implicit any or unsafe type casts',
			);
		});

		it('Python reviewer: returns Python checklist with correct header and format', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/tools/analysis.py',
			);
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC REVIEW CHECKLIST — Python]');
			expect(result).toContain(
				'- [ ] Verify type annotations are present on all public functions',
			);
		});

		it('Ruby reviewer: returns Ruby checklist with correct header and format', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/scripts/deploy.rb',
			);
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC REVIEW CHECKLIST — Ruby]');
			expect(result).toContain(
				'- [ ] Verify frozen_string_literal comment is present in new files',
			);
		});

		it('Architect agent: helper returns non-null (gating done by caller, not helper)', () => {
			// The helper doesn't discriminate by agent type - it returns non-null for any valid src/ path
			// The agent gating is done by the caller in system-enhancer.ts
			const result = buildCoderConstraintsIntegration('Update src/main.ts');
			expect(result).not.toBeNull();
		});

		it('C# reviewer: returns C# checklist with correct header and format', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/services/data.cs',
			);
			expect(result).not.toBeNull();
			expect(result).toContain(
				'[LANGUAGE-SPECIFIC REVIEW CHECKLIST — C# / .NET]',
			);
			expect(result).toContain(
				'- [ ] Verify no .Result or .Wait() calls that could cause deadlocks',
			);
		});

		it('Java reviewer: returns Java checklist with correct header and format', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/main/java/App.java',
			);
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC REVIEW CHECKLIST — Java]');
			expect(result).toContain(
				'- [ ] Check for unclosed resources — verify try-with-resources or explicit close()',
			);
		});

		it('Dart reviewer: returns Dart checklist with correct header and format', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/lib/main.dart',
			);
			expect(result).not.toBeNull();
			expect(result).toContain(
				'[LANGUAGE-SPECIFIC REVIEW CHECKLIST — Dart / Flutter]',
			);
			expect(result).toContain(
				'- [ ] Verify null safety annotations are correct (no unnecessary ?)',
			);
		});

		it('Unknown extension (.xyz) reviewer: returns null when no profile matches', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/tools/file.xyz',
			);
			expect(result).toBeNull();
		});

		it('Null task text: returns null', () => {
			const result = buildReviewerChecklistIntegration(null);
			expect(result).toBeNull();
		});
	});

	describe('Consistency checks', () => {
		it('Coder and reviewer helpers use same file path extraction', () => {
			const taskText = 'Update src/main.ts';
			const coderResult = buildCoderConstraintsIntegration(taskText);
			const reviewerResult = buildReviewerChecklistIntegration(taskText);

			// Both should extract and return non-null for the same task text
			expect(coderResult).not.toBeNull();
			expect(reviewerResult).not.toBeNull();

			// Each should have its respective header
			expect(coderResult).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS');
			expect(reviewerResult).toContain('[LANGUAGE-SPECIFIC REVIEW CHECKLIST');
		});

		it('Language injection does not interfere with adversarial detection payload', () => {
			const coderResult =
				buildCoderConstraintsIntegration('Update src/main.ts');

			expect(coderResult).not.toBeNull();
			expect(coderResult).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS');

			// The coder constraints output does NOT contain [SWARM CONFIG]
			// (that's a different injection by the caller)
			expect(coderResult).not.toContain('[SWARM CONFIG]');
		});

		it('Multi-language reviewer task: merges checklists from both profiles', () => {
			const result = buildReviewerChecklistIntegration(
				'Update src/main.rs and src/utils/helper.go',
			);
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC REVIEW CHECKLIST — Rust]');
			// Should include checklist items from both profiles
			expect(result).toContain(
				'- [ ] Verify no unwrap() or expect() calls in library/production paths',
			); // Rust
			expect(result).toContain(
				'- [ ] Verify all error return values are checked (no _ = err pattern)',
			); // Go
		});

		it('Swift coder: returns Swift constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration('Update src/main.swift');
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — Swift]');
			expect(result).toContain(
				'Prefer value types (structs, enums) over classes',
			);
		});

		it('C++ coder: returns C++ constraints with correct header', () => {
			const result = buildCoderConstraintsIntegration('Update src/main.cpp');
			expect(result).not.toBeNull();
			expect(result).toContain('[LANGUAGE-SPECIFIC CONSTRAINTS — C / C++]');
			expect(result).toContain(
				'Prefer RAII and smart pointers (unique_ptr, shared_ptr) over raw pointers',
			);
		});
	});

	describe('Profile data consistency', () => {
		it('All registered profiles have non-empty coderConstraints', () => {
			const profiles = LANGUAGE_REGISTRY.getAll();
			for (const profile of profiles) {
				expect(profile.prompts.coderConstraints.length).toBeGreaterThan(0);
				expect(
					profile.prompts.coderConstraints.every((c) => typeof c === 'string'),
				).toBe(true);
			}
		});

		it('All registered profiles have non-empty reviewerChecklist', () => {
			const profiles = LANGUAGE_REGISTRY.getAll();
			for (const profile of profiles) {
				expect(profile.prompts.reviewerChecklist.length).toBeGreaterThan(0);
				expect(
					profile.prompts.reviewerChecklist.every((c) => typeof c === 'string'),
				).toBe(true);
			}
		});

		it('getProfileForFile returns correct profile for known extensions', () => {
			const tsProfile = getProfileForFile('src/file.ts');
			expect(tsProfile?.id).toBe('typescript');

			const pyProfile = getProfileForFile('src/file.py');
			expect(pyProfile?.id).toBe('python');

			const rsProfile = getProfileForFile('src/file.rs');
			expect(rsProfile?.id).toBe('rust');

			const goProfile = getProfileForFile('src/file.go');
			expect(goProfile?.id).toBe('go');
		});

		it('getProfileForFile returns undefined for unknown extensions', () => {
			const profile = getProfileForFile('src/file.xyz');
			expect(profile).toBeUndefined();
		});

		it('getProfileForFile returns undefined for files without extension', () => {
			const profile = getProfileForFile('src/Makefile');
			expect(profile).toBeUndefined();
		});
	});
});
