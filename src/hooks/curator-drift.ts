import { getGlobalEventBus } from '../background/event-bus.js';
import {
	phaseReportLocator,
	readPhaseReportsDb,
	upsertPhaseReportDb,
} from '../db/phase-report-store.js';
import { readEffectiveSpecSync } from '../sdd/effective-spec';
import * as logger from '../utils/logger';
import type {
	CriticDriftResult,
	CuratorConfig,
	CuratorPhaseResult,
	DriftReport,
} from './curator-types.js';
import { readSwarmFileAsync } from './utils.js';

/**
 * Read all prior drift reports (#2480: from the `phase_report` entity table
 * in `.swarm/swarm.db`, kind `curator_drift`; the legacy
 * `.swarm/drift-report-phase-*.json` files are imported once — idempotent,
 * one-txn — and cold-archived `.json.imported`).
 * Returns reports sorted ascending by phase number.
 * Skips corrupt/unreadable payloads with a console.warn.
 */
export async function readPriorDriftReports(
	directory: string,
): Promise<DriftReport[]> {
	const reports: DriftReport[] = [];
	try {
		for (const row of readPhaseReportsDb(directory, 'curator_drift')) {
			try {
				const report = JSON.parse(row.payload) as DriftReport;
				// Basic schema validation (unchanged from the file reader).
				if (
					typeof report.phase !== 'number' ||
					typeof report.alignment !== 'string' ||
					typeof report.timestamp !== 'string' ||
					typeof report.drift_score !== 'number' ||
					typeof report.schema_version !== 'number' ||
					!Array.isArray(report.compounding_effects)
				) {
					logger.warn(
						`[curator-drift] Skipping corrupt drift report: phase ${row.phase}`,
					);
					continue;
				}
				reports.push(report);
			} catch {
				logger.warn(
					`[curator-drift] Skipping unreadable drift report: phase ${row.phase}`,
				);
			}
		}
	} catch {
		// DB unavailable (read-only project, disk full): report no priors —
		// drift analysis must fail open exactly like the file reader did.
		return [];
	}

	// Sort ascending by phase number (content.phase is authoritative).
	reports.sort((a, b) => a.phase - b.phase);

	return reports;
}

/**
 * Write a drift report to the `phase_report` entity table (#2480: upsert via
 * the group-commit writer — one txn per flush, atomic, replacing the legacy
 * non-batched file rewrite). A same-phase re-run overwrites the row.
 * Returns the DB-backed report locator.
 */
export async function writeDriftReport(
	directory: string,
	report: DriftReport,
): Promise<string> {
	const locator = phaseReportLocator('curator_drift', report.phase);
	try {
		await upsertPhaseReportDb(
			directory,
			'curator_drift',
			report.phase,
			JSON.stringify(report, null, 2),
		);
	} catch (err) {
		throw new Error(
			`[curator-drift] Failed to write drift report to ${locator}: ${String(err)}`,
		);
	}

	return locator;
}

// ============================================================================
// DI Seam — _internals (declared before functions that use it to avoid TDZ)
// ============================================================================

export const _internals = {
	readPriorDriftReports,
	writeDriftReport,
	runDeterministicDriftCheck,
	buildDriftInjectionText,
};

/** Extract FR-### requirement IDs from text (e.g., FR-001, FR-012). */
function extractRequirementIds(text: string): string[] {
	const matches = text.match(/FR-\d{3,}/g);
	return matches ? [...new Set(matches)] : [];
}

/**
 * Deterministic drift check for the given phase.
 * Builds a structured DriftReport from curator data, plan, spec, and prior reports.
 * Writes the report to .swarm/drift-report-phase-N.json.
 * Emits 'curator.drift.completed' event on success.
 * On any error: emits 'curator.error' event and returns a safe default result.
 * NEVER throws — drift failures must not block phase_complete.
 */
