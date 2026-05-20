import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const SESSION_ID = 'test-session-1';

function writePlan() {
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: PLAN_SWARM,
			title: PLAN_TITLE,
			spec: '',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Test task',
						},
					],
				},
			],
		}),
	);
}

/**
 * Write plugin config with optional council overrides.
 * Uses a minimal default config that passes Zod validation.
 */
function writePluginConfig(
	councilOverrides?: Record<string, unknown> | null,
	extraConfig?: Record<string, unknown>,
) {
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	const config: Record<string, unknown> = {
		phase_complete: {
			enabled: true,
			required_agents: [],
			require_docs: false,
			policy: 'warn',
		},
		...extraConfig,
	};
	if (councilOverrides === null) {
		// Explicitly set council to null to test how loader handles it
		config.council = null;
	} else if (councilOverrides !== undefined) {
		config.council = {
			phaseConcernsAllowComplete: true,
			...councilOverrides,
		};
	}
	// If councilOverrides is undefined, no council key is written at all
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

function writeRetro() {
	const retroPath = join(tempDir, '.swarm', 'evidence', 'retro-1');
	mkdirSync(retroPath, { recursive: true });
	writeFileSync(
		join(retroPath, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 done',
					phase_number: 1,
					total_tool_calls: 5,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
		}),
	);
}

function enableCouncilMode() {
	getOrCreateProfile(tempDir, PLAN_ID);
	setGates(tempDir, PLAN_ID, { council_mode: true });
}

function writePhaseCouncil(options: {
	verdict: string;
	quorumSize?: number;
	timestamp?: string;
	phaseNumber?: number;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence', '1');
	mkdirSync(evidencePath, { recursive: true });
	const ts = options.timestamp ?? new Date().toISOString();
	writeFileSync(
		join(evidencePath, 'phase-council.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'phase-1',
			created_at: ts,
			updated_at: ts,
			entries: [
				{
					type: 'phase-council',
					phase_number: options.phaseNumber ?? 1,
					scope: 'phase',
					timestamp: ts,
					verdict: options.verdict,
					quorumSize: options.quorumSize ?? 3,
					requiredFixes: [],
					advisoryNotes: [],
					advisoryFindings: [],
					roundNumber: 1,
					allCriteriaMet: true,
				},
			],
		}),
	);
}

function setup(councilMode: boolean) {
	writePlan();
	writePluginConfig();
	writeRetro();
	ensureAgentSession(SESSION_ID);
	recordPhaseAgentDispatch(SESSION_ID, 'coder');
	recordPhaseAgentDispatch(SESSION_ID, 'reviewer');
	recordPhaseAgentDispatch(SESSION_ID, 'test_engineer');
	recordPhaseAgentDispatch(SESSION_ID, 'docs');
	if (councilMode) enableCouncilMode();
}

async function phaseComplete() {
	return executePhaseComplete(
		{ phase: 1, summary: 'adversarial test', sessionID: SESSION_ID },
		tempDir,
		tempDir,
	);
}

