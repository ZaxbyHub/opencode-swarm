import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPreCheckBatch } from '../../../src/tools/pre-check-batch';
// _internals is the DI seam for the detector registry.
import { _internals } from '../../../src/tools/secretscan';

const { SECRET_PATTERNS } = _internals;

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-secrets-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pattern-based detector types — these are registered in SECRET_PATTERNS.
// The SecretType union also lists 'secret_token' and 'high_entropy', but:
//   - 'secret_token' has no implementation in the codebase (not a false negative)
//   - 'high_entropy' is a heuristic run inline inside scanLineForSecrets and
//     does NOT appear in SECRET_PATTERNS (tested separately below)
// ---------------------------------------------------------------------------
const PATTERN_DETECTOR_TYPES = [
	'api_key',
	'aws_access_key',
	'aws_secret_key',
	'private_key',
	'password',
	'bearer_token',
	'basic_auth',
	'database_url',
	'jwt',
	'github_token',
	'slack_token',
	'stripe_key',
	'sendgrid_key',
	'twilio_key',
	'generic_token',
] as const;

describe('secretscan registry completeness (F-006)', () => {
	/**
	 * F-006: Prove the full detector set is wired so a regression dropping a
	 * non-AWS detector is caught.
	 *
	 * We assert the registry STRUCTURE (SECRET_PATTERNS entries) rather than
	 * seeding real-format secrets — this avoids GitHub Push Protection
	 * blocking the push while still giving strong coverage: if any detector is
	 * removed from SECRET_PATTERNS the test fails immediately.
	 */

	test('SECRET_PATTERNS contains an entry for every pattern-based detector type', () => {
		const registeredTypes = SECRET_PATTERNS.map((p) => p.type);
		const missing = PATTERN_DETECTOR_TYPES.filter(
			(type) => !registeredTypes.includes(type),
		);
		expect(missing).toEqual([]);
	});

	test('SECRET_PATTERNS has at least 15 entries (one per provider/pattern)', () => {
		// Guards against an accidental bulk removal of detector entries.
		expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(15);
	});

	test('every SECRET_PATTERNS entry has a regex, confidence, severity, and redactTemplate', () => {
		for (const pattern of SECRET_PATTERNS) {
			expect(pattern.regex).toBeInstanceOf(RegExp);
			expect(pattern.confidence).toMatch(/^(high|medium|low)$/);
			expect(pattern.severity).toMatch(/^(critical|high|medium|low)$/);
			expect(typeof pattern.redactTemplate).toBe('function');
		}
	});

	test('no duplicate detector types in SECRET_PATTERNS', () => {
		const types = SECRET_PATTERNS.map((p) => p.type);
		const unique = new Set(types);
		expect(types.length).toBe(unique.size);
	});

	test('high_entropy is NOT in SECRET_PATTERNS (it runs as inline heuristic)', () => {
		// Verifies our understanding is correct: high_entropy is NOT a regex entry.
		// It is implemented inside scanLineForSecrets as a Shannon-entropy fallback.
		const entry = SECRET_PATTERNS.find((p) => p.type === 'high_entropy');
		expect(entry).toBeUndefined();
	});

	test('high_entropy integration: random 32-char base64 string triggers high_entropy finding', async () => {
		// Shannon entropy of a 32-char random alphanumeric string is ~4.7 bits/char
		// (> 4.0 threshold), so this exercises the inline heuristic without
		// seeding any real secret format. This is safe for GitHub Push Protection.
		const highEntropyValue = '5J8mP2nK4qL9rT6wX0zA3bC7dE1fG5hJ';
		fs.writeFileSync(
			path.join(tempDir, 'secrets.env'),
			`secret=${highEntropyValue}\n`,
		);

		const result = await runPreCheckBatch({
			directory: tempDir,
			files: ['secrets.env'],
		});

		expect(result.secretscan.ran).toBe(true);
		expect(result.gates_passed).toBe(false);
		const secrets = result.secretscan.result as {
			count: number;
			findings: Array<{ type: string }>;
		};
		expect(secrets.count).toBeGreaterThan(0);
		expect(secrets.findings.some((f) => f.type === 'high_entropy')).toBe(true);
	});
});

describe('AWS integration — end-to-end gate', () => {
	/**
	 * Keeps the AWS end-to-end test: proves the full pipeline works
	 * (file with secret → runPreCheckBatch → gate fails → aws_access_key finding).
	 * Uses AWS's documented example value which GitHub explicitly allows.
	 */
	test('hard-fails the gate for AWS access keys in changed files', async () => {
		// AWS documentation example — GitHub Push Protection allow-lists this.
		const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE';
		fs.writeFileSync(
			path.join(tempDir, 'secrets.env'),
			`AWS_ACCESS_KEY_ID=${awsAccessKey}\n`,
		);

		const result = await runPreCheckBatch({
			directory: tempDir,
			files: ['secrets.env'],
		});

		expect(result.secretscan.ran).toBe(true);
		expect(result.gates_passed).toBe(false);
		expect(result.secretscan.result).toBeDefined();
		const secrets = result.secretscan.result as {
			count: number;
			findings: Array<{ type: string }>;
		};
		expect(secrets.count).toBeGreaterThan(0);
		expect(secrets.findings.some((f) => f.type === 'aws_access_key')).toBe(
			true,
		);
	});
});
