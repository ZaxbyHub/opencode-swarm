/**
 * JavaScript/TypeScript SAST Rules
 * Detects common security vulnerabilities in JS/TS code
 */

import type { SastRule } from './index';
import {
	classifyJavascriptCall,
	type JavascriptCallDisposition,
	type JavascriptCallFamily,
} from './javascript-call-classifier';

function hasDisposition(
	family: JavascriptCallFamily,
	disposition: JavascriptCallDisposition,
): NonNullable<SastRule['validate']> {
	return (match, context) =>
		classifyJavascriptCall(match, context, family) === disposition;
}

/**
 * JavaScript/TypeScript security rules
 */
export const javascriptRules: SastRule[] = [
	{
		id: 'sast/js-eval',
		name: 'Dangerous eval() Usage',
		severity: 'high',
		languages: ['javascript', 'typescript'],
		description:
			'Dangerous use of eval() detected - allows arbitrary code execution',
		remediation:
			'Avoid using eval(). If you must parse dynamic content, use JSON.parse() or a proper parser instead.',
		pattern: /\beval\b/,
		validate: hasDisposition('eval', 'confirmed'),
	},
	{
		id: 'sast/js-eval-review',
		name: 'Unresolved eval-like call',
		severity: 'low',
		languages: ['javascript', 'typescript'],
		description: 'Unresolved eval-like call requires manual review',
		remediation: 'Verify the callee binding and avoid dynamic code evaluation.',
		pattern: /\beval\b/,
		validate: hasDisposition('eval', 'ambiguous'),
	},
	{
		id: 'sast/js-dangerous-function',
		name: 'Dangerous new Function()',
		severity: 'high',
		languages: ['javascript', 'typescript'],
		description:
			'Dangerous use of new Function() detected - allows arbitrary code execution',
		remediation:
			'Avoid using new Function(). Use a safer alternative like JSON.parse() or a proper expression parser.',
		pattern: /\bFunction\b/,
		validate: hasDisposition('function-constructor', 'confirmed'),
	},
	{
		id: 'sast/js-function-constructor-review',
		name: 'Unresolved Function-like constructor',
		severity: 'low',
		languages: ['javascript', 'typescript'],
		description: 'Unresolved Function-like constructor requires manual review',
		remediation:
			'Verify the constructor binding and avoid dynamic code construction.',
		pattern: /\bFunction\b/,
		validate: hasDisposition('function-constructor', 'ambiguous'),
	},
	{
		id: 'sast/js-command-injection',
		name: 'Command Injection via child_process',
		severity: 'critical',
		languages: ['javascript', 'typescript'],
		description:
			'Potential command injection via child_process.exec() with unsanitized input',
		remediation:
			'Never pass user input directly to exec(). Use execFile() with arguments array or sanitize input thoroughly.',
		// Binding aliases can have any identifier name, so candidate discovery is
		// intentionally broad; the context-aware classifier admits only calls
		// proven to be exec-like.
		pattern: /[A-Za-z_$][\w$]*/,
		validate: hasDisposition('exec', 'confirmed'),
	},
	{
		id: 'sast/js-command-exec-review',
		name: 'Unresolved exec-like call',
		severity: 'low',
		languages: ['javascript', 'typescript'],
		description: 'Unresolved exec-like call requires manual review',
		remediation:
			'Verify whether the callee reaches child_process; prefer execFile() with an arguments array.',
		pattern: /[A-Za-z_$][\w$]*/,
		validate: hasDisposition('exec', 'ambiguous'),
	},
	{
		id: 'sast/js-set-timeout-string',
		name: 'setTimeout/setInterval with string',
		severity: 'high',
		languages: ['javascript', 'typescript'],
		description:
			'setTimeout/setInterval called with string argument - similar to eval()',
		remediation:
			'Use function references instead of strings: setTimeout(() => ..., 1000) instead of setTimeout("...", 1000)',
		pattern: /\b(?:setTimeout|setInterval)\b/,
		validate: hasDisposition('timer-string', 'confirmed'),
	},
	{
		id: 'sast/js-timer-string-review',
		name: 'Unresolved string timer call',
		severity: 'low',
		languages: ['javascript', 'typescript'],
		description: 'Unresolved string timer call requires manual review',
		remediation:
			'Verify the timer binding and replace string callbacks with functions.',
		pattern: /\b(?:setTimeout|setInterval)\b/,
		validate: hasDisposition('timer-string', 'ambiguous'),
	},
	{
		id: 'sast/js-innerhtml',
		name: 'Dangerous innerHTML usage',
		severity: 'medium',
		languages: ['javascript', 'typescript'],
		description:
			'Potential XSS via innerHTML - user input may be injected into DOM',
		remediation:
			'Use textContent instead of innerHTML, or sanitize input with a library like DOMPurify.',
		pattern: /\.innerHTML\s*=/,
	},
	{
		id: 'sast/js-document-write',
		name: 'Dangerous document.write usage',
		severity: 'medium',
		languages: ['javascript', 'typescript'],
		description: 'document.write() can introduce XSS vulnerabilities',
		remediation:
			'Use DOM manipulation methods (createElement, appendChild, textContent) instead.',
		pattern: /\bwrite\b/,
		validate: hasDisposition('document-write', 'confirmed'),
	},
	{
		id: 'sast/js-document-write-review',
		name: 'Unresolved document.write-like call',
		severity: 'low',
		languages: ['javascript', 'typescript'],
		description: 'Unresolved document.write-like call requires manual review',
		remediation: 'Verify the document binding and use safe DOM construction.',
		pattern: /\bwrite\b/,
		validate: hasDisposition('document-write', 'ambiguous'),
	},
	{
		id: 'sast/js-postmessage',
		name: 'Unsafely handling postMessage',
		severity: 'medium',
		languages: ['javascript', 'typescript'],
		description: 'postMessage event listener without origin validation',
		remediation:
			'Always validate the origin in postMessage event handlers: event.origin === expectedOrigin',
		pattern: /\baddEventListener\b/,
		validate: hasDisposition('postmessage', 'confirmed'),
	},
	{
		id: 'sast/js-postmessage-review',
		name: 'Unresolved message-listener call',
		severity: 'low',
		languages: ['javascript', 'typescript'],
		description: 'Unresolved message-listener call requires manual review',
		remediation:
			'Verify the event target and validate message origins where applicable.',
		pattern: /\baddEventListener\b/,
		validate: hasDisposition('postmessage', 'ambiguous'),
	},
	{
		id: 'sast/js-hardcoded-secret',
		name: 'Hardcoded secret detected',
		severity: 'critical',
		languages: ['javascript', 'typescript'],
		description: 'Potential hardcoded API key, password, or token detected',
		remediation:
			'Move secrets to environment variables or a secure secrets manager.',
		pattern:
			/(?:api_key|password|secret|token|auth)[_-]?\w*\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/i,
	},
];
