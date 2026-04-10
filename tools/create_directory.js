import { z } from "zod";
import fs from "fs/promises";
import { validatePath } from '../lib.js';

export function register(server) {
    server.registerTool("create_directory", {
        title: "Create Directory",
        description: "Create a directory. Creates nested directories in one operation.",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false }
    }, async (args) => {
        const validPath = await validatePath(args.path);
        await fs.mkdir(validPath, { recursive: true });
        const text = "Directory created.";
        return {
            content: [{ type: "text", text }],
        };
    });
}
