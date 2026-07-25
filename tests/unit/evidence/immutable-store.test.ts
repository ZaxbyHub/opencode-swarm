/**
 * Tests for the shared immutable-artifact write pipeline (issue #1821).
 *
 * `writeImmutableArtifact` is the single write-once path shared by the
 * evaluation store and the consensus report store. These tests exercise it
 * through a stand-in "consensus report" artifact — a caller that is NOT the
 * evaluation store — so the extraction is proven to be genuinely generic:
 * its own serializer, its own schema parse, its own conflict error class, and
 * its own lock actor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ImmutableArtifactConflict,
	readOptionalFile,
	writeImmutableArtifact,
} from '../../../src/evidence/immutable-store';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';

// ---------------------------------------------------------------------------
// Stand-in consumer: a "consensus report" store with its own everything.
// ---------------------------------------------------------------------------

type Report = { id: string; score: number };

/** Deterministic canonical encoding: sorted keys, trailing newline. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort())
			out[key] = canonical(record[key]);
		return out;
	}
	return value;
}

function serialize(value: unknown): string {
	return `${JSON.stringify(canonical(value))}\n`;
}

function parseReport(value: unknown): Report {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('report must be an object');
	}
	const record = value as Record<string, unknown>;
	if (typeof record.id !== 'string' || typeof record.score !== 'number') {
		throw new Error('report shape is invalid');
	}
	return { id: record.id, score: record.score };
}

class ConsensusConflictError extends Error {
	readonly kind: ImmutableArtifactConflict['kind'];
	readonly filePath: string;

	constructor(conflict: ImmutableArtifactConflict) {
		super(
			conflict.kind === 'corrupt'
				? `consensus artifact is corrupt: ${conflict.filePath}: ${String(conflict.cause)}`
				: `consensus artifact conflicts with existing content: ${conflict.filePath}`,
		);
		this.name = 'ConsensusConflictError';
		this.kind = conflict.kind;
		this.filePath = conflict.filePath;
	}
}

let tempDir: string;

const REL_PATH = join('evolution', 'consensus', 'report-1.json');

function artifactPath(dir: string = tempDir): string {
	return join(dir, '.swarm', REL_PATH);
}

function writeReport(options: {
	value: Report;
	agent?: string;
	isEquivalent?: (existing: Report, desired: Report) => boolean;
}): Promise<Report> {
	return writeImmutableArtifact<Report>({
		directory: tempDir,
		relativeLockPath: REL_PATH,
		filePath: artifactPath(),
		agent: options.agent ?? 'consensus-store',
		taskId: options.value.id,
		value: options.value,
		serialize,
		parse: parseReport,
		...(options.isEquivalent ? { isEquivalent: options.isEquivalent } : {}),
		conflictError: (conflict) => new ConsensusConflictError(conflict),
	});
}

beforeEach(() => {
	// realpathSync wrap is required (AGENTS.md invariant 7): on macOS
	// os.tmpdir() returns /var/folders/... which is a symlink to
	// /private/var/folders/..., and the containment guards these tests exercise
	// compare canonical paths. Enforced by scripts/check-test-tmpdir.sh.
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'immutable-store-')));
	resetTelemetryForTesting();
});

afterEach(() => {
	resetTelemetryForTesting();
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('writeImmutableArtifact — first write', () => {
	test('persists the artifact and returns the written value', async () => {
		const value: Report = { id: 'r1', score: 7 };

		const result = await writeReport({ value });

		expect(result).toEqual(value);
		expect(readFileSync(artifactPath(), 'utf-8')).toBe(serialize(value));
	});

	test('creates missing parent directories', async () => {
		// Nothing under .swarm/ exists yet — the writer must mkdir -p.
		expect(readdirSync(tempDir)).toEqual([]);

		await writeReport({ value: { id: 'r1', score: 1 } });

		expect(
			readdirSync(join(tempDir, '.swarm', 'evolution', 'consensus')),
		).toContain('report-1.json');
	});

	test('written content is complete and parses back to the same artifact', async () => {
		const value: Report = { id: 'r1', score: 42 };
		await writeReport({ value });

		const raw = readFileSync(artifactPath(), 'utf-8');
		expect(raw.endsWith('\n')).toBe(true);
		expect(parseReport(JSON.parse(raw))).toEqual(value);
	});
});

describe('writeImmutableArtifact — idempotent re-write', () => {
	test('an identical second write does not throw and returns the artifact', async () => {
		const value: Report = { id: 'r1', score: 7 };
		await writeReport({ value });

		const second = await writeReport({ value: { ...value } });

		expect(second).toEqual(value);
		expect(readFileSync(artifactPath(), 'utf-8')).toBe(serialize(value));
	});

	test('a canonically-identical write leaves the existing bytes untouched', async () => {
		// Seed a file whose raw bytes differ (key order, no trailing newline) but
		// whose canonical form equals the desired payload. If the writer rewrote
		// the file, these bytes would be replaced — proving no write occurred.
		const seeded = '{"score":7,"id":"r1"}';
		mkdirSync(join(tempDir, '.swarm', 'evolution', 'consensus'), {
			recursive: true,
		});
		writeFileSync(artifactPath(), seeded, 'utf-8');

		const result = await writeReport({ value: { id: 'r1', score: 7 } });

		expect(result).toEqual({ id: 'r1', score: 7 });
		expect(readFileSync(artifactPath(), 'utf-8')).toBe(seeded);
	});

	test('re-write returns the value parsed from disk, not the caller argument', async () => {
		// The existing artifact carries an extra field the schema drops; the
		// returned object must be the on-disk parse, so the extra field is gone.
		mkdirSync(join(tempDir, '.swarm', 'evolution', 'consensus'), {
			recursive: true,
		});
		writeFileSync(
			artifactPath(),
			'{"id":"r1","score":7,"extra":true}',
			'utf-8',
		);

		const result = (await writeReport({
			value: { id: 'r1', score: 7 },
		})) as Record<string, unknown>;

		expect(result).toEqual({ id: 'r1', score: 7 });
		expect(result.extra).toBeUndefined();
	});

	test('isEquivalent accepts a differing payload and returns the stored one', async () => {
		await writeReport({ value: { id: 'r1', score: 7 } });

		const result = await writeReport({
			value: { id: 'r1', score: 999 },
			isEquivalent: (existing, desired) => existing.id === desired.id,
		});

		// The stored artifact wins — the divergent score is discarded, not written.
		expect(result).toEqual({ id: 'r1', score: 7 });
		expect(readFileSync(artifactPath(), 'utf-8')).toBe(
			serialize({ id: 'r1', score: 7 }),
		);
	});
});

describe('writeImmutableArtifact — conflicts', () => {
	test('a different payload at the same path throws the conflict error', async () => {
		await writeReport({ value: { id: 'r1', score: 7 } });

		const attempt = writeReport({ value: { id: 'r1', score: 8 } });

		await expect(attempt).rejects.toBeInstanceOf(ConsensusConflictError);
		await expect(attempt).rejects.toThrow(
			'consensus artifact conflicts with existing content',
		);
	});

	test('the conflict carries kind "divergent" and the artifact path', async () => {
		await writeReport({ value: { id: 'r1', score: 7 } });

		const error = await writeReport({ value: { id: 'r1', score: 8 } }).catch(
			(caught: unknown) => caught as ConsensusConflictError,
		);

		expect(error.kind).toBe('divergent');
		expect(error.filePath).toBe(artifactPath());
	});

	test('a conflicting write does not overwrite the existing artifact', async () => {
		await writeReport({ value: { id: 'r1', score: 7 } });

		await expect(
			writeReport({ value: { id: 'r1', score: 8 } }),
		).rejects.toBeInstanceOf(ConsensusConflictError);

		expect(readFileSync(artifactPath(), 'utf-8')).toBe(
			serialize({ id: 'r1', score: 7 }),
		);
	});

	test('unparseable existing content throws kind "corrupt" with the cause', async () => {
		mkdirSync(join(tempDir, '.swarm', 'evolution', 'consensus'), {
			recursive: true,
		});
		writeFileSync(artifactPath(), '{ not json', 'utf-8');

		const error = await writeReport({ value: { id: 'r1', score: 7 } }).catch(
			(caught: unknown) => caught as ConsensusConflictError,
		);

		expect(error).toBeInstanceOf(ConsensusConflictError);
		expect(error.kind).toBe('corrupt');
		expect(error.message).toContain('consensus artifact is corrupt');
	});

	test('schema-invalid existing content also throws kind "corrupt"', async () => {
		mkdirSync(join(tempDir, '.swarm', 'evolution', 'consensus'), {
			recursive: true,
		});
		writeFileSync(artifactPath(), '{"id":"r1","score":"seven"}', 'utf-8');

		const error = await writeReport({ value: { id: 'r1', score: 7 } }).catch(
			(caught: unknown) => caught as ConsensusConflictError,
		);

		expect(error.kind).toBe('corrupt');
		expect(error.message).toContain('report shape is invalid');
	});

	test('concurrent divergent writers: exactly one wins, the other conflicts', async () => {
		const settled = await Promise.allSettled([
			writeReport({ value: { id: 'r1', score: 1 } }),
			writeReport({ value: { id: 'r1', score: 2 } }),
		]);

		const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
		const rejected = settled.filter((entry) => entry.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			ConsensusConflictError,
		);
	});
});

describe('writeImmutableArtifact — lock actor', () => {
	test('the agent parameter is the actor recorded on the acquired lock', async () => {
		initTelemetry(tempDir);
		const acquired: Record<string, unknown>[] = [];
		addTelemetryListener((event, data) => {
			if (event === 'evidence_lock_acquired') acquired.push(data);
		});

		await writeReport({
			value: { id: 'r1', score: 7 },
			agent: 'consensus-store',
		});

		expect(acquired).toHaveLength(1);
		expect(acquired[0]?.agent).toBe('consensus-store');
		expect(acquired[0]?.evidencePath).toBe(REL_PATH);
		expect(acquired[0]?.taskId).toBe('r1');
	});

	test('a different agent is honored rather than a hard-coded default', async () => {
		initTelemetry(tempDir);
		const agents: unknown[] = [];
		addTelemetryListener((event, data) => {
			if (event === 'evidence_lock_acquired') agents.push(data.agent);
		});

		await writeReport({
			value: { id: 'r1', score: 7 },
			agent: 'evaluation-store',
		});
		await writeReport({ value: { id: 'r1', score: 7 }, agent: 'audit-store' });

		expect(agents).toEqual(['evaluation-store', 'audit-store']);
	});
});

describe('writeImmutableArtifact — atomicity', () => {
	test('leaves no temp files beside the artifact', async () => {
		await writeReport({ value: { id: 'r1', score: 7 } });

		const dir = join(tempDir, '.swarm', 'evolution', 'consensus');
		expect(readdirSync(dir)).toEqual(['report-1.json']);
	});

	test('a reader only ever observes complete, parseable content', async () => {
		// The atomic temp+rename write means the target either does not exist or
		// holds the full payload; it is never observed half-written.
		const value: Report = {
			id: 'r1',
			score: 7,
		};
		const write = writeReport({ value });

		const observations: string[] = [];
		for (let i = 0; i < 25; i++) {
			try {
				observations.push(readFileSync(artifactPath(), 'utf-8'));
			} catch {
				// Not yet created — an acceptable observation.
			}
			await Promise.resolve();
		}
		await write;
		observations.push(readFileSync(artifactPath(), 'utf-8'));

		for (const observed of observations) {
			expect(parseReport(JSON.parse(observed))).toEqual(value);
		}
	});
});

describe('readOptionalFile', () => {
	test('returns undefined when the file does not exist', async () => {
		expect(
			await readOptionalFile(join(tempDir, 'missing.json')),
		).toBeUndefined();
	});

	test('returns the file content when it exists', async () => {
		const target = join(tempDir, 'present.json');
		writeFileSync(target, '{"a":1}', 'utf-8');
		expect(await readOptionalFile(target)).toBe('{"a":1}');
	});

	test('propagates non-ENOENT errors instead of masking them', async () => {
		// Reading a directory fails with EISDIR (Linux/macOS) or EACCES/EPERM
		// (Windows) — either way it must surface, not become undefined.
		const directory = join(tempDir, 'a-directory');
		mkdirSync(directory);
		await expect(readOptionalFile(directory)).rejects.toBeInstanceOf(Error);
	});
});
