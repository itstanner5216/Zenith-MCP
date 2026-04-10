import { z } from "zod";
import fs from "fs/promises";
import { validatePath } from '../lib.js';

export function register(server) {
    server.registerTool("move_file", {
        title: "Move File",
        description: "Move or rename files and directories.",
        inputSchema: {
            source: z.string(),
            destination: z.string()
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false }
    }, async (args) => {
        const validSourcePath = await validatePath(args.source);
        const validDestPath = await validatePath(args.destination);
        await fs.rename(validSourcePath, validDestPath);
        const text = "File moved successfully.";
        return {
            content: [{ type: "text", text }],
        };
    });
}
