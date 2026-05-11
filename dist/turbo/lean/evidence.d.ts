/**
 * Evidence record for a single lane.
 */
export interface LaneEvidence {
    laneId: string;
    taskIds: string[];
    files: string[];
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    startedAt?: string;
    completedAt?: string;
    error?: string;
    agent?: string;
    sessionId?: string;
}
import type { LeanTurboConfig } from '../../config/schema';
/**
 * Aggregated evidence for an entire Lean Turbo phase.
 */
export interface PhaseEvidence {
    phase: number;
    planId: string;
    lanes: LaneEvidence[];
    degradedTasks: {
        taskId: string;
        reason: string;
    }[];
    startedAt: string;
    completedAt?: string;
    status: 'running' | 'completed' | 'failed';
    /** Paths to lane evidence files (e.g., `.swarm/evidence/{phase}/lean-turbo/{laneId}.json`) */
    evidencePaths?: string[];
    /** Summary of integrated diff across all lanes */
    integratedDiffSummary?: string;
    /** Integrated reviewer verdict */
    reviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    /** Critic verdict */
    criticVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
    /** Snapshot of lean turbo config used for this phase */
    configSnapshot?: LeanTurboConfig;
    /** ISO timestamp when phase evidence was written (distinct from startedAt/completedAt) */
    timestamp?: string;
}
/**
 * Writes a single lane's evidence to disk.
 *
 * Uses atomic write (temp file + rename) so readers never see a partial file.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @param evidence - Lane evidence to persist
 * @throws Error if laneId fails validation
 */
export declare function writeLaneEvidence(directory: string, phase: number, evidence: LaneEvidence): Promise<void>;
/**
 * Reads a single lane's evidence from disk.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @param laneId - Lane identifier
 * @returns Parsed LaneEvidence, or null if file does not exist or is invalid
 * @throws Error if laneId fails validation
 */
export declare function readLaneEvidence(directory: string, phase: number, laneId: string): Promise<LaneEvidence | null>;
/**
 * Writes phase-level aggregated evidence to disk.
 *
 * Uses atomic write (temp file + rename).
 *
 * @param directory - Project root directory
 * @param evidence - Phase evidence to persist
 */
export declare function writePhaseEvidence(directory: string, evidence: PhaseEvidence): Promise<void>;
/**
 * Reads phase-level aggregated evidence from disk.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @returns Parsed PhaseEvidence, or null if file does not exist or is invalid
 */
export declare function readPhaseEvidence(directory: string, phase: number): Promise<PhaseEvidence | null>;
/**
 * Lists all lane evidence files for a given phase.
 *
 * Reads every `.json` file in the lean-turbo evidence directory and returns
 * parsed LaneEvidence objects. Files that cannot be read or parsed are skipped.
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @returns Array of LaneEvidence, skipping any invalid files
 */
export declare function listLaneEvidence(directory: string, phase: number): Promise<LaneEvidence[]>;
