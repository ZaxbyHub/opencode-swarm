import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	handleBlueprintCurrentCommand,
	handleBlueprintDiffCommand,
	handleBlueprintHistoryCommand,
	handleBlueprintValidateCommand,
	handleHarnessCandidateDiffCommand,
	handleHarnessCandidateShowCommand,
	handleHarnessCandidateValidateCommand,
} from '../../../src/commands/harness.js';
import type { PluginConfig } from '../../../src/config/schema.js';
import { PluginConfigSchema } from '../../../src/config/schema.js';
import {
	computeHarnessCandidateManifestHash,
	deriveHarnessCandidateRiskTier,
} from '../../../src/harness/contracts.js';
import { sha256 } from '../../../src/harness/hash.js';
import { recordHarnessCandidate } from '../../../src/harness/store.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function parseEnvelope(text: string) {
	return JSON.parse(text) as {
		v: 1;
		ok: boolean;
		command: string;
		truncated: boolean;
		maxOutputBytes: number;
		result?: Record<string, unknown>;
		error?: { code: string; message: string };
	};
}

function outputBytes(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}

function makeConfig(
	overrides: Partial<NonNullable<PluginConfig['harness_evolution']>> = {},
): PluginConfig {
	return PluginConfigSchema.parse({
		harness_evolution: {
			max_output_bytes: 262_144,
			max_replay_records: 10_000,
			...overrides,
		},
	});
}

async function seedCandidate(root: string, fileCount = 1) {
	const files = Array.from({ length: fileCount }, (_, index) => ({
		relativePath: `src/example-${index}.ts`,
		trackedMode: '100644',
		beforeSha256: sha256(`before-${index}`),
		afterSha256: sha256(`after-${index}`),
		bytesBefore: 10,
		bytesAfter: 20,
		addedLines: 2,
		removedLines: 1,
		changedLines: 3,
	}));
	const base = {
		v: 1 as const,
		candidateId: `candidate-${fileCount}`,
		baseSha: 'a'.repeat(40),
		origin: 'test',
		patchSha256: sha256('SECRET_PATCH_BYTES'),
		approvedPaths: files.map((file) => file.relativePath),
		promptArtifactHashes: [],
		files,
	};
	const manifest = {
		...base,
		riskTier: deriveHarnessCandidateRiskTier(base),
		manifestHash: computeHarnessCandidateManifestHash(base),
	};
	await recordHarnessCandidate({
		directory: root,
		candidate: {
			v: 1,
			candidate: { ...manifest, patch: 'SECRET_PATCH_BYTES' },
			recordedAt: new Date(0).toISOString(),
		},
	});
	return manifest.candidateId;
}

