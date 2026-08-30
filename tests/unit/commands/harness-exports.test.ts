import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	handleBlueprintDiffCommand,
	handleBlueprintExportCommand,
	handleBlueprintValidateCommand,
} from '../../../src/commands/harness.js';
import type { PluginConfig } from '../../../src/config/schema.js';
import { PluginConfigSchema } from '../../../src/config/schema.js';
import {
	computeHarnessCandidateManifestHash,
	deriveHarnessCandidateRiskTier,
} from '../../../src/harness/contracts.js';
import { createAgentFactory } from '../../../src/harness/factory.js';
import { sha256 } from '../../../src/harness/hash.js';
import {
	activateHarnessCandidate,
	buildHarnessActivationApprovalRequest,
	loadHarnessCurrent,
	recordHarnessCandidate,
} from '../../../src/harness/store.js';
import {
	computeWriteApprovalHash,
	issueWriteApprovalFact,
} from '../../../src/security/write-authority.js';
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

function allowedPathDigest(paths: readonly string[]): string {
	return computeWriteApprovalHash({
		allowedPaths: [...paths].sort(),
	});
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

function buildBlueprint(args: {
	blueprintId: string;
	prompt: string;
	tools?: string[];
}): ReturnType<ReturnType<typeof createAgentFactory>['projectBlueprint']> {
	const tools = args.tools ?? ['read', 'write'];
	return createAgentFactory({
		runtimeDefinitions: [
			{
				name: 'architect',
				config: {
					mode: 'primary',
					temperature: 0.1,
					prompt: args.prompt,
					tools: Object.fromEntries(tools.map((tool) => [tool, true])),
				},
			},
		],
		registeredToolIds: tools,
	}).projectBlueprint({
		blueprintId: args.blueprintId,
	});
}

function writeHarnessVersion(
	root: string,
	versionId: string,
	blueprint: ReturnType<typeof buildBlueprint>,
) {
	const versionsDir = path.join(
		root,
		'.swarm',
		'evolution',
		'harness',
		'versions',
	);
	mkdirSync(versionsDir, { recursive: true });
	writeFileSync(
		path.join(versionsDir, `${versionId}.json`),
		`${JSON.stringify(
			{
				v: 1,
				versionId,
				candidateId: `candidate-${versionId}`,
				manifestHash: sha256(versionId),
				allowedPathDigest: allowedPathDigest(['src/example.ts']),
				generation: 1,
				sourceKind: 'activation',
				parentVersionId: null,
				restoredFromVersionId: null,
				approvalFactId: `approval-${versionId}`,
				blueprint,
				recordedAt: new Date(0).toISOString(),
			},
			null,
			2,
		)}\n`,
	);
}

async function seedActivatedVersion(args: {
	root: string;
	versionSeed: string;
	prompt: string;
}): Promise<{ versionId: string }> {
	const blueprint = buildBlueprint({
		blueprintId: args.versionSeed,
		prompt: args.prompt,
	});
	const manifestBase = {
		v: 1 as const,
		candidateId: `candidate-${args.versionSeed}`,
		baseSha: 'a'.repeat(40),
		origin: 'test',
		patchSha256: sha256(`patch-${args.versionSeed}`),
		approvedPaths: ['src/example.ts'],
		promptArtifactHashes: [],
		files: [
			{
				relativePath: 'src/example.ts',
				trackedMode: '100644',
				beforeSha256: sha256(`before-${args.versionSeed}`),
				afterSha256: sha256(`after-${args.versionSeed}`),
				bytesBefore: 10,
				bytesAfter: 20,
				addedLines: 2,
				removedLines: 1,
				changedLines: 3,
			},
		],
	};
	const stored = {
		v: 1 as const,
		candidate: {
			...manifestBase,
			riskTier: deriveHarnessCandidateRiskTier(manifestBase),
			manifestHash: computeHarnessCandidateManifestHash(manifestBase),
			patch: `patch-${args.versionSeed}`,
		},
		baseBlueprint: blueprint,
		targetBlueprint: blueprint,
		blueprintPatch: {
			v: 1 as const,
			patchId: `patch-${args.versionSeed}`,
			expectedBaseHash: blueprint.contentHash,
			expectedResultHash: blueprint.contentHash,
			operations: [],
		},
		recordedAt: new Date(0).toISOString(),
	};
	await recordHarnessCandidate({
		directory: args.root,
		candidate: stored,
	});
	const current = await loadHarnessCurrent(args.root);
	const expectedCurrentHash =
		current.currentVersionId === null ? null : current.currentHash;
	const expectedCurrentGeneration = current.generation;
	const targetContentHash = stored.candidate.manifestHash;
	const pathsDigest = allowedPathDigest(stored.candidate.approvedPaths);
	const request = buildHarnessActivationApprovalRequest({
		targetSessionId: 'session-a',
		candidate: stored,
		expectedCurrentHash,
		expectedCurrentGeneration,
		targetContentHash,
		allowedPathDigest: pathsDigest,
	});
	await issueWriteApprovalFact({
		directory: args.root,
		request,
		issuingSessionId: 'human-session',
	});
	const activated = await activateHarnessCandidate({
		directory: args.root,
		candidateId: stored.candidate.candidateId,
		consumerSessionId: 'session-a',
		expectedCurrentHash,
		expectedCurrentGeneration,
		targetContentHash,
		allowedPathDigest: pathsDigest,
	});
	if (activated.status !== 'activated') {
		throw new Error(`expected activation, got ${activated.status}`);
	}
	return { versionId: activated.version.versionId };
}

describe('harness export and version command boundaries', () => {
	let root: string;

	beforeEach(() => {
		root = canonicalMkdtemp('swarm-harness-export-');
		mkdirSync(path.join(root, '.git'));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('rejects orphan versions that are not committed in ledger history', async () => {
		writeHarnessVersion(
			root,
			'orphan-version',
			buildBlueprint({
				blueprintId: 'orphan-version',
				prompt: 'Orphan prompt',
			}),
		);
		const committed = await seedActivatedVersion({
			root,
			versionSeed: 'committed-version',
			prompt: 'Committed prompt',
		});

		const validate = parseEnvelope(
			await handleBlueprintValidateCommand(root, ['orphan-version']),
		);
		expect(validate.ok).toBe(false);
		expect(validate.error?.code).toBe('HARNESS_VALIDATION_FAILED');
		expect(validate.error?.message).toContain(
			'not committed in harness ledger',
		);

		const exported = parseEnvelope(
			await handleBlueprintExportCommand(root, ['orphan-version']),
		);
		expect(exported.ok).toBe(false);
		expect(exported.error?.code).toBe('HARNESS_NOT_FOUND');
		expect(exported.error?.message).toContain(
			'not committed in harness ledger',
		);

		const diff = parseEnvelope(
			await handleBlueprintDiffCommand(root, [
				'orphan-version',
				committed.versionId,
			]),
		);
		expect(diff.ok).toBe(false);
		expect(diff.error?.code).toBe('HARNESS_NOT_FOUND');
		expect(diff.error?.message).toContain('not committed in harness ledger');
	});

	it('falls back to bounded summary output for large export and diff payloads', async () => {
		const activatedOne = await seedActivatedVersion({
			root,
			versionSeed: 'version-a',
			prompt: `Prompt ${'A'.repeat(5000)}`,
		});
		const activatedTwo = await seedActivatedVersion({
			root,
			versionSeed: 'version-b',
			prompt: `Prompt ${'B'.repeat(5000)}`,
		});
		const config = makeConfig({ max_output_bytes: 1250 });

		const exported = await handleBlueprintExportCommand(
			root,
			[activatedOne.versionId],
			{ config },
		);
		const exportEnvelope = parseEnvelope(exported);
		expect(exportEnvelope.ok).toBe(true);
		expect(exportEnvelope.truncated).toBe(false);
		expect(exportEnvelope.result?.blueprint).toBeDefined();
		expect(outputBytes(exported)).toBeLessThanOrEqual(1250);

		const diff = await handleBlueprintDiffCommand(
			root,
			[activatedOne.versionId, activatedTwo.versionId],
			{ config },
		);
		const diffEnvelope = parseEnvelope(diff);
		expect(diffEnvelope.ok).toBe(true);
		expect(diffEnvelope.truncated).toBe(false);
		expect(diffEnvelope.result?.changes).toBeDefined();
		expect(outputBytes(diff)).toBeLessThanOrEqual(1250);
	});
});
