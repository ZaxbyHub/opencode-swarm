import { createSwarmTool } from './create-tool';
type SecretType = 'api_key' | 'aws_access_key' | 'aws_secret_key' | 'private_key' | 'password' | 'secret_token' | 'bearer_token' | 'basic_auth' | 'database_url' | 'jwt' | 'github_token' | 'slack_token' | 'stripe_key' | 'sendgrid_key' | 'twilio_key' | 'generic_token' | 'high_entropy';
type Confidence = 'high' | 'medium' | 'low';
type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface SecretFinding {
    path: string;
    line: number;
    type: SecretType;
    confidence: Confidence;
    severity: Severity;
    redacted: string;
    context: string;
}
export interface SecretscanResult {
    scan_dir: string;
    findings: SecretFinding[];
    count: number;
    files_scanned: number;
    skipped_files: number;
    message?: string;
}
export interface SecretscanErrorResult {
    error: string;
    scan_dir: string;
    findings: [];
    count: 0;
    files_scanned: 0;
    skipped_files: 0;
}
export declare const secretscan: ReturnType<typeof createSwarmTool>;
/**
 * Run secretscan programmatically
 */
export declare function runSecretscan(directory: string): Promise<SecretscanResult | SecretscanErrorResult>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    secretscan: typeof secretscan;
    runSecretscan: typeof runSecretscan;
};
export {};
