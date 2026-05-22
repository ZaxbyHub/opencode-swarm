import { type BuildEvidence, type Evidence, type EvidenceBundle, type PlaceholderEvidence, type QualityBudgetEvidence, type SastEvidence, type SbomEvidence, type SecretscanEvidence, type SyntaxEvidence } from '../config/evidence-schema';
/**
 * Discriminated union returned by loadEvidence.
 * - 'found': file exists and passed Zod schema validation
 * - 'not_found': file does not exist on disk
 * - 'invalid_schema': file exists but failed Zod validation; errors contains field names
 */
export type LoadEvidenceResult = {
    status: 'found';
    bundle: EvidenceBundle;
} | {
    status: 'not_found';
} | {
    status: 'invalid_schema';
    errors: string[];
};
/**
 * All valid evidence types (13 total)
 */
export declare const VALID_EVIDENCE_TYPES: readonly ["review", "test", "diff", "approval", "note", "retrospective", "syntax", "placeholder", "sast", "sbom", "build", "quality_budget", "secretscan"];
/**
 * Check if a string is a valid evidence type.
 * Returns true if the type is recognized, false otherwise.
 */
export declare function isValidEvidenceType(type: string): type is (typeof VALID_EVIDENCE_TYPES)[number];
/**
 * Type guards for new evidence types
 */
export declare function isSyntaxEvidence(evidence: Evidence): evidence is SyntaxEvidence;
export declare function isPlaceholderEvidence(evidence: Evidence): evidence is PlaceholderEvidence;
export declare function isSastEvidence(evidence: Evidence): evidence is SastEvidence;
export declare function isSbomEvidence(evidence: Evidence): evidence is SbomEvidence;
export declare function isBuildEvidence(evidence: Evidence): evidence is BuildEvidence;
export declare function isQualityBudgetEvidence(evidence: Evidence): evidence is QualityBudgetEvidence;
/**
 * Type guard for secretscan evidence
 */
export declare function isSecretscanEvidence(evidence: Evidence): evidence is SecretscanEvidence;
import { sanitizeTaskId as _sanitizeTaskId } from '../validation/task-id';
export declare const sanitizeTaskId: typeof _sanitizeTaskId;
/**
 * Defense-in-depth: verify that `directory` is the project root and not a subdirectory
 * of a project that already has a .swarm/ at its root.
 * Walks up the directory tree to filesystem root looking for a parent .swarm/ directory.
 * @throws Error if a parent directory contains .swarm/
 */
export declare function validateProjectRoot(directory: string): void;
/**
 * Save evidence to a task's evidence bundle.
 * Creates new bundle if doesn't exist, appends to existing.
 * Performs atomic write via temp file + rename.
 * @throws Error if task ID is invalid or size limit would be exceeded
 */
export declare function saveEvidence(directory: string, taskId: string, evidence: Evidence): Promise<EvidenceBundle>;
/**
 * Transform a flat retrospective object into a valid EvidenceBundle.
 */
declare function wrapFlatRetrospective(flatEntry: Record<string, unknown>, taskId: string): EvidenceBundle;
/**
 * Load evidence bundle for a task.
 * Returns a LoadEvidenceResult discriminated union.
 */
export declare function loadEvidence(directory: string, taskId: string): Promise<LoadEvidenceResult>;
/**
 * List all task IDs that have evidence bundles.
 * Returns sorted array of valid task IDs.
 * Returns empty array if evidence directory doesn't exist.
 */
export declare function listEvidenceTaskIds(directory: string): Promise<string[]>;
/**
 * Delete evidence bundle for a task.
 * Returns true if deleted, false if didn't exist or deletion failed.
 */
export declare function deleteEvidence(directory: string, taskId: string): Promise<boolean>;
/**
 * Check if a requirement coverage file exists for a given phase.
 * Looks for .swarm/evidence/req-coverage-phase-{N}.json
 */
export declare function checkRequirementCoverage(phase: number, directory: string): Promise<{
    exists: boolean;
    path: string;
}>;
/**
 * Archive old evidence bundles based on retention policy.
 * Removes evidence older than maxAgeDays.
 * If maxBundles is provided, enforces a maximum bundle count by deleting oldest first.
 * Returns array of archived (deleted) task IDs.
 */
export declare function archiveEvidence(directory: string, maxAgeDays: number, maxBundles?: number): Promise<string[]>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    wrapFlatRetrospective: typeof wrapFlatRetrospective;
    loadEvidence: typeof loadEvidence;
    listEvidenceTaskIds: typeof listEvidenceTaskIds;
    validateProjectRoot: typeof validateProjectRoot;
};
export {};
