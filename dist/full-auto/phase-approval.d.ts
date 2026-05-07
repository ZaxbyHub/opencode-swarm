import type { PluginConfig } from '../config';
export interface PhaseApprovalDecision {
    ok: boolean;
    reason?: string;
    evidence?: Record<string, unknown>;
}
export declare function verifyFullAutoPhaseApproval(directory: string, sessionID: string | undefined, phase: number, config: PluginConfig): PhaseApprovalDecision;
