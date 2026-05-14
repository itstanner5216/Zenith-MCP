import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

export const DEFAULT_COMPRESSION_KEEP_RATIO = 0.70;

const _BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toon_bridge.js');

export function computeCompressionBudget(rawLength: number, maxChars: number, keepRatio = DEFAULT_COMPRESSION_KEEP_RATIO): number {
    if (!Number.isFinite(rawLength) || rawLength <= 0) return 0;
    const boundedMaxChars = Math.max(0, Math.floor(maxChars));
    const ratioBudget = Math.max(1, Math.floor(rawLength * keepRatio));
    return Math.min(boundedMaxChars, ratioBudget);
}

export function isCompressionUseful(rawText: unknown, compressedText: unknown, maxChars: number, keepRatio = DEFAULT_COMPRESSION_KEEP_RATIO): boolean {
    if (typeof rawText !== 'string' || typeof compressedText !== 'string') return false;
    if (compressedText.length === 0 || rawText.length === 0) return false;

    // If raw text length exactly equals maxChars, it already fits the budget — no compression needed
    const boundedMaxChars = Math.max(0, Math.floor(maxChars));
    if (rawText.length === boundedMaxChars) return false;

    const targetBudget = computeCompressionBudget(rawText.length, maxChars, keepRatio);
    if (targetBudget <= 0 || targetBudget >= rawText.length) return false;

    // compressed must (a) actually be smaller than the raw, (b) fit within the ratio budget,
    // and (c) leave headroom under maxChars (filling the entire output budget is just truncation).
    return compressedText.length < rawText.length
        && compressedText.length <= targetBudget
        && compressedText.length < boundedMaxChars;
}

export function truncateToBudget(text: unknown, budget: number): { text: string; truncated: boolean } {
    if (typeof text !== 'string') {
        return { text: '', truncated: false };
    }

    if (text.length <= budget) {
        // If the text contains no non-newline content, it is considered truncated
        const hasContent = text.replace(/\n/g, '').length > 0;
        return { text, truncated: !hasContent };
    }

    let cutoff = text.lastIndexOf('\n', budget);
    if (cutoff === -1) cutoff = budget;

    return {
        text: text.slice(0, cutoff),
        truncated: true,
    };
}

export async function runToonBridge(validPath: string, budget: number): Promise<string | null> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [_BRIDGE, validPath, String(budget)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        child.stdout.on('data', d => out += d);

        const timer = setTimeout(() => {
            child.kill();
            resolve(null);
        }, 30_000);

        child.on('close', code => {
            clearTimeout(timer);
            resolve(code === 0 && out.length > 0 ? out : null);
        });

        child.on('error', () => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}

export async function compressTextFile(validPath: string, rawText: string, maxChars: number, keepRatio = DEFAULT_COMPRESSION_KEEP_RATIO): Promise<{ text: string; targetBudget: number; rawLength: number; compressedLength: number } | null> {
    const targetBudget = computeCompressionBudget(rawText.length, maxChars, keepRatio);
    if (targetBudget <= 0 || targetBudget >= rawText.length) {
        return null;
    }

    const compressed = await runToonBridge(validPath, targetBudget);
    if (!isCompressionUseful(rawText, compressed, maxChars, keepRatio)) {
        return null;
    }

    return {
        text: compressed!,
        targetBudget,
        rawLength: rawText.length,
        compressedLength: compressed!.length,
    };
}
