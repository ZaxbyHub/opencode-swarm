/**
 * Go SAST Rules
 * Detects common security vulnerabilities in Go code
 */

import type { SastRule } from './index';

/**
 * Go security rules
 */
export const goRules: SastRule[] = [
	{
		id: 'sast/go-hardcoded-secret',
		name: 'Hardcoded secret detected',
		severity: 'critical',
		languages: ['go'],
		description: 'Potential hardcoded API key, password, or token detected',
		remediation:
			'Move secrets to environment variables using os.Getenv() or a secrets manager.',
		pattern:
			/(?:api_key|password|secret|token|auth)[_-]?\w*\s*[:=]\s*["'][a-zA-Z0-9_-]{10,}["']/i,
	},
	{
		id: 'sast/go-weak-tls',
		name: 'Insecure TLS configuration',
		severity: 'medium',
		languages: ['go'],
		description: 'tls.Config with InsecureSkipVerify allows MITM attacks',
		remediation:
			'Set InsecureSkipVerify to false in production. Use proper certificate validation.',
		pattern: /InsecureSkipVerify\s*:\s*true/,
	},
	{
		id: 'sast/go-shell-injection',
		name: 'Shell injection via os/exec',
		severity: 'critical',
		languages: ['go'],
		description:
			'exec.Command with shell interpretation allows command injection',
		remediation:
			'Use exec.Command with separate arguments, avoiding shell interpretation. Never pass user input directly to command execution.',
		pattern: /exec\.Command/,
	},
	{
		id: 'sast/go-template-injection',
		name: 'Template injection risk',
		severity: 'high',
		languages: ['go'],
		description: 'html/template used with variable content - potential XSS',
		remediation:
			'Ensure user input is properly escaped. Use template.HTMLEscapeString() or auto-escaping features.',
		pattern: /template\.HTML\s*\(/,
	},
	{
		id: 'sast/go-pprof',
		name: 'pprof endpoint exposed',
		severity: 'medium',
		languages: ['go'],
		description: 'pprof debugging endpoints can expose sensitive information',
		remediation:
			'Only enable pprof in development. Ensure production does not expose /debug/pprof.',
		pattern: /net\/http\/pprof/,
	},
];
