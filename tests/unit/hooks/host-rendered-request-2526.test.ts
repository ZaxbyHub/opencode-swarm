/**
 * Issue #2526 residual closure (AC2): the captured deterministic provider
 * request.
 *
 * `tests/fixtures/host-rendered-request-2526.json` is a committed, byte-stable
 * capture of the request the pinned host renders (via
 * `tests/helpers/host-contract-v1_18_3.ts`, @opencode-ai 1.18.3) for ONE turn
 * carrying all three injection classes — guardrail advisory + knowledge recall
 * + memory recall — driven through the REAL registered
 * `experimental.chat.messages.transform` chain (`bootKnowledgeHost`).
 *
 * This parity test re-derives the request from the same seeds (same knowledge
 * entry, same memory record, same advisory text, frozen clock) and asserts
 * deep-equality with the fixture, so any drift in the composed chain, the
 * carrier format, or the rendered structure fails loudly here.
 *
 * Determinism contract (why the fixture is byte-stable):
 *  - the clock is frozen (`withFrozenClock`/`withFrozenClockAsync`,
 *    fixedNow + isoNow) around the memory seeding AND the transform run, so
 *    the memory record's createdAt/updatedAt, the recall bundle id
 *    (`bundle_<timestamp>_<hash>`), and the recency-scored `age=` field are
 *    identical on every derivation;
 *  - the project config explicitly pins `execution_mode: "balanced"`, so a
 *    user-level/global config cannot change the meaningful planning-profile
 *    directive in the architect-session carrier;
 *  - TWO per-run random tokens are normalized to placeholders in BOTH the
 *    derived capture and the fixture text:
 *      1. `trace_id: <uuid>` — the knowledge retrieval trace id is a fresh
 *         `randomUUID()` per run (`src/hooks/knowledge-events.ts:newTraceId`)
 *         with no DI seam or clock dependence;
 *      2. `mem_<16 hex>` — the memory record id is
 *         `sha256(scope-derived-repoId …)` and the repository scope id hashes
 *         the temp project's directory basename, which differs on every run
 *         (no absolute temp path may appear in the fixture, so the id cannot
 *         be pinned — its normalized shape is asserted instead).
 *    3. the environment-dependent `[PRE-FLIGHT ADVISORY]` missing-binary list
 *       is normalized to one explicit placeholder; its fixed header,
 *       placeholder, and following command-rule marker remain ordered and
 *       asserted below;
 *    Everything else (all directive bodies, fences, ordering, budgets) is
 *    compared byte-for-byte;
 *  - the fixture serializes ONLY the rendered structure — one `{ role, text }`
 *    per rendered message, plus `pinnedHostVersion` and the three assertion
 *    keywords. No absolute temp paths, no provider/session metadata.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveMemoryConfig } from '../../../src/memory/config';
import {
	createConfiguredMemoryProvider,
	MemoryGateway,
} from '../../../src/memory/gateway';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../src/memory/schema';
import type { MemoryRecord } from '../../../src/memory/types';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import {
	withFrozenClock,
	withFrozenClockAsync,
} from '../../helpers/test-clock';

const FIXTURE_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'fixtures',
	'host-rendered-request-2526.json',
);

const SESSION_ID = 'captured-request-2526';
const KEYWORD = 'orbit-flanger-capture';
/** Frozen instant for the memory record stamp, the recall bundle id, and the
 * transform run. Deterministic across runs and platforms. */
const FIXED_ISO = '2026-01-02T00:00:00.000Z';
const FIXED_NOW = Date.parse(FIXED_ISO);
const CLOCK_OPTIONS = { fixedNow: FIXED_NOW, isoNow: FIXED_ISO } as const;

/** Random-per-run tokens normalized to placeholders in BOTH the derived
 * capture and the fixture (see the file header for the rationale). */
