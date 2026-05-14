import { z } from "zod";
import path from "path";
import { readFileAsBase64Stream } from '../core/shared.js';
import type { ToolServer, ToolContext } from './types.js';

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
};

type MediaArgs = { path: string };

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool<MediaArgs>("read_media_file", {
        title: "Read Media File",
        description: "Read an image or audio file. Returns base64 data and MIME type.",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const validPath = await ctx.validatePath(args.path);
        const extension = path.extname(validPath).toLowerCase();
        const mimeType = MIME_TYPES[extension] ?? "application/octet-stream";
        const rawData = await readFileAsBase64Stream(validPath);
        const data = typeof rawData === 'string' ? rawData : String(rawData);
        const type: "image" | "audio" | "blob" = mimeType.startsWith("image/") ? "image"
            : mimeType.startsWith("audio/") ? "audio"
                : "blob";
        const contentItem = { type, data, mimeType };
        return {
            content: [contentItem],
        };
    });
}
//# sourceMappingURL=read_media_file.js.map