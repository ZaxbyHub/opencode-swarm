/**
 * Context Map Types
 * Durable data model for cross-agent context sharing in the opencode-swarm plugin.
 * These types define the schema used by the Context Map feature to capture
 * file-level summaries, task history, and architectural decisions for
 * efficient context injection across agent interactions.
 *
 * The Context Map is opt-in (enabled=false by default) and uses SHA-256
 * content hashes for file invalidation detection.
 */

/**
 * Branded type alias for a SHA-256 content hash string.
 * Always a 64-character lowercase hex string produced by hashing file contents.
 */
export type ContentHash = string;

/**
 * Summary of a single source file in the context map.
 * Provides a condensed view of file contents, structure, and metadata
 * to enable efficient cross-agent context sharing without re-reading full files.
 */
export interface FileContextEntry {
	/** Relative file path within the project */
	path: string;
	/** SHA-256 hash of file contents for invalidation detection */
	content_hash: ContentHash;
	/** File modification timestamp in milliseconds since epoch (fast pre-check) */
	mtime_ms: number;
	/** Programming language (e.g. "typescript", "javascript", "python") */
	language?: string;
	/** One-to-two sentence description of what this file does */
	purpose: string;
	/** Exported symbol names from this file */
	exports?: string[];
	/** Imported module paths referenced by this file */
	imports?: string[];
	/** Important types, functions, or classes defined in this file */
	key_symbols?: string[];
	/** Observed constraints or rules governing this file's behavior */
	invariants?: string[];
	/** Detected risk factors (complexity, churn, fragility, etc.) */
	risks?: string[];
	/** Related test file paths covering this file */
	tests?: string[];
	/** Task IDs that last accessed or modified this file */
	last_seen_task_ids?: string[];
	/** Natural language summary of file purpose and key behavior */
	summary: string;
}

/**
 * Summary of a completed or in-progress task within the context map.
 * Captures what a task set out to do, what files it touched, and
 * the evidence from reviewer, critic, and test gates.
 */
export interface TaskContextSummary {
	/** Unique task identifier (e.g. "1.1", "2.3") */
	task_id: string;
	/** What the task was supposed to accomplish */
	goal: string;
	/** Files modified during the task */
	files_touched: string[];
	/** Natural language description of what was actually implemented */
	implementation_summary?: string;
	/** Reviewer feedback extracted from evidence files */
	reviewer_findings?: string[];
	/** Critic feedback extracted from evidence files */
	critic_findings?: string[];
	/** Test results extracted from evidence files */
	test_findings?: string[];
	/** Final disposition of the task after QA gates */
	final_status: 'pending' | 'approved' | 'rejected' | 'blocked';
}

/**
 * Architectural decision made during a session, captured in the context map.
 * These decisions provide reasoning context for future agents to understand
 * why certain approaches were chosen or rejected.
 */
export interface DecisionEntry {
	/** Unique identifier for the decision (e.g. "D1", "D2") */
	id: string;
	/** The actual decision text describing what was decided */
	decision: string;
	/** Rationale explaining why this decision was made */
	rationale: string;
	/** ISO 8601 timestamp of when the decision was recorded */
	timestamp: string;
	/** Related task ID if the decision was made in the context of a specific task */
	task_id?: string;
	/** Related phase number if the decision was phase-scoped */
	phase?: number;
}

/**
 * The top-level context map structure.
 * This is the root object that aggregates file summaries, task history,
 * and architectural decisions into a single durable snapshot.
 * Used for efficient cross-agent context injection without re-reading
 * full source files.
 */
export interface ContextMap {
	/** Schema version for forward-compatibility (currently 1) */
	schema_version: 1;
	/** ISO 8601 timestamp of when this context map was generated */
	generated_at: string;
	/** Unique repository identifier for cache invalidation across repos */
	repo_fingerprint: string;
	/** File context entries keyed by relative file path */
	files: Record<string, FileContextEntry>;
	/** Task history entries keyed by task ID */
	task_history: Record<string, TaskContextSummary>;
	/** Architectural decisions recorded during the session */
	decisions: DecisionEntry[];
}

/**
 * Entry tracking a file detected as stale in the context map.
 * Used to identify which files need re-analysis due to content changes
 * since the context map was last generated.
 */
export interface ContextMapStaleEntry {
	/** Relative file path of the stale file */
	path: string;
	/** SHA-256 content hash at the time the context map was generated */
	old_hash: ContentHash;
	/** ISO 8601 timestamp of when staleness was detected */
	detected_at: string;
}
