/**
 * Curator core — file I/O for curator summary persistence.
 * Extended incrementally: filterPhaseEvents, checkPhaseCompliance,
 * runCuratorInit, runCuratorPhase, applyCuratorKnowledgeUpdates added in subsequent tasks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalEventBus } from '../background/event-bus.js';
import { bunWrite } from '../utils/bun-compat';
import type {
	ComplianceObservation,
	CuratorConfig,
	CuratorInitResult,
	CuratorPhaseResult,
	CuratorSummary,
	KnowledgeRecommendation,
	PhaseDigestEntry,
} from './curator-types.js';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from './knowledge-store.js';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { readSwarmFileAsync, validateSwarmPath } from './utils.js';

/**
 * Read curator summary from .swarm/curator-summary.json
 * @param directory - The workspace directory
 * @returns CuratorSummary if valid, null if missing or invalid
 */
export async function readCuratorSummary(
	directory: string,
): Promise<CuratorSummary | null> {
	const content = await readSwarmFileAsync(directory, 'curator-summary.json');

	if (content === null) {
		return null;
	}

	try {
		const parsed = JSON.parse(content) as CuratorSummary;

		if (parsed.schema_version !== 1) {
			console.warn(
				`Curator summary has unsupported schema version: ${parsed.schema_version}. Expected 1.`,
			);
			return null;
		}

		return parsed;
	} catch {
		console.warn('Failed to parse curator-summary.json: invalid JSON');
		return null;
	}
}

/**
 * Write curator summary to .swarm/curator-summary.json
 * @param directory - The workspace directory
 * @param summary - The curator summary to write
 */
export async function writeCuratorSummary(
	directory: string,
	summary: CuratorSummary,
): Promise<void> {
	const resolvedPath = validateSwarmPath(directory, 'curator-summary.json');

	// Ensure .swarm/ directory exists
	fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

	// Write JSON file
	await bunWrite(resolvedPath, JSON.stringify(summary, null, 2));
}

/**
 * Normalize agent name by stripping common swarm prefixes.
 */
function normalizeAgentName(name: string): string {
	return name
		.toLowerCase()
		.replace(/^(mega|paid|local|lowtier|modelrelay)_/, '');
}

/**
 * Filter events from JSONL by phase or timestamp.
 * @param eventsJsonl - Raw JSONL string of events
 * @param phase - Phase number to filter by
 * @param sinceTimestamp - Optional ISO 8601 timestamp to filter events after
 * @returns Array of parsed event objects
 */
