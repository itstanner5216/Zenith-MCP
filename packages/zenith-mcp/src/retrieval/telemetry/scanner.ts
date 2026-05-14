import { readdir, readFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import type { RootEvidence, WorkspaceEvidence } from "../models.js";
import { MANIFEST_LANGUAGE_MAP, LOCKFILE_NAMES, buildTokens } from "./tokens.js";
import { fingerprintEvidence, mergeEvidence } from "./evidence.js";

// ── Allowlist ────────────────────────────────────────────────────────────────
const ALLOWED_MANIFESTS: Set<string> = new Set(Object.keys(MANIFEST_LANGUAGE_MAP));
const ALLOWED_LOCKFILES: Set<string> = LOCKFILE_NAMES;
const ALLOWED_CI_FILES: Set<string> = new Set([
  ".travis.yml",
  "Jenkinsfile",
  ".circleci",
  "azure-pipelines.yml",
  "Makefile",
]);
const ALLOWED_CONTAINER_FILES: Set<string> = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);
const ALLOWED_INFRA_FILES: Set<string> = new Set([
  "terraform.tf",
  "main.tf",
  "variables.tf",
  "cloudformation.yaml",
]);
const ALLOWED_DB_FILES: Set<string> = new Set(["schema.prisma", "schema.sql"]);

const README_RE = /^readme(\.(md|rst|txt))?$/i;

const ALL_ALLOWED_FILES: Set<string> = new Set([
  ...ALLOWED_MANIFESTS,
  ...ALLOWED_LOCKFILES,
  ...ALLOWED_CI_FILES,
  ...ALLOWED_CONTAINER_FILES,
  ...ALLOWED_INFRA_FILES,
  ...ALLOWED_DB_FILES,
]);

// ── Denylist ─────────────────────────────────────────────────────────────────
const DENIED_PATTERNS: string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_dsa",
  "id_ecdsa",
  "*.aws_credentials",
  "credentials",
  ".aws",
  "*.secret",
  "*.secrets",
];

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_TIMEOUT_MS = 150;

function _isDenied(name: string): boolean {
  const lower = name.toLowerCase();
  for (const pattern of DENIED_PATTERNS) {
    if (
      _fnmatch(name, pattern) ||
      _fnmatch(lower, pattern.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

function _fnmatch(name: string, pattern: string): boolean {
  const parts = pattern.split("*");
  let idx = 0;
  for (const part of parts) {
    if (part === "") continue;
    const found = name.indexOf(part, idx);
    if (found === -1) return false;
    idx = found + part.length;
  }
  return true;
}

function _uriToPath(uri: string): string | null {
  try {
    if (uri.startsWith("file://")) {
      return fileURLToPath(uri);
    }
    return uri;
  } catch {
    return null;
  }
}

export interface ScanOptions {
  maxDepth: number;
  maxFiles: number;
  timeoutMs: number;
}

async function _scanRootAsync(
  rootPath: string,
  rootUri: string,
  rootName: string | undefined,
  options: Required<ScanOptions>
): Promise<RootEvidence> {
  const evidence: RootEvidence = {
    rootUri,
    rootName,
    tokens: {},
    features: {},
    confidence: 0.0,
    fingerprintHash: "",
    partialScan: false,
  };

  if (!existsSync(rootPath)) return evidence;

  const deadline = performance.now() + options.timeoutMs;
  const foundFiles: Set<string> = new Set();
  let readmeLines: string[] | null = null;
  let entriesVisited = 0;
  let partial = false;

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > options.maxDepth) return;
    if (performance.now() >= deadline) { partial = true; return; }
    if (entriesVisited >= options.maxFiles) { partial = true; return; }

    let entries: { name: string; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (performance.now() >= deadline) { partial = true; return; }
      if (entriesVisited >= options.maxFiles) { partial = true; return; }
      entriesVisited++;

      const name = entry.name;
      const fullPath = join(dirPath, name);

      // Skip symlinks — never follow
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(fullPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;

      if (_isDenied(name)) continue;

      const relPath = relative(rootPath, fullPath).replace(/\\/g, "/");

      if (stats.isFile()) {
        if (ALL_ALLOWED_FILES.has(name)) {
          foundFiles.add(relPath);
        } else if (README_RE.test(name) && readmeLines === null) {
          try {
            const content = await readFile(fullPath, "utf-8");
            readmeLines = content.split("\n").slice(0, 40);
          } catch {
            // ignore
          }
        }
      } else if (stats.isDirectory()) {
        // Flag signal directories by relPath or name (matches Python behavior)
        if (
          relPath === ".github" ||
          relPath === ".github/workflows" ||
          relPath === ".circleci" ||
          relPath === "migrations" ||
          name === ".github" ||
          name === ".circleci" ||
          name === "migrations"
        ) {
          foundFiles.add(relPath);
        }
        await walk(fullPath, depth + 1);
      }
    }
  }

  try {
    await walk(rootPath, 0);
  } catch {
    partial = true;
  }

  evidence.partialScan = partial;

  const tokens = buildTokens({
    foundFiles,
    readmeLines: readmeLines ?? undefined,
  });
  evidence.tokens = tokens;

  if (Object.keys(tokens).length > 0) {
    const families = new Set(Object.keys(tokens).map((t) => t.split(":")[0]));
    evidence.confidence = Math.min(1.0, families.size / 3.0);
  }

  // Stable fingerprint hash from sorted found files
  evidence.fingerprintHash = fingerprintEvidence([...foundFiles]);

  return evidence;
}

export class TelemetryScanner {
  private readonly _options: Required<ScanOptions>;

  constructor(options?: Partial<ScanOptions>) {
    this._options = {
      maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxFiles: options?.maxFiles ?? DEFAULT_MAX_FILES,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  async scanRoot(rootUri: string, rootName?: string): Promise<RootEvidence> {
    const rootPath = _uriToPath(rootUri);
    if (rootPath === null) {
      return {
        rootUri,
        rootName,
        tokens: {},
        features: {},
        confidence: 0.0,
        fingerprintHash: "",
        partialScan: false,
      };
    }
    return _scanRootAsync(rootPath, rootUri, rootName, this._options);
  }

  async scanRoots(
    rootUris: string[],
    rootNames?: (string | undefined)[]
  ): Promise<WorkspaceEvidence> {
    let names: (string | undefined)[];
    if (rootNames !== undefined) {
      if (rootNames.length !== rootUris.length) {
        throw new Error(
          `root_names length (${rootNames.length}) must match root_uris length (${rootUris.length})`
        );
      }
      names = rootNames;
    } else {
      names = rootUris.map(() => undefined);
    }

    const results: RootEvidence[] = [];
    for (let i = 0; i < rootUris.length; i++) {
      const evidence = await this.scanRoot(rootUris[i], names[i]);
      results.push(evidence);
    }
    return mergeEvidence(results);
  }
}

export async function scanRoots(
  rootUris: string[],
  rootNames?: (string | undefined)[],
  options?: Partial<ScanOptions>
): Promise<WorkspaceEvidence> {
  const scanner = new TelemetryScanner(options);
  return scanner.scanRoots(rootUris, rootNames);
}
