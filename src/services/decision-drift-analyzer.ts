/**
 * Decision Drift Analyzer Service
 *
 * Analyzes decisions from context.md and current plan state to detect:
 * 1. Stale decisions (age/phase mismatch or no recent confirmation)
 * 2. Contradictions (new decisions conflicting with existing ones)
 *
 * Results are integrated into architect context injection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSwarmFileAsync } from '../hooks/utils';
import { loadPlan } from '../plan/manager';
import { log } from '../utils';
import { extractContextDecisions } from '../utils/context-decisions';

/**
 * Drift signal severity levels
 */
export type DriftSeverity = 'warning' | 'error';

/**
 * A single decision extracted from context.md
 */
export interface Decision {
	/** Raw decision text */
	text: string;
	/** Phase when decision was made (extracted or inferred) */
	phase: number | null;
	/** Whether decision has a confirmation marker */
	confirmed: boolean;
	/** Timestamp if available */
	timestamp: string | null;
	/** Line number in source file */
	line: number;
}

/**
 * A detected drift signal
 */
export interface DriftSignal {
	/** Unique identifier for this drift */
	id: string;
	/** Severity level */
	severity: DriftSeverity;
	/** Type of drift */
	type: 'stale' | 'contradiction';
	/** Human-readable description */
	message: string;
	/** Source reference (file and line) */
	source: {
		file: string;
		line: number;
	};
	/** Related decisions if applicable */
	relatedDecisions?: string[];
	/** Suggested resolution hint */
	hint?: string;
}

/**
 * Result of drift analysis
 */
export interface DriftAnalysisResult {
	/** Whether drift was detected */
	hasDrift: boolean;
	/** List of drift signals */
	signals: DriftSignal[];
	/** Summary text for context injection */
	summary: string;
	/** Timestamp of analysis */
	analyzedAt: string;
}

/**
 * Configuration for drift analyzer
 */
export interface DriftAnalyzerConfig {
	/** Maximum age in phases before a decision is considered stale */
	staleThresholdPhases: number;
	/** Whether to detect contradictions */
	detectContradictions: boolean;
	/** Maximum signals to return */
	maxSignals: number;
}

/**
 * Default configuration
 */
export const DEFAULT_DRIFT_CONFIG: DriftAnalyzerConfig = {
	staleThresholdPhases: 1,
	detectContradictions: true,
	maxSignals: 5,
};

/**
 * Extract decisions from context.md content
 *
 * #2493 W9a: the section scan itself now lives in the shared extractor
 * (`src/utils/context-decisions.ts`) so all four historical consumers of
 * the `## Decisions` section agree on boundaries. This delegate preserves
 * this module's public shape exactly — `ContextDecision` is a structural
 * superset of `Decision` (it additionally carries the raw source line), so
 * the mapping is the identity.
 */
export function extractDecisionsFromContext(
	contextContent: string,
): Decision[] {
	return extractContextDecisions(contextContent);
}

/**
 * Check if a decision is stale based on current phase and threshold
 */
function isDecisionStale(
	decision: Decision,
	currentPhase: number,
	threshold: number,
): boolean {
	// No phase info means we can't determine staleness
	if (decision.phase === null) {
		// Check if decision has any confirmation - unconfirmed old decisions are suspicious
		return !decision.confirmed;
	}

	// Decision is from a past phase at or beyond threshold
	const phaseDiff = currentPhase - decision.phase;
	if (phaseDiff >= threshold) {
		return true;
	}

	// Decision from current phase but not confirmed
	if (phaseDiff === 0 && !decision.confirmed) {
		return true;
	}

	return false;
}

/**
 * Polarity of a decision with respect to a single contradiction category.
 * - `positive` → the decision affirms the category (e.g. "use X", "keep X")
 * - `negative` → the decision negates the category (e.g. "do not use X", "remove X")
 * - `null`     → the category does not apply to this decision
 */
type Polarity = 'positive' | 'negative' | null;

/**
 * Classify a decision's polarity for a single contradiction category.
 *
 * Negative keywords are checked FIRST and take precedence because several of
 * them are multi-word negation phrases that literally contain the positive
 * verb as a substring (e.g. "do not use" / "not use" / "don't use" all contain
 * "use"). Raw substring matching would otherwise mark a negated decision as
 * BOTH positive and negative, which is exactly the false-positive that made two
 * agreeing "do not use Redis" decisions look contradictory.
 *
 * We intentionally keep `includes()` (not tokenized matching) so the multi-word
 * negation phrases continue to match and true negatives are preserved.
 */
