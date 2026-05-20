/**
 * Requirement coverage tool for analyzing FR requirements against touched files.
 * Reads .swarm/spec.md for FR-### requirements and checks coverage against
 * files touched during a phase via evidence files.
 */
import type { tool } from '@opencode-ai/plugin';
declare const OBLIGATION_KEYWORDS: readonly ["MUST", "SHOULD", "SHALL"];
type ObligationLevel = (typeof OBLIGATION_KEYWORDS)[number];
interface Requirement {
    id: string;
    obligation: ObligationLevel | null;
    text: string;
    status: 'covered' | 'missing';
    filesSearched: string[];
}
interface RequirementMatch {
    id: string;
    obligation: ObligationLevel | null;
    text: string;
}
/**
 * Extract all FR-### requirements from spec content.
 * For each requirement, identifies obligation level (MUST/SHOULD/SHALL) and text.
 */
export declare function extractRequirements(specContent: string): RequirementMatch[];
/**
 * Extract obligation level (MUST/SHOULD/SHALL) and requirement text from a line.
 */
export declare function extractObligationAndText(id: string, lineText: string): RequirementMatch | null;
/**
 * Read evidence files from .swarm/evidence/{taskId}/ directory structure.
 * Returns list of source files that were touched during the specified phase.
 * Evidence is stored at .swarm/evidence/<taskId>/evidence.json (e.g., 1.1, 2.3.1).
 * Only directories with numeric task IDs matching the phase prefix are processed.
 */
export declare function readTouchedFiles(evidenceDir: string, phase: number, cwd: string): string[];
/**
 * Search a file for keywords from a requirement.
 * Returns true if any keyword is found.
 */
export declare function searchFileForKeywords(filePath: string, keywords: string[], cwd: string): boolean;
/**
 * Analyze coverage for a requirement against touched files.
 */
export declare function analyzeRequirementCoverage(requirement: RequirementMatch, touchedFiles: string[], cwd: string): Requirement;
export declare const req_coverage: ReturnType<typeof tool>;
export {};
