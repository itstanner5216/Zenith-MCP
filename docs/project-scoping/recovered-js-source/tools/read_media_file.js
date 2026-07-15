import { z } from "zod";
import path from "path";
import { readFileAsBase64Stream } from '../core/shared.js';

const MIME_TYPES = {
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

export function register(server, ctx) {
    server.registerTool("read_media_file", {
        title: "Read Media File",
        description: "Read an image or audio file. Returns base64 data and MIME type.",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const validPath = await ctx.validatePath(args.path);
        const extension = path.extname(validPath).toLowerCase();
        const mimeType = MIME_TYPES[extension] || "application/octet-stream";
        const data = await readFileAsBase64Stream(validPath);
        const type = mimeType.startsWith("image/") ? "image"
            : mimeType.startsWith("audio/") ? "audio"
            : "blob";
        const contentItem = { type, data, mimeType };
        return {
            content: [contentItem],
        };
    });
}
