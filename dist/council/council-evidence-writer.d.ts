/**
 * Work Complete Council — evidence writer.
 *
 * Stamps the council synthesis result into `.swarm/evidence/{taskId}.json`
 * under `gates.council`, matching the shape other gate writers use and the
 * shape that `check_gate_status` and `update_task_status` consume (they read
 * `evidence.gates[gateName]`). Council-specific fields (verdict, vetoedBy,
 * roundNumber, allCriteriaMet) are stored alongside the standard GateInfo
 * fields (sessionId, timestamp, agent); existing consumers only check
 * `gates.council != null`, so the extras are compatible.
 *
 * Existing fields in the evidence file — top-level keys AND other `gates[*]`
 * entries — are preserved across the write. The raw taskId is used as the
 * filename; defense-in-depth regex validation rejects malformed IDs before
 * any filesystem op.
 */
import type { CouncilSynthesis } from './types';
export declare function writeCouncilEvidence(workingDir: string, synthesis: CouncilSynthesis): Promise<void>;
