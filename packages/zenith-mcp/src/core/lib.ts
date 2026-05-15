import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { normalizePath, expandHome } from './path-utils.js';
import { isPathWithinAllowedDirectories } from './path-validation.js';

function hasCode(e: unknown): e is { code: string } {
    return typeof e === 'object' && e !== null && 'code' in e && typeof (e as Record<string, unknown>).code === 'string';
}



export interface FilesystemContext {
    getAllowedDirectories(): string[];
    setAllowedDirectories(directories: string[]): void;
    validatePath(requestedPath: string): Promise<string>;
}

export function createFilesystemContext(initialAllowedDirectories: string[] = []): FilesystemContext {
    let _allowedDirectories = [...initialAllowedDirectories];

    function getAllowedDirectories() {
        return [..._allowedDirectories];
    }

    function setAllowedDirectories(directories: string[]) {
        _allowedDirectories = [...directories];
    }

    async function validatePath(requestedPath: string) {
        const expandedPath = expandHome(requestedPath);
        const absolute = path.isAbsolute(expandedPath)
            ? path.resolve(expandedPath)
            : path.resolve(process.cwd(), expandedPath);
        const normalizedRequested = normalizePath(absolute);

        const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories);
        if (!isAllowed) {
            throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${_allowedDirectories.join(', ')}`);
        }

        try {
            const realPath = await fs.realpath(absolute);
            const normalizedReal = normalizePath(realPath);
            if (!isPathWithinAllowedDirectories(normalizedReal, _allowedDirectories)) {
                throw new Error(`Access denied - symlink target outside allowed directories: ${realPath} not in ${_allowedDirectories.join(', ')}`);
            }
            return realPath;
        } catch (error: unknown) {
            if (hasCode(error) && error.code === 'ENOENT') {
                const parentDir = path.dirname(absolute);
                try {
                    const realParentPath = await fs.realpath(parentDir);
                    const normalizedParent = normalizePath(realParentPath);
                    if (!isPathWithinAllowedDirectories(normalizedParent, _allowedDirectories)) {
                        throw new Error(`Access denied - parent directory outside allowed directories: ${realParentPath} not in ${_allowedDirectories.join(', ')}`);
                    }
                    return absolute;
                } catch {
                    throw new Error(`Parent directory does not exist: ${parentDir}`);
                }
            }
            throw error;
        }
    }

    return { getAllowedDirectories, setAllowedDirectories, validatePath };
}

export function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0)
        return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i < 0 || i === 0)
        return `${bytes} ${units[0]}`;
    const unitIndex = Math.min(i, units.length - 1);
    return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Detect how many incoming lines overlap with the tail of an existing file.
 * Used by append-mode writes to avoid duplicating content on resume.
 */
export function findResumeOffset(existingTailLines: string[], incomingLines: string[]): number {
    if (!existingTailLines.length || !incomingLines.length)
        return 0;
    const trim = (s: string) => s.trimEnd();
    const firstIncomingRaw = incomingLines[0];
    if (firstIncomingRaw === undefined)
        throw new Error('findResumeOffset: incomingLines[0] missing despite non-empty check');
    const firstIncoming = trim(firstIncomingRaw);
    for (let i = 0; i < existingTailLines.length; i++) {
        const existingAtI = existingTailLines[i];
        if (existingAtI === undefined)
            throw new Error(`findResumeOffset: existingTailLines[${i}] out of range`);
        if (trim(existingAtI) !== firstIncoming)
            continue;
        const overlapLen = Math.min(existingTailLines.length - i, incomingLines.length);
        let matched = true;
        for (let j = 0; j < overlapLen; j++) {
            const existingAtIJ = existingTailLines[i + j];
            const incomingAtJ = incomingLines[j];
            if (existingAtIJ === undefined || incomingAtJ === undefined)
                throw new Error(`findResumeOffset: index out of range at i=${i}, j=${j}`);
            if (trim(existingAtIJ) !== trim(incomingAtJ)) {
                matched = false;
                break;
            }
        }
        if (matched)
            return overlapLen;
    }
    return 0;
}

export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

export function createUnifiedDiff(originalContent: string, newContent: string, filepath = 'file'): string {
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}

export function createMinimalDiff(originalContent: string, newContent: string, filepath = 'file'): string {
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, '', '', { context: 0 });
}



export async function getFileStats(filePath: string) {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}

export async function readFileContent(filePath: string, encoding = 'utf-8') {
    return await fs.readFile(filePath, encoding as BufferEncoding);
}

export async function writeFileContent(filePath: string, content: string) {
    try {
        await fs.writeFile(filePath, content, { encoding: "utf-8", flag: 'wx' });
    } catch (error: unknown) {
        if (hasCode(error) && error.code === 'EEXIST') {
            const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
            try {
                await fs.writeFile(tempPath, content, 'utf-8');
                await fs.rename(tempPath, filePath);
            } catch (renameError) {
                try { await fs.unlink(tempPath); } catch { }
                throw renameError;
            }
        } else {
            throw error;
        }
    }
}

export async function applyFileEdits(filePath: string, edits: Array<{ oldText: string; newText: string }>, dryRun = false) {
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    let modifiedContent = content;
    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);
        if (modifiedContent.includes(normalizedOld)) {
            modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
            continue;
        }
        const oldLines = normalizedOld.split('\n');
        const contentLines = modifiedContent.split('\n');
        let matchFound = false;
        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            const potentialMatch = contentLines.slice(i, i + oldLines.length);
            const isMatch = oldLines.every((oldLine, j) => {
                const contentLine = potentialMatch[j];
                if (contentLine === undefined)
                    throw new Error(`applyFileEdits: potentialMatch[${j}] missing for window at i=${i}`);
                return oldLine.trim() === contentLine.trim();
            });
            if (isMatch) {
                const firstContentLine = contentLines[i];
                if (firstContentLine === undefined)
                    throw new Error(`applyFileEdits: contentLines[${i}] missing despite matched window`);
                const originalIndent = firstContentLine.match(/^\s*/)?.[0] || '';
                const newLines = normalizedNew.split('\n').map((line, j) => {
                    if (j === 0) return originalIndent + line.trimStart();
                    const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
                    const newIndent = line.match(/^\s*/)?.[0] || '';
                    if (oldIndent && newIndent) {
                        const relativeIndent = newIndent.length - oldIndent.length;
                        return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
                    }
                    return line;
                });
                contentLines.splice(i, oldLines.length, ...newLines);
                modifiedContent = contentLines.join('\n');
                matchFound = true;
                break;
            }
        }
        if (!matchFound) {
            throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
        }
    }
    const diff = createUnifiedDiff(content, modifiedContent, filePath);
    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) { numBackticks++; }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
    if (!dryRun) {
        const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, modifiedContent, 'utf-8');
            await fs.rename(tempPath, filePath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch { }
            throw error;
        }
    }
    return formattedDiff;
}

export function countOccurrences(text: string, search: string): number {
    let count = 0;
    let pos = 0;
    const normText = normalizeLineEndings(text);
    const normSearch = normalizeLineEndings(search);
    while (true) {
        const idx = normText.indexOf(normSearch, pos);
        if (idx === -1) break;
        count++;
        pos = idx + normSearch.length;
    }
    return count;
}

export async function tailFile(filePath: string, numLines: number) {
    const CHUNK_SIZE = 1024;
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return '';
    const fileHandle = await fs.open(filePath, 'r');
    try {
        const lines = [];
        let position = fileSize;
        let chunk = Buffer.alloc(CHUNK_SIZE);
        let linesFound = 0;
        let remainingText = '';
        while (position > 0 && linesFound < numLines) {
            const size = Math.min(CHUNK_SIZE, position);
            position -= size;
            const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
            if (!bytesRead) break;
            const readData = chunk.slice(0, bytesRead).toString('utf-8');
            const chunkText = readData + remainingText;
            const chunkLines = normalizeLineEndings(chunkText).split('\n');
            if (position > 0) {
                const firstChunkLine = chunkLines[0];
                if (firstChunkLine === undefined)
                    throw new Error('tailFile: split produced empty array unexpectedly');
                remainingText = firstChunkLine;
                chunkLines.shift();
            }
            for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
                lines.unshift(chunkLines[i]);
                linesFound++;
            }
        }
        return lines.join('\n');
    } finally {
        await fileHandle.close();
    }
}

export async function headFile(filePath: string, numLines: number) {
    const fileHandle = await fs.open(filePath, 'r');
    try {
        const lines = [];
        let buffer = '';
        let bytesRead = 0;
        const chunk = Buffer.alloc(1024);
        while (lines.length < numLines) {
            const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
            buffer += chunk.slice(0, result.bytesRead).toString('utf-8');
            const newLineIndex = buffer.lastIndexOf('\n');
            if (newLineIndex !== -1) {
                const completeLines = buffer.slice(0, newLineIndex).split('\n');
                buffer = buffer.slice(newLineIndex + 1);
                for (const line of completeLines) {
                    lines.push(line);
                    if (lines.length >= numLines) break;
                }
            }
        }
        if (buffer.length > 0 && lines.length < numLines) {
            lines.push(buffer);
        }
        return lines.join('\n');
    } finally {
        await fileHandle.close();
    }
}

export async function offsetReadFile(filePath: string, offset: number, length: number) {
    return new Promise((resolveP, rejectP) => {
        const stream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let lineNum = 0;
        const collected: string[] = [];
        let totalLines = 0;

        rl.on('line', (line) => {
            totalLines++;
            if (lineNum >= offset && collected.length < length) {
                collected.push(line);
            }
            lineNum++;
            if (collected.length >= length) {
                rl.close();
                stream.destroy();
            }
        });

        rl.on('close', () => {
            resolveP({ content: collected.join('\n'), totalLines, linesReturned: collected.length });
        });

        rl.on('error', rejectP);
        stream.on('error', rejectP);
    });
}

export async function searchFilesWithValidation(rootPath: string, pattern: string, allowedDirectories: string[], options: { excludePatterns?: string[] } = {}) {
    const { excludePatterns = [] } = options;
    const results: string[] = [];
    async function search(currentPath: string) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const normalizedFull = normalizePath(path.resolve(fullPath));
            if (!isPathWithinAllowedDirectories(normalizedFull, allowedDirectories)) {
                continue;
            }
            const relativePath = path.relative(rootPath, fullPath);
            const shouldExclude = excludePatterns.some(excludePattern => minimatch(relativePath, excludePattern, { dot: true }));
            if (shouldExclude) continue;
            if (minimatch(relativePath, pattern, { dot: true })) {
                results.push(fullPath);
            }
            if (entry.isDirectory()) {
                await search(fullPath);
            }
        }
    }
    await search(rootPath);
    return results;
}
