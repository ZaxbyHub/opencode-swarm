export interface SecretFinding {
    type: string;
    match: string;
}
export declare function findSecrets(text: string): SecretFinding[];
export declare function containsSecret(text: string): boolean;
export declare function redactSecrets(text: string): string;