function classifyPolarity(
	textLower: string,
	positiveKeywords: string[],
	negativeKeywords: string[],
): Polarity {
	if (negativeKeywords.some((k) => textLower.includes(k))) {
		return 'negative';
	}
	if (positiveKeywords.some((k) => textLower.includes(k))) {
		return 'positive';
	}
	return null;
}

/**
 * Simple keyword-based contradiction detection
 * Looks for decisions that express opposite intentions
 */
export function findContradictions(decisions: Decision[]): DriftSignal[] {
	const signals: DriftSignal[] = [];

	// Define contradiction keyword pairs
	const contradictionPairs: Array<[string[], string[]]> = [
		// Use vs Don't use
		[
			['use', 'using', 'use ', 'adopt', 'implement', 'enable'],
			['not use', "don't use", 'do not use', 'avoid', 'disable', 'remove'],
		],
		// Keep vs Remove
		[
			['keep', 'retain', 'preserve'],
			['remove', 'delete', 'drop', 'eliminate'],
		],
		// Include vs Exclude
		[
			['include', 'add', 'incorporate'],
			['exclude', 'skip', 'omit'],
		],
		// Require vs Optional
		[
			['require', 'mandatory', 'must'],
			['optional', 'skip', 'can skip'],
		],
		// Background vs Foreground (for features)
		[
			['background', 'async'],
			['foreground', 'sync', 'synchronous'],
		],
	];

	for (let i = 0; i < decisions.length; i++) {
		const decisionA = decisions[i];
		const textLower = decisionA.text.toLowerCase();

		for (let j = i + 1; j < decisions.length; j++) {
			const decisionB = decisions[j];
			const textBLower = decisionB.text.toLowerCase();

			for (const [positiveKeywords, negativeKeywords] of contradictionPairs) {
				// Compute ONE polarity per decision for this category. This is
				// negation-aware: a decision is positive OR negative (or neutral),
				// never both, so a negation phrase that contains the positive verb
				// (e.g. "do not use" contains "use") no longer double-matches, and
				// two agreeing negated decisions are not flagged as contradictory.
				const polarityA = classifyPolarity(
					textLower,
					positiveKeywords,
					negativeKeywords,
				);
				const polarityB = classifyPolarity(
					textBLower,
					positiveKeywords,
					negativeKeywords,
				);

				// Contradiction only when the two decisions have OPPOSITE
				// polarity on the same category. Two agreeing decisions (both
				// positive or both negative) - and any decision neutral for this
				// category - are never flagged.
				const isOpposite =
					(polarityA === 'positive' && polarityB === 'negative') ||
					(polarityA === 'negative' && polarityB === 'positive');

				if (isOpposite) {
					// Check if they're about the same subject (very simple heuristic)
					// Extract potential subject words (first few words or key terms)
					const wordsA = textLower.split(/\s+/).slice(0, 4).join(' ');
					const wordsB = textBLower.split(/\s+/).slice(0, 4).join(' ');

					// Only flag if they share some common terms (avoid false positives)
					const commonWords = wordsA
						.split(/\s+/)
						.filter((w) => w.length > 2 && wordsB.includes(w));

					if (commonWords.length > 0 || wordsA.includes('file')) {
						signals.push({
							id: `contradiction-${i}-${j}`,
							severity: 'error',
							type: 'contradiction',
							message: `Contradictory decisions detected`,
							source: {
								file: 'context.md',
								line: decisionA.line,
							},
							relatedDecisions: [decisionA.text, decisionB.text],
							hint: 'Review both decisions and clarify the intended approach.',
						});
					}
				}
			}
		}
	}

	return signals;
}

/**
 * Extract current phase from legacy plan.md format
 */
function extractCurrentPhaseFromLegacy(planContent: string): number | null {
	if (!planContent) return null;

	const lines = planContent.split('\n');

	// Look for IN PROGRESS phase first
	for (let i = 0; i < Math.min(30, lines.length); i++) {
		const line = lines[i].trim();
		const progressMatch = line.match(
			/^## Phase (\d+):?\s*(.*?)\s*\[IN PROGRESS\]/i,
		);
		if (progressMatch) {
			return parseInt(progressMatch[1], 10);
		}
	}

	// Fall back to Phase: N in header
	for (let i = 0; i < Math.min(5, lines.length); i++) {
		const line = lines[i].trim();
		const phaseMatch = line.match(/Phase:\s*(\d+)/i);
		if (phaseMatch) {
			return parseInt(phaseMatch[1], 10);
		}
	}

	return null;
}

/**
 * Analyze decision drift
 */
