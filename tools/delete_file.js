import { z } from "zod";
import fs from "fs/promises";
import { validatePath } from '../lib.js';

export function register(server) {
    server.registerTool("delete_file", {
        title: "Delete File",
        description: "Permanently delete a file. Only works on files — not directories. Irreversible.",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        let validPath;
        try {
            validPath = await validatePath(args.path);
        } catch (e) {
            if (e.code === 'ENOENT' || (e.message && e.message.includes('ENOENT'))) {
                throw new Error("Unable to locate file.");
            }
            throw e;
        }
        const stats = await fs.stat(validPath);
        if (stats.isDirectory()) {
            throw new Error("Not a file.");
        }
        await fs.unlink(validPath);
        const text = "File deleted successfully.";
        return {
            content: [{ type: "text", text }],
        };
    });
}
