// ---------------------------------------------------------------------------
// tree-sitter/languages.ts — Extension / filename → language mapping
//
// Contains the EXT_TO_LANG and FILENAME_TO_LANG lookup tables plus the
// three helper functions that query them: getLangForFile, getSupportedExtensions,
// isSupported.
//
// No imports from sibling submodules — this is a pure leaf module.
// ---------------------------------------------------------------------------

import path from 'node:path';

// ---------------------------------------------------------------------------
// Extension → language mapping
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
    // JavaScript / TypeScript
    '.js':   'javascript',
    '.mjs':  'javascript',
    '.cjs':  'javascript',
    '.jsx':  'javascript',
    // JavaScript (additions)
    '.es':   'javascript',
    '.es6':  'javascript',
    '.ts':   'typescript',
    '.mts':  'typescript',
    '.cts':  'typescript',
    '.tsx':  'tsx',
    // Python
    '.py':   'python',
    '.pyi':  'python',
    // Python (additions)
    '.pyw':  'python',
    // Shell
    '.sh':   'bash',
    '.bash': 'bash',
    '.zsh':  'bash',
    // Shell / Bash (additions — bash grammar handles ksh/ash syntax)
    '.ksh':  'bash',
    '.ash':  'bash',
    // Go
    '.go':   'go',
    // Rust
    '.rs':   'rust',
    // Java
    '.java': 'java',
    // C / C++
    '.c':    'c',
    '.h':    'c',
    '.cpp':  'cpp',
    '.cc':   'cpp',
    '.cxx':  'cpp',
    '.hpp':  'cpp',
    '.hh':   'cpp',
    '.hxx':  'cpp',
    // C++ (additions — template and module file extensions)
    '.ipp':  'cpp',
    '.inl':  'cpp',
    '.tcc':  'cpp',
    '.cppm': 'cpp',
    '.ixx':  'cpp',
    // C#
    '.cs':   'csharp',
    // C# (additions)
    '.csx':  'csharp',
    // Kotlin
    '.kt':   'kotlin',
    '.kts':  'kotlin',
    // PHP
    '.php':  'php',
    // PHP (additions)
    '.php3':  'php',
    '.php4':  'php',
    '.php5':  'php',
    '.php7':  'php',
    '.php8':  'php',
    '.phtml': 'php',
    // Ruby
    '.rb':     'ruby',
    '.rake':   'ruby',
    '.gemspec': 'ruby',
    // Ruby (additions)
    '.ru':       'ruby',
    '.jbuilder': 'ruby',
    '.rabl':     'ruby',
    '.podspec':  'ruby',
    '.arb':      'ruby',
    // Swift
    '.swift': 'swift',
    // Web
    '.css':  'css',
    '.scss': 'scss',
    // Data formats
    '.json':  'json',
    '.jsonc': 'json',
    // JSON (additions)
    '.json5':    'json',
    '.geojson':  'json',
    '.topojson': 'json',
    '.jsonl':    'json',
    '.ndjson':   'json',
    '.yaml':  'yaml',
    '.yml':   'yaml',
    '.sql':   'sql',
    // SQL (additions)
    '.pgsql':  'sql',
    '.plsql':  'sql',
    '.mysql':  'sql',
    // Documentation
    '.md':  'markdown',
    '.mdx': 'markdown',
    // Markdown (additions)
    '.markdown': 'markdown',
    '.mdown':    'markdown',
    '.mkd':      'markdown',
    '.mkdn':     'markdown',
    '.mkdown':   'markdown',
    '.mdwn':     'markdown',

    // --- Full coverage additions (WASM + tags.scm present) ---

    // Dockerfile
    '.dockerfile': 'dockerfile',

    // GraphQL
    '.graphql': 'graphql',
    '.gql':     'graphql',

    // HCL / Terraform / Packer
    '.tf':      'hcl',
    '.hcl':     'hcl',
    '.tfvars':  'hcl',
    '.nomad':   'hcl',

    // HTML
    '.html':  'html',
    '.htm':   'html',
    '.shtml': 'html',
    '.xhtml': 'html',

    // Lua
    '.lua': 'lua',

    // Nix
    '.nix': 'nix',

    // Prisma
    '.prisma': 'prisma',

    // Protocol Buffers
    '.proto': 'proto',

    // Tree-sitter Query Language (the .scm grammar files themselves).
    // NOTE: .scm extension is NOT mapped here because it conflicts with
    // Scheme source files, which conventionally use .scm. Tree-sitter
    // query files have a strict naming convention (tags.scm,
    // highlights.scm, locals.scm, injections.scm) and are matched via
    // FILENAME_TO_LANG instead, so editors of Scheme code don't get
    // their files misclassified as tree-sitter query language.

    // Svelte
    '.svelte': 'svelte',

    // TOML
    '.toml': 'toml',

    // Vue
    '.vue': 'vue',

    // XML, SVG, and XML-based formats
    '.xml':  'xml',
    '.svg':  'xml',
    '.xsl':  'xml',
    '.xslt': 'xml',
    '.xsd':  'xml',
    '.wsdl': 'xml',
    '.plist': 'xml',
    '.gpx':  'xml',
    '.kml':  'xml',
    '.rss':  'xml',
    '.atom': 'xml',

    // --- Parse-capable only (WASM present, no query file) ---

    // CMake
    '.cmake': 'cmake',

    // Dart
    '.dart': 'dart',

    // Elixir
    '.ex':  'elixir',
    '.exs': 'elixir',

    // INI / config-style formats
    '.ini': 'ini',
    '.cfg': 'ini',

    // Make (fragments — full Makefile detected by filename below)
    '.mk': 'make',

    // Perl
    '.pl': 'perl',
    '.pm': 'perl',
    '.t':  'perl',

    // R
    '.r': 'r',

    // Regex pattern files
    // tree-sitter-regex.wasm + regex-tags.scm exist and capture named groups
    '.regex': 'regex',
};

