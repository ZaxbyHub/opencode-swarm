/**
 * Work Complete Council — pure synthesis service.
 *
 * Given the verdicts of council members (critic, reviewer, sme, test_engineer),
 * compute the overall verdict, classify findings, detect conflicts, and build a
 * single unified feedback document for the coder.
 *
 * No I/O — fully unit-testable with mock inputs. All file reads/writes happen in
 * sibling modules (criteria-store, council-evidence-writer).
 */
import type { CouncilConfig, CouncilCriteria, CouncilMemberVerdict, CouncilSynthesis, PhaseCouncilSynthesis } from './types';
export declare function synthesizeCouncilVerdicts(taskId: string, swarmId: string, verdicts: CouncilMemberVerdict[], criteria: CouncilCriteria | null, roundNumber: number, config?: Partial<CouncilConfig>): CouncilSynthesis;
/**
 * Synthesize phase-level council verdicts into a PhaseCouncilSynthesis.
 * Reuses the same veto detection, conflict detection, and finding
 * classification logic as per-task council, but scoped to a phase number.
 *
 * Pure computation — no I/O. File writes are the caller's responsibility
 * (see writePhaseCouncilEvidence in submit-phase-council-verdicts.ts).
 */
export declare function synthesizePhaseCouncilAdvisory(phaseNumber: number, phaseSummary: string, verdicts: CouncilMemberVerdict[], roundNumber: number, config?: Partial<CouncilConfig>, _workingDir?: string): PhaseCouncilSynthesis;
