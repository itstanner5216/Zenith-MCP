# Deep Research Prompt: Enhancing Automatic Project Root Detection in an MCP Server

---

## Context

I maintain **Zenith-MCP**, an MCP (Model Context Protocol) filesystem server written in TypeScript/Node.js. It runs as either a **stdio** transport (spawned by an MCP client like Claude Desktop, Cursor, OpenCode) or as an **HTTP** transport (long-running server accepting multiple sessions).

A core feature is **automatic project root detection** — when a tool call comes in (e.g. edit a file, search code, stash a snippet), the server needs to know which project the user is working in so it can scope databases, symbol indexes, and stash storage to the correct project root. **This detection must happen with zero input from the user or model** — no tool parameters, no configuration flags, no manual setup. The server figures it out on its own.

## What I Currently Do

My detection system uses a multi-step resolution ladder, tried in order:

### Step 0: Process-Tree CWD Walk
On Linux, the server reads `/proc/<pid>/cwd` for each ancestor process (up to 5 levels: parent, grandparent, etc.), collecting their working directories. On macOS, it uses `lsof -p <ppid> -d cwd` for the immediate parent. The rationale: the IDE or shell that spawned the MCP server almost always has its CWD set to the user's project directory. Each candidate CWD is tested against the remaining detection steps.

### Step 1: Git Root Detection
Walk up from the target path looking for a `.git` directory (pure filesystem check via `statSync`, no dependency on the `git` CLI being in PATH). If found, optionally refine with `git rev-parse --show-toplevel` for worktree/submodule accuracy, falling back to the `.git` parent directory if the CLI isn't available.

### Step 2: Project Marker Detection
Walk up from the target path looking for language-specific project markers (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`, etc. — 15 markers total). Within a git repo, finds the *deepest* marker root (for monorepo package detection). Without git, returns the nearest marker.

### Step 3: Allowed Directories Fallback
If the file path itself doesn't resolve, iterate the allowed directories (provided by MCP roots protocol or CLI args at startup) and try git/marker detection on each of them. Includes single-directory fallback and longest-match containment logic.

### Step 4: Project Registry
Check a SQLite-backed registry of explicitly registered project roots (persisted across sessions). Supports matching by project ID, name, path prefix, and leading path segment.

### Step 5: Global Fallback
If nothing matches, operate in global mode with a shared database at `~/.zenith-mcp/global-stash.db`. The server **never crashes** — it degrades gracefully.

### Additional Context
- The server also implements the **MCP roots protocol** (`initialized` callback + `notifications/roots/list_changed`), which allows clients to declare filesystem roots. These roots are merged with CLI-provided directories and feed into the resolution ladder as "allowed directories."
- Per-file resolution is triggered by `getRoot(filePath)` on tool calls that provide a file path. Session-wide resolution uses `_resolve()` which tries allowed dirs, then the process-tree walk, then global fallback.
- Results are cached in a 512-entry LRU cache keyed by `(absPath, sortedAllowedDirs, sortedRegistryRoots)`.

## The Task

**Research and propose your top three creative, practical techniques for enhancing automatic project root detection in this MCP server.**

I want ideas that go beyond what I already have. Things I haven't thought of. Novel heuristics, signals, or data sources that can improve detection accuracy and reliability — especially in edge cases like:

- Server spawned by a GUI app (e.g. Claude Desktop on macOS) where the process tree CWDs are all `/` or `/Applications/...`
- Multiple projects open simultaneously in the same IDE
- Monorepos with dozens of packages
- Non-git projects (Mercurial, SVN, or no VCS at all)
- Remote/container environments where `/proc` isn't available
- The very first tool call of a session, before any file paths have been seen

## Hard Constraints

Please internalize these before generating suggestions. These are non-negotiable:

1. **Fully automatic.** No user action, no model action, no tool call parameters, no CLI flags, no config files. The server detects the project on its own. If your suggestion requires the user or model to do anything — even once — it is rejected.

2. **Implementable inside an MCP server.** I am an MCP server. I have access to: the Node.js runtime, the filesystem, the process environment, the MCP SDK's server-side APIs (roots, logging, notifications, tool registration), and whatever npm packages I want to bundle. I do NOT have: access to the model's context window, provider-level APIs, the ability to intercept or inspect LLM requests/responses, access to the client application's internal state beyond what MCP exposes, or any kind of proxy/middleware position in the request chain. Suggestions that require me to be something other than an MCP server are out of scope.

3. **No proxies, wrappers, or middleware.** I'm not wrapping another server. I'm not intercepting traffic. I'm not inserting myself between the client and the model. I am a tool server that receives tool calls and returns results.

4. **No one-time setup commands or initialization rituals.** No "run `zenith init` in your project first" or "add a `.zenith` config file." The server must work the very first time it's invoked in any directory on any machine with zero prior setup.

5. **Must be realistic to implement in TypeScript/Node.js.** No "train a classifier on repo structures" or "use an embedding model to match directory layouts." I need concrete, deterministic techniques that I can implement in a few hundred lines of TypeScript.

## What a Good Suggestion Looks Like

For each of your three suggestions, please provide:

- **The technique**: What signal or data source does it use? How does it work?
- **Why it's better than what I have**: What edge case or failure mode does it address that my current ladder doesn't?
- **Where it fits**: Should it be a new step in the ladder? An enhancement to an existing step? A parallel signal that feeds into a scoring/voting system?
- **Platform considerations**: Does it work on Linux, macOS, Windows? What are the fallback behaviors?
- **Implementation sketch**: Enough detail that I could implement it in an afternoon. Pseudocode or TypeScript is welcome. I don't need production-ready code, but I need to see that you've thought through the mechanics.
- **Failure modes**: When does this technique give wrong results? How do I detect and handle that?

## What I Don't Want

- Suggestions to "just use MCP roots" — I already do, it's Step 3.
- Suggestions to "look for `.git`" — I already do, it's Step 1.
- Suggestions to "check `process.cwd()`" — I already do, it's the final candidate in Step 0.
- Suggestions to add a CLI flag or config option — violates Constraint 1.
- Suggestions to build a proxy or wrapper — violates Constraint 3.
- Vague hand-waving like "use heuristics" without specifying what the heuristics actually are.

Thank you. I'm looking for the kind of ideas that make me say "why didn't I think of that."