export async function runDeterministicDriftCheck(
	directory: string,
	phase: number,
	curatorResult: CuratorPhaseResult,
	config: CuratorConfig,
	injectAdvisory?: (message: string) => void,
): Promise<CriticDriftResult> {
	try {
		// 1. Read plan.md
		const planMd = await readSwarmFileAsync(directory, 'plan.md');

		// 2. Read effective spec (may not exist)
		const specMd = readEffectiveSpecSync(directory)?.content ?? null;

		// 3. Read prior drift reports
		const priorReports = await _internals.readPriorDriftReports(directory);

		// 4. Build drift analysis from curator data
		// Compliance observations drive alignment severity
		const complianceCount = curatorResult.compliance.length;
		const warningCompliance = curatorResult.compliance.filter(
			(obs) => obs.severity === 'warning',
		);

		// Compute alignment from spec coverage + compliance observations
		let alignment: DriftReport['alignment'] = 'ALIGNED';
		let driftScore = 0;

		// Extract requirement IDs from spec for coverage analysis
		const specRequirements = specMd ? extractRequirementIds(specMd) : [];
		const planRequirements = planMd ? extractRequirementIds(planMd) : [];
		const digestRequirements = extractRequirementIds(
			JSON.stringify(curatorResult.digest) +
				JSON.stringify(curatorResult.compliance) +
				JSON.stringify(curatorResult.knowledge_recommendations ?? []),
		);

		if (!planMd) {
			// No plan — cannot assess alignment
			alignment = 'MINOR_DRIFT';
			driftScore = 0.3;
		} else if (specRequirements.length > 0) {
			// Spec-based drift: check how many spec requirements are covered
			const coveredInPlan = specRequirements.filter((fr) =>
				planRequirements.includes(fr),
			);
			const coveredInDigest = specRequirements.filter((fr) =>
				digestRequirements.includes(fr),
			);
			const specCoverageRatio = coveredInPlan.length / specRequirements.length;
			const implementationRatio =
				coveredInDigest.length / specRequirements.length;

			if (specCoverageRatio < 0.5) {
				// Less than half of spec requirements appear in plan
				alignment = 'MAJOR_DRIFT';
				driftScore = Math.min(0.9, 0.6 + (1 - specCoverageRatio) * 0.3);
			} else if (warningCompliance.length >= 3) {
				// Compliance severity takes priority — multiple serious warnings
				alignment = 'MAJOR_DRIFT';
				driftScore = Math.min(0.9, 0.5 + warningCompliance.length * 0.1);
			} else if (warningCompliance.length >= 1 || complianceCount >= 3) {
				// Some compliance concerns — minor drift
				alignment = 'MINOR_DRIFT';
				driftScore = Math.min(0.49, 0.2 + complianceCount * 0.05);
			} else if (implementationRatio < 0.5) {
				// Plan covers requirements but implementation doesn't reference them
				alignment = 'MINOR_DRIFT';
				driftScore = Math.min(0.6, 0.2 + (1 - implementationRatio) * 0.3);
			}
		} else {
			// No spec — fall back to compliance-count-based drift
			if (warningCompliance.length >= 3) {
				alignment = 'MAJOR_DRIFT';
				driftScore = Math.min(0.9, 0.5 + warningCompliance.length * 0.1);
			} else if (warningCompliance.length >= 1 || complianceCount >= 3) {
				alignment = 'MINOR_DRIFT';
				driftScore = Math.min(0.49, 0.2 + complianceCount * 0.05);
			}
		}

		const keyCorrections = warningCompliance.map((obs) => obs.description);
		const firstDeviation =
			warningCompliance.length > 0
				? {
						phase,
						task: 'unknown',
						description: warningCompliance[0]?.description ?? '',
					}
				: null;

		// 6. Compute requirements stats from plan
		const requirementsChecked = curatorResult.digest.tasks_total;
		const requirementsSatisfied = curatorResult.digest.tasks_completed;

		const coverageNote =
			specRequirements.length > 0
				? ` [${digestRequirements.filter((fr) => specRequirements.includes(fr)).length}/${specRequirements.length} FRs covered]`
				: '';
		const injectionSummaryRaw = `Phase ${phase}: ${alignment} (${driftScore.toFixed(2)})${coverageNote} — ${
			firstDeviation ? firstDeviation.description : 'all requirements on track'
		}.${keyCorrections.length > 0 ? `Correction: ${keyCorrections[0] ?? ''}.` : ''}`;

		// 7. Truncate injection_summary to config.drift_inject_max_chars
		const injectionSummary = injectionSummaryRaw.slice(
			0,
			config.drift_inject_max_chars,
		);

		const report: DriftReport = {
			schema_version: 1,
			phase,
			timestamp: new Date().toISOString(),
			alignment,
			drift_score: driftScore,
			first_deviation: firstDeviation,
			compounding_effects: priorReports
				.filter((r) => r.alignment !== 'ALIGNED')
				.map((r) => `Phase ${r.phase}: ${r.alignment}`)
				.slice(0, 5),
			corrections: keyCorrections.slice(0, 5),
			requirements_checked: requirementsChecked,
			requirements_satisfied: requirementsSatisfied,
			scope_additions: [],
			injection_summary: injectionSummary,
		};

		// 8. Write drift report
		const reportPath = await _internals.writeDriftReport(directory, report);

		// 9. Emit curator.drift.completed event
		getGlobalEventBus().publish('curator.drift.completed', {
			phase,
			alignment,
			drift_score: driftScore,
			report_path: reportPath,
		});

		// Also inject advisory via callback if provided and drift was detected.
		// The critic_drift_verifier nudge is folded in here (issue #1976 B5.4) so the
		// surviving advisory carries the actionable guidance even though the
		// phase-complete side that re-reads prior reports is now de-duplicated.
		if (injectAdvisory && alignment !== 'ALIGNED' && driftScore > 0) {
			try {
				const advisoryText = `CURATOR DRIFT DETECTED (phase ${phase}, score ${driftScore.toFixed(2)}): ${injectionSummary.slice(0, 300)}. Review the phase-${phase} drift report stored in .swarm/swarm.db (${phaseReportLocator('curator_drift', phase)}) and address spec alignment before proceeding. Consider running critic_drift_verifier before phase completion to get a proper drift review.`;
				injectAdvisory(advisoryText);
			} catch {
				/* advisory injection failure must not block drift check */
			}
		}

		// 10. Build injection text using the raw injection summary
		const injectionText = injectionSummary;

		return {
			phase,
			report,
			report_path: reportPath,
			injection_text: injectionText,
		};
	} catch (err) {
		// Drift failures must NEVER block phase_complete
		getGlobalEventBus().publish('curator.error', {
			operation: 'drift',
			phase,
			error: String(err),
		});

		// Return safe default — ALIGNED with empty data
		const defaultReport: DriftReport = {
			schema_version: 1,
			phase,
			timestamp: new Date().toISOString(),
			alignment: 'ALIGNED',
			drift_score: 0,
			first_deviation: null,
			compounding_effects: [],
			corrections: [],
			requirements_checked: 0,
			requirements_satisfied: 0,
			scope_additions: [],
			injection_summary: `Phase ${phase}: drift analysis unavailable (${String(err)})`,
		};

		return {
			phase,
			report: defaultReport,
			report_path: '',
			injection_text: '',
		};
	}
}

