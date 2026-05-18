#!/usr/bin/env node
import fs from 'node:fs';
import { compressToon } from './toon_bridge.js';

function parseBudget(raw: string | undefined): number | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (!/^\d+$/.test(raw)) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

async function main(): Promise<void> {
    const [filePath, budgetRaw] = process.argv.slice(2);
    if (!filePath) process.exit(1);
    const budget = parseBudget(budgetRaw);
    if (budget === null) process.exit(1);

    const content = fs.readFileSync(filePath, 'utf8');
    process.stdout.write(await compressToon(content, budget, filePath));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
