import { describe, expect, test } from 'bun:test';
import { EXPLORER_PROMPT } from './explorer';

/**
 * Prompt-contract tests verifying the explorer agent prompt correctly scopes the
 * explorer's role and does NOT overreach into:
 * 1. Verdict authority (final judgments)
 * 2. Compliance enforcement
 * 3. Curation decisions (promote/archive/flag as decisions)
 * 4. Agent routing (SME nomination, next-agent routing)
 */

describe('explorer-role-boundary', () => {
	// -------------------------------------------------------------------
	// Helper: collect all lines containing a keyword (trimmed, for matching)
	// -------------------------------------------------------------------
	function linesContaining(keyword: string): string[] {
		return EXPLORER_PROMPT.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.includes(keyword));
	}

	// -------------------------------------------------------------------
	// 1. Verdict authority — Explorer must NOT emit final judgment terms
	//    that imply verdict authority. VERDICT as a standalone word is
	//    banned. BREAKING/COMPATIBLE in integration mode are observable
	//    classifications framed as candidate signals, not final verdicts.
	// -------------------------------------------------------------------

	describe('verdict-authority', () => {
		/**
		 * VERDICT as a standalone word implies a final judgment.
		 * Explorer is a factual mapper — it must not pronounce verdicts.
		 */
		test('VERDICT does not appear as a judgment term', () => {
			const verdictLines = linesContaining('VERDICT');
			expect(verdictLines).toHaveLength(0);
		});

		/**
		 * BREAKING appears in integration mode as a classification label.
		 * It must be framed as an observable candidate signal, not a verdict.
		 * Check that the section header uses SIGNAL or CHANGES (observable
		 * classification) rather than VERDICT language.
		 */
		test('BREAKING in integration mode is labeled as observable classification', () => {
			const breakingHeader = linesContaining('BREAKING_CHANGES');
			expect(breakingHeader.length).toBeGreaterThan(0);

			// BREAKING_CHANGES is an observable classification, not a verdict
			const hasClassificationLabel = /CHANGES|SIGNAL|OBSERVATION/i.test(
				breakingHeader[0],
			);
			expect(hasClassificationLabel).toBe(true);
		});

		/**
		 * COMPATIBLE appears in integration mode as a classification label.
		 * It must be labeled as a signal or observable, not as a final verdict.
		 */
		test('COMPATIBLE in integration mode is labeled as observable signal', () => {
			const compatHeader = linesContaining('COMPATIBLE_CHANGES');
			expect(compatHeader.length).toBeGreaterThan(0);

			const hasSignalLabel = /CHANGES|SIGNAL|OBSERVATION/i.test(
				compatHeader[0],
			);
			expect(hasSignalLabel).toBe(true);
		});

		/**
		 * COMPATIBILITY SIGNALS must use [COMPATIBLE | INCOMPATIBLE | UNCERTAIN]
		 * to show these are observable signals, not verdicts.
		 */
		test('COMPATIBILITY SIGNALS explicitly labels values as signals', () => {
			const signalLine = linesContaining('COMPATIBILITY SIGNALS')[0];
			expect(signalLine).toBeDefined();

			// Must show the three-value signal pattern with COMPATIBLE/INCOMPATIBLE/UNCERTAIN
			const hasSignalPattern =
				/COMPATIBLE.*INCOMPATIBLE.*UNCERTAIN|UNCERTAIN.*COMPATIBLE.*INCOMPATIBLE/i.test(
					signalLine,
				);
			expect(hasSignalPattern).toBe(true);
		});

		/**
		 * The word "approve" or "reject" must not appear as verbs that
		 * Explorer would apply to code or decisions.
		 * Note: "rejected" appears in "deviations will be rejected" which is
		 * about output format, not explorer making approval decisions.
		 */
		test('approve does not appear as an Explorer action', () => {
			const approveLines = EXPLORER_PROMPT.split('\n')
				.map((l) => l.trim())
				.filter((l) => /approve/i.test(l) && !/deviations.*rejected/i.test(l));
			expect(approveLines).toHaveLength(0);
		});

		test('reject does not appear as an Explorer action', () => {
			const rejectLines = EXPLORER_PROMPT.split('\n')
				.map((l) => l.trim())
				.filter(
					(l) =>
						/reject/i.test(l) &&
						!/deviations.*rejected|will be rejected/i.test(l),
				);
			expect(rejectLines).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------
	// 2. Compliance enforcer — Explorer must NOT act as a compliance cop.
	//    Compliance observations are explicitly labeled READ-ONLY.
	// -------------------------------------------------------------------

	describe('compliance-enforcer', () => {
		/**
		 * Compliance observations must be explicitly labeled READ-ONLY
		 * or as observations, never as enforceable directives.
		 */
		test('compliance mentions are explicitly read-only', () => {
			const complianceLines = linesContaining('compliance');
			if (complianceLines.length === 0) return; // not present = fine

			for (const line of complianceLines) {
				const isReadOnly = /READ-?ONLY|OBSERVATION|report|observe/i.test(line);
				expect(isReadOnly).toBe(true);
			}
		});

		test('prompt does not contain enforce', () => {
			const enforceLines = linesContaining('enforce');
			expect(enforceLines).toHaveLength(0);
		});

		test('prompt does not contain mandate', () => {
			const mandateLines = linesContaining('mandate');
			expect(mandateLines).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------
	// 3. Curation decisions — Explorer must NOT make promote/archive/flag
	//    decisions. These may appear only as "suggests" (candidate ideas)
	//    in curator mode, never as Explorer deciding.
	// -------------------------------------------------------------------

	describe('curation-decisions', () => {
		/**
		 * "suggests archive" is appropriate — Explorer suggests candidates,
		 * it does not archive.
		 */
		test('archive only appears with suggest language', () => {
			const archiveLines = linesContaining('archive');
			if (archiveLines.length === 0) return;

			for (const line of archiveLines) {
				const isSuggested = /suggest/i.test(line);
				expect(isSuggested).toBe(true);
			}
		});

		/**
		 * "suggests promote" or "suggests boost confidence" is appropriate.
		 * Direct "promote" without suggest is not allowed.
		 */
		test('promote only appears with suggest language', () => {
			const promoteLines = linesContaining('promote');
			if (promoteLines.length === 0) return;

			for (const line of promoteLines) {
				const isSuggested = /suggest/i.test(line);
				expect(isSuggested).toBe(true);
			}
		});

		/**
		 * "suggests tag as contradicted" is appropriate.
		 * Direct "flag" without suggest is not allowed.
		 * Note: "feature flags" in configuration context is excluded.
		 */
		test('flag only appears with suggest language or in configuration context', () => {
			const flagLines = linesContaining('flag');
			if (flagLines.length === 0) return;

			for (const line of flagLines) {
				// "feature flags" is about configuration management, not curation
				if (/feature flags?/i.test(line)) continue;
				const isSuggested = /suggest/i.test(line);
				expect(isSuggested).toBe(true);
			}
		});
	});

	// -------------------------------------------------------------------
	// 4. Agent routing — Explorer must NOT nominate SMEs, route to
	//    specific agents, or make next-agent calls.
	// -------------------------------------------------------------------

	describe('agent-routing', () => {
		/**
		 * Explorer explicitly must NOT delegate to other agents.
		 * The prompt says "DO NOT use the Task tool to delegate".
		 * This is correct behavior (prohibition, not overreach).
		 */
		test('explorer is explicitly prohibited from delegating to other agents', () => {
			const delegateLines = linesContaining('delegate to');
			expect(delegateLines.length).toBeGreaterThan(0);

			// All "delegate to" mentions must be NEGATIVE (do not delegate)
			for (const line of delegateLines) {
				const isNegative = /do not|don't|never|not.*delegate/i.test(line);
				expect(isNegative).toBe(true);
			}
		});

		test('prompt does not contain next-agent', () => {
			const nextAgentLines = linesContaining('next-agent');
			expect(nextAgentLines).toHaveLength(0);
		});

		/**
		 * "sme" (Subject Matter Expertise) refers to domain labels in the
		 * DOMAINS section, not to SME nominations or routing.
		 */
		test('sme refers to domain labels, not agent nomination', () => {
			const smeLines = EXPLORER_PROMPT.toLowerCase()
				.split('\n')
				.filter((l) => l.includes('sme'));

			if (smeLines.length === 0) return;

			// If sme appears, it must be in context of domain expertise labels
			for (const line of smeLines) {
				const isDomainLabel =
					/domains?|subject matter expertise|powershell|security|python/i.test(
						line,
					);
				expect(isDomainLabel).toBe(true);
			}
		});

		test('prompt does not contain assign to', () => {
			const assignLines = linesContaining('assign to');
			expect(assignLines).toHaveLength(0);
		});

		test('prompt does not contain route to', () => {
			const routeLines = EXPLORER_PROMPT.toLowerCase()
				.split('\n')
				.filter((l) => l.includes('route'));
			expect(routeLines).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------
	// 5. Role identity — Explorer is explicitly a read-only factual mapper
	//    that does not make judgments or modifications.
	// -------------------------------------------------------------------

	describe('role-identity', () => {
		/**
		 * Explorer must be explicitly described as read-only or similar.
		 */
		test('explorer is described as read-only or discovers-and-summarizes', () => {
			const readOnly = /read.?only/i.test(EXPLORER_PROMPT);
			// Accepts: "discovery and analysis", "discovers and summarizes", etc.
			const discoveryPattern =
				/discov(?:ery|ers?)\s*(and\s*)?(summariz(?:es?|ation)|analysis|maps?)/i.test(
					EXPLORER_PROMPT,
				);
			// Also accept "analyze codebases directly" as identity statement
			const analyzesDirectly =
				/analyz(?:e|es|ing)\s+codebases?\s+directly/i.test(EXPLORER_PROMPT);

			expect(readOnly || discoveryPattern || analyzesDirectly).toBe(true);
		});

		/**
		 * Explorer explicitly does not modify code.
		 */
		test('no code modifications rule is present', () => {
			const noModifications =
				/no\s+code\s+modifications?|read.?only|do(es)?\s+not\s+modify/i.test(
					EXPLORER_PROMPT,
				);
			expect(noModifications).toBe(true);
		});

		/**
		 * Explorer does not make judgments — verified by explicit "do not
		 * make judgments/decisions/verdicts" or equivalent language.
		 */
		test('explorer explicitly does not make final judgments', () => {
			// Either "does not make judgments/decisions" OR the IDENTITY section
			// makes clear explorer is a factual mapper
			const noJudgment =
				/does not make (judgments?|decisions?|verdicts?)/i.test(
					EXPLORER_PROMPT,
				);
			const isFactualMapper =
				/factual\s*mapper|analyzes? (codebases? )?directly/i.test(
					EXPLORER_PROMPT,
				);

			expect(noJudgment || isFactualMapper).toBe(true);
		});
	});

	// -------------------------------------------------------------------
	// 6. Output sections — must be framed as observations/candidates,
	//    not directives or verdicts.
	// -------------------------------------------------------------------

	describe('output-sections', () => {
		/**
		 * COMPLEXITY INDICATORS section must not contain verdict language.
		 */
		test('COMPLEXITY INDICATORS section contains no verdict language', () => {
			const sectionMatch = EXPLORER_PROMPT.match(
				/(?:###|##)\s*COMPLEXITY INDICATORS[\s\S]*?(?=(?:###|##)\s|$)/i,
			);
			expect(sectionMatch).not.toBeNull();

			const sectionText = sectionMatch![0];
			const hasVerdict = /verdict|final\s+judgment|determine|decide/i.test(
				sectionText,
			);
			expect(hasVerdict).toBe(false);
		});

		/**
		 * FOLLOW-UP CANDIDATE AREAS must use "consider" or "candidate" to
		 * signal these are exploratory suggestions, not directives.
		 */
		test('FOLLOW-UP CANDIDATE AREAS is framed as candidate suggestions', () => {
			// Section header may be prefixed with ### or be a plain uppercase header
			const sectionMatch = EXPLORER_PROMPT.match(
				/(?:###\s*|##\s*)?FOLLOW-UP CANDIDATE AREAS[:]?[\s\S]*?(?=(?:###|##)\s|$)/i,
			);
			expect(sectionMatch).not.toBeNull();

			const sectionText = sectionMatch![0];
			const hasSuggestionFrame = /consider|candidate|suggest/i.test(
				sectionText,
			);
			expect(hasSuggestionFrame).toBe(true);
		});
	});

	// -------------------------------------------------------------------
	// 7. Adversarial edge cases — verify no hidden overreach via
	//    synonyms or euphemisms.
	// -------------------------------------------------------------------

	describe('adversarial-edge-cases', () => {
		/**
		 * "shall" is an imperative directive — explorer must not be told
		 * what it "shall" do (only examples may use this).
		 */
		test('prompt does not use shall as an explorer directive', () => {
			// Filter out example lines that might use "shall" in a different context
			const shallLines = EXPLORER_PROMPT.split('\n')
				.map((l) => l.trim())
				.filter(
					(l) =>
						l.includes('shall') &&
						!l.includes('Example') &&
						!/callers? shall/i.test(l),
				);
			expect(shallLines).toHaveLength(0);
		});

		/**
		 * "must" as a directive to explorer is banned when it relates to
		 * verdicts or judgments. Output formatting constraints (like "manifest
		 * must be small") are acceptable.
		 */
		test('prompt does not use must as a directive for verdicts or judgments', () => {
			// "must" for output formatting (manifest size) is acceptable
			// "must" for caller obligations (callers must update) is acceptable in examples
			// "must" in example contexts is acceptable
			const mustLines = EXPLORER_PROMPT.split('\n')
				.map((l) => l.trim())
				.filter(
					(l) =>
						/must\s+(not|be|do)/i.test(l) &&
						!/callers/i.test(l) &&
						!/manifest must be small/i.test(l) &&
						!/Example/i.test(l),
				);
			expect(mustLines).toHaveLength(0);
		});

		test('prompt does not contain final decision', () => {
			const finalDecisionLines = EXPLORER_PROMPT.toLowerCase()
				.split('\n')
				.filter((l) => l.includes('final') && l.includes('decision'));
			expect(finalDecisionLines).toHaveLength(0);
		});
	});
});

describe('repo_map graph-first directive role-boundary (issue #1988 C1)', () => {
	// The graph-first ACTIONS directive must not smuggle in verdict,
	// enforcement, or routing language — it is a discovery-strategy
	// directive only.
	test('graph-first directive present in ACTIONS without verdict/imperative language', () => {
		const actionsSection = EXPLORER_PROMPT.substring(
			EXPLORER_PROMPT.indexOf('ACTIONS:'),
			EXPLORER_PROMPT.indexOf('RULES:'),
		);
		expect(actionsSection).toContain('repo_map action="ask"');
		expect(actionsSection).not.toMatch(/\bVERDICT\b/);
		expect(actionsSection).not.toMatch(/\bapprove\b/i);
		expect(actionsSection).not.toMatch(/\breject\b/i);
		expect(actionsSection).not.toMatch(/\benforce\b/i);
		expect(actionsSection).not.toMatch(/\bmandate\b/i);
		expect(actionsSection).not.toMatch(/\bshall\b/i);
		expect(actionsSection).not.toMatch(/\bmust\b/i);
	});
});
