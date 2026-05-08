# Zenith-MCP Configuration Guide

Everything you need to know about configuring Zenith-MCP. Written for humans, not developers.

---

## Where Is the Config File?

```
~/.zenith-mcp/config
```

That `~` means your home directory. On macOS and Linux, the full path is something like `/home/yourname/.zenith-mcp/config`. On Windows, it's `C:\Users\yourname\.zenith-mcp\config`.

**You don't need to create this file yourself.** The very first time you start Zenith, it runs an interactive setup wizard that asks you a few questions and creates the config file for you. After that, you can edit the file by hand whenever you want.

If the config file is missing or corrupted, Zenith will quietly use sensible defaults and keep running. It will never crash because of a bad config.

---

## What the File Looks Like

The config file is plain text. It uses a simple format:

- **Settings** are written as `key: value`
- **Sections** start with `###` (like `### Tools`)
- **Comments** start with `#` (Zenith ignores these — they're notes for you)
- **Blank lines** are fine anywhere — they're just for readability

Here's a complete example showing every setting with its default value:

```text
Port: 7000

### Tools
read_file: enabled
search_file: enabled
read_media_file: enabled
read_multiple_files: enabled
write_file: enabled
edit_file: enabled
directory: enabled
search_files: enabled
file_manager: enabled
stashRestore: enabled
refactor_batch: enabled

### Auto Write
status: disabled
backup_dir: ~/.zenith-mcp/mcp_backups/
backup_mode: file
custom_mcp_paths:

### Zenith-Rag
status: disabled
postgres_url:
username:
password:

### Advanced
char_budget: 400000
search_char_budget: 15000
refactor_max_chars: 30000
refactor_max_context: 30
refactor_version_ttl_hours: 24
session_ttl_ms: 1800000
default_excludes: node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo
sensitive_patterns: **/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**
```

You can add comments anywhere:

```text
Port: 8080  # Changed to 8080 because 7000 was taken
```

**Note about inline comments:** Zenith treats ` # ` (space, hash, space) as the start of an inline comment. If a value needs to contain that exact sequence (unusual, but possible in file paths), there is no way to escape it — the text after ` # ` will be treated as a comment. Standalone comment lines (lines starting with `#`) are not affected by this.

---

## Every Setting Explained

### Port

```text
Port: 7000
```

The network port Zenith listens on when running in HTTP mode (remote access). This setting does not matter if you only use Zenith through stdio (the default for desktop apps like Claude Desktop or VS Code).

- **Default:** `7000`
- **Valid values:** Any whole number from 1 to 65535
- **When to change:** Only if port 7000 is already taken by something else on your computer

---

### Tools Section

```text
### Tools
read_file: enabled
edit_file: enabled
search_files: disabled
```

This section controls which tools your AI agent can use. Each tool is either `enabled` or `disabled`.

**You don't need to list tools yourself.** Zenith automatically discovers all available tools when it starts up. If a tool isn't in your config file yet, Zenith adds it as `enabled` by default. If a tool is already listed, Zenith respects your choice and leaves it alone. If a tool is removed from Zenith in a future update, its entry is automatically cleaned up from your config.

To turn off a tool, just change its value to `disabled`:

```text
refactor_batch: disabled
```

To turn it back on:

```text
refactor_batch: enabled
```

**The tools Zenith ships with:**

| Tool | What It Does |
|------|-------------|
| `read_file` | Read the contents of a text file |
| `search_file` | Search within a single file (grep, symbol lookup) |
| `read_media_file` | Read images and other non-text files |
| `read_multiple_files` | Read several files at once |
| `write_file` | Create or overwrite a file |
| `edit_file` | Make precise changes to a file without rewriting the whole thing |
| `directory` | List files and folders, show project structure |
| `search_files` | Search for files and content across your entire project |
| `file_manager` | Move, copy, rename, and delete files |
| `stashRestore` | Undo failed edits or roll back changes |
| `refactor_batch` | Rename or restructure code across multiple files at once |

---

### Auto Write Section

```text
### Auto Write
status: disabled
backup_dir: ~/.zenith-mcp/mcp_backups/
backup_mode: file
custom_mcp_paths:
```

Auto-write is an optional feature that saves you setup time. When enabled, Zenith automatically registers itself in the configuration files of other AI tools on your computer (like Claude Desktop, VS Code Copilot, Cline, etc.). That way, those tools can find and use Zenith without you manually editing their config files.

**This is completely opt-in.** It's turned off by default. The first-run wizard asks if you want to enable it.

#### status

```text
status: disabled
```

Whether auto-write is turned on or off.

- **Default:** `disabled`
- **Valid values:** `enabled` or `disabled`

#### backup_dir

```text
backup_dir: ~/.zenith-mcp/mcp_backups/
```

Before Zenith modifies any other tool's config file, it saves a backup copy in this directory. If anything goes wrong, you can find the original file here.

- **Default:** `~/.zenith-mcp/mcp_backups/`
- **Valid values:** Any directory path on your computer

Backup files are named with a timestamp so they don't overwrite each other. For example: `mcp.json.2026-05-07T120000.bak`.

#### backup_mode

```text
backup_mode: file
```

How Zenith stores backups of config files before modifying them.

- **Default:** `file`
- **Valid values:**
  - `file` — Saves a copy of the original file in the backup directory. These stay forever until you delete them.
  - `sqlite` — Stores the backup in a database that automatically deletes old entries after 24 hours. Keeps your disk clean.
  - `none` — Don't save any backups. Not recommended unless you have your own backup system.

#### custom_mcp_paths

```text
custom_mcp_paths:
```

Extra file paths or directories where Zenith should look for MCP configuration files to register itself in. This is for tools that Zenith doesn't have a built-in adapter for, or for custom locations.

- **Default:** empty (no extra paths)
- **Valid values:** A comma-separated list of file paths or directory paths

If you point to a directory, Zenith scans it for files with `.json`, `.json5`, `.toml`, `.yaml`, or `.yml` extensions and checks if they look like MCP config files (they need to have a `mcpServers` key). It only writes to files that already exist and actually contain MCP configuration — it never creates new files or writes to unrelated config files.

**Limitation:** Since commas separate paths, individual paths cannot contain commas. This is a known trade-off of the simple config format. If you need to point to a path with a comma in its name, rename the directory or use a symlink.

Example:

```text
custom_mcp_paths: /opt/my-tool/mcp-config.json,~/other-configs/
```

---

### Zenith-Rag Section

```text
### Zenith-Rag
status: disabled
postgres_url:
username:
password:
```

Zenith-Rag is an optional feature that connects Zenith to a PostgreSQL database for retrieval-augmented generation (RAG). Most users don't need this.

#### status

- **Default:** `disabled`
- **Valid values:** `enabled` or `disabled`

#### postgres_url

The connection URL for your PostgreSQL database.

- **Default:** empty
- **Example:** `postgresql://localhost:5432/zenith_rag`

#### username

The database username.

- **Default:** empty

#### password

The database password.

- **Default:** empty

---

### Advanced Section

```text
### Advanced
char_budget: 400000
search_char_budget: 15000
refactor_max_chars: 30000
refactor_max_context: 30
refactor_version_ttl_hours: 24
session_ttl_ms: 1800000
default_excludes: node_modules,.git,.next,...
sensitive_patterns: **/.env,**/*.pem,...
```

These settings fine-tune how Zenith operates. The defaults work well for most projects. You generally only need to change these if you're working with unusually large codebases or have specific performance needs.

#### char_budget

```text
char_budget: 400000
```

The maximum number of characters Zenith will include when reading files or returning results. This is a safety limit that prevents Zenith from overwhelming your AI agent with too much text at once.

- **Default:** `400000` (400 thousand characters)
- **Valid range:** `10000` to `2000000` (10 thousand to 2 million)
- **If the value is outside this range:** Zenith ignores it and uses 400,000

Bigger values let Zenith return more content but use more of your AI's context window. Smaller values keep responses compact but might truncate large files.

#### search_char_budget

```text
search_char_budget: 15000
```

A separate, smaller character limit specifically for search results. Search results are line-by-line snippets (not full files), so they need a tighter budget to stay useful.

- **Default:** `15000` (15 thousand characters)
- **Hard cap:** Can never exceed `char_budget`. If you set it higher, Zenith caps it automatically.

#### refactor_max_chars

```text
refactor_max_chars: 30000
```

The maximum characters for the refactoring tool's output when loading code for review, and the maximum payload size when applying refactoring changes.

- **Default:** `30000` (30 thousand characters)
- **If set to 0 or empty:** Zenith uses 30,000

When refactoring many symbols at once, the tool loads them in pages. If the total would exceed this budget, remaining symbols are deferred to the next page (you ask for them with `loadMore`).

#### refactor_max_context

```text
refactor_max_context: 30
```

When the refactoring tool shows you a piece of code, it includes some surrounding lines above and below for context (so you can see what's around it). This setting caps how many context lines are shown.

- **Default:** `30` lines
- **Hard cap:** `30` lines maximum. If you set it higher, Zenith caps it at 30.
- **Minimum:** `0` (no context lines at all)

#### refactor_version_ttl_hours

```text
refactor_version_ttl_hours: 24
```

Whenever Zenith edits a piece of code through the refactoring tool, it takes a snapshot of the original version so you can roll back if needed. This setting controls how long those snapshots are kept before being automatically cleaned up.

- **Default:** `24` hours
- **If set to 0 or empty:** Zenith uses 24 hours

Set this higher if you want to be able to roll back changes from days ago. Set it lower if you want to save disk space.

#### session_ttl_ms

```text
session_ttl_ms: 1800000
```

When running in HTTP mode, each client that connects gets its own isolated session. If a session has no activity for this long, Zenith automatically closes it to free up memory.

- **Default:** `1800000` (1,800,000 milliseconds = 30 minutes)
- **This setting only matters for HTTP mode.** If you use Zenith through stdio (the default for desktop apps), sessions are tied to the process lifetime and this value is ignored.

For reference: `1800000` ms = 30 minutes, `3600000` ms = 1 hour, `900000` ms = 15 minutes.

#### default_excludes

```text
default_excludes: node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo
```

A comma-separated list of file and directory names that Zenith should skip when searching, indexing, or listing files. These are directories and files that are almost never useful to look inside (like `node_modules` or `.git`).

- **Default:** The full list above
- **Format:** Comma-separated names, no spaces around commas

You can add your own entries or remove ones you don't want. For example, if you actually need to search inside `dist/`:

```text
default_excludes: node_modules,.git,.next,.venv,venv,.env.local,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo
```

(Notice `dist` was removed from the list.)

#### sensitive_patterns

```text
sensitive_patterns: **/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**
```

A comma-separated list of file patterns that Zenith treats as sensitive. Files matching these patterns are blocked from appearing in search results and from being indexed in the symbol database. This is a safety feature to prevent secrets from accidentally leaking into AI conversations.

- **Default:** The full list above
- **Format:** Comma-separated glob patterns (the `**` means "in any subdirectory")

For example, `**/*.pem` means "any file ending in `.pem`, no matter how deep in the directory tree."

---

## The First-Run Wizard

When you start Zenith for the first time and there's no config file yet, it runs a styled interactive wizard in your terminal (red and white on dark background). The wizard walks you through:

1. **Auto-Write** — "Enable auto-write?" Type `y` or `n`. Default is no.

2. *(Only if you said yes)* **Backup Mode** — Four choices:
   - `[1]` File backups in Zenith's directory (default)
   - `[2]` SQLite with auto-cleanup after 24 hours
   - `[3]` Custom path (you type it in)
   - `[4]` No backups

3. *(Only if you said yes)* **Custom MCP Paths** — Enter comma-separated paths to extra config files or directories, or press Enter to skip.

4. **Server Port** — Enter a number (1–65535) or press Enter for the default (7000).

5. **Character Budget** — Enter a number (10,000–2,000,000) or press Enter for the default (400,000).

After answering, the wizard saves the config file and (if you enabled auto-write) immediately registers Zenith in your other AI tools' configs. You'll see a confirmation with the config file path.

---

## Environment Variables

Zenith does **not** use environment variables for configuration. Everything is in the config file.

The only environment variables Zenith reads are:

| Variable | What It's For |
|----------|--------------|
| `ZENITH_MCP_API_KEY` or `MCP_BRIDGE_API_KEY` or `COMMANDER_API_KEY` | The password for HTTP mode. Required if you run Zenith as a remote server. Not needed for local/stdio use. |
| `TOON_PROJECT_DIR` | Points to the `toon` compression tool (optional, most users don't need this). |
| `APPDATA`, `LOCALAPPDATA`, `USERPROFILE` | Standard Windows paths. Zenith reads these on Windows to find where other tools store their configs. You never need to set these — Windows sets them automatically. |

---

## Tips

- **You can edit the config file at any time.** Changes take effect the next time Zenith starts up. A full server restart is required — Zenith loads the config once at startup and does not re-read it during a session.

- **Your edits are preserved.** When Zenith starts up, it only touches the `### Tools` section (to add newly registered tools or remove unregistered ones). Comments and blank lines inside the Tools section are kept in place. Everything outside the Tools section — your comments, custom formatting, unknown keys, other sections — is never modified.

- **The config file never stores secrets.** API keys for HTTP authentication are passed as environment variables, not stored in the config file.

- **If something goes wrong,** just delete the config file and restart Zenith. The wizard will run again and create a fresh one with defaults.
