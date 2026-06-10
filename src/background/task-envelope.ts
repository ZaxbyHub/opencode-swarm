/**
 * Background subagent task-envelope parsing (issue #1151, PR 2 Stage A).
 *
 * OpenCode background subagents (v1.16.2) render task dispatch/completion as a stable
 * XML-ish envelope via the upstream `renderOutput`:
 *
 *   <task id="<subagentSessionID>" state="running|completed|error">
 *   <summary>...</summary>
 *   <task_result>...</task_result>   (or <task_error> for state="error")
 *   </task>
 *
 * - The dispatch tool result carries `state="running"` and the subagent session id.
 * - The deferred completion arrives as a synthetic parent message part whose text is the
 *   same envelope with `state="completed"` or `state="error"`.
 *
 * These parsers are intentionally pure and defensive — they never throw — so they can be
 * used both at dispatch (tool.execute.after output) and at completion observation time.
 */

export type TaskEnvelopeState = 'running' | 'completed' | 'error';

export interface TaskEnvelope {
	/** The subagent session id from `<task id="...">` — the cross-event correlation key. */
	sessionId: string;
	state: TaskEnvelopeState;
}

// Anchored to the opening tag only; tolerant of arbitrary body/whitespace after it.
// `id` is captured non-greedily and must be non-empty; `state` is constrained to the
// known set so unrelated `<task ...>` text cannot masquerade as an envelope.
const TASK_ENVELOPE_RE =
	/<task\s+id="([^"]+)"\s+state="(running|completed|error)"\s*>/;

/**
 * Parse a task envelope from arbitrary text. Returns null when the text does not contain
 * a well-formed opening `<task id="..." state="...">` tag. Never throws.
 */
export function parseTaskEnvelope(text: unknown): TaskEnvelope | null {
	if (typeof text !== 'string' || text.length === 0) return null;
	const match = text.match(TASK_ENVELOPE_RE);
	if (!match) return null;
	const sessionId = match[1];
	const state = match[2] as TaskEnvelopeState;
	if (!sessionId) return null;
	return { sessionId, state };
}

/**
 * Extract the subagent session id and (optional) jobId from a background `Task` dispatch
 * result (the `tool.execute.after` output object `{ title, output, metadata }`).
 *
 * - `subagentSessionId` is parsed from the rendered `output` envelope `<task id="...">`.
 * - `jobId` is read defensively from `metadata.jobId` (the installed plugin SDK types this
 *   field as `any`; upstream sets `{ background: true, jobId }`). Absent → null.
 *
 * Both are best-effort; either may be null.
 */
export function extractDispatchIds(output: unknown): {
	subagentSessionId: string | null;
	jobId: string | null;
} {
	let subagentSessionId: string | null = null;
	let jobId: string | null = null;

	if (typeof output === 'object' && output !== null) {
		const o = output as Record<string, unknown>;

		// jobId from structured metadata (trusted, not free text).
		const metadata = o.metadata;
		if (typeof metadata === 'object' && metadata !== null) {
			const rawJobId = (metadata as Record<string, unknown>).jobId;
			if (typeof rawJobId === 'string' && rawJobId.length > 0) {
				jobId = rawJobId;
			}
		}

		// subagent session id from the rendered dispatch envelope.
		const rendered = o.output;
		const envelope = parseTaskEnvelope(
			typeof rendered === 'string' ? rendered : undefined,
		);
		if (envelope && envelope.state === 'running') {
			subagentSessionId = envelope.sessionId;
		}
	} else if (typeof output === 'string') {
		// Some runtimes may surface the rendered string directly.
		const envelope = parseTaskEnvelope(output);
		if (envelope && envelope.state === 'running') {
			subagentSessionId = envelope.sessionId;
		}
	}

	// Fall back to jobId as the correlation id when the envelope is unavailable but the
	// structured jobId is present (upstream treats them as equivalent identifiers).
	if (!subagentSessionId && jobId) {
		subagentSessionId = jobId;
	}

	return { subagentSessionId, jobId };
}
