/**
 * C# SAST Rules
 * Detects common security vulnerabilities in C# code
 */

import type { SastRule } from './index';

/**
 * C# security rules
 */
export const csharpRules: SastRule[] = [
	{
		id: 'sast/cs-command-injection',
		name: 'Command injection via Process.Start',
		severity: 'critical',
		languages: ['csharp'],
		description: 'Process.Start allows command injection',
		remediation:
			'Use ProcessStartInfo with Arguments property, or sanitize input thoroughly.',
		pattern: /Process\.Start/,
		// Context-aware filtering (DD-C016). `Process.Start` alone is not a
		// vulnerability — the canonical .NET mitigation is a ProcessStartInfo
		// with UseShellExecute disabled (no shell interpretation). When the
		// file demonstrates that safe pattern, suppress the critical finding to
		// avoid blocking the coder workflow on legitimate process invocation.
		validate: (_match, context) => {
			return !/UseShellExecute\s*=\s*false/i.test(context.content);
		},
	},
	{
		id: 'sast/cs-sqli',
		name: 'Potential SQL injection',
		severity: 'critical',
		languages: ['csharp'],
		description: 'String concatenation in SQL query can lead to SQL injection',
		remediation:
			'Use parameterized queries or an ORM. Never concatenate user input into SQL.',
		pattern: /\.Execute.*\+/,
	},
	{
		id: 'sast/cs-xss',
		name: 'Potential XSS vulnerability',
		severity: 'high',
		languages: ['csharp'],
		description: 'User input in HTML response without encoding',
		remediation:
			'Use HttpUtility.HtmlEncode() or a templating engine with auto-escaping.',
		pattern: /Response\.Write\s*\(\s*(?:Request|Form|QueryString)/i,
	},
	{
		id: 'sast/cs-deserialization',
		name: 'Unsafe deserialization',
		severity: 'critical',
		languages: ['csharp'],
		description: 'BinaryFormatter can deserialize malicious objects',
		remediation:
			'Use System.Text.Json or Newtonsoft.Json for serialization. Never use BinaryFormatter.',
		pattern: /BinaryFormatter/,
	},
	{
		id: 'sast/cs-hardcoded-secret',
		name: 'Hardcoded secret detected',
		severity: 'critical',
		languages: ['csharp'],
		description: 'Potential hardcoded API key, password, or token detected',
		remediation: 'Move secrets to configuration or environment variables.',
		pattern:
			/(?:api_key|password|secret|token|auth)[_-]?\w*\s*=\s*["'][a-zA-Z0-9_-]{10,}["']/i,
	},
	{
		id: 'sast/cs-path-traversal',
		name: 'Path traversal vulnerability',
		severity: 'high',
		languages: ['csharp'],
		description: 'File path from user input used without validation',
		remediation:
			'Use Path.GetFullPath and validate the result stays within expected directory.',
		pattern:
			/File\.(?:Read|Write|Open|AllLines)\s*\(\s*(?:Request|Form|QueryString)/i,
	},
	{
		id: 'sast/cs-xml-xxe',
		name: 'XML External Entity vulnerability',
		severity: 'high',
		languages: ['csharp'],
		description: 'XML reader without XXE protection',
		remediation:
			'Disable DTD processing: XmlReaderSettings.DtdProcessing = DtdProcessing.Prohibit',
		pattern: /XmlReader\.Create\s*\(/,
	},
	{
		id: 'sast/cs-weak-random',
		name: 'Weak random for security purposes',
		severity: 'medium',
		languages: ['csharp'],
		description: 'Using Random class for cryptographic randomness',
		remediation:
			'Use RandomNumberGenerator or cryptographic random: System.Security.Cryptography.RandomNumberGenerator',
		pattern: /new\s+Random\s*\(/,
	},
	{
		id: 'sast/cs-hardcoded-connection-string',
		name: 'Hardcoded connection string',
		severity: 'high',
		languages: ['csharp'],
		description: 'Hardcoded database connection string with credentials',
		remediation:
			'Store connection strings in configuration files with encryption or use Azure Key Vault.',
		pattern:
			/ConnectionString\s*=\s*["'][^"']*(?:uid|user|password|pwd)[^"']*["']/i,
	},
	{
		id: 'sast/cs-weak-encryption',
		name: 'Weak encryption algorithm',
		severity: 'high',
		languages: ['csharp'],
		description: 'Using weak encryption like DES or RC4',
		remediation:
			'Use AES-256 or stronger. Avoid DES, RC4, and other deprecated algorithms.',
		pattern: /DESCryptoServiceProvider/,
	},
	{
		id: 'sast/cs-ssl-validation-bypass',
		name: 'SSL/TLS certificate validation bypass',
		severity: 'critical',
		languages: ['csharp'],
		description:
			'ServicePointManager or WebRequest with disabled certificate validation',
		remediation: 'Never disable certificate validation in production.',
		pattern: /ServerCertificateValidationCallback\s*=\s*(?:AcceptAll|true)/,
	},
];
