#!/usr/bin/env node
import { loadSettings, saveSettings } from "./adapter-settings.js";
import { listAdapters, configureRegistry } from "../adapters/registry.js";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

async function main() {
  if (args.includes("--list")) {
    configureRegistry();
    for (const a of listAdapters()) {
      console.log(`  ${a.toolName.padEnd(20)} ${a.displayName} [${a.configFormat}] (${a.supportedPlatforms.join(",")})`);
    }
    return;
  }

  if (args.includes("--status")) {
    const s = loadSettings();
    console.log(`Enabled adapters: ${s.enabledAdapters.length ? s.enabledAdapters.join(", ") : "none"}`);
    console.log(`Backup dir:       ${s.backupDir ?? "[none set]"}`);
    return;
  }

  const enableIdx = args.indexOf("--enable");
  if (enableIdx !== -1 && args[enableIdx + 1]) {
    const names = args[enableIdx + 1].split(",").map(s => s.trim()).filter(Boolean);
    const s = loadSettings();
    for (const n of names) {
      if (!s.enabledAdapters.includes(n)) s.enabledAdapters.push(n);
    }
    saveSettings(s);
    console.log(`Enabled: ${names.join(", ")}`);
    return;
  }

  const disableIdx = args.indexOf("--disable");
  if (disableIdx !== -1 && args[disableIdx + 1]) {
    const name = args[disableIdx + 1];
    const s = loadSettings();
    s.enabledAdapters = s.enabledAdapters.filter(a => a !== name);
    saveSettings(s);
    console.log(`Disabled: ${name}`);
    return;
  }

  const backupIdx = args.indexOf("--backup-dir");
  if (backupIdx !== -1 && args[backupIdx + 1]) {
    const s = loadSettings();
    s.backupDir = args[backupIdx + 1];
    saveSettings(s);
    console.log(`Backup dir set: ${s.backupDir}`);
    return;
  }

  // Interactive mode
  await interactiveMode();
}

async function interactiveMode() {
  const s = loadSettings();
  console.log("\nZenith-MCP Adapter Configuration");
  console.log("=================================");
  console.log(`Backup directory: ${s.backupDir ?? "[none set]"}`);
  console.log(`Enabled adapters: ${s.enabledAdapters.length ? s.enabledAdapters.join(", ") : "none"}`);
  console.log("\n1. Set backup directory\n2. Enable adapters\n3. Disable adapters\n4. Show status\n5. Exit");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string) => new Promise<string>(res => rl.question(q, res));

  const choice = await question("\nChoice: ");
  if (choice === "1") {
    const dir = await question("Backup directory path: ");
    s.backupDir = dir.trim();
    saveSettings(s);
    console.log(`Set.`);
  } else if (choice === "2") {
    const names = (await question("Adapter names (comma-separated): ")).split(",").map(s => s.trim()).filter(Boolean);
    for (const n of names) if (!s.enabledAdapters.includes(n)) s.enabledAdapters.push(n);
    saveSettings(s);
    console.log(`Enabled: ${names.join(", ")}`);
  } else if (choice === "3") {
    const name = (await question("Adapter name to disable: ")).trim();
    s.enabledAdapters = s.enabledAdapters.filter(a => a !== name);
    saveSettings(s);
    console.log(`Disabled: ${name}`);
  } else if (choice === "4") {
    console.log(`Enabled: ${s.enabledAdapters.join(", ") || "none"}\nBackup: ${s.backupDir ?? "none"}`);
  }
  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
