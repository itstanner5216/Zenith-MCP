export type ToolTextContent = {
    type: "text";
    text: string;
};

export type ToolImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};

export type ToolAudioContent = {
    type: "audio";
    data: string;
    mimeType: string;
};

export type ToolBlobContent = {
    type: "blob";
    data: string;
    mimeType: string;
};

export type ToolContent = ToolTextContent | ToolImageContent | ToolAudioContent | ToolBlobContent;

export type ToolResult = {
    content: ToolContent[];
};

export type ToolHandler<TArgs> = (args: TArgs) => Promise<ToolResult> | ToolResult;

export type ToolRegistration = {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: {
        readOnlyHint?: boolean;
        idempotentHint?: boolean;
        destructiveHint?: boolean;
    };
};

export type ToolServer = {
    registerTool<TArgs>(
        name: string,
        registration: ToolRegistration,
        handler: ToolHandler<TArgs>
    ): void;
};

export type ToolContext = {
    sessionId?: string;
    validatePath(inputPath: string): Promise<string>;
    getAllowedDirectories: () => string[];
    setAllowedDirectories: (directories: string[]) => void;
};

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
