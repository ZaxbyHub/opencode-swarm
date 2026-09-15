import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

const BASE_SYSTEM = 'Stable architect system prefix';
const HOST_CONFIG = {
	version_check: false,
	context_budget: { scoring: { enabled: false } },
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

describe('System Enhancer - Retrospective Injection', () => {
	let tempDir: string;
	const sessionId = 'test-session-123';

	beforeEach(async () => {
		tempDir = createPluginHostProject('swarm-retro-test-');
		resetSwarmState();
	});

	afterEach(async () => {
		try {
			safeRmRecursive(tempDir);
		} catch {}
	});

	async function createSwarmFiles(): Promise<void> {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');
		await writeFile(join(swarmDir, 'context.md'), '# Context\n');
	}

	async function createPlan(currentPhase: number): Promise<void> {
		const planContent = JSON.stringify({
			schema_version: '1.0.0',
			title: 'test',
			swarm: 'test',
			phases: [
				{ id: 1, name: 'Phase 1', status: 'completed', tasks: [] },
				{
					id: 2,
					name: 'Phase 2',
					status: currentPhase === 2 ? 'in_progress' : 'pending',
					tasks: [],
				},
				{
					id: 3,
					name: 'Phase 3',
					status: currentPhase === 3 ? 'in_progress' : 'pending',
					tasks: [],
				},
				{ id: 4, name: 'Phase 4', status: 'pending', tasks: [] },
				{ id: 5, name: 'Phase 5', status: 'pending', tasks: [] },
			],
			current_phase: currentPhase,
		});
		await writeFile(join(tempDir, '.swarm', 'plan.json'), planContent);
	}

	async function createRetroBundle(
		phase: number,
		verdict: 'pass' | 'fail' | 'info',
		daysAgo = 1,
	): Promise<void> {
		const retroDir = join(tempDir, '.swarm', 'evidence', `retro-${phase}`);
		await mkdir(retroDir, { recursive: true });

		const timestamp = new Date(
			Date.now() - daysAgo * 24 * 60 * 60 * 1000,
		).toISOString();
		const bundle = {
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					type: 'retrospective',
					task_id: `retro-${phase}`,
					timestamp,
					agent: 'architect',
					verdict,
					summary: `Phase ${phase} completed successfully`,
					metadata: {},
					phase_number: phase,
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: verdict === 'fail' ? 5 : 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: ['Config schema approach not aligned'],
					lessons_learned: [
						'Tree-sitter integration requires WASM grammar files',
						'Security reviews are critical',
					],
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		};
		await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));
	}

	async function invokeHook(
		agentName: string,
		currentPhase = 2,
	): Promise<string[]> {
		await createSwarmFiles();
		await createPlan(currentPhase);

		// Set active agent in swarm state
		swarmState.activeAgent.set(sessionId, agentName);
		if (agentName === 'architect') {
			const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
			const messages: HostPartsMessage[] = [
				{
					info: {
						id: 'retro-architect-user',
						role: 'user',
						agent: agentName,
						sessionID: sessionId,
					},
					parts: [{ type: 'text', text: 'Continue the active plan.' }],
				},
			];
			await host.hooks['experimental.chat.messages.transform'](
				{},
				{ messages },
			);
			const system = [BASE_SYSTEM];
			await host.hooks['experimental.chat.system.transform'](
				{ sessionID: sessionId },
				{ system },
			);
			expect(system).toEqual([BASE_SYSTEM]);
			const carrier = messages.find(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			);
			if (!carrier) return [];
			expect(isRenderableGuidance(carrier)).toBe(true);
			expect(carrier.info.role).toBe('user');
			const text = messageTextOf(carrier);
			expect(renderedText(hostToModelMessages(messages))).toContain(text);
			return [text];
		}

		const hooks = createSystemEnhancerHook(
			{ max_iterations: 5, qa_retry_limit: 3, inject_phase_reminders: true },
			tempDir,
		);
		const transform = hooks['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;
		const input = { sessionID: sessionId };
		const output = { system: ['Initial system prompt'] };
		await transform(input, output);
		return output.system;
	}

	// ========== Tier 1 Tests (same-plan, previous phase) ==========

	it('1. Injects previous phase retrospective when retro-{N-1} exists', async () => {
		// Create retro-1 for Phase 2 context
		await createRetroBundle(1, 'pass', 1);
		await mkdir(join(tempDir, '.swarm', 'evidence', 'retro-2'), {
			recursive: true,
		});

		const systemOutput = await invokeHook('architect', 2);

		// Assert the heading appears with proper format
		const hasRetroHeading = systemOutput.some((s) =>
			s.includes('## Previous Phase Retrospective (Phase 1)'),
		);
		expect(hasRetroHeading).toBe(true);

		// Assert it includes content from the bundle
		const hasOutcome = systemOutput.some((s) =>
			s.includes('Phase 1 completed successfully'),
		);
		const hasRejectionReason = systemOutput.some((s) =>
			s.includes('Config schema approach not aligned'),
		);
		const hasLesson = systemOutput.some((s) =>
			s.includes('Tree-sitter integration requires WASM grammar files'),
		);

		expect(hasOutcome).toBe(true);
		expect(hasRejectionReason).toBe(true);
		expect(hasLesson).toBe(true);
	});

	it('2. Falls back to scan when direct lookup fails but another retro-* bundle exists', async () => {
		// Create retro-3 (not retro-1) to test fallback scan
		await createRetroBundle(3, 'pass', 1);
		await mkdir(join(tempDir, '.swarm', 'evidence', 'retro-1'), {
			recursive: true,
		});
		await mkdir(join(tempDir, '.swarm', 'evidence', 'retro-2'), {
			recursive: true,
		});

		const systemOutput = await invokeHook('architect', 4);

		// Assert fallback found retro-3
		const hasRetroHeading = systemOutput.some((s) =>
			s.includes('## Previous Phase Retrospective (Phase 3)'),
		);
		expect(hasRetroHeading).toBe(true);

		// Assert it includes the phase 3 content
		const hasOutcome = systemOutput.some((s) =>
			s.includes('Phase 3 completed successfully'),
		);
		expect(hasOutcome).toBe(true);
	});

	it('3. Injects for ALL retros regardless of reviewer_rejections count', async () => {
		// Create retro with high reviewer_rejections (5)
		await createRetroBundle(1, 'pass', 1);

		const systemOutput = await invokeHook('architect', 2);

		// Assert injection happens despite high reviewer_rejections
		const hasRetroHeading = systemOutput.some((s) =>
			s.includes('## Previous Phase Retrospective (Phase 1)'),
		);
		expect(hasRetroHeading).toBe(true);
	});

	it('4. Structured block format includes: summary, rejection reasons, lessons learned bullets', async () => {
		await createRetroBundle(1, 'pass', 1);

		const systemOutput = await invokeHook('architect', 2);

		// The carrier contains multiple guidance blocks; measure only the retro
		// block emitted by this injection, not its fence or sibling guidance.
		const carrierText = systemOutput.join('\n\n');
		const retroStart = carrierText.indexOf(
			'## Previous Phase Retrospective (Phase 1)',
		);
		expect(retroStart).toBeGreaterThan(-1);
		const retroTail = carrierText.slice(retroStart);
		const nextBlock = retroTail.search(
			/\n\n(?=(?:## |\[|<\/swarm_system_directive))/,
		);
		const retroBlock =
			nextBlock === -1 ? retroTail : retroTail.slice(0, nextBlock);

		// Check for structured sections
		expect(retroBlock!).toMatch(/\*\*Outcome:\*\*/);
		expect(retroBlock!).toMatch(/\*\*Rejection reasons:\*\*/);
		expect(retroBlock!).toMatch(/\*\*Lessons learned:\*\*/);

		// Check for bullet format in lessons
		expect(retroBlock!).toMatch(
			/- Tree-sitter integration requires WASM grammar files/,
		);
	});

	it('5. Does NOT inject when retro-{N-1} verdict is "fail"', async () => {
		// Create retro-1 with 'fail' verdict
		await createRetroBundle(1, 'fail', 1);

		const systemOutput = await invokeHook('architect', 2);

		// Assert no retrospective injection
		const hasRetroHeading = systemOutput.some((s) =>
			s.includes('## Previous Phase Retrospective'),
		);
		expect(hasRetroHeading).toBe(false);
	});

	// ========== Tier 2 Tests (cross-project historical) ==========

	it('6. Phase 1 project receives "## Historical Lessons" block when recent retros exist', async () => {
		// Create multiple retros with recent timestamps
		await createRetroBundle(3, 'pass', 1); // 1 day ago
		await createRetroBundle(4, 'pass', 2); // 2 days ago

		const systemOutput = await invokeHook('architect', 1);

		// Assert Tier 2 Historical Lessons block appears
		const hasHistoricalHeading = systemOutput.some((s) =>
			s.includes('## Historical Lessons (from recent prior projects)'),
		);
		expect(hasHistoricalHeading).toBe(true);

		// Assert it includes recent retros
		const hasPhase3 = systemOutput.some((s) => s.includes('Phase 3'));
		const hasPhase4 = systemOutput.some((s) => s.includes('Phase 4'));
		expect(hasPhase3 || hasPhase4).toBe(true);
	});

	it('7. Phase 1 project receives NO injection when all retros are older than 30 days', async () => {
		// Create retros older than 30 days
		await createRetroBundle(5, 'pass', 45); // 45 days ago
		await createRetroBundle(6, 'pass', 60); // 60 days ago

		const systemOutput = await invokeHook('architect', 1);

		// Assert no Historical Lessons block
		const hasHistoricalHeading = systemOutput.some((s) =>
			s.includes('## Historical Lessons'),
		);
		expect(hasHistoricalHeading).toBe(false);
	});

	it('8. Phase 1 project receives NO injection when no retro bundles exist at all', async () => {
		// Create evidence directory but no retros
		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		await mkdir(evidenceDir, { recursive: true });

		const systemOutput = await invokeHook('architect', 1);

		// Assert no Historical Lessons block
		const hasHistoricalHeading = systemOutput.some((s) =>
			s.includes('## Historical Lessons'),
		);
		expect(hasHistoricalHeading).toBe(false);
	});

	it('9. Tier 2 shows top-3 most recent retros when 5+ exist', async () => {
		// Create 5 retros
		await createRetroBundle(1, 'pass', 5); // 5 days ago
		await createRetroBundle(2, 'pass', 4);
		await createRetroBundle(3, 'pass', 3);
		await createRetroBundle(4, 'pass', 2);
		await createRetroBundle(5, 'pass', 1); // 1 day ago - most recent

		const systemOutput = await invokeHook('architect', 1);

		// Assert Historical Lessons block appears
		const hasHistoricalHeading = systemOutput.some((s) =>
			s.includes('## Historical Lessons'),
		);
		expect(hasHistoricalHeading).toBe(true);

		// Find the block and count distinct phase entries (not all "Phase X" mentions in text)
		const historicalBlock = systemOutput.find((s) =>
			s.includes('## Historical Lessons'),
		);
		expect(historicalBlock).toBeDefined();

		// Count unique phase numbers mentioned in the format "Phase N (date):"
		const phaseEntryMatches =
			historicalBlock!.match(/Phase \d+ \(\d{4}-\d{2}-\d{2}\):/g) || [];
		// Should have exactly 3 phases (top-3 most recent)
		expect(phaseEntryMatches.length).toBe(3);
	});

	it('10. Phase 2 does NOT get Tier 2 injection (Tier 2 is Phase 1 only)', async () => {
		// Create recent retros for Tier 2
		await createRetroBundle(3, 'pass', 1);

		// Invoke with Phase 2 (should use Tier 1 instead)
		const systemOutput = await invokeHook('architect', 2);

		// Assert NO Historical Lessons block (Tier 2 is Phase 1 only)
		const hasHistoricalHeading = systemOutput.some((s) =>
			s.includes('## Historical Lessons'),
		);
		expect(hasHistoricalHeading).toBe(false);
	});

	it('12. Architect agent does NOT receive [SWARM RETROSPECTIVE] prefix (gets ## heading)', async () => {
		await createRetroBundle(1, 'pass', 1);

		const systemOutput = await invokeHook('architect', 2);

		// Assert architect does NOT get the [SWARM RETROSPECTIVE] prefix
		const hasPrefix = systemOutput.some((s) =>
			s.includes('[SWARM RETROSPECTIVE]'),
		);
		expect(hasPrefix).toBe(false);

		// Assert architect gets the ## heading format
		const hasFullHeading = systemOutput.some((s) =>
			s.includes('## Previous Phase Retrospective'),
		);
		expect(hasFullHeading).toBe(true);
	});

	// ========== General/regression tests ==========

	it('14. No injection when evidence directory does not exist (graceful null)', async () => {
		// Don't create evidence directory
		await createSwarmFiles();

		// Create hook manually to avoid createSwarmFiles() in invokeHook
		const hooks = createSystemEnhancerHook(
			{ max_iterations: 5, qa_retry_limit: 3, inject_phase_reminders: true },
			tempDir,
		);
		const transform = hooks['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;
		const input = { sessionID: sessionId };
		const output = { system: ['Initial system prompt'] };
		await transform(input, output);

		// Assert no retrospective injection (graceful null)
		const hasRetro = output.system.some(
			(s) =>
				s.includes('## Previous Phase Retrospective') ||
				s.includes('[SWARM RETROSPECTIVE]'),
		);
		expect(hasRetro).toBe(false);
	});

	it('15. Combined injection stays within 1600-char cap for architect', async () => {
		// Create retro with long content
		const retroDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
		await mkdir(retroDir, { recursive: true });
		const timestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const longLesson =
			'This is a very long lesson that adds many characters to test the 1600 character cap for architect injection '.repeat(
				20,
			);
		const bundle = {
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					type: 'retrospective',
					task_id: 'retro-1',
					timestamp,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 completed',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [longLesson, longLesson, longLesson],
					lessons_learned: [
						longLesson,
						longLesson,
						longLesson,
						longLesson,
						longLesson,
					],
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		};
		await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));

		const systemOutput = await invokeHook('architect', 2);

		// Measure only the retrospective block within the full architect carrier;
		// the carrier framing and sibling guidance are not part of this cap.
		const carrierText = systemOutput.join('\n\n');
		const retroStart = carrierText.indexOf(
			'## Previous Phase Retrospective (Phase 1)',
		);
		expect(retroStart).toBeGreaterThan(-1);
		const retroTail = carrierText.slice(retroStart);
		const nextSection = retroTail.search(
			/\n\n(?=(?:## |\[|<\/swarm_system_directive))/,
		);
		const retroBlock =
			nextSection < 0 ? retroTail : retroTail.slice(0, nextSection);
		expect(retroBlock.length).toBeLessThanOrEqual(1603);
	});
});
