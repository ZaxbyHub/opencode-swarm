/**
 * write_architecture_supervisor_evidence — persists the architecture-supervisor critic's
 * verdict for a phase (issue #893, Chunk C). The architect dispatches
 * critic_architecture_supervisor, collects its structured JSON verdict, then calls this
 * tool to write the raw sidecar that the phase-complete gate (Chunk D) reads.
 *
 * Mirrors write_drift_evidence / submit_phase_council_verdicts: the tool persists only —
 * it does not contact the supervisor.
 */
import type { tool } from '@opencode-ai/plugin';
export declare const write_architecture_supervisor_evidence: ReturnType<typeof tool>;
