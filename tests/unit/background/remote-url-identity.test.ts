/**
 * Direct unit coverage for the publication remote-URL identity redaction
 * (PR #2422 review M3/H2/M4): the primitive was previously only exercised
 * through wholesale resolver stubs, which is how the first-`@` host-collision
 * defect survived to review. Every case here pins the actual parsing logic.
 */
import { describe, expect, test } from 'bun:test';
import { redactRemoteUrlIdentity } from '../../../src/background/workspace-snapshot.js';

const CAP = 200;

describe('redactRemoteUrlIdentity (publication remote-URL identity)', () => {
	test('redacts URL-form userinfo', () => {
		expect(
			redactRemoteUrlIdentity('https://user:pass@github.com/org/repo.git', CAP),
		).toBe('https://***@github.com/org/repo.git');
		expect(
			redactRemoteUrlIdentity('https://x-oauth-token@github.com/org/repo', CAP),
		).toBe('https://***@github.com/org/repo');
	});

	test('an @ in the PATH is path content, not userinfo (H2 collision fix)', () => {
		// The old first-@ split turned this into ***@github.com/… — colliding
		// with the genuinely-credentialed form above. The fixed parser bounds
		// the @ search to the authority, so the path passes through verbatim.
		expect(
			redactRemoteUrlIdentity(
				'https://evil.example.com/pwn@github.com/org/repo.git',
				CAP,
			),
		).toBe('https://evil.example.com/pwn@github.com/org/repo.git');
	});

	test('a crafted path-@ remote can no longer collide with a credentialed one', () => {
		const legit = redactRemoteUrlIdentity(
			'https://token@github.com/org/repo.git',
			CAP,
		);
		const crafted = redactRemoteUrlIdentity(
			'https://evil.example.com/pwn@github.com/org/repo.git',
			CAP,
		);
		// Different hosts must produce DIFFERENT identities.
		expect(legit).not.toBe(crafted);
		expect(legit).toBe('https://***@github.com/org/repo.git');
		expect(crafted).toBe(
			'https://evil.example.com/pwn@github.com/org/repo.git',
		);
	});

	test('userinfo with multiple @ segments redacts to the same host', () => {
		expect(
			redactRemoteUrlIdentity('https://a@b@github.com/org/repo.git', CAP),
		).toBe(redactRemoteUrlIdentity('https://tok@github.com/org/repo.git', CAP));
		expect(
			redactRemoteUrlIdentity('https://a@b@github.com/org/repo.git', CAP),
		).toBe('https://***@github.com/org/repo.git');
	});

	test('query-string and fragment credentials are stripped (M4)', () => {
		expect(
			redactRemoteUrlIdentity(
				'https://github.com/org/repo.git?access_token=ghp_secret',
				CAP,
			),
		).toBe('https://github.com/org/repo.git?…');
		expect(redactRemoteUrlIdentity('https://host/path#frag-secret', CAP)).toBe(
			'https://host/path?…',
		);
	});

	test('scp-form redacts userinfo and preserves host/path', () => {
		expect(redactRemoteUrlIdentity('git@github.com:org/repo.git', CAP)).toBe(
			'***@github.com:org/repo.git',
		);
	});

	test('plain URLs without credentials pass through structurally intact', () => {
		expect(
			redactRemoteUrlIdentity('https://github.com/org/repo.git', CAP),
		).toBe('https://github.com/org/repo.git');
		expect(redactRemoteUrlIdentity('/mnt/data/repo', CAP)).toBe(
			'/mnt/data/repo',
		);
	});

	test('result is capped at maxChars', () => {
		const long = `https://github.com/${'a'.repeat(300)}`;
		expect(redactRemoteUrlIdentity(long, 50).length).toBe(50);
	});
});
