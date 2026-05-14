import { z } from "zod";
import fs from "fs/promises";
import { getFileStats } from '../core/lib.js';
import type { ToolServer, ToolContext } from './types.js';

type FilesystemArgs = {
    mode: "mkdir" | "delete" | "move" | "info";
    path?: string;
    source?: string;
    destination?: string;
};

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool<FilesystemArgs>("file_manager", {
        title: "Filesystem",
        description: "Create directories, delete files, move/rename, or get file metadata.",
        inputSchema: z.object({
            mode: z.enum(["mkdir", "delete", "move", "info"]).describe("Operation mode."),
            path: z.string().optional().describe("File or directory path."),
            source: z.string().optional().describe("Source path."),
            destination: z.string().optional().describe("Destination path."),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        if (args.mode === "mkdir") {
            if (!args.path) throw new Error('path required for mkdir.');
            const validPath = await ctx.validatePath(args.path);
            await fs.mkdir(validPath, { recursive: true });
            return { content: [{ type: "text", text: "Created." }] };
        }
        if (args.mode === "delete") {
            if (!args.path) throw new Error('path required for delete.');
            let validPath;
            try {
                validPath = await ctx.validatePath(args.path);
            }
            catch (e: unknown) {
                if (e instanceof Error && (((e as NodeJS.ErrnoException).code === 'ENOENT') || e.message.includes('ENOENT'))) {
                    throw new Error("Unable to locate file.");
                }
                throw e;
            }
            const stats = await fs.stat(validPath);
            if (stats.isDirectory()) {
                throw new Error("Not a file.");
            }
            await fs.unlink(validPath);
            return { content: [{ type: "text", text: "Deleted." }] };
        }
        if (args.mode === "move") {
            if (!args.source) throw new Error('source required for move.');
            if (!args.destination) throw new Error('destination required for move.');
            const validSourcePath = await ctx.validatePath(args.source);
            const validDestPath = await ctx.validatePath(args.destination);
            await fs.rename(validSourcePath, validDestPath);
            return { content: [{ type: "text", text: "Moved." }] };
        }
        if (args.mode === "info") {
            if (!args.path) throw new Error('path required for info.');
            const validPath = await ctx.validatePath(args.path);
            const info = await getFileStats(validPath);
            const text = Object.entries(info).map(([key, value]) => `${key}: ${value}`).join("\n");
            return { content: [{ type: "text", text }] };
        }
        throw new Error("Unknown mode.");
    });
}
//# sourceMappingURL=filesystem.js.map