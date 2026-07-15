import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

/**
 * Walk the process tree to find candidate working directories.
 *
 * On Linux: reads /proc/<pid>/cwd (symlink to CWD) and /proc/<pid>/status
 * (PPid line) for each ancestor.
 *
 * On macOS/other: attempts lsof-based approach, falls back to own process.cwd() only.
 *
 * Returns an array of { cwd, source } tuples, ordered from nearest ancestor
 * to farthest. Always includes own process.cwd() as the final entry.
 *
 * Walks at most 5 ancestors — covers:
 *   IDE → shell → mcp  (depth 2)
 *   tmux → shell → wrapper → mcp  (depth 3)
 *   systemd → IDE → shell → mcp  (depth 4)
 */
export function getProcessTreeCwds(): Array<{ cwd: string; source: string }> {
    const candidates: Array<{ cwd: string; source: string }> = [];
    const seen = new Set<string>();

    if (os.platform() === 'linux') {
        try {
            let pid = process.ppid;

            for (let depth = 0; depth < 5 && pid > 1; depth++) {
                try {
                    // Read the CWD of the ancestor process
                    const cwdLink = `/proc/${pid}/cwd`;
                    const cwd = fs.readlinkSync(cwdLink);

                    if (cwd && !seen.has(cwd)) {
                        seen.add(cwd);
                        // Read the process name for diagnostics
                        let name = `pid:${pid}`;
                        try {
                            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
                            const nameLine = status.split('\n').find(l => l.startsWith('Name:'));
                            if (nameLine) {
                                name = nameLine.split('\t')[1]?.trim() ?? name;
                            }
                        } catch {
                            // Can't read name — use pid
                        }
                        candidates.push({ cwd, source: `ancestor[${depth}]:${name}` });
                    }

                    // Get the parent PID of this ancestor
                    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
                    const ppidLine = status.split('\n').find(l => l.startsWith('PPid:'));
                    if (!ppidLine) break;
                    pid = parseInt(ppidLine.split('\t')[1]?.trim() ?? '0', 10);
                    if (isNaN(pid) || pid <= 1) break;
                } catch {
                    // Process disappeared, permission denied, or /proc unavailable
                    break;
                }
            }
        } catch {
            // /proc not available — fall through to self:cwd
        }
    }

    // macOS: try lsof-based approach (less reliable but worth a shot)
    if (os.platform() === 'darwin' && candidates.length === 0) {
        try {
            const ppid = process.ppid;
            if (ppid > 1) {
                const result = execFileSync('lsof', ['-a', '-p', String(ppid), '-d', 'cwd', '-Fn'], {
                    encoding: 'utf-8',
                    timeout: 2000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                const lines = result.split('\n');
                for (const line of lines) {
                    if (line.startsWith('n') && line.length > 1) {
                        const cwd = line.slice(1);
                        if (cwd && !seen.has(cwd)) {
                            seen.add(cwd);
                            candidates.push({ cwd, source: `ancestor[0]:ppid:${ppid}` });
                        }
                    }
                }
            }
        } catch {
            // lsof not available or failed — fall through
        }
    }

    // Always include own cwd as final fallback
    const ownCwd = process.cwd();
    if (!seen.has(ownCwd)) {
        candidates.push({ cwd: ownCwd, source: 'self:cwd' });
    }

    return candidates;
}

/**
 * Resolve the process tree CWDs to real paths, deduplicating and filtering
 * out non-existent or non-directory paths.
 */
export function getProcessTreeCwdsResolved(): Array<{ cwd: string; source: string }> {
    const raw = getProcessTreeCwds();
    const result: Array<{ cwd: string; source: string }> = [];
    const seen = new Set<string>();

    for (const { cwd, source } of raw) {
        try {
            const resolved = fs.realpathSync(path.resolve(cwd));
            if (!seen.has(resolved)) {
                try {
                    const stat = fs.statSync(resolved);
                    if (stat.isDirectory()) {
                        seen.add(resolved);
                        result.push({ cwd: resolved, source });
                    }
                } catch {
                    // Path doesn't exist or isn't accessible — skip
                }
            }
        } catch {
            // realpath failed — skip
        }
    }

    return result;
}
