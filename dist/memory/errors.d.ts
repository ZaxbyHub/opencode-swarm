export declare class MemoryValidationError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
export declare class MemoryDisabledError extends Error {
    constructor(message?: string);
}