/**
 * Build a truncated summary suitable for architect context injection.
 * Format: "<drift_report>Phase N: {alignment} ({drift_score}) — {key finding}. {correction if any}.</drift_report>"
 * Truncate to maxChars (simple slice). Tags may be broken when truncation occurs mid-tag.
 * If ALIGNED with drift_score < 0.1: minimal output "Phase N: ALIGNED, all requirements on track."
 * If MINOR_DRIFT or worse: include first_deviation and top correction.
 */
export function buildDriftInjectionText(
	report: DriftReport,
	maxChars: number,
): string {
	if (maxChars <= 0) {
		return '';
	}

	let text: string;

	// Case 1: Minimal output for well-aligned phases
	if (report.alignment === 'ALIGNED' && report.drift_score < 0.1) {
		text = `<drift_report>Phase ${report.phase}: ALIGNED, all requirements on track.</drift_report>`;
	}
	// Case 2: Detailed output for drift cases
	else {
		const keyFinding =
			report.first_deviation?.description ?? 'no deviation recorded';
		const score = report.drift_score ?? 0;
		const correctionClause = report.corrections?.[0]
			? `Correction: ${report.corrections[0]}.`
			: '';
		text = `<drift_report>Phase ${report.phase}: ${report.alignment} (${score.toFixed(2)}) — ${keyFinding}. ${correctionClause}</drift_report>`;
	}

	// Truncate to maxChars (simple slice — doesn't need special tag preservation beyond maxChars <= 0 guard)
	return text.slice(0, maxChars);
}
