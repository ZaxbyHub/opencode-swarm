/**
 * Lean Turbo Review Tool.
 * Wraps dispatchPhaseReviewer from src/turbo/lean/reviewer.
 * Dispatches a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { type PhaseReviewerResult } from '../turbo/lean/reviewer';
/**
 * Arguments for the lean_turbo_review tool
 */
export interface LeanTurboReviewArgs {
    directory: string;
    phase: number;
    sessionID: string;
}
/**
 * Result from executing lean_turbo_review
 */
export interface LeanTurboReviewResult {
    success: boolean;
    verdict?: PhaseReviewerResult['verdict'];
    reason?: string;
    evidencePath?: string;
    errors?: string[];
}
/**
 * Execute the lean_turbo_review tool.
 * Dispatches a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 */
export declare function executeLeanTurboReview(args: LeanTurboReviewArgs): Promise<LeanTurboReviewResult>;
/**
 * Tool definition for lean_turbo_review
 */
export declare const lean_turbo_review: ToolDefinition;
