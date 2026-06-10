/**
 * Java SAST Rules
 * Detects common security vulnerabilities in Java code
 */

import type { SastRule } from './index';

/**
 * Java security rules
 */
export const javaRules: SastRule[] = [
	{
		id: 'sast/java-command-injection',
		name: 'Command injection via Runtime.exec',
		severity: 'critical',
		languages: ['java'],
		description:
			'Runtime.exec() with unsanitized input can lead to command injection',
		remediation:
			'Avoid Runtime.exec(). Use ProcessBuilder with separate arguments, or validate/sanitize input thoroughly.',
		pattern: /\.exec\s*\(/,
	},
	{
		id: 'sast/java-deserialization',
		name: 'Unsafe object deserialization',
		severity: 'high',
		languages: ['java'],
		description:
			'ObjectInputStream.readObject() can lead to deserialization vulnerabilities',
		remediation:
			'Use a safe serialization format like JSON. If Java serialization is required, validate the class whitelist.',
		pattern: /readObject\s*\(\s*\)/,
	},
	{
		id: 'sast/java-xss',
		name: 'Potential XSS vulnerability',
		severity: 'high',
		languages: ['java'],
		description: 'Unescaped user input in HTTP response can lead to XSS',
		remediation:
			'Use OWASP Java Encoder or similar library to encode output. Enable CSRF protection.',
		pattern: /getWriter\(\)\.write\s*\(/,
	},
	{
		id: 'sast/java-hardcoded-secret',
		name: 'Hardcoded secret detected',
		severity: 'critical',
		languages: ['java'],
		description: 'Potential hardcoded API key, password, or token detected',
		remediation:
			'Move secrets to environment variables or a secure configuration manager.',
		// Minimum length aligned with the other C-family static languages (Go,
		// C# both use {10,}). The previous {5,} flagged 5-char strings like
		// token: "abcde" as critical, producing far more false positives in
		// Java codebases than in any other supported language (DD-C015).
		pattern:
			/(?:api_key|password|secret|token|auth)[_-]?\w*\s*=\s*["'][a-zA-Z0-9_-]{10,}["']/i,
	},
	{
		id: 'sast/java-xxe',
		name: 'XML External Entity (XXE) vulnerability',
		severity: 'high',
		languages: ['java'],
		description: 'XML parser configured without XXE protection',
		remediation:
			'Configure XML parser to disable external entities: setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)',
		pattern: /DocumentBuilderFactory\.newInstance/,
	},
	{
		id: 'sast/java-path-traversal',
		name: 'Path traversal vulnerability',
		severity: 'high',
		languages: ['java'],
		description: 'File path from user input used without validation',
		remediation:
			'Validate and sanitize file paths. Use canonical paths and allow-list validation.',
		pattern: /new\s+File\s*\(\s*(?:request|param)/i,
	},
	{
		id: 'sast/java-sqli',
		name: 'Potential SQL injection',
		severity: 'critical',
		languages: ['java'],
		description: 'String concatenation in SQL query can lead to SQL injection',
		remediation:
			'Use PreparedStatement with parameterized queries. Never concatenate user input into SQL.',
		pattern: /createStatement\s*\(\s*\).*\+/,
	},
	{
		id: 'sast/java-weak-crypto',
		name: 'Weak cryptographic algorithm',
		severity: 'medium',
		languages: ['java'],
		description: 'Using weak cryptographic algorithms (MD5, SHA1, DES)',
		remediation:
			'Use strong algorithms like AES-256, SHA-256, or stronger. Avoid MD5 and SHA-1 for security purposes.',
		pattern: /MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1|DES)["']/i,
	},
	{
		id: 'sast/java-trust-manager',
		name: 'Weak SSL/TLS trust manager',
		severity: 'high',
		languages: ['java'],
		description:
			'Custom TrustManager that accepts all certificates - vulnerable to MITM',
		remediation:
			'Use proper certificate validation. Never implement a TrustManager that accepts all certificates.',
		pattern: /TrustManager\s*\{\s*public\s+void\s+checkClientTrusted/,
	},
];