export async function analyzeDecisionDrift(
	directory: string,
	config: Partial<DriftAnalyzerConfig> = {},
): Promise<DriftAnalysisResult> {
	const effectiveConfig: DriftAnalyzerConfig = {
		...DEFAULT_DRIFT_CONFIG,
		...config,
	};

	const signals: DriftSignal[] = [];
	const analyzedAt = new Date().toISOString();

	try {
		// Load current plan to get current phase
		const plan = await loadPlan(directory);
		let currentPhase = plan?.current_phase ?? 1;

		// If no plan.json, try to extract from legacy plan.md
		if (!plan) {
			const legacyPhase = extractCurrentPhaseFromLegacy(
				(await readSwarmFileAsync(directory, 'plan.md')) ?? '',
			);
			if (legacyPhase !== null) {
				currentPhase = legacyPhase;
			}
		}

		// Load context.md
		const contextPath = path.join(directory, '.swarm', 'context.md');
		let contextContent = '';
		try {
			if (fs.existsSync(contextPath)) {
				contextContent = fs.readFileSync(contextPath, 'utf-8');
			}
		} catch (error) {
			log('[DecisionDriftAnalyzer] context file read failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				hasDrift: false,
				signals: [],
				summary: '',
				analyzedAt,
			};
		}

		if (!contextContent) {
			return {
				hasDrift: false,
				signals: [],
				summary: '',
				analyzedAt,
			};
		}

		// Extract decisions
		const decisions = extractDecisionsFromContext(contextContent);

		if (decisions.length === 0) {
			return {
				hasDrift: false,
				signals: [],
				summary: '',
				analyzedAt,
			};
		}

		// Check for stale decisions
		for (const decision of decisions) {
			if (
				isDecisionStale(
					decision,
					currentPhase,
					effectiveConfig.staleThresholdPhases,
				)
			) {
				let hint: string | undefined;
				if (decision.phase !== null && decision.phase < currentPhase) {
					hint = `Decision was from Phase ${decision.phase}, current is Phase ${currentPhase}.`;
				} else if (!decision.confirmed) {
					hint =
						'Decision has not been confirmed. Consider confirming or revisiting.';
				}

				signals.push({
					id: `stale-${decision.line}`,
					severity:
						decision.phase !== null && decision.phase < currentPhase
							? 'warning'
							: 'warning',
					type: 'stale',
					message: `Stale decision: "${decision.text.substring(0, 50)}${decision.text.length > 50 ? '...' : ''}"`,
					source: {
						file: 'context.md',
						line: decision.line,
					},
					hint,
				});
			}
		}

		// Check for contradictions if enabled
		if (effectiveConfig.detectContradictions) {
			const contradictions = findContradictions(decisions);
			signals.push(...contradictions);
		}

		// Limit signals
		const limitedSignals = signals.slice(0, effectiveConfig.maxSignals);

		// Build summary
		const summary = buildDriftSummary(limitedSignals);

		return {
			hasDrift: limitedSignals.length > 0,
			signals: limitedSignals,
			summary,
			analyzedAt,
		};
	} catch (error) {
		log('[DecisionDriftAnalyzer] drift analysis failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			hasDrift: false,
			signals: [],
			summary: '',
			analyzedAt,
		};
	}
}

/**
 * Build a concise summary string for context injection
 */
function buildDriftSummary(signals: DriftSignal[]): string {
	if (signals.length === 0) {
		return '';
	}

	const warnings = signals.filter((s) => s.severity === 'warning');
	const errors = signals.filter((s) => s.severity === 'error');

	const lines: string[] = ['[SWARM DECISION DRIFT]'];

	if (errors.length > 0) {
		lines.push(`⚠️ ${errors.length} contradiction(s) detected:`);
		for (const err of errors.slice(0, 2)) {
			const related = err.relatedDecisions
				? ` (${err.relatedDecisions[0].substring(0, 30)}... vs ${err.relatedDecisions[1].substring(0, 30)}...)`
				: '';
			lines.push(`  - ${err.type}: ${err.message}${related}`);
		}
	}

	if (warnings.length > 0) {
		lines.push(`💡 ${warnings.length} stale decision(s) found:`);
		for (const warn of warnings.slice(0, 3)) {
			const hint = warn.hint ? ` - ${warn.hint}` : '';
			lines.push(`  - ${warn.message.substring(0, 60)}${hint}`);
		}
	}

	// Add reference line
	lines.push('See .swarm/context.md for details.');

	return lines.join('\n');
}

/**
 * Format drift signals as a structured section for context injection
 * Returns bounded output suitable for LLM context
 */
export function formatDriftForContext(result: DriftAnalysisResult): string {
	if (!result.hasDrift || !result.summary) {
		return '';
	}

	// Ensure we don't exceed reasonable context size
	const maxLength = 600;
	let summary = result.summary;
	if (summary.length > maxLength) {
		summary = `${summary.substring(0, maxLength - 3)}...`;
	}

	return summary;
}