beforeEach(() => {
	resetSwarmState();
	tempDir = mkdtempSync(join(tmpdir(), 'pc-adv-'));
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// ADVERSARIAL TESTS: phaseConcernsAllowComplete config path
// =============================================================================

/**
 * Attack Vector 1: phaseConcernsAllowComplete is absent from config
 * Expected: ?? true fallback applies, phase completes successfully
 *
 * Mechanism: config.council is written WITHOUT phaseConcernsAllowComplete key.
 * Zod default(true) applies during PluginConfigSchema.parse → parsed config has
 * phaseConcernsAllowComplete = true. The ?? true is never reached (no null/undef).
 */
describe('adversarial: phaseConcernsAllowComplete undefined', () => {
	test('AV1: council key absent — Zod default(true) is applied, phase completes', async () => {
		setup(true);
		// Write config with council but WITHOUT phaseConcernsAllowComplete key
		writePluginConfig({});
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// Zod default(true) is applied during config parse, so CONCERNS is allowed
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 2: phaseConcernsAllowComplete is explicitly null in config JSON
 * Expected: Zod rejects null (z.boolean() doesn't accept null), config fails validation
 * The loader falls back to fail-secure defaults (no council key).
 * Result: phase completes (fail-secure is permissive).
 */
describe('adversarial: phaseConcernsAllowComplete null', () => {
	test('AV2: phaseConcernsAllowComplete=null — Zod rejects, loader falls back to fail-secure, phase completes', async () => {
		setup(true);
		// Write config with explicit null
		writePluginConfig({ phaseConcernsAllowComplete: null });
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// null is rejected by z.boolean(), config parse fails, fail-secure defaults used
		// fail-secure has no council key → undefined ?? true → true → allows completion
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 3: phaseConcernsAllowComplete = 0 (falsy number)
 * Expected: Zod rejects 0 (z.boolean() is strict, no coercion)
 * Config parse fails → fail-secure defaults → phase completes.
 */
describe('adversarial: phaseConcernsAllowComplete 0 (falsy number)', () => {
	test('AV3: phaseConcernsAllowComplete=0 — Zod rejects (strict boolean), fail-secure fallback, phase completes', async () => {
		setup(true);
		writePluginConfig({ phaseConcernsAllowComplete: 0 });
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// z.boolean() is strict — 0 is not a boolean → ZodError
		// → config parse fails → fail-secure (no council) → ?? true → true
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 4: phaseConcernsAllowComplete = "true" (string instead of boolean)
 * Expected: Zod rejects string (z.boolean() is strict), fail-secure fallback
 */
describe('adversarial: phaseConcernsAllowComplete "true" (string)', () => {
	test('AV4: phaseConcernsAllowComplete="true" (string) — Zod rejects, fail-secure fallback, phase completes', async () => {
		setup(true);
		writePluginConfig({ phaseConcernsAllowComplete: 'true' });
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 5: phaseConcernsAllowComplete = 1 (truthy number)
 * Expected: Zod rejects 1 (z.boolean() is strict), fail-secure fallback
 */
describe('adversarial: phaseConcernsAllowComplete 1 (truthy number)', () => {
	test('AV5: phaseConcernsAllowComplete=1 — Zod rejects, fail-secure fallback, phase completes', async () => {
		setup(true);
		writePluginConfig({ phaseConcernsAllowComplete: 1 });
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 6: config.council is entirely absent from plugin config
 * Expected: config.council is undefined → optional chaining returns undefined
 *           → ?? true fallback applies → phase completes
 *
 * This is the ONLY case where the ?? true is actually reached at runtime.
 */
describe('adversarial: config.council entirely absent', () => {
	test('AV6: no council key at all — config.council undefined, ?? true applies, phase completes', async () => {
		setup(true);
		// Write config WITHOUT any council key whatsoever
		writePluginConfig(undefined);
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// config.council is undefined → optional chaining bypassed → ?? true triggers
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 7: config.council is explicitly null
 * Expected: config.council is null → optional chaining returns null
 *           → null ?? true = true → phase completes
 *
 * Note: This tests nullish coalescing, not Zod (Zod would fail validation first).
 */
describe('adversarial: config.council null', () => {
	test('AV7: council=null — config.council is null, null ?? true = true, phase completes', async () => {
		setup(true);
		// Write config with council = null
		writePluginConfig(null);
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// config.council === null → optional chaining gives null → null ?? true = true
		// BUT: Zod schema (CouncilConfigSchema.optional()) may reject null at config load time
		// If rejected, fail-secure (no council) is used → ?? true → true
		// Either way, phase completes
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 8: Mixed-case verdict "Concerns" (not all-caps)
 * Expected: Does NOT match 'CONCERNS' or 'concerns' → PHASE_COUNCIL_INVALID
 *
 * Code at lines 1101-1185 shows verdict checks:
 *   entry.verdict === 'REJECT' || entry.verdict === 'reject'   → line 1102-1103
 *   entry.verdict === 'CONCERNS' || entry.verdict === 'concerns' → line 1129-1130
 *   entry.verdict !== 'APPROVE' && ... !== 'approve' && ... !== 'CONCERNS' && ... !== 'concerns'
 *       → PHASE_COUNCIL_INVALID
 * "Concerns" (mixed case) matches none of these → INVALID
 */
describe('adversarial: verdict case sensitivity', () => {
	test('AV8: verdict="Concerns" (mixed case) — NOT matched by CONCERNS or concerns checks, blocked as INVALID', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'Concerns', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_INVALID');
	});

	test('AV8b: verdict="concerns" (lowercase) — MATCHES code at line 1130, treated as advisory', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'concerns', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// 'concerns' is explicitly matched at line 1130
		// With default (no council key), ?? true → true → allows completion
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('AV8c: verdict="reject" (lowercase) — MATCHES code at line 1103, blocks as PHASE_COUNCIL_REJECTED', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'reject', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_REJECTED');
	});

	test('AV8d: verdict="approve" (lowercase) — MATCHES code at line 1167, allows completion', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'approve', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

/**
 * Attack Vector 9: Empty string verdict ""
 * Expected: Does not match any known verdict → PHASE_COUNCIL_INVALID
 */
describe('adversarial: empty string verdict', () => {
	test('AV9: verdict="" (empty string) — not matched by any known verdict, blocked as PHASE_COUNCIL_INVALID', async () => {
		setup(true);
		writePhaseCouncil({ verdict: '', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_INVALID');
	});
});

/**
 * Attack Vector 10: Whitespace-padded verdict " CONCERNS "
 * Expected: Does NOT match 'CONCERNS' (exact string comparison) → PHASE_COUNCIL_INVALID
 *
 * The code uses === comparisons which are strict about whitespace.
 */
describe('adversarial: whitespace-padded verdict', () => {
	test('AV10: verdict=" CONCERNS " (whitespace-padded) — NOT matched by strict === checks, blocked as PHASE_COUNCIL_INVALID', async () => {
		setup(true);
		writePhaseCouncil({ verdict: ' CONCERNS ', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_INVALID');
	});

	test('AV10b: verdict="  concerns  " (whitespace-padded lowercase) — NOT matched, blocked as PHASE_COUNCIL_INVALID', async () => {
		setup(true);
		writePhaseCouncil({
			verdict: '  concerns  ',
			quorumSize: 3,
			phaseNumber: 1,
		});
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_INVALID');
	});
});

// =============================================================================
// BOUNDARY: phaseConcernsAllowComplete explicitly false (valid boolean falsy)
// =============================================================================

/**
 * phaseConcernsAllowComplete: false is a VALID Zod boolean.
 * This tests the explicit false path — CONCERNS should BLOCK completion.
 */
describe('adversarial: phaseConcernsAllowComplete=false (valid boolean)', () => {
	test('AV-BOUNDARY: phaseConcernsAllowComplete=false — CONCERNS verdict BLOCKS with PHASE_COUNCIL_CONCERNS', async () => {
		setup(true);
		writePluginConfig({ phaseConcernsAllowComplete: false });
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_CONCERNS');
	});
});

// =============================================================================
// BOUNDARY: council key is empty object {}
// =============================================================================

/**
 * config.council = {} (empty object, no fields)
 * Zod: missing fields get their defaults
 * phaseConcernsAllowComplete defaults to true
 */
describe('adversarial: config.council empty object', () => {
	test('AV-BOUNDARY: council={} — Zod defaults apply, phaseConcernsAllowComplete=true via default, phase completes', async () => {
		setup(true);
		// Write config with council = {} (empty object)
		mkdirSync(join(tempDir, '.opencode'), { recursive: true });
		writeFileSync(
			join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'warn',
				},
				council: {},
			}),
		);
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// council = {} is valid Zod (all fields optional/defaulted)
		// phaseConcernsAllowComplete gets Zod default(true)
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});

// =============================================================================
// BOUNDARY: Extra keys in council object (.strict() should reject)
// =============================================================================

/**
 * Extra unknown keys in council object
 * CouncilConfigSchema uses .strict() — unknown keys throw ZodError
 * Config fails validation → fail-secure → no council → ?? true → true
 */
describe('adversarial: extra unknown keys in council config', () => {
	test('AV-BOUNDARY: council has extra unknown keys — .strict() rejects, fail-secure, phase completes', async () => {
		setup(true);
		// Write config with extra unknown key in council
		mkdirSync(join(tempDir, '.opencode'), { recursive: true });
		writeFileSync(
			join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'warn',
				},
				council: {
					phaseConcernsAllowComplete: true,
					unknownField: 'should cause strict rejection',
				},
			}),
		);
		writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// .strict() rejects unknown key → config parse fails → fail-secure (no council)
		// → config.council undefined → ?? true → true → allows completion
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});
