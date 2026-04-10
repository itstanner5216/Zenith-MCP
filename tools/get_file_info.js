import { z } from "zod";
import { validatePath, getFileStats } from '../lib.js';

export function register(server) {
    server.registerTool("get_file_info", {
        title: "Get File Info",
        description: "Retrieve detailed metadata about a file or directory.",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const validPath = await validatePath(args.path);
        const info = await getFileStats(validPath);
        const text = Object.entries(info).map(([key, value]) => `${key}: ${value}`).join("\n");
        return {
            content: [{ type: "text", text }],
        };
    });
}
