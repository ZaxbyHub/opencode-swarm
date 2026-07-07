/**
 * Rust SAST Rules
 * Detects common security vulnerabilities in Rust code
 */

import type { SastRule } from './index';

export const rustRules: SastRule[] = [
	{
		id: 'sast/rust-hardcoded-secret',
		name: 'Hardcoded secret detected',
		severity: 'critical',
		languages: ['rust'],
		description: 'Potential hardcoded API key, password, or token detected',
		remediation:
			'Move secrets to environment variables or a secrets manager; do not commit credentials.',
		pattern:
			/(?:api_key|password|secret|token|auth)[_-]?\w*\s*(?::\s*&?str)?\s*(?:=|:)\s*["'][a-zA-Z0-9_-]{10,}["']/i,
	},
	{
		id: 'sast/rust-command-injection',
		name: 'Shell command injection risk',
		severity: 'critical',
		languages: ['rust'],
		description:
			'std::process::Command invokes a shell interpreter, which can enable command injection when user input is passed as arguments.',
		remediation:
			'Invoke the target binary directly and pass arguments separately; avoid sh -c, bash -c, cmd /C, and powershell -Command with user input.',
		pattern: /Command::new\s*\(\s*["'](?:sh|bash|cmd|powershell|pwsh)["']\s*\)/,
	},
	{
		id: 'sast/rust-unsafe-block',
		name: 'Unsafe Rust block',
		severity: 'medium',
		languages: ['rust'],
		description:
			'Unsafe blocks bypass Rust safety checks and require careful manual validation.',
		remediation:
			'Minimize unsafe code and document invariants with a SAFETY comment.',
		pattern: /\bunsafe\s*\{/,
	},
];
