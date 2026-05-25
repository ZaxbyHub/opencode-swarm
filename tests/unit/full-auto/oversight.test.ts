/**
 * Unit tests for src/full-auto/oversight.ts.
 *
 * The oversight dispatcher needs the OpenCode SDK client at runtime. For
 * unit testing we exercise:
 *   - parseFullAutoCriticResponse: pure parser, no client.
 *   - dispatchFullAutoOversight fallback (no client) with no durable run:
 *     returns PENDING decision and writes an event.
 *   - dispatchFullAutoOversight fallback (no client) with active durable run:
 *     fail-closed pause + BLOCKED verdict.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	dispatchFullAutoOversight,
	parseFullAutoCriticResponse,
} from '../../../src/full-auto/oversight';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-oversight-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	stateInternals.swarmState.opencodeClient = null;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('parseFullAutoCriticResponse', () => {
	test('parses APPROVED verdict with single-line reasoning', () => {
		const r = parseFullAutoCriticResponse(
			'VERDICT: APPROVED\nREASONING: looks good\nEVIDENCE_CHECKED: diff,test_impact\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
		);
		expect(r.verdict).toBe('APPROVED');
		expect(r.reasoning).toBe('looks good');
		expect(r.evidenceChecked).toEqual(['diff', 'test_impact']);
		expect(r.antiPatternsDetected.length).toBe(0);
		expect(r.escalationNeeded).toBe(false);
	});

	test('flags ESCALATION_NEEDED YES', () => {
		const r = parseFullAutoCriticResponse(
			'VERDICT: ESCALATE_TO_HUMAN\nREASONING: prod migration\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: YES',
		);
		expect(r.verdict).toBe('ESCALATE_TO_HUMAN');
		expect(r.escalationNeeded).toBe(true);
	});

	test('defaults unknown verdict to NEEDS_REVISION', () => {
		const r = parseFullAutoCriticResponse(
			'VERDICT: WHAT\nREASONING: x\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
		);
		expect(r.verdict).toBe('NEEDS_REVISION');
	});

	test('parses PENDING verdict', () => {
		const r = parseFullAutoCriticResponse(
			'VERDICT: PENDING\nREASONING: Waiting for additional evidence\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
		);
		expect(r.verdict).toBe('PENDING');
		expect(r.reasoning).toBe('Waiting for additional evidence');
	});

	test('handles multi-line reasoning blocks', () => {
		const r = parseFullAutoCriticResponse(
			'VERDICT: NEEDS_REVISION\nREASONING: line1\n  more details\n  and more\nEVIDENCE_CHECKED: diff\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
		);
		expect(r.reasoning).toContain('line1');
		expect(r.reasoning).toContain('more details');
		expect(r.evidenceChecked).toEqual(['diff']);
	});
});

describe('dispatchFullAutoOversight fail-closed behavior', () => {
	test('returns PENDING when no client and no durable run', async () => {
		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-1',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
		});
		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pending');
		// Event must have been written.
		const eventsPath = path.join(tmpDir, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);
		const lines = fs
			.readFileSync(eventsPath, 'utf-8')
			.trim()
			.split('\n')
			.filter(Boolean);
		expect(lines.length).toBe(1);
		const event = JSON.parse(lines[0]);
		expect(event.type).toBe('full_auto_oversight');
		expect(event.session_id).toBe('sess-1');
	});

	test('pauses durable run when no client and run is active', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-1',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
		});
		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pause');
		const state = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(state?.status).toBe('paused');
	});

	test('writes evidence when phase is provided', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-1',
			trigger: 'phase done',
			triggerSource: 'phase_boundary',
			phase: 2,
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
		});
		const evidenceDir = path.join(tmpDir, '.swarm', 'evidence', '2');
		expect(fs.existsSync(evidenceDir)).toBe(true);
		const files = fs
			.readdirSync(evidenceDir)
			.filter((f) => f.startsWith('full-auto-'));
		expect(files.length).toBe(1);
	});
});

describe('TASK 6 — persistence failure -> BLOCKED in fail_closed mode', () => {
	test('writeFullAutoOversightEvent throws on append failure', async () => {
		const { writeFullAutoOversightEvent } = await import(
			'../../../src/full-auto/oversight'
		);
		// Force append failure by making events.jsonl an unwritable directory.
		const eventsPath = path.join(tmpDir, '.swarm', 'events.jsonl');
		fs.mkdirSync(eventsPath, { recursive: true });
		await expect(
			writeFullAutoOversightEvent(tmpDir, {
				type: 'full_auto_oversight',
				timestamp: new Date().toISOString(),
				session_id: 'sess',
				trigger_source: 'tool_action',
				trigger_reason: 'test',
				critic_agent: 'critic_oversight',
				critic_model: 'm',
				verdict: 'APPROVED',
				reasoning: '',
				evidence_checked: ['diff'],
				anti_patterns_detected: [],
				escalation_needed: false,
				decision: 'allow',
				oversight_sequence: 1,
			}),
		).rejects.toThrow(/persistence failed/);
	});

	test('writeFullAutoOversightEvidence throws on phase write failure', async () => {
		const { writeFullAutoOversightEvidence } = await import(
			'../../../src/full-auto/oversight'
		);
		// Force evidence write failure: make the per-phase evidence path
		// already a regular file so mkdirSync(recursive) cannot succeed.
		const phaseDir = path.join(tmpDir, '.swarm', 'evidence');
		fs.mkdirSync(phaseDir, { recursive: true });
		fs.writeFileSync(path.join(phaseDir, '99'), 'blocking-file', 'utf-8');
		await expect(
			writeFullAutoOversightEvidence(tmpDir, 99, {
				type: 'full_auto_oversight',
				timestamp: new Date().toISOString(),
				session_id: 'sess',
				trigger_source: 'phase_boundary',
				trigger_reason: 'test',
				critic_agent: 'critic_oversight',
				critic_model: 'm',
				verdict: 'APPROVED',
				reasoning: '',
				evidence_checked: ['diff'],
				anti_patterns_detected: [],
				escalation_needed: false,
				decision: 'allow',
				oversight_sequence: 1,
			}),
		).rejects.toThrow(/evidence persistence failed/);
	});
});
