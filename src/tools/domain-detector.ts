import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createSwarmTool } from './create-tool';

const DOMAIN_PATTERNS: Record<string, RegExp[]> = {
	windows: [
		/\bwindows\b/i,
		/\bwin32\b/i,
		/\bregistry\b/i,
		/\bregedit\b/i,
		/\bwmi\b/i,
		/\bcim\b/i,
		/\bservice\b/i,
		/\bevent\s*log\b/i,
		/\bscheduled\s*task\b/i,
		/\bgpo\b/i,
		/\bgroup\s*policy\b/i,
		/\bmsi\b/i,
		/\binstaller\b/i,
		/\bwinrm\b/i,
	],
	powershell: [
		/\bpowershell\b/i,
		/\bpwsh\b/i,
		/\bps1\b/i,
		/\bcmdlet\b/i,
		/\bget-\w+/i,
		/\bset-\w+/i,
		/\bnew-\w+/i,
		/\bremove-\w+/i,
		/\binvoke-\w+/i,
		/\bpester\b/i,
	],
	python: [
		/\bpython\b/i,
		/\bpip\b/i,
		/\bpypi\b/i,
		/\bdjango\b/i,
		/\bflask\b/i,
		/\bpandas\b/i,
		/\bnumpy\b/i,
		/\bpytest\b/i,
		/\bvenv\b/i,
		/\bconda\b/i,
	],
	oracle: [
		/\boracle\b/i,
		/\bsqlplus\b/i,
		/\bplsql\b/i,
		/\btnsnames\b/i,
		/\bpdb\b/i,
		/\bcdb\b/i,
		/\btablespace\b/i,
		/\brman\b/i,
		/\bdataguard\b/i,
		/\basm\b/i,
		/\brac\b/i,
		/\bora-\d+/i,
	],
	network: [
		/\bnetwork\b/i,
		/\bfirewall\b/i,
		/\bdns\b/i,
		/\bdhcp\b/i,
		/\btcp\b/i,
		/\budp\b/i,
		/\bip\s*address\b/i,
		/\bsubnet\b/i,
		/\bvlan\b/i,
		/\brouting\b/i,
		/\bswitch\b/i,
		/\bload\s*balanc/i,
		/\bproxy\b/i,
		/\bssl\b/i,
		/\btls\b/i,
		/\bcertificate\b/i,
	],
	security: [
		/\bstig\b/i,
		/\bdisa\b/i,
		/\bcve\b/i,
		/\bvulnerabil/i,
		/\bharden\b/i,
		/\baudit\b/i,
		/\bcompliance\b/i,
		/\bscap\b/i,
		/\bfips\b/i,
		/\bcac\b/i,
		/\bpki\b/i,
		/\bencrypt/i,
	],
	linux: [
		/\blinux\b/i,
		/\bubuntu\b/i,
		/\brhel\b/i,
		/\bcentos\b/i,
		/\bbash\b/i,
		/\bsystemd\b/i,
		/\bsystemctl\b/i,
		/\byum\b/i,
		/\bapt\b/i,
		/\bcron\b/i,
		/\bchmod\b/i,
		/\bchown\b/i,
	],
	vmware: [
		/\bvmware\b/i,
		/\bvsphere\b/i,
		/\besxi\b/i,
		/\bvcenter\b/i,
		/\bvsan\b/i,
		/\bnsx\b/i,
		/\bvmotion\b/i,
		/\bdatastore\b/i,
		/\bpowercli\b/i,
		/\bova\b/i,
		/\bovf\b/i,
	],
	azure: [
		/\bazure\b/i,
		/\baz\s+\w+/i,
		/\bentra\b/i,
		/\baad\b/i,
		/\bazure\s*ad\b/i,
		/\barm\s*template\b/i,
		/\bbicep\b/i,
		/\bazure\s*devops\b/i,
		/\bblob\b/i,
		/\bkeyvault\b/i,
	],
	active_directory: [
		/\bactive\s*directory\b/i,
		/\bad\s+\w+/i,
		/\bldap\b/i,
		/\bdomain\s*controller\b/i,
		/\bgpupdate\b/i,
		/\bdsquery\b/i,
		/\bdsmod\b/i,
		/\baduc\b/i,
		/\bkerberos\b/i,
		/\bspn\b/i,
	],
	ui_ux: [
		/\bui\b/i,
		/\bux\b/i,
		/\buser\s+experience\b/i,
		/\buser\s+interface\b/i,
		/\bvisual\s+design\b/i,
		/\binteraction\s+design\b/i,
		/\bdesign\s+system\b/i,
		/\bwireframe\b/i,
		/\bprototype\b/i,
		/\baccessibility\b/i,
		/\btypography\b/i,
		/\blayout\b/i,
		/\bresponsive\b/i,
	],
};

/**
 * Detect SME domains from text content.
 * Returns list of domains that match patterns in the input.
 */
export const detect_domains: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Detect which SME domains are relevant for a given text. ' +
		'Returns a list of domain names (windows, powershell, python, oracle, ' +
		'network, security, linux, vmware, azure, active_directory, ui_ux) ' +
		'that match patterns in the input text.',
	args: {
		text: z.string().describe('The text to analyze for domain patterns'),
	},
	execute: async (args) => {
		const text = (
			typeof args.text === 'string' ? args.text : String(args.text)
		).toLowerCase();
		const detected: string[] = [];

		for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
			for (const pattern of patterns) {
				if (pattern.test(text)) {
					detected.push(domain);
					break; // Only need one match per domain
				}
			}
		}

		if (detected.length === 0) {
			return 'No specific domains detected. The Architect should determine requirements from context.';
		}

		return `Detected domains: ${detected.join(', ')}\n\nUse these as DOMAIN values when delegating to @sme.`;
	},
});
