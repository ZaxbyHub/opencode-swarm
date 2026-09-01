/** AC1 positive — every catalogued event kind round-trips create -> validate -> project, and Task/lane/resume/cross-process fixtures parse against `ObservabilityEventSchema`. */
import { describe, expect, test } from 'bun:test';
import { CATALOG_KINDS } from '../../../src/observability/catalog.js';
import { ObservabilityEventSchema } from '../../../src/observability/envelope.js';
import {
	createObservation,
	resetObservabilityForTesting,
	toLegacyTelemetryLine,
} from '../../../src/observability/observe.js';
import { validateEventRelationships } from '../../../src/observability/relationships.js';

/** Representative payloads for every catalogued kind (sessionId/taskId present where the producer genuinely supplies them, per catalog.ts requiredWorkflowIds). */
const FIXTURES: Record<string, Record<string, unknown>> = {
	// Issue #2063 / #2065 containment events, catalogued when this branch merged main. Payloads mirror the real producers in src/telemetry.ts.
	no_op_strong_warning: {
		sessionId: 'sess-1',
		agentName: 'coder',
		count: 3,
		threshold: 3,
	},
	gate_denial_loop: {
		sessionId: 'sess-1',
		tool: 'write',
		code: 'SCOPE_NOT_DECLARED',
		count: 5,
	},
	execution_stall_warning: { sessionId: 'sess-1', count: 40, threshold: 40 },
	execution_stall_denied: {
		sessionId: 'sess-1',
		tool: 'read',
		count: 60,
		threshold: 60,
	},
	swarm_internals_read_denied: {
		sessionId: 'sess-1',
		tool: 'read',
		target: 'src/hooks/guardrails/index.ts',
	},
	prm_hard_stop_delivered: {
		sessionId: 'sess-1',
		pattern: 'thrash',
		level: 4,
		occurrenceCount: 7,
	},
	session_started: { sessionId: 'sess-1', agentName: 'architect' },
	session_ended: { sessionId: 'sess-1', reason: 'completed' },
	agent_activated: {
		sessionId: 'sess-1',
		agentName: 'coder',
		oldName: 'architect',
	},
	task_state_changed: {
		sessionId: 'sess-1',
		taskId: '1.1',
		newState: 'in_progress',
		oldState: 'pending',
	},
	phase_changed: { sessionId: 'sess-1', oldPhase: 1, newPhase: 2 },
	heartbeat: { sessionId: 'sess-1' },
	turbo_mode_changed: {
		sessionId: 'sess-1',
		enabled: true,
		agentName: 'architect',
	},
	environment_detected: {
		sessionId: 'sess-1',
		hostOS: 'win32',
		shellFamily: 'powershell',
		executionMode: 'gui',
	},
	delegation_begin: { sessionId: 'sess-1', agentName: 'coder', taskId: '1.1' },
	delegation_end: {
		sessionId: 'sess-1',
		agentName: 'coder',
		taskId: '1.1',
		result: 'success',
	},
	delegation_cost_correction: {
		sessionId: 'sess-1',
		taskId: '1.1',
		record_id: 'record-1',
		version: 1,
		cost_usd: 0.01,
	},
	delegation_cost_binding: { sessionId: 'sess-1', record_id: 'record-1' },
	delegation_cost_join: { sessionId: 'sess-1', reason: 'join_miss' },
	model_fallback: {
		sessionId: 'sess-1',
		agentName: 'coder',
		fromModel: 'a',
		toModel: 'b',
		reason: 'rate_limited',
	},
	model_unresolved: {
		sessionId: 'sess-1',
		agentName: 'critic',
		model: 'opencode/nope',
		detail: 'provider "opencode" does not list model "nope"',
	},
	gate_passed: { sessionId: 'sess-1', gate: 'qa_gate', taskId: '1.1' },
	gate_failed: {
		sessionId: 'sess-1',
		gate: 'qa_gate',
		taskId: '1.1',
		reason: 'x',
	},
	gate_parse_error: { taskId: '1.1', errorName: 'Error', errorMessage: 'bad' },
	reviewer_gate_decision: {
		sessionId: 'sess-1',
		gate: 'qa_gate',
		taskId: '1.1',
		blocked: false,
		allowed: true,
		reasonCode: 'durable_evidence_complete',
		evidenceKind: 'genuine',
	},
	budget_updated: {
		sessionId: 'sess-1',
		budgetPct: 42.5,
		agentName: 'architect',
	},
	context_pruned: {
		sessionId: 'sess-1',
		agentName: 'architect',
		trigger: 'critical_threshold',
		usageSource: 'estimated',
		beforeTokens: 900,
		afterTokens: 450,
		modelLimit: 1000,
		maskedMessages: 1,
		maskedToolParts: 2,
		maskedTokensFreed: 200,
		prunedMessages: 3,
		prunedTextParts: 2,
		prunedToolParts: 1,
		prunedTokensFreed: 250,
	},
	hard_limit_hit: {
		sessionId: 'sess-1',
		agentName: 'coder',
		limitType: 'tokens',
		value: 100000,
	},
	revision_limit_hit: { sessionId: 'sess-1', agentName: 'coder' },
	loop_detected: {
		sessionId: 'sess-1',
		agentName: 'coder',
		loopType: 'debugging_spiral',
	},
	scope_violation: {
		sessionId: 'sess-1',
		agentName: 'coder',
		file: 'src/forbidden.ts',
		reason: 'outside declared scope',
	},
	qa_skip_violation: { sessionId: 'sess-1', agentName: 'coder', skipCount: 3 },
	auto_oversight_escalation: {
		sessionId: 'sess-1',
		reason: 'deadlock',
		interactionCount: 4,
		deadlockCount: 2,
		phase: 3,
	},
	prm_pattern_detected: {
		sessionId: 'sess-1',
		pattern: 'thrash',
		severity: 'high',
		category: 'edit_loop',
		stepRange: [3, 9],
	},
	prm_course_correction_injected: {
		sessionId: 'sess-1',
		pattern: 'thrash',
		level: 2,
	},
	prm_escalation_triggered: {
		sessionId: 'sess-1',
		pattern: 'thrash',
		level: 3,
		occurrenceCount: 5,
	},
	prm_hard_stop: {
		sessionId: 'sess-1',
		pattern: 'thrash',
		level: 4,
		occurrenceCount: 7,
	},
	evidence_lock_acquired: {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'coder',
		taskId: '1.1',
		attempt: 0,
	},
	evidence_lock_contended: {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'reviewer',
		taskId: '1.1',
		attempt: 1,
	},
	evidence_lock_stale_recovered: {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'coder',
		taskId: '1.1',
		attempt: 2,
	},
	plan_ledger_cas_retry: {
		attempt: 1,
		expectedHashPrefix: 'deadbeef',
		delayMs: 37,
	},
	plan_md_write_failed: {
		directory: '/proj',
		error: 'EACCES: permission denied',
		timestamp: '2020-01-02T03:04:05.678Z',
	},
	snapshot_failed: {
		error: 'ENOSPC: no space left on device',
		retries: 3,
		source: 'savePlan',
	},
	agent_conflict_detected: {
		type: 'agent_conflict_detected',
		timestamp: '2020-01-02T03:04:05.678Z',
		sessionId: 'sess-1',
		phase: 2,
		taskId: '1.1',
		sourceAgent: 'coder',
		targetAgent: 'reviewer',
		conflictType: 'verdict_disagreement',
		resolutionPath: 'escalate_critic',
		summary: 'reviewer rejected three cycles',
	},
	// Issue #2030 close/archive structured result. Payload mirrors the real
	// producer in src/commands/close.ts (emitCloseArchiveResult).
	close_archive_result: {
		archive_valid: true,
		archive_empty: false,
		file_count: 12,
		bundle: 'swarm-2026-08-09T12-00-00-000Z-abc123',
		artifacts: [
			{
				artifact: 'swarm.db',
				requiredness: 'optional',
				attempt: 'succeeded',
				validation: 'passed',
				source_disposition: 'removed',
				method: 'vacuum_into',
				reason_code: 'ok',
				row_counts: {
					schema_migrations_max_version: 1,
					project_constraints: 3,
					qa_gate_profile: 0,
				},
			},
		],
	},
	knowledge_receipt_transition: {
		transition: 'terminal_committed',
		reasonCode: 'committed',
		schemaVersion: 2,
		knowledgeTraceId: 'trace-1',
		knowledgeEntryId: 'entry-1',
		sessionId: 'sess-1',
		taskId: '1.1',
		phase: 'review',
		receiptOutcome: 'applied',
		receiptSource: 'delegate_ack',
	},
	knowledge_maintenance: {
		phase: 'committed',
		selectedCount: 2,
		storeEntriesBefore: 30,
		storeEntriesAfter: 28,
		backupBytes: 27877,
		storeSha256Prefix: 'a1b2c3d4e5f6',
		token12: '0f6c3e29fc00',
	},
	// Issue #2035 atomic-write residue health. Payload mirrors the real
	// producer in src/services/swarm-residue.ts (quarantineSwarmResidue):
	// counts + frozen-registry grammar ids only — no paths or content.
	residue_health: {
		trigger: 'close',
		scanned: 148,
		matched: 3,
		eligible: 2,
		ambiguous: 1,
		quarantined: 2,
		preserved: 1,
		total_bytes: 4096,
		oldest_age_ms: 5_400_000,
		grammar_counts: {
			'target-suffix-tmp-num-alnum': 2,
			'dot-tmp-prefix-legacy': 1,
		},
	},

	// Issue #2037 context-map telemetry storage health. Payload mirrors the
	// real producer in src/context-map/telemetry.ts (compactStore/finalize):
	// bounded counts + timestamps only — no capsule/query content, no paths.
	context_telemetry_health: {
		trigger: 'compaction',
		accepted_count: 1250,
		compacted_count: 1000,
		retained_count: 250,
		dropped_count: 0,
		corrupt_count: 1,
		oldest_timestamp: '2026-07-01T00:00:00.000Z',
		newest_timestamp: '2026-08-22T00:00:00.000Z',
		bytes: 131072,
		limit_bytes: 262144,
	},

	// Issue #2038 skill-usage-log/pending health. Payload mirrors the real producer in src\hooks\skill-usage-pending.ts (emitSkillUsageHealth): bounded counts + timestamps only — no skillPath, no per-skill identifier.
	skill_usage_health: {
		trigger: 'compaction',
		accepted: 500,
		compacted: 400,
		dropped: 20,
		skills_dropped: 3,
		corrupt: 5,
		pending_retained: 40,
		uncertain_retained: 10,
		uncertain_expired: 2,
		pending_evicted: 1,
		no_source_knowledge: 0,
		no_matching_knowledge: 0,
		bump_retry: 2,
		bump_unrecoverable: 0,
		bump_applied_zero: 1,
		pressure: 0,
		curator_skipped: 1,
		bytes: 524288,
		limit_bytes: 1572864,
		oldest_timestamp: '2026-07-01T00:00:00.000Z',
		newest_timestamp: '2026-08-22T00:00:00.000Z',
		coverage: true,
	},

	// Issue #2039 core event store health. Payload mirrors the real producer in src/events/core-events.ts (foldPass/finalize): bounded counts + timestamps only — no event content, no paths.
	core_events_health: {
		trigger: 'compaction',
		accepted_count: 5250,
		compacted_count: 5000,
		retained_count: 250,
		dropped_count: 0,
		corrupt_count: 1,
		authority_index_count: 7,
		authority_evicted_count: 0,
		oldest_timestamp: '2026-07-01T00:00:00.000Z',
		newest_timestamp: '2026-08-22T00:00:00.000Z',
		bytes: 524288,
		limit_bytes: 2097152,
	},

	// Issue #2040 shell-audit store health. Payload mirrors the real producer in src/hooks/guardrails/shell-audit-store.ts (foldPass/finalize): bounded counts + timestamps only — no commands, no paths, no agents.
	shell_audit_health: {
		trigger: 'compaction',
		accepted_count: 5250,
		compacted_count: 5000,
		retained_count: 250,
		dropped_count: 2000,
		corrupt_count: 1,
		oldest_timestamp: '2026-07-01T00:00:00.000Z',
		newest_timestamp: '2026-08-22T00:00:00.000Z',
		bytes: 524288,
		limit_bytes: 1048576,
	},

	// Issue #2041 PRM session-trajectory store health (counts only).
	trajectory_health: {
		trigger: 'compaction',
		retained_count: 500,
		dropped_count: 1500,
		corrupt_count: 2,
		skipped_lock_count: 0,
		bytes: 204800,
		limit_bytes: 524288,
	},
	// Issue #2042 PR-monitor subscription store health (counts only).
	pr_subscription_health: {
		trigger: 'compact',
		recovery_resets: 2,
		active_count: 12,
		terminal_count: 30,
		compactions: 4,
		corrupt_count: 1,
		dropped_audit_count: 260,
		checkpoint_bytes: 16384,
		limit_bytes: 262144,
	},
	learning_health_alarm: {
		alarm: 'model_limit_fallback',
		transition: 'raised',
	},
};

