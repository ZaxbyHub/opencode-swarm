/**
 * Tests for src/tools/convene-general-council.ts.
 *
 * Covers config gating, evidence path isolation (.swarm/council/general/),
 * roundsCompleted derivation, and structured-error responses for invalid
 * args + disabled-config paths. The moderatorPrompt field has been removed
 * from ConveneOk — the architect now synthesizes the final answer directly
 * via the inline output rules in MODE: COUNCIL.
 *
 * Real filesystem (tmp dir) for evidence-path assertions; no real HTTP.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	// Create the tmp dir in the OS tmp area, not under cwd, so the resolver's
	// "subdirectory of project root" check does not reject it.
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'convene-gc-test-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.opencode'), { recursive: true });
	// Point cwd at tmpDir so the createSwarmTool wrapper's ctx?.directory ?? process.cwd()
	// fallback resolves to tmpDir (which matches working_directory passed in args).
	process.chdir(tmpDir);
});

afterEach(() => {
	try {
		process.chdir(originalCwd);
	} catch {
		// ignore
	}
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function writeConfig(config: object): void {
	fs.writeFileSync(
		path.join(tmpDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config, null, 2),
	);
}

const validRound1 = [
	{
		memberId: 'm1',
		model: 'gpt-test',
		role: 'generalist' as const,
		response: 'Round 1 response from m1.',
		sources: [],
		searchQueries: [],
		confidence: 0.8,
		areasOfUncertainty: [],
		durationMs: 100,
	},
	{
		memberId: 'm2',
		model: 'claude-test',
		role: 'skeptic' as const,
		response: 'Round 1 response from m2.',
		sources: [],
		searchQueries: [],
		confidence: 0.7,
		areasOfUncertainty: [],
		durationMs: 120,
	},
];

async function callTool(
	args: unknown,
	dir: string,
): Promise<{
	parsed: Record<string, unknown>;
	raw: string;
}> {
	const { convene_general_council } = await import(
		'../tools/convene-general-council.js'
	);
	const wrapped = convene_general_council as unknown as {
		execute: (a: unknown, d: string) => Promise<string>;
	};
	const raw = await wrapped.execute(args, dir);
	return { parsed: JSON.parse(raw), raw };
}

describe('convene_general_council — config gate', () => {
	test('blocks when council.general.enabled is false', async () => {
		writeConfig({ council: { general: { enabled: false } } });
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('council_general_disabled');
	});

	test('blocks when council.general is absent', async () => {
		writeConfig({ council: { general: { enabled: false } } });
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('council_general_disabled');
	});
});

describe('convene_general_council — happy paths', () => {
	test('Round 1 only: roundsCompleted = 1, no moderatorPrompt field on result', async () => {
		writeConfig({
			council: { general: { enabled: true } },
		});
		const { parsed } = await callTool(
			{
				question: 'What database?',
				mode: 'general',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.roundsCompleted).toBe(1);
		expect(parsed.moderatorPrompt).toBeUndefined();
		expect(typeof parsed.synthesis).toBe('string');
	});

	test('Round 1 + Round 2: roundsCompleted = 2', async () => {
		writeConfig({ council: { general: { enabled: true } } });
		const round2 = [
			{
				...validRound1[0],
				disagreementTopics: ['some topic'],
				response: 'I MAINTAIN my position.',
			},
		];
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: validRound1,
				round2Responses: round2,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.roundsCompleted).toBe(2);
	});

	test('moderator: true in config is ignored (no moderatorPrompt on result)', async () => {
		// The moderator config field is deprecated and ignored at runtime — the
		// architect synthesizes the final answer directly. This test pins the
		// new behavior so a regression that resurrects moderatorPrompt would fail.
		writeConfig({ council: { general: { enabled: true, moderator: true } } });
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.moderatorPrompt).toBeUndefined();
	});
});

describe('convene_general_council — evidence isolation', () => {
	test('writes evidence to .swarm/council/general/, not .swarm/council/ root', async () => {
		writeConfig({ council: { general: { enabled: true, moderator: false } } });
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(true);
		const evidenceDir = path.join(tmpDir, '.swarm', 'council', 'general');
		const files = fs.readdirSync(evidenceDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/-general\.json$/);

		// Confirm the parent .swarm/council/ root has only the general/ subdir
		// (no flat files written there)
		const councilRoot = path.join(tmpDir, '.swarm', 'council');
		const rootEntries = fs.readdirSync(councilRoot);
		expect(
			rootEntries.filter((e) =>
				fs.statSync(path.join(councilRoot, e)).isFile(),
			),
		).toEqual([]);
	});

	test('spec_review mode is reflected in evidence filename', async () => {
		writeConfig({ council: { general: { enabled: true, moderator: false } } });
		await callTool(
			{
				question: 'review',
				mode: 'spec_review',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		const files = fs.readdirSync(
			path.join(tmpDir, '.swarm', 'council', 'general'),
		);
		expect(files.some((f) => f.endsWith('-spec_review.json'))).toBe(true);
	});
});

describe('convene_general_council — adversarial inputs', () => {
	test('malformed round1Responses → structured error, no throw', async () => {
		writeConfig({ council: { general: { enabled: true } } });
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: [{ broken: true }],
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid_args');
	});

	test('empty round1Responses → structured error', async () => {
		writeConfig({ council: { general: { enabled: true } } });
		const { parsed } = await callTool(
			{
				question: 'q',
				mode: 'general',
				round1Responses: [],
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid_args');
	});

	test('missing question → structured error', async () => {
		writeConfig({ council: { general: { enabled: true } } });
		const { parsed } = await callTool(
			{
				mode: 'general',
				round1Responses: validRound1,
				working_directory: tmpDir,
			},
			tmpDir,
		);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid_args');
	});
});
