export type EvidenceDocumentSourceType = 'api_docs' | 'web_search' | 'crawl' | 'manual';
export interface EvidenceDocumentInput {
    sourceType: EvidenceDocumentSourceType;
    query?: string;
    title?: string;
    url?: string;
    text?: string;
    snippet?: string;
    capturedAt?: string;
    createdBy?: string;
    metadata?: Record<string, unknown>;
}
export interface EvidenceDocumentRecord {
    id: string;
    ref: string;
    sourceType: EvidenceDocumentSourceType;
    query?: string;
    title?: string;
    url?: string;
    text: string;
    capturedAt: string;
    createdBy?: string;
    metadata: Record<string, unknown>;
}
export interface WriteEvidenceDocumentsResult {
    path: string;
    records: EvidenceDocumentRecord[];
    refs: string[];
}
export declare function writeEvidenceDocuments(directory: string, inputs: EvidenceDocumentInput[], now?: () => Date): Promise<WriteEvidenceDocumentsResult>;
export declare function createEvidenceDocumentRecord(input: EvidenceDocumentInput, defaultCapturedAt: string): EvidenceDocumentRecord | null;