export function filterPhaseEvents(
	eventsJsonl: string,
	phase: number,
	sinceTimestamp?: string,
): object[] {
	const lines = eventsJsonl.split('\n');
	const filtered: object[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		try {
			const event = JSON.parse(line);

			if (sinceTimestamp) {
				// Include all events after the timestamp
				if (event.timestamp > sinceTimestamp) {
					filtered.push(event);
				}
			} else {
				// Filter by phase
				if ((event as Record<string, unknown>).phase === phase) {
					filtered.push(event);
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	return filtered;
}

/**
 * Check compliance for a phase based on events and dispatched agents.
 * @param phaseEvents - Array of events for the phase
 * @param agentsDispatched - List of agent names that were dispatched
 * @param requiredAgents - List of required agent names for this phase
 * @param phase - Phase number
 * @returns Array of compliance observations
 */
export function checkPhaseCompliance(
	phaseEvents: object[],
	agentsDispatched: string[],
	requiredAgents: string[],
	phase: number,
): ComplianceObservation[] {
	const observations: ComplianceObservation[] = [];
	const timestamp = new Date().toISOString();

	// Check 1: Missing required agents
	for (const agent of requiredAgents) {
		const normalizedAgent = normalizeAgentName(agent);
		const isDispatched = agentsDispatched.some(
			(a) => normalizeAgentName(a) === normalizedAgent,
		);

		if (!isDispatched) {
			observations.push({
				phase,
				timestamp,
				type: 'workflow_deviation',
				severity: 'warning',
				description: `Agent '${agent}' required but not dispatched in phase ${phase}`,
			});
		}
	}

	// Check 2: Reviewer after every coder delegation

	const coderDelegations: { event: object; index: number }[] = [];
	const reviewerDelegations: { event: object; index: number }[] = [];

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			if ((e as Record<string, unknown>).type === 'agent.delegation') {
				const agent = (e as Record<string, unknown>).agent;
				if (agent && typeof agent === 'string') {
					const normalized = normalizeAgentName(agent);
					if (normalized === 'coder') {
						coderDelegations.push({ event: e, index: i });
					} else if (normalized === 'reviewer') {
						reviewerDelegations.push({ event: e, index: i });
					}
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	for (const coderEvent of coderDelegations) {
		const hasSubsequentReviewer = reviewerDelegations.some(
			(r) => r.index > coderEvent.index,
		);

		if (!hasSubsequentReviewer) {
			observations.push({
				phase,
				timestamp,
				type: 'missing_reviewer',
				severity: 'warning',
				description: `Coder delegation in phase ${phase} has no subsequent reviewer delegation`,
			});
		}
	}

	// Check 3: Retrospective before phase_complete
	let phaseCompleteIndex = -1;
	let retroIndex = -1;

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			const eventType = (e as Record<string, unknown>).type;
			const evidenceType = (e as Record<string, unknown>).evidence_type;

			if (
				typeof eventType === 'string' &&
				(eventType === 'phase_complete' || eventType === 'phase.complete')
			) {
				phaseCompleteIndex = i;
			}
			if (
				(typeof eventType === 'string' &&
					eventType === 'retrospective.written') ||
				(typeof evidenceType === 'string' && evidenceType === 'retrospective')
			) {
				retroIndex = i;
			}
		} catch {
			// Skip events that fail access
		}
	}

	if (phaseCompleteIndex !== -1 && retroIndex === -1) {
		observations.push({
			phase,
			timestamp,
			type: 'missing_retro',
			severity: 'warning',
			description: `Phase ${phase} completed without retrospective evidence`,
		});
	}

	// Check 4: SME after domain detection
	const domainDetectionEvents: { event: object; index: number }[] = [];
	const smeDelegations: { event: object; index: number }[] = [];

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			if ((e as Record<string, unknown>).type === 'domains.detected') {
				domainDetectionEvents.push({ event: e, index: i });
			}
			if (
				(e as Record<string, unknown>).type === 'agent.delegation' &&
				(e as Record<string, unknown>).agent
			) {
				const agent = (e as Record<string, unknown>).agent;
				if (agent && typeof agent === 'string') {
					const normalized = normalizeAgentName(agent);
					if (normalized === 'sme') {
						smeDelegations.push({ event: e, index: i });
					}
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	for (const domainEvent of domainDetectionEvents) {
		const hasSubsequentSme = smeDelegations.some(
			(s) => s.index > domainEvent.index,
		);

		if (!hasSubsequentSme) {
			observations.push({
				phase,
				timestamp,
				type: 'missing_sme',
				severity: 'info',
				description: `Domains detected in phase ${phase} but no SME consultation found`,
			});
		}
	}

	return observations;
}

/**
 * Prepare curator init data: reads prior summary, knowledge entries, and context.md.
 * Returns a structured briefing result. Does NOT make LLM calls.
 * The caller (phase-monitor integration) is responsible for the actual agent delegation.
 * @param directory - The workspace directory
 * @param config - Curator configuration
 * @returns CuratorInitResult with briefing text, contradictions, and stats
 */
export async function runCuratorInit(
	directory: string,
	config: CuratorConfig,
): Promise<CuratorInitResult> {
	try {
		// 1. Read prior curator summary
		const priorSummary = await readCuratorSummary(directory);

		// 2. Read high-confidence knowledge entries
		const knowledgePath = resolveSwarmKnowledgePath(directory);
		const allEntries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		const highConfidenceEntries = allEntries.filter(
			(e) =>
				typeof e.confidence === 'number' &&
				e.confidence >= config.min_knowledge_confidence,
		);

		// 3. Read context.md
		const contextMd = await readSwarmFileAsync(directory, 'context.md');

		// 4. Build briefing text from available data
		const briefingParts: string[] = [];

		if (priorSummary) {
			briefingParts.push(
				`## Prior Session Summary (Phase ${priorSummary.last_phase_covered})`,
			);
			briefingParts.push(priorSummary.digest);

			if (
				priorSummary.compliance_observations.length > 0 &&
				!config.suppress_warnings
			) {
				briefingParts.push('\n## Compliance Observations');
				for (const obs of priorSummary.compliance_observations) {
					briefingParts.push(
						`- [${obs.severity.toUpperCase()}] Phase ${obs.phase}: ${obs.description}`,
					);
				}
			}

			if (priorSummary.knowledge_recommendations.length > 0) {
				briefingParts.push('\n## Knowledge Recommendations');
				for (const rec of priorSummary.knowledge_recommendations) {
					briefingParts.push(`- ${rec.action}: ${rec.lesson} (${rec.reason})`);
				}
			}
		} else {
			briefingParts.push('## First Session — No Prior Summary');
			briefingParts.push(
				'This is the first curator run for this project. No prior phase data available.',
			);
		}

		if (highConfidenceEntries.length > 0) {
			briefingParts.push('\n## High-Confidence Knowledge');
			for (const entry of highConfidenceEntries.slice(0, 10)) {
				// Cap at 10 entries to stay within token budget
				const lesson =
					typeof entry.lesson === 'string'
						? entry.lesson
						: JSON.stringify(entry.lesson);
				briefingParts.push(`- ${lesson}`);
			}
		}

		if (contextMd) {
			briefingParts.push('\n## Context Summary');
			// Truncate to stay within token budget (approx 4 chars per token)
			const maxContextChars = config.max_summary_tokens * 2;
			briefingParts.push(contextMd.slice(0, maxContextChars));
		}

		// 5. Find contradictions in knowledge entries (entries with 'contradiction' in tags)
		const contradictions = allEntries
			.filter(
				(e) =>
					Array.isArray(e.tags) &&
					e.tags.some((t: string) => t.includes('contradiction')),
			)
			.map((e) =>
				typeof e.lesson === 'string' ? e.lesson : JSON.stringify(e.lesson),
			);

		const result: CuratorInitResult = {
			briefing: briefingParts.join('\n'),
			contradictions,
			knowledge_entries_reviewed: allEntries.length,
			prior_phases_covered: priorSummary ? priorSummary.last_phase_covered : 0,
		};

		// 6. Emit event
		getGlobalEventBus().publish('curator.init.completed', {
			prior_phases_covered: result.prior_phases_covered,
			knowledge_entries_reviewed: result.knowledge_entries_reviewed,
			contradictions_found: contradictions.length,
		});

		return result;
	} catch (err) {
		// Curator failures must NEVER block the caller
		getGlobalEventBus().publish('curator.error', {
			operation: 'init',
			error: String(err),
		});
		return {
			briefing: '## Curator Init Failed\nCould not load prior session context.',
			contradictions: [],
			knowledge_entries_reviewed: 0,
			prior_phases_covered: 0,
		};
	}
}

/**
 * Run curator phase analysis: reads events, runs compliance, updates and writes summary.
 * Does NOT make LLM calls. The caller is responsible for agent delegation.
 * @param directory - The workspace directory
 * @param phase - The phase number that just completed
 * @param agentsDispatched - List of agent names dispatched in this phase
 * @param config - Curator configuration
 * @param knowledgeConfig - Knowledge configuration (used for knowledge path resolution)
 * @returns CuratorPhaseResult with digest, compliance, and recommendations
 */
export async function runCuratorPhase(
	directory: string,
	phase: number,
	agentsDispatched: string[],
	_config: CuratorConfig,
	_knowledgeConfig: { directory?: string },
): Promise<CuratorPhaseResult> {
	try {
		// 1. Read prior curator summary
		const priorSummary = await readCuratorSummary(directory);

		// 2. Read events.jsonl filtered to this phase window
		const eventsJsonlContent = await readSwarmFileAsync(
			directory,
			'events.jsonl',
		);
		const phaseEvents = eventsJsonlContent
			? filterPhaseEvents(eventsJsonlContent, phase)
			: [];

		// 3. Read context.md decisions
		const contextMd = await readSwarmFileAsync(directory, 'context.md');

		// 4. Run compliance check
		// Required agents for a standard phase: reviewer, test_engineer
		const requiredAgents = ['reviewer', 'test_engineer'];
		const complianceObservations = checkPhaseCompliance(
			phaseEvents,
			agentsDispatched,
			requiredAgents,
			phase,
		);

		// 5. Build phase digest entry from available data
		const tasksCompleted = phaseEvents.filter(
			(e) => (e as Record<string, unknown>).type === 'task.completed',
		).length;

		// Extract key decisions from context.md (lines starting with '- ')
		const keyDecisions: string[] = [];
		if (contextMd) {
			const decisionSection = contextMd.match(
				/## Decisions\r?\n([\s\S]*?)(?:\r?\n##|$)/,
			);
			if (decisionSection) {
				const lines = decisionSection[1].split('\n');
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('- ')) {
						keyDecisions.push(trimmed.slice(2));
					}
				}
			}
		}

		const phaseDigest: PhaseDigestEntry = {
			phase,
			timestamp: new Date().toISOString(),
			summary: `Phase ${phase} completed. ${tasksCompleted} tasks recorded. ${complianceObservations.length} compliance observations.`,
			agents_used: [...new Set(agentsDispatched.map(normalizeAgentName))],
			tasks_completed: tasksCompleted,
			tasks_total: tasksCompleted, // actual total not available here; caller may update
			key_decisions: keyDecisions.slice(0, 5),
			blockers_resolved: [],
		};

		// 6. Knowledge recommendations are intentionally empty here.
		// This function is a data preparer — it does not invoke LLM agents.
		// The caller (phase-monitor integration, Task 6) runs the CURATOR_PHASE
		// agent and parses its output to populate recommendations before persisting.
		// runCuratorPhase only initializes the summary structure; the caller updates it.
		const knowledgeRecommendations: KnowledgeRecommendation[] = [];

		// 7. Update and write curator summary
		const sessionId = `session-${Date.now()}`;
		const now = new Date().toISOString();

		let updatedSummary: CuratorSummary;
		if (priorSummary) {
			// Extend existing summary
			updatedSummary = {
				...priorSummary,
				last_updated: now,
				last_phase_covered: Math.max(priorSummary.last_phase_covered, phase),
				digest:
					priorSummary.digest +
					`\n\n### Phase ${phase}\n${phaseDigest.summary}`,
				phase_digests: [...priorSummary.phase_digests, phaseDigest],
				compliance_observations: [
					...priorSummary.compliance_observations,
					...complianceObservations,
				],
				knowledge_recommendations: knowledgeRecommendations,
			};
		} else {
			updatedSummary = {
				schema_version: 1,
				session_id: sessionId,
				last_updated: now,
				last_phase_covered: phase,
				digest: `### Phase ${phase}\n${phaseDigest.summary}`,
				phase_digests: [phaseDigest],
				compliance_observations: complianceObservations,
				knowledge_recommendations: knowledgeRecommendations,
			};
		}

		await writeCuratorSummary(directory, updatedSummary);

		// 8. Write compliance observations to events.jsonl as curator_compliance events
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		for (const obs of complianceObservations) {
			await appendKnowledge(eventsPath, {
				type: 'curator_compliance',
				timestamp: obs.timestamp,
				phase: obs.phase,
				observation_type: obs.type,
				severity: obs.severity,
				description: obs.description,
			});
		}

		const result: CuratorPhaseResult = {
			phase,
			digest: phaseDigest,
			compliance: complianceObservations,
			knowledge_recommendations: knowledgeRecommendations,
			summary_updated: true,
		};

		// 9. Emit event
		getGlobalEventBus().publish('curator.phase.completed', {
			phase,
			compliance_count: complianceObservations.length,
			summary_updated: true,
		});

		return result;
	} catch (err) {
		// Curator failures must NEVER block phase_complete
		getGlobalEventBus().publish('curator.error', {
			operation: 'phase',
			phase,
			error: String(err),
		});
		return {
			phase,
			digest: {
				phase,
				timestamp: new Date().toISOString(),
				summary: `Phase ${phase} curator run failed: ${String(err)}`,
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
		};
	}
}

/**
 * Apply curator knowledge recommendations: promote, archive, or flag contradictions.
 * Uses readKnowledge + rewriteKnowledge pattern for atomic updates.
 * @param directory - The workspace directory
 * @param recommendations - Array of knowledge recommendations to apply
 * @param knowledgeConfig - Knowledge configuration (for path resolution)
 * @returns Counts of applied and skipped recommendations
 */
export async function applyCuratorKnowledgeUpdates(
	directory: string,
	recommendations: KnowledgeRecommendation[],
	_knowledgeConfig: KnowledgeConfig,
): Promise<{ applied: number; skipped: number }> {
	let applied = 0;
	let skipped = 0;

	if (recommendations.length === 0) {
		return { applied, skipped };
	}

	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);

	let modified = false;
	const appliedIds = new Set<string>();
	const updatedEntries = entries.map((entry) => {
		// Find matching recommendation by entry_id
		const rec = recommendations.find((r) => r.entry_id === entry.id);
		if (!rec) return entry;

		// Apply mutation
		switch (rec.action) {
			case 'promote':
				appliedIds.add(entry.id);
				applied++;
				modified = true;
				return {
					...entry,
					hive_eligible: true,
					confidence: Math.min(1.0, (entry.confidence ?? 0) + 0.1),
					updated_at: new Date().toISOString(),
				};
			case 'archive':
				appliedIds.add(entry.id);
				applied++;
				modified = true;
				// 'archived' is an extension to the status union per spec
				return {
					...entry,
					status: 'archived' as SwarmKnowledgeEntry['status'],
					updated_at: new Date().toISOString(),
				};
			case 'flag_contradiction':
				appliedIds.add(entry.id);
				applied++;
				modified = true;
				return {
					...entry,
					tags: [
						...(entry.tags ?? []),
						`contradiction:${(rec.reason ?? '').slice(0, 50)}`,
					],
					updated_at: new Date().toISOString(),
				};
			default:
				return entry;
		}
	});

	// Count skipped: recommendations that were not applied
	for (const rec of recommendations) {
		if (rec.entry_id !== undefined && !appliedIds.has(rec.entry_id)) {
			const found = entries.some((e) => e.id === rec.entry_id);
			if (!found) {
				console.warn(
					`[curator] applyCuratorKnowledgeUpdates: entry_id '${rec.entry_id}' not found — skipping`,
				);
			}
			skipped++;
		}
	}

	// Only rewrite if at least one entry was mutated
	if (modified) {
		await rewriteKnowledge(knowledgePath, updatedEntries);
	}

	return { applied, skipped };
}