const TRACE_ID_PATTERN =
	/(trace_id: )[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const MEMORY_ID_PATTERN = /(mem_)[0-9a-f]{16}/g;
const PREFLIGHT_ADVISORY_HEADER =
	'[PRE-FLIGHT ADVISORY] The following Class 3 tool binaries were not found on PATH at session start.\n' +
	'These tools will soft-skip at invocation. Plan tasks accordingly.';
const PREFLIGHT_ADVISORY_PLACEHOLDER =
	'- MISSING BINARY: <machine-dependent tool list>';
const PREFLIGHT_ADVISORY_RULE_MARKER = '[opencode-swarm:swarm-command-rule]';
const PREFLIGHT_ADVISORY_LIST_PATTERN =
	/(\[PRE-FLIGHT ADVISORY\] The following Class 3 tool binaries were not found on PATH at session start\.\nThese tools will soft-skip at invocation\. Plan tasks accordingly\.\n)(?:- MISSING BINARY: [^\n]+\n)+/g;

function normalizeRenderedText(text: string): string {
	return text
		.replace(TRACE_ID_PATTERN, '$1<trace-id>')
		.replace(MEMORY_ID_PATTERN, '$1<record-id>')
		.replace(
			PREFLIGHT_ADVISORY_LIST_PATTERN,
			`$1${PREFLIGHT_ADVISORY_PLACEHOLDER}\n`,
		);
}

function userMessage(text: string, id: string): HostPartsMessage {
	return {
		info: { id, role: 'user', agent: 'architect', sessionID: SESSION_ID },
		parts: [{ type: 'text', text }],
	};
}

function assistantMessage(text: string, id: string): HostPartsMessage {
	return {
		info: { id, role: 'assistant', agent: 'architect', sessionID: SESSION_ID },
		parts: [{ type: 'text', text }],
	};
}

function seedKnowledgeEntry(directory: string): void {
	const entry = {
		id: 'b7e5c1a2-0000-4000-8000-252600000001',
		tier: 'swarm',
		lesson: `Always run the ${KEYWORD} smoke gate before merging database changes.`,
		category: 'process',
		tags: ['fixture'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00.000Z',
				project_name: 'captured-request-2526',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'captured-request-2526',
		applies_to_agents: ['architect'],
		forbidden_actions: [`skip the ${KEYWORD} smoke gate`],
		directive_priority: 'critical',
	};
	writeFileSync(
		path.join(directory, '.swarm', 'knowledge.jsonl'),
		JSON.stringify(entry),
		'utf-8',
	);
}

async function seedMemoryRecordAsync(
	directory: string,
	sessionId: string,
): Promise<void> {
	const config = resolveMemoryConfig({ enabled: true });
	const context = {
		directory,
		sessionID: sessionId,
		agentRole: 'architect',
		agentId: 'architect',
		runId: sessionId,
	};
	const probe = new MemoryGateway(context, { config });
	const scopes = probe.deriveAllowedScopes();
	probe.dispose();
	const repositoryScope =
		scopes.find((s) => s.type === 'repository') ?? scopes[0]!;
	// Frozen stamp: the record's createdAt/updatedAt feed the recall bundle's
	// age computation and the fixture must stay byte-stable across runs.
	const now = withFrozenClock(() => new Date().toISOString(), CLOCK_OPTIONS);
	const text = `The ${KEYWORD} pipeline requires bun test before every release cut.`;
	const record: MemoryRecord = {
		id: createMemoryId({ scope: repositoryScope, kind: 'project_fact', text }),
		scope: repositoryScope,
		kind: 'project_fact',
		text,
		tags: ['fixture'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'manual', ref: 'issue-2526-capture' },
		createdAt: now,
		updatedAt: now,
		contentHash: computeMemoryContentHash({
			scope: repositoryScope,
			kind: 'project_fact',
			text,
		}),
		metadata: {},
	};
	const provider = createConfiguredMemoryProvider(directory, config);
	await provider.upsert(record);
}

export interface CapturedRequest {
	pinnedHostVersion: string;
	assertionKeywords: string[];
	renderedMessages: Array<{ role: string; text: string }>;
}

/**
 * Derive the captured provider request from the seeds. Exported so the
 * throwaway fixture generator (deleted before commit) captured the fixture
 * with EXACTLY this code path — the parity test re-runs it and compares.
 */
export async function deriveCapturedRequest(): Promise<CapturedRequest> {
	resetSwarmState();
	const directory = createKnowledgeProject();
	try {
		seedKnowledgeEntry(directory);
		await seedMemoryRecordAsync(directory, SESSION_ID);

		const plugin = await bootKnowledgeHost(directory, {
			execution_mode: 'balanced',
			context_budget: { scoring: { enabled: false } },
			memory: { enabled: true },
			guardrails: { enabled: true },
		});

		ensureAgentSession(SESSION_ID, 'architect', directory);
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.pendingAdvisoryMessages = [
			`DEGRADED: ${KEYWORD} context-limit error detected. No fallback models available.`,
		];

		const messages: HostPartsMessage[] = [
			userMessage(`Please handle the ${KEYWORD} release checklist.`, 'u1'),
			assistantMessage('Working on it.', 'a1'),
			userMessage(`Continue the ${KEYWORD} release checklist.`, 'u2'),
		];
		// Frozen clock for the transform run: the recall bundle id embeds the
		// generatedAt instant and the memory score embeds recency decay.
		await withFrozenClockAsync(async () => {
			await plugin.hooks['experimental.chat.messages.transform'](
				{},
				{ messages: messages as never },
			);
		}, CLOCK_OPTIONS);

		const rendered = hostToModelMessages(messages);
		return {
			pinnedHostVersion: '1.18.3',
			assertionKeywords: [
				'DEGRADED:',
				KEYWORD,
				'bun test before every release cut',
			],
			renderedMessages: rendered.map((m) => ({
				role: m.role,
				text: normalizeRenderedText(renderedText([m])),
			})),
		};
	} finally {
		resetSwarmState();
		try {
			safeRmRecursive(directory);
		} catch {
			// Best-effort teardown only (Windows EBUSY from background workers).
		}
	}
}

describe('captured provider request parity (issue #2526 AC2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('the re-derived rendered request deep-equals the committed fixture', async () => {
		// CRLF-normalize the read (git may check the fixture out with CRLF on
		// Windows; the fixture was generated with LF).
		const fixtureRaw = readFileSync(FIXTURE_PATH, 'utf-8').replace(
			/\r\n/g,
			'\n',
		);
		const fixture = JSON.parse(fixtureRaw) as CapturedRequest;

		const derived = await deriveCapturedRequest();
		// Issue #2759 keeps the established transcript prefix intact and stages
		// changing guidance as trailing user-role carriers; deep equality below
		// remains the non-vacuous ordering and content guard.

		expect(derived.pinnedHostVersion).toBe('1.18.3');
		expect(fixture.pinnedHostVersion).toBe('1.18.3');
		expect(derived).toEqual(fixture);

		// Self-contained gate mirroring the frozen C2 check: the joined fixture
		// text must carry all three injection classes.
		const joined = fixture.renderedMessages.map((m) => m.text).join('\n');
		for (const keyword of fixture.assertionKeywords) {
			expect(joined).toContain(keyword);
		}
		const architectSession = derived.renderedMessages.find((message) =>
			message.text.includes('kind="architect-session"'),
		);
		expect(architectSession?.role).toBe('user');
		expect(architectSession?.text).toContain(PREFLIGHT_ADVISORY_HEADER);
		expect(architectSession?.text).toContain(PREFLIGHT_ADVISORY_PLACEHOLDER);
		expect(architectSession?.text).toContain(PREFLIGHT_ADVISORY_RULE_MARKER);
		const advisoryStart = architectSession?.text.indexOf(
			PREFLIGHT_ADVISORY_HEADER,
		);
		const placeholderStart = architectSession?.text.indexOf(
			PREFLIGHT_ADVISORY_PLACEHOLDER,
		);
		const ruleMarkerStart = architectSession?.text.indexOf(
			PREFLIGHT_ADVISORY_RULE_MARKER,
		);
		expect(advisoryStart).toBeGreaterThanOrEqual(0);
		expect(
			architectSession?.text.slice(
				advisoryStart! + PREFLIGHT_ADVISORY_HEADER.length,
				placeholderStart,
			),
		).toBe('\n');
		expect(placeholderStart).toBeGreaterThan(advisoryStart!);
		expect(ruleMarkerStart).toBeGreaterThan(placeholderStart!);
		expect(
			architectSession?.text.slice(
				placeholderStart! + PREFLIGHT_ADVISORY_PLACEHOLDER.length,
				ruleMarkerStart,
			),
		).toBe('\n\n');
		expect(fixture.assertionKeywords).toEqual([
			'DEGRADED:',
			KEYWORD,
			'bun test before every release cut',
		]);
	}, 60_000);
});