/**
 * Basename → language for files without a meaningful extension.
 * Checked as a fallback in getLangForFile when ext is empty or unrecognized.
 */
const FILENAME_TO_LANG: Record<string, string> = {
    // Dockerfile (exact basenames — prefix detection handled in getLangForFile)
    'Dockerfile':            'dockerfile',
    'dockerfile':            'dockerfile',

    // Make
    'Makefile':              'make',
    'makefile':              'make',
    'GNUmakefile':           'make',
    'BSDmakefile':           'make',

    // CMake
    'CMakeLists.txt':        'cmake',

    // Ruby DSL files (no extension — all use Ruby syntax)
    'Gemfile':               'ruby',
    'Rakefile':              'ruby',
    'Vagrantfile':           'ruby',
    'Podfile':               'ruby',
    'Brewfile':              'ruby',
    'Guardfile':             'ruby',
    'Capfile':               'ruby',
    'Berksfile':             'ruby',
    'Thorfile':              'ruby',
    'Fastfile':              'ruby',
    'Appfile':               'ruby',
    'Matchfile':             'ruby',
    'Pluginfile':            'ruby',
    'Snapfile':              'ruby',
    'Gymfile':               'ruby',
    'Deliverfile':           'ruby',
    'Scanfile':              'ruby',

    // Shell dotfiles (bash grammar handles zsh/profile syntax)
    '.bashrc':               'bash',
    '.bash_profile':         'bash',
    '.bash_logout':          'bash',
    '.bash_aliases':         'bash',
    '.bash_functions':       'bash',
    '.zshrc':                'bash',
    '.zshenv':               'bash',
    '.zprofile':             'bash',
    '.zlogout':              'bash',
    '.zlogin':               'bash',
    '.profile':              'bash',

    // EditorConfig (INI-style format)
    '.editorconfig':         'ini',

    // Git config files (INI-style format)
    '.gitconfig':            'ini',
    '.gitmodules':           'ini',

    // TOML-format files without .toml extension
    'Cargo.lock':            'toml',
    'Pipfile':               'toml',

    // Tree-sitter Query Language — canonical basenames inside grammar
    // source trees. The .scm extension is intentionally NOT mapped in
    // EXT_TO_LANG because Scheme source files share that extension and
    // are far more common than tree-sitter query files outside of
    // grammar-author workflows. These four basenames are the only files
    // in standard tree-sitter grammar layouts.
    'tags.scm':              'query',
    'highlights.scm':        'query',
    'locals.scm':            'query',
    'injections.scm':        'query',
};

/**
 * Get the tree-sitter language name for a file path.
 * Returns null if the extension is not supported.
 */
export function getLangForFile(filePath?: string): string | null {
    const resolved = filePath ?? '';
    const ext = path.extname(resolved).toLowerCase();
    if (ext) {
        const lang = EXT_TO_LANG[ext];
        if (lang !== undefined) return lang;
    }
    // Fallback: basename-exact lookup for extensionless files
    const basename = path.basename(resolved);
    const exactLang = FILENAME_TO_LANG[basename];
    if (exactLang !== undefined) return exactLang;
    // Dockerfile is the only filename family with widely-used case variants
    // (dockerfile.dev, DOCKERFILE.prod, etc., common on case-insensitive
    // filesystems like macOS). Other canonical filenames such as Gemfile or
    // Cargo.lock are emitted by their tooling with a fixed case; keeping
    // those case-sensitive lets typos surface rather than silently match.
    // The dot anchor on `dockerfile.` is required so we don't false-positive
    // on names like DockerfileBackup or DockerfileNotes.txt.
    const lowerBasename = basename.toLowerCase();
    if (lowerBasename === 'dockerfile' || lowerBasename.startsWith('dockerfile.')) {
        return 'dockerfile';
    }
    return null;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
    return Object.keys(EXT_TO_LANG);
}

/**
 * Check if a file can be parsed by tree-sitter.
 */
export function isSupported(filePath: string): boolean {
    return getLangForFile(filePath) !== null;
}