describe('envelope roundtrip — AC1 positive', () => {
	test('FIXTURES covers every catalogued kind (self-check)', () => {
		expect(Object.keys(FIXTURES).sort()).toEqual([...CATALOG_KINDS].sort());
	});

	describe.each(CATALOG_KINDS)('kind: %s', (kind) => {
		test(`${kind}: createObservation -> ObservabilityEventSchema.safeParse succeeds`, () => {
			resetObservabilityForTesting();
			const data = FIXTURES[kind];
			expect(data).toBeDefined();

			const event = createObservation(kind, data);
			const result = ObservabilityEventSchema.safeParse(event);
			if (!result.success) {
				throw new Error(
					`safeParse failed for ${kind}: ${JSON.stringify(result.error.issues)}`,
				);
			}
			expect(result.success).toBe(true);
		});

		test(`${kind}: validateEventRelationships returns ok:true`, () => {
			resetObservabilityForTesting();
			const data = FIXTURES[kind];
			const event = createObservation(kind, data);
			const verdict = validateEventRelationships(event);
			if (!verdict.ok) {
				throw new Error(
					`validateEventRelationships failed for ${kind}: ${JSON.stringify(verdict.violations)}`,
				);
			}
			expect(verdict.ok).toBe(true);
		});

		test(`${kind}: projects to a legacy line carrying timestamp and event`, () => {
			resetObservabilityForTesting();
			const data = FIXTURES[kind];
			const event = createObservation(kind, data);
			const line = toLegacyTelemetryLine(event);
			expect(line.event).toBe(kind);
			expect(typeof line.timestamp).toBe('string');
		});
	});

	test('Task-workflow fixture (taskId + hostSessionId) round-trips', () => {
		resetObservabilityForTesting();
		const event = createObservation('delegation_begin', {
			sessionId: 'task-sess',
			agentName: 'coder',
			taskId: '2.3',
		});
		expect(event.workflow.taskId).toBe('2.3');
		expect(event.workflow.hostSessionId).toBe('task-sess');
		expect(ObservabilityEventSchema.safeParse(event).success).toBe(true);
		expect(validateEventRelationships(event).ok).toBe(true);
	});

	test('lane fixture (batchId present) round-trips', () => {
		resetObservabilityForTesting();
		const event = createObservation('plan_ledger_cas_retry', {
			attempt: 1,
			expectedHashPrefix: 'deadbeef',
			delayMs: 37,
			batchId: 'lane-batch-9',
		});
		expect(event.workflow.batchId).toBe('lane-batch-9');
		expect(ObservabilityEventSchema.safeParse(event).success).toBe(true);
		expect(validateEventRelationships(event).ok).toBe(true);
	});

	test('resume fixture (session id reused across two createObservation calls) round-trips both', () => {
		resetObservabilityForTesting();
		const first = createObservation('session_started', {
			sessionId: 'resume-sess',
			agentName: 'architect',
		});
		const second = createObservation('session_started', {
			sessionId: 'resume-sess',
			agentName: 'architect',
		});
		expect(ObservabilityEventSchema.safeParse(first).success).toBe(true);
		expect(ObservabilityEventSchema.safeParse(second).success).toBe(true);
		expect(validateEventRelationships(first).ok).toBe(true);
		expect(validateEventRelationships(second).ok).toBe(true);
		// Distinct eventIds/writerSequence even though the payload repeats.
		expect(first.eventId).not.toBe(second.eventId);
		expect(second.writerSequence).toBeGreaterThan(first.writerSequence);
	});

	test('cross-process fixture (no shared in-memory state between two independent createObservation calls) round-trips', () => {
		resetObservabilityForTesting();
		const procA = createObservation('heartbeat', { sessionId: 'proc-a' });
		resetObservabilityForTesting();
		const procB = createObservation('heartbeat', { sessionId: 'proc-b' });
		expect(ObservabilityEventSchema.safeParse(procA).success).toBe(true);
		expect(ObservabilityEventSchema.safeParse(procB).success).toBe(true);
		expect(validateEventRelationships(procA).ok).toBe(true);
		expect(validateEventRelationships(procB).ok).toBe(true);
		expect(procA.trace.traceId).not.toBe(procB.trace.traceId);
	});
});