describe('declarative harness commands', () => {
	let root: string;

	beforeEach(() => {
		root = canonicalMkdtemp('swarm-harness-command-');
		mkdirSync(path.join(root, '.git'));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('enforces exact argument counts with bounded v1 error envelopes', async () => {
		const output = await handleBlueprintValidateCommand(root, []);
		const envelope = parseEnvelope(output);
		expect(envelope).toMatchObject({
			v: 1,
			ok: false,
			command: 'blueprint.validate',
			truncated: false,
		});
		expect(envelope.error?.code).toBe('HARNESS_COMMAND_USAGE');
		expect(outputBytes(output)).toBeLessThanOrEqual(envelope.maxOutputBytes);

		const history = parseEnvelope(
			await handleBlueprintHistoryCommand(root, ['extra']),
		);
		expect(history.error?.code).toBe('HARNESS_COMMAND_USAGE');

		const malformedLimit = parseEnvelope(
			await handleBlueprintHistoryCommand(root, ['--limit', '1.5']),
		);
		expect(malformedLimit.error?.code).toBe('HARNESS_COMMAND_USAGE');

		const outOfRangeLimit = parseEnvelope(
			await handleBlueprintHistoryCommand(root, ['--limit', '101']),
		);
		expect(outOfRangeLimit.error?.code).toBe('HARNESS_COMMAND_USAGE');

		const diff = parseEnvelope(
			await handleBlueprintDiffCommand(root, ['one', 'two', 'three']),
		);
		expect(diff.error?.code).toBe('HARNESS_COMMAND_USAGE');
	});

	it('validates bounded project-relative JSON, rejects traversal, and honors config file-size limits', async () => {
		const traversal = parseEnvelope(
			await handleBlueprintValidateCommand(root, ['../outside.json']),
		);
		expect(traversal.ok).toBe(false);
		expect(traversal.error?.code).toBe('HARNESS_VALIDATION_FAILED');

		const tightConfig = makeConfig({ max_output_bytes: 1024 });
		writeFileSync(
			path.join(root, 'oversized.json'),
			`{"pad":"${'x'.repeat(1400)}"}`,
		);
		const oversizedRaw = await handleHarnessCandidateValidateCommand(
			root,
			['oversized.json'],
			{ config: tightConfig },
		);
		const oversized = parseEnvelope(oversizedRaw);
		expect(oversized.ok).toBe(false);
		expect(oversized.error?.message).toContain(
			'configured harness command size limit',
		);
		expect(outputBytes(oversizedRaw)).toBeLessThanOrEqual(1024);
	});

	it('rejects hardlinked JSON inputs before parsing them', async () => {
		const sourcePath = path.join(root, 'source.json');
		const hardlinkPath = path.join(root, 'hardlinked.json');
		writeFileSync(sourcePath, '{"v":1,"value":"ok"}', 'utf8');
		linkSync(sourcePath, hardlinkPath);

		const output = parseEnvelope(
			await handleBlueprintValidateCommand(root, ['hardlinked.json']),
		);
		expect(output.ok).toBe(false);
		expect(output.error?.code).toBe('HARNESS_VALIDATION_FAILED');
		expect(output.error?.message).toContain('hardlinked file');
	});

	it('projects the supplied static runtime inventory when no version is active', async () => {
		const output = parseEnvelope(
			await handleBlueprintCurrentCommand(root, {
				architect: {
					name: 'architect',
					config: {
						mode: 'primary',
						temperature: 0.1,
						prompt: 'Static architect prompt',
						tools: { read: true },
					},
				},
			}),
		);
		expect(output.ok).toBe(true);
		expect(output.result?.source).toBe('static-shadow');
		const blueprint = output.result?.blueprint as {
			agents: Array<{ agentName: string }>;
			tools: Array<{ toolId: string }>;
			orchestration: { defaultAgent: string };
			agents: Array<{
				agentName: string;
				prompt: { ref: string };
				tools: string[];
			}>;
		};
		expect(blueprint.agents[0].agentName).toBe('architect');
		expect(blueprint.orchestration.defaultAgent).toBe('architect');
		expect(blueprint.agents[0]?.prompt.ref).toBe('static:architect');
		expect(blueprint.agents[0]?.tools).toEqual(['read']);
	});

	it('keeps command static projection stable across insertion order', async () => {
		const first = parseEnvelope(
			await handleBlueprintCurrentCommand(root, {
				zeta: {
					name: 'zeta',
					config: { mode: 'subagent', tools: { write: true, read: true } },
				},
				alpha: {
					name: 'alpha',
					config: { mode: 'primary', tools: { execute: true, read: true } },
				},
			}),
		);
		const second = parseEnvelope(
			await handleBlueprintCurrentCommand(root, {
				alpha: {
					name: 'alpha',
					config: { mode: 'primary', tools: { read: true, execute: true } },
				},
				zeta: {
					name: 'zeta',
					config: { mode: 'subagent', tools: { read: true, write: true } },
				},
			}),
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(first.result?.blueprint).toEqual(second.result?.blueprint);
	});

	it('never exposes raw source patch content and falls back to a bounded summary', async () => {
		const candidateId = await seedCandidate(root, 40);
		const config = makeConfig({ max_output_bytes: 1100 });

		const show = await handleHarnessCandidateShowCommand(root, [candidateId], {
			config,
		});
		const showEnvelope = parseEnvelope(show);
		expect(showEnvelope.ok).toBe(true);
		expect(showEnvelope.truncated).toBe(true);
		expect(show).not.toContain('SECRET_PATCH_BYTES');
		expect(showEnvelope.result?.candidateId).toBe(candidateId);
		expect(outputBytes(show)).toBeLessThanOrEqual(1100);

		const diff = await handleHarnessCandidateDiffCommand(root, [candidateId], {
			config,
		});
		const diffEnvelope = parseEnvelope(diff);
		expect(diffEnvelope.ok).toBe(true);
		expect(diffEnvelope.truncated).toBe(true);
		expect(diff).not.toContain('SECRET_PATCH_BYTES');
		expect(outputBytes(diff)).toBeLessThanOrEqual(1100);
	});

	it('surfaces replay-bound violations as bounded error envelopes', async () => {
		for (let index = 0; index < 6; index++) {
			await seedCandidate(root, index + 1);
		}

		const output = await handleBlueprintHistoryCommand(root, [], {
			config: makeConfig({ max_replay_records: 4, max_output_bytes: 1024 }),
		});
		const envelope = parseEnvelope(output);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe('HARNESS_HISTORY_FAILED');
		expect(envelope.error?.message).toContain('replay bound 4');
		expect(outputBytes(output)).toBeLessThanOrEqual(1024);
	});

	it('trims history output to the configured byte budget when replay stays within bounds', async () => {
		for (let index = 0; index < 4; index++) {
			await seedCandidate(root, index + 1);
		}

		const output = await handleBlueprintHistoryCommand(root, [], {
			config: makeConfig({
				max_replay_records: 10_000,
				max_output_bytes: 1024,
			}),
		});
		const envelope = parseEnvelope(output);
		expect(envelope.ok).toBe(true);
		expect(envelope.truncated).toBe(true);
		const records = (envelope.result?.records as Array<unknown>) ?? [];
		expect(records.length).toBeLessThan(4);
		expect(outputBytes(output)).toBeLessThanOrEqual(1024);
	});

	it('respects an explicit history --limit within the bounded output envelope', async () => {
		for (let index = 0; index < 4; index++) {
			await seedCandidate(root, index + 1);
		}

		const output = await handleBlueprintHistoryCommand(root, ['--limit', '2'], {
			config: makeConfig({
				max_replay_records: 10_000,
				max_output_bytes: 16_384,
			}),
		});
		const envelope = parseEnvelope(output);
		expect(envelope.ok).toBe(true);
		expect(envelope.truncated).toBe(true);
		expect(envelope.result?.recordCount).toBe(2);
		const records =
			(envelope.result?.records as Array<{ candidateId?: string }>) ?? [];
		expect(records).toHaveLength(2);
		expect(outputBytes(output)).toBeLessThanOrEqual(16_384);
	});

	it('rejects unsafe artifact ids with machine-readable envelopes', async () => {
		const output = parseEnvelope(
			await handleHarnessCandidateShowCommand(root, ['../bad']),
		);
		expect(output.ok).toBe(false);
		expect(output.error?.code).toBe('HARNESS_INVALID_IDENTIFIER');
		expect(output.command).toBe('harness.candidate.show');
	});
});
