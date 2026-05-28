// string-codec.ts — Content-type-aware text compression
//
// Two public entry points:
//   - compressString(text, budget) — auto-detects content type and compresses
//   - compressSourceStructured(text, budget, structure) — language-aware compression using tree-sitter block/anchor metadata provided by the consumer
//
// Language awareness: The `structure` parameter in compressSourceStructured is
// produced by consumers that have their own parser/structure extractor.

import { blake2bHash, NORMALIZERS } from './utils.js';
import { SageRank } from './sagerank.js';
import type { StructureBlock, ASTEdge, CompressionContext } from './types.js';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------
const _LOG_SEVERITY_RE =
  /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i;
const _TIMESTAMP_LINE_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/;

const _ERROR_KEYWORDS: ReadonlySet<string> = new Set([
  'error', 'fatal', 'critical', 'exception', 'traceback',
  'caused by', 'failed', 'killed', 'oom', 'panic', 'crash', 'abort',
]);
const _FRAME_RE = /^\s+(at\s+|File\s+")/;

// Stack-trace header detection: language-agnostic structural signal.
// and class names ending in Error/Exception/Fault/Panic at line start.
const _STACK_HEADER_RE = /^(?:Traceback \(most recent call last\):|Caused by:\s|[\w.$]+(?:Error|Exception|Fault|Panic)(?::|$))/;

// ---------------------------------------------------------------------------
// Source code detection patterns
// ---------------------------------------------------------------------------

const _ENTRY_POINT_NAMES: ReadonlySet<string> = new Set([
  '__init__', '__call__', '__enter__', '__exit__',
  '__aenter__', '__aexit__', '__str__', '__repr__',
  '__len__', '__iter__', '__next__', '__getitem__', '__setitem__', '__contains__',
  'main', 'run', 'start', 'stop', 'close', 'open', 'setup', 'teardown', 'reset',
  'compress', 'decompress', 'encode', 'decode',
  'search', 'query', 'find', 'get', 'fetch',
  'build', 'build_index', 'index', 'add', 'remove', 'update', 'delete',
  'handle', 'on_call_tool', 'execute', 'process', 'dispatch', 'call', 'invoke',
  'create', 'insert', 'save', 'load', 'read', 'write',
  'connect', 'disconnect', 'send', 'receive', 'listen',
  'validate', 'parse', 'serialize', 'deserialize', 'from_dict', 'to_dict',
  'feed', 'transform', 'apply', 'fit', 'predict',
  'register', 'unregister', 'subscribe', 'unsubscribe',
  'allocate', 'score', 'rank', 'deduplicate',
]);

const _DUNDER_KEEPERS: ReadonlySet<string> = new Set([
  '__init__', '__call__', '__enter__', '__exit__', '__aenter__', '__aexit__',
  '__str__', '__repr__', '__len__', '__iter__', '__next__',
  '__getitem__', '__setitem__', '__contains__',
]);

const _DEF_RE = /^(?:(?:async\s+)?def\s+(\w+)|class\s+(\w+)|(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)|(?:export\s+)?(?:interface|type|enum)\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/;
const _SOURCE_IMPORT_RE = /^\s*(?:from\s+\S|\bimport\s|\brequire\(|export\s*\{)/;
const _DECORATOR_RE = /^\s*@\w+/;
const _DOC_TAG_RE = /^\s*(?:\*\s*)?@(?:param|returns?|type|template|typedef|property|throws?)\b/;

const _MIN_OMISSION_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Content Type Detection
// ---------------------------------------------------------------------------

/**
 * Detects whether text is a multi-line stack trace (not a single-line error).
 */
function _isStackTrace(text: string): boolean {
  const sample = text.slice(0, 2000);
  const lines = sample.split('\n').slice(0, 80);

  let headerCount = 0;
  let frameCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (_STACK_HEADER_RE.test(line)) headerCount += 1;
    if (_FRAME_RE.test(rawLine)) frameCount += 1;
  }

  // Primary: frames-with-or-without-header (Python tracebacks, JS stack traces).
  if (frameCount >= 2) return true;
  if (headerCount >= 1 && frameCount >= 1) return true;

  // Tertiary: chained-exception header pattern (JVM "Caused by:" chains can appear with no leading indent on the per-frame "at" lines, in which case _FRAME_RE won't match. Multiple headers in a small window strongly imply a chained exception even without parseable frames.
  if (headerCount >= 2) return true;

  return false;
}

function _isJsonString(text: string): boolean {
  const stripped = text.trim();
  return (stripped.startsWith('{') || stripped.startsWith('[')) && stripped.length > 2;
}

function _isLogOutput(text: string): boolean {
  const lines = text.split('\n', 21).slice(0, 21);
  let tsCount = 0;
  let sevCount = 0;
  for (const line of lines) {
    if (_TIMESTAMP_LINE_RE.test(line)) tsCount++;
    if (_LOG_SEVERITY_RE.test(line)) sevCount++;
  }
  return tsCount >= 3 || sevCount >= 3;
}

function _isSourceCode(text: string): boolean {
  let score = 0;
  const lines = text.split('\n', 51).slice(0, 51);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (s.startsWith('import ') || s.startsWith('from ')) {
      score += 2;
    } else if (_DEF_RE.test(s)) {
      score += 3;
    } else if (s.startsWith('export ') || s.startsWith('require(')) {
      score += 2;
    } else if (s.startsWith('const ') || s.startsWith('let ') || s.startsWith('var ')) {
      score += 1;
    } else if (s.startsWith('"""') || s.startsWith("'''")) {
      score += 1;
    }
  }
  return score >= 5;
}

function _isCommentOnlyLine(line: string): boolean {
  const stripped = line.trim();
  return (
    !stripped ||
    stripped.startsWith('/*') ||
    stripped.startsWith('/**') ||
    stripped.startsWith('*/') ||
    stripped.startsWith('*') ||
    stripped.startsWith('//') ||
    stripped.startsWith('#')
  );
}

// ---------------------------------------------------------------------------
// Stack Trace Compression (SageRank-enhanced)
// ---------------------------------------------------------------------------

// Minimum frames to trigger SageRank — below this, simple priority scoring is fine
const _SAGERANK_FRAME_THRESHOLD = 5;

function _compressStackTrace(text: string, budget: number, maxUserFrames: number): string {
  const lines = text.split('\n');
  
  // Phase 1: Classify lines into categories
  const headers: Array<[number, string]> = [];  // Always keep — exception headers
  const frames: Array<[number, string]> = [];   // Stack frames — run SageRank on these
  const other: Array<[number, string]> = [];    // Context lines — lowest priority

  for (const [i, line] of lines.entries()) {
    const stripped = line.trim();
    if (!stripped) continue;

    const lower = stripped.toLowerCase();

    // Exception headers: always keep
    if (lower.includes('exception') || lower.includes('error:') || lower.includes('caused by:') || _STACK_HEADER_RE.test(stripped)) {
      headers.push([i, line]);
      continue;
    }

    // Stack frames: these go through SageRank
    if (_FRAME_RE.test(line)) {
      frames.push([i, line]);
      continue;
    }

    // Everything else: context
    other.push([i, line]);
  }

  // Phase 2: Calculate header cost (headers always included)
  let headerCost = 0;
  for (const [, line] of headers) {
    headerCost += line.length + 1;
  }
  const frameBudget = Math.max(0, budget - headerCost);

  // Phase 3: Select frames using SageRank if we have enough
  let selectedFrameIndices: number[];
  
  if (frames.length <= _SAGERANK_FRAME_THRESHOLD) {
    // Few frames: keep all that fit
    selectedFrameIndices = [];
    let used = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const lineLen = frames[fi]![1].length + 1;
      if (used + lineLen <= frameBudget) {
        selectedFrameIndices.push(fi);
        used += lineLen;
      }
    }
  } else {
    // Enough frames to benefit from SageRank
    const sagerank = new SageRank(
      1.5,    // k1 (BM25)
      0.75,   // b (BM25)
      0.85,   // damping (PageRank)
      50,     // maxIter
      1e-6,   // epsilon
      0.6,    // coverageWeight — higher = prefer diverse frames
      5,      // minSentenceLength — frames are short, lower threshold
      true,   // normalize
    );
    
    const frameTexts = frames.map(([, line]) => line);
    
    // Calculate how many frames we can fit
    const avgFrameLen = frameTexts.reduce((sum, f) => sum + f.length, 0) / frameTexts.length;
    const estimatedTopK = Math.min(
      maxUserFrames * 2,  // Allow some library frames too
      Math.max(3, Math.floor(frameBudget / (avgFrameLen + 1))),
      frames.length
    );
    
    const result = sagerank.rankSentences(frameTexts, estimatedTopK, null);
    
    // result.selectedIndices are the most central frames
    // Verify they fit in budget
    selectedFrameIndices = [];
    let used = 0;
    
    // First pass: add SageRank-selected frames
    for (const fi of result.selectedIndices) {
      const lineLen = frames[fi]![1].length + 1;
      if (used + lineLen <= frameBudget) {
        selectedFrameIndices.push(fi);
        used += lineLen;
      }
    }
    
    // Second pass: if budget remains, fill with highest-scored non-selected
    if (used < frameBudget) {
      const scores = result.scores;
      const selectedSet = new Set(selectedFrameIndices);
      const remaining = frames
        .map((_, i) => i)
        .filter(i => !selectedSet.has(i))
        .sort((a, b) => scores[b]! - scores[a]!);
      
      for (const fi of remaining) {
        const lineLen = frames[fi]![1].length + 1;
        if (used + lineLen <= frameBudget) {
          selectedFrameIndices.push(fi);
          used += lineLen;
        }
      }
    }
  }

  // Phase 4: Build final selection (headers + selected frames, in original order)
  const selected: Array<[number, string]> = [...headers];
  for (const fi of selectedFrameIndices) {
    selected.push(frames[fi]!);
  }
  selected.sort((a, b) => a[0] - b[0]);

  if (selected.length === 0 && lines.length > 0) {
    return `[TRUNCATED: lines 1-${lines.length}]`;
  }

  const keptIndices = selected.map(([idx]) => idx);

  // Phase 5: Fill tiny gaps (< _MIN_OMISSION_THRESHOLD) to avoid excessive markers
  const tinyGapLines = new Set<number>();
  for (let i = 1; i < keptIndices.length; i++) {
    const prev = keptIndices[i - 1]!;
    const curr = keptIndices[i]!;
    const gap = curr - prev - 1;
    if (gap > 0 && gap < _MIN_OMISSION_THRESHOLD) {
      for (let g = prev + 1; g < curr; g++) tinyGapLines.add(g);
    }
  }

  // Add tiny gap lines to selected (within budget)
  let usedAfterGaps = selected.reduce((sum, [, line]) => sum + line.length + 1, 0);
  for (const idx of [...tinyGapLines].sort((a, b) => a - b)) {
    const lineLen = lines[idx]!.length + 1;
    if (usedAfterGaps + lineLen <= budget) {
      selected.push([idx, lines[idx]!]);
      usedAfterGaps += lineLen;
    }
  }
  selected.sort((a, b) => a[0] - b[0]);
  const finalKeptIndices = selected.map(([idx]) => idx);

  // Phase 6: Build result with markers only for gaps >= threshold
  const resultParts: string[] = [];

  // Check for leading gap
  if (finalKeptIndices[0]! >= _MIN_OMISSION_THRESHOLD) {
    resultParts.push(`[TRUNCATED: lines 1-${finalKeptIndices[0]!}]`);
  }

  for (let i = 0; i < selected.length; i++) {
    resultParts.push(selected[i]![1]);

    if (i < selected.length - 1) {
      const currentIdx = finalKeptIndices[i]!;
      const nextIdx = finalKeptIndices[i + 1]!;
      const gap = nextIdx - currentIdx - 1;
      if (gap >= _MIN_OMISSION_THRESHOLD) {
        resultParts.push(`[TRUNCATED: lines ${currentIdx + 2}-${nextIdx}]`);
      }
    }
  }

  // Check for trailing gap
  const lastKept = finalKeptIndices[finalKeptIndices.length - 1]!;
  const trailingGap = lines.length - 1 - lastKept;
  if (trailingGap >= _MIN_OMISSION_THRESHOLD) {
    resultParts.push(`[TRUNCATED: lines ${lastKept + 2}-${lines.length}]`);
  }

  return resultParts.join('\n');
}

// ---------------------------------------------------------------------------
// JSON Compression
// ---------------------------------------------------------------------------

function _compressJson(obj: unknown, budget: number, depth: number): string {
  if (budget <= 0) {
    const typeName = obj === null ? 'NoneType' : Array.isArray(obj) ? 'list' : typeof obj === 'object' ? 'dict' : typeof obj;
    return `"...(${typeName} at depth ${depth})"`;
  }

  const depthBudget = depth > 0 ? Math.floor(budget * Math.pow(0.5, depth)) : budget;

  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const dict = obj as Record<string, unknown>;
    if (depth >= 3) {
      return JSON.stringify({
        '__keys': Object.keys(dict).sort(),
        '__depth': depth,
        '__omitted': Object.keys(dict).length,
      });
    }

    const resultParts: string[] = [];
    let remaining = depthBudget;

    const important = new Set([
      'error', 'message', 'status', 'code', 'type',
      'id', 'name', 'result', 'output',
    ]);

    const sortedKeys = Object.keys(dict).sort((a, b) => {
      const aScore = important.has(a.toLowerCase()) ? 0 : 1;
      const bScore = important.has(b.toLowerCase()) ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    for (const key of sortedKeys) {
      if (remaining <= 20) {
        resultParts.push(`  "...": "(${Object.keys(dict).length - resultParts.length} more keys)"`);
        break;
      }
      const val = dict[key];
      // Skip nulls and empty collections when budget is tight
      if (remaining < depthBudget * 0.5) {
        if (val === null || val === undefined) continue;
        if (Array.isArray(val) && val.length === 0) continue;
        if (typeof val === 'object' && val !== null && !Array.isArray(val) && Object.keys(val).length === 0) continue;
      }
      const valStr = _compressJson(val, Math.floor(remaining / 2), depth + 1);
      const entry = `  ${JSON.stringify(key)}: ${valStr}`;
      resultParts.push(entry);
      remaining -= entry.length;
    }

    return '{\n' + resultParts.join(',\n') + '\n}';

  } else if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';

    if (obj.length <= 5) {
      const items = obj.map((item) =>
        _compressJson(item, Math.floor(depthBudget / Math.max(1, obj.length)), depth + 1)
      );
      return '[' + items.join(', ') + ']';
    } else {
      // Check homogeneity across first 5 items
      const types = new Set(obj.slice(0, 5).map((item) => {
        if (item === null) return 'NoneType';
        if (Array.isArray(item)) return 'list';
        return typeof item === 'object' ? 'dict' : typeof item;
      }));

      if (types.size === 1) {
        const head = _compressJson(obj[0], Math.floor(depthBudget / 3), depth + 1);
        return `[${head}, "... (${obj.length - 1} more similar items)"]`;
      } else {
        const head = obj.slice(0, 3).map((item) =>
          _compressJson(item, Math.floor(depthBudget / 8), depth + 1)
        );
        const tail = obj.slice(-2).map((item) =>
          _compressJson(item, Math.floor(depthBudget / 8), depth + 1)
        );
        const mid = `"... (${obj.length - 5} more items)"`;
        return '[' + head.join(', ') + ', ' + mid + ', ' + tail.join(', ') + ']';
      }
    }

  } else {
    let s: string;
    if (obj === null || obj === undefined) {
      s = 'null';
    } else if (typeof obj === 'boolean') {
      s = obj ? 'true' : 'false';
    } else if (typeof obj === 'number') {
      s = JSON.stringify(obj);
    } else if (typeof obj === 'string') {
      s = JSON.stringify(obj);
    } else {
      // default=str fallback
      s = JSON.stringify(String(obj));
    }
    if (s.length > depthBudget) {
      const objStr = String(obj === null || obj === undefined ? 'None' : obj);
      return JSON.stringify(objStr.slice(0, depthBudget - 10) + '...');
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Log Compression (SageRank-enhanced)
// ---------------------------------------------------------------------------

// Minimum unique lines to trigger SageRank for logs
const _SAGERANK_LOG_THRESHOLD = 8;

function _compressLog(text: string, budget: number): string {
  const lines = text.split('\n');

  // Phase 1: Normalize and deduplicate
  interface LogEntry {
    originalIdx: number;
    line: string;
    normHash: string;
    isError: boolean;
    isWarning: boolean;
  }

  const seenNormalized = new Map<string, LogEntry[]>();
  const allEntries: LogEntry[] = [];

  for (const [i, line] of lines.entries()) {
    const stripped = line.trim();
    if (!stripped) continue;

    // Normalize for dedup
    let normalized = stripped;
    for (const [reFn, token] of NORMALIZERS) {
      normalized = normalized.replace(reFn(), token);
    }
    const normHash = blake2bHash(normalized);

    const lower = stripped.toLowerCase();
    const isError = [..._ERROR_KEYWORDS].some((kw) => lower.includes(kw));
    const isWarning = _LOG_SEVERITY_RE.test(stripped) &&
      ['warn', 'timeout', 'retry', 'refused', 'denied'].some((kw) => lower.includes(kw));

    const entry: LogEntry = { originalIdx: i, line, normHash, isError, isWarning };
    allEntries.push(entry);

    if (!seenNormalized.has(normHash)) {
      seenNormalized.set(normHash, []);
    }
    seenNormalized.get(normHash)!.push(entry);
  }

  // Phase 2: Get unique log patterns (first occurrence of each normalized hash)
  const uniquePatterns: Array<{ normHash: string; firstEntry: LogEntry; count: number }> = [];
  for (const [normHash, entries] of seenNormalized.entries()) {
    uniquePatterns.push({
      normHash,
      firstEntry: entries[0]!,
      count: entries.length,
    });
  }

  if (uniquePatterns.length === 0) {
    return lines.length > 0 ? `[TRUNCATED: lines 1-${lines.length}]` : '';
  }

  // Phase 3: Rank unique patterns
  let rankedIndices: number[];

  if (uniquePatterns.length <= _SAGERANK_LOG_THRESHOLD) {
    // Few unique patterns: prioritize by error > warning > other, then by position
    rankedIndices = uniquePatterns
      .map((p, i) => ({ idx: i, ...p }))
      .sort((a, b) => {
        // Errors first
        if (a.firstEntry.isError !== b.firstEntry.isError) {
          return a.firstEntry.isError ? -1 : 1;
        }
        // Then warnings
        if (a.firstEntry.isWarning !== b.firstEntry.isWarning) {
          return a.firstEntry.isWarning ? -1 : 1;
        }
        // Then by original position
        return a.firstEntry.originalIdx - b.firstEntry.originalIdx;
      })
      .map((p) => p.idx);
  } else {
    // Enough patterns: use SageRank with error/warning boost
    const sagerank = new SageRank(
      1.5,    // k1 (BM25)
      0.75,   // b (BM25)
      0.85,   // damping (PageRank)
      50,     // maxIter
      1e-6,   // epsilon
      0.5,    // coverageWeight — balanced for logs
      10,     // minSentenceLength
      true,   // normalize
    );

    const patternTexts = uniquePatterns.map((p) => p.firstEntry.line);
    const avgPatternLen = patternTexts.reduce((sum, t) => sum + t.length, 0) / patternTexts.length;
    const estimatedTopK = Math.max(5, Math.floor(budget / (avgPatternLen + 1)));

    const result = sagerank.rankSentences(patternTexts, Math.min(estimatedTopK, uniquePatterns.length), null);

    // Combine SageRank scores with error/warning priority boost
    const boostedScores = result.scores.map((score, i) => {
      const pattern = uniquePatterns[i]!;
      let boost = 1.0;
      if (pattern.firstEntry.isError) boost = 3.0;  // Error lines get 3x boost
      else if (pattern.firstEntry.isWarning) boost = 1.5;  // Warnings get 1.5x
      // Repetition bonus: highly repeated patterns are important signals
      boost *= Math.log2(1 + pattern.count);
      return { idx: i, score: score * boost };
    });

    // Sort by boosted score
    rankedIndices = boostedScores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.idx);
  }

  // Phase 4: Select patterns within budget
  const selectedPatterns: Array<{ normHash: string; firstEntry: LogEntry; count: number }> = [];
  let used = 0;

  for (const idx of rankedIndices) {
    const pattern = uniquePatterns[idx]!;
    const lineCost = pattern.firstEntry.line.length + 1;
    const repeatMarkerCost = pattern.count > 1 ? `  [repeated ${pattern.count} times]`.length : 0;

    if (used + lineCost + repeatMarkerCost > budget) continue;
    selectedPatterns.push(pattern);
    used += lineCost + repeatMarkerCost;
  }

  // Phase 5: For patterns with multiple occurrences, also try to include last occurrence
  const finalEntries: LogEntry[] = [];
  const includedIndices = new Set<number>();

  for (const pattern of selectedPatterns) {
    const entries = seenNormalized.get(pattern.normHash)!;
    // Always include first
    finalEntries.push(entries[0]!);
    includedIndices.add(entries[0]!.originalIdx);

    // Include last if different and budget allows
    if (entries.length > 1) {
      const lastEntry = entries[entries.length - 1]!;
      const lastCost = lastEntry.line.length + 1;
      if (used + lastCost <= budget && !includedIndices.has(lastEntry.originalIdx)) {
        finalEntries.push(lastEntry);
        includedIndices.add(lastEntry.originalIdx);
        used += lastCost;
      }
    }
  }

  // Phase 6: Sort by original position and build output
  finalEntries.sort((a, b) => a.originalIdx - b.originalIdx);

  const outputParts: string[] = [];
  const patternCounts = new Map<string, number>();
  for (const pattern of selectedPatterns) {
    if (pattern.count > 1) {
      patternCounts.set(pattern.normHash, pattern.count);
    }
  }

  for (const entry of finalEntries) {
    const count = patternCounts.get(entry.normHash);
    if (count !== undefined) {
      outputParts.push(`${entry.line}  [repeated ${count} times]`);
      patternCounts.delete(entry.normHash); // Only annotate once
    } else {
      outputParts.push(entry.line);
    }
  }

  // Phase 7: Add truncation marker if needed
  let result = outputParts.join('\n');
  const keptIndices = [...includedIndices].sort((a, b) => a - b);

  if (keptIndices.length > 0 && keptIndices.length < lines.filter(l => l.trim()).length) {
    const lastKept = keptIndices[keptIndices.length - 1]!;
    if (lastKept < lines.length - 1) {
      result += `\n[TRUNCATED: lines ${lastKept + 2}-${lines.length}]`;
    }
  } else if (keptIndices.length === 0 && lines.length > 0) {
    result = `[TRUNCATED: lines 1-${lines.length}]`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Source Code Compression (unstructured path, SageRank-enhanced)
// ---------------------------------------------------------------------------

// Minimum anchor groups to trigger SageRank for source code
const _SAGERANK_SOURCE_THRESHOLD = 4;

function _compressSourceCode(text: string, budget: number): string {
  const lines = text.split('\n');
  const n = lines.length;

  // Find and cap module-level docstring.
  // Walk past leading blank lines by inspecting each entry safely.
  let i = 0;
  while (i < n) {
    const candidate = lines[i];
    if (candidate === undefined || candidate.trim()) break;
    i++;
  }

  const modDocIndices: number[] = [];
  const MOD_DOC_CAP = 5;
  if (i < n) {
    const docStart = lines[i];
    if (docStart !== undefined) {
      const s = docStart.trim();
      if (s.startsWith('"""') || s.startsWith("'''")) {
        const marker = s.slice(0, 3);
        modDocIndices.push(i);
        const countMarker = s.split(marker).length - 1;
        if (!(countMarker >= 2 && s.length > 3)) {
          let j = i + 1;
          while (j < n) {
            const nextLine = lines[j];
            if (nextLine === undefined) break;
            modDocIndices.push(j);
            if (nextLine.trim().endsWith(marker) && j > i) break;
            j++;
          }
        }
      }
    }
  }

  const modDocSet = new Set(modDocIndices);
  const modDocKeep = modDocIndices.slice(0, MOD_DOC_CAP);
  const modDocOmitted = modDocIndices.length - modDocKeep.length;

  // Parse lines into anchor groups
  const alwaysLines: number[] = [];
  interface AnchorGroup {
    sigLine: number;
    decoratorLines: number[];
    name: string;
    basePriority: number;  // Renamed: base priority from heuristics
    bodyLines: number[];
    fullText: string;      // For SageRank similarity
  }
  const anchorGroups: AnchorGroup[] = [];
  let pendingDecorators: number[] = [];
  let currentGroup: AnchorGroup | null = null;

  for (const [idx, line] of lines.entries()) {
    if (modDocSet.has(idx)) continue;
    const stripped = line.trim();

    if (!stripped) {
      if (currentGroup !== null) {
        currentGroup.bodyLines.push(idx);
      }
      continue;
    }

    if (_SOURCE_IMPORT_RE.test(line)) {
      alwaysLines.push(idx);
      currentGroup = null;
      pendingDecorators = [];
      continue;
    }

    if (_DECORATOR_RE.test(line)) {
      pendingDecorators.push(idx);
      continue;
    }

    const m = _DEF_RE.exec(stripped);
    if (m) {
      const name = m.slice(1).find((g) => g !== undefined) ?? '';
      const indent = line.length - line.trimStart().length;
      const isDunder = _DUNDER_KEEPERS.has(name);
      const isPrivate = name.startsWith('_') && !isDunder;
      const isEntry = _ENTRY_POINT_NAMES.has(name.toLowerCase());
      const basePriority = (isEntry ? 300 : !isPrivate ? 200 : 100) - indent * 0.5;

      currentGroup = {
        sigLine: idx,
        decoratorLines: [...pendingDecorators],
        name,
        basePriority,
        bodyLines: [],
        fullText: '',  // Will be populated after parsing
      };
      anchorGroups.push(currentGroup);
      pendingDecorators = [];
      continue;
    }

    if (currentGroup !== null) {
      currentGroup.bodyLines.push(idx);
    } else {
      if (pendingDecorators.length > 0) {
        alwaysLines.push(...pendingDecorators);
        pendingDecorators = [];
      }
      alwaysLines.push(idx);
    }
  }

  // Build fullText for each anchor group (for SageRank similarity)
  for (const group of anchorGroups) {
    const groupLines: string[] = [];
    for (const dl of group.decoratorLines) {
      const line = lines[dl];
      if (line !== undefined) groupLines.push(line);
    }
    const sigLine = lines[group.sigLine];
    if (sigLine !== undefined) groupLines.push(sigLine);
    // Include first 10 body lines for context
    for (const bl of group.bodyLines.slice(0, 10)) {
      const line = lines[bl];
      if (line !== undefined) groupLines.push(line);
    }
    group.fullText = groupLines.join('\n');
  }

  // Build mandatory set
  const mandatory = new Set<number>(modDocKeep);
  for (const al of alwaysLines) mandatory.add(al);
  for (const g of anchorGroups) {
    mandatory.add(g.sigLine);
    for (const dl of g.decoratorLines) mandatory.add(dl);
    // First non-blank body line if it looks like a docstring
    for (const li of g.bodyLines) {
      const bodyLine = lines[li];
      if (bodyLine === undefined) continue;
      if (!bodyLine.trim()) continue;
      const s = bodyLine.trim();
      if (s.startsWith('"""') || s.startsWith("'''") || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) {
        mandatory.add(li);
      }
      break; // only check the very first non-blank body line
    }
  }

  const lc = (idx: number): number => {
    const line = lines[idx];
    if (line === undefined) {
      throw new Error(`invariant: lc called with out-of-range index ${idx}`);
    }
    return line.length + 1;
  };

  let mandatoryChars = 0;
  for (const mi of mandatory) mandatoryChars += lc(mi);
  if (modDocOmitted > 0) mandatoryChars += 50;
  let remaining = Math.max(0, budget - mandatoryChars);

  // Rank anchor groups using SageRank + base priority boost
  let rankedGroups: AnchorGroup[];

  if (anchorGroups.length <= _SAGERANK_SOURCE_THRESHOLD) {
    // Few groups: use base priority directly
    rankedGroups = [...anchorGroups].sort((a, b) => b.basePriority - a.basePriority);
  } else {
    // Enough groups: use SageRank for centrality ranking
    const sagerank = new SageRank(
      1.5,    // k1 (BM25)
      0.75,   // b (BM25)
      0.85,   // damping (PageRank)
      50,     // maxIter
      1e-6,   // epsilon
      0.4,    // coverageWeight — lower for source code (we want related functions)
      20,     // minSentenceLength — functions have more content
      true,   // normalize
    );

    const groupTexts = anchorGroups.map((g) => g.fullText);
    const result = sagerank.rankSentences(groupTexts, anchorGroups.length, null);

    // Combine SageRank centrality with base priority
    const combinedScores = result.scores.map((score, idx) => {
      const group = anchorGroups[idx]!;
      // Normalize base priority to 0-1 range (max is ~300)
      const normalizedPriority = group.basePriority / 300;
      // Combined score: 60% centrality, 40% priority
      const combined = 0.6 * score + 0.4 * normalizedPriority;
      return { group, score: combined };
    });

    rankedGroups = combinedScores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.group);
  }

  // Fill bodies by ranked order
  const includedBody = new Set<number>();
  const MARKER_COST = 45;

  for (const group of rankedGroups) {
    if (remaining <= 0) break;
    const body = group.bodyLines.filter((li) => !mandatory.has(li));
    if (body.length === 0) continue;

    const bodyChars = body.reduce((sum, li) => sum + lc(li), 0);
    if (bodyChars <= remaining) {
      for (const li of body) includedBody.add(li);
      remaining -= bodyChars;
    } else {
      // Fit lines from the top of the body, leave room for omission marker
      let used = 0;
      for (const li of body) {
        const cost = lc(li);
        if (used + cost + MARKER_COST > remaining) break;
        includedBody.add(li);
        used += cost;
      }
      remaining -= used;
    }
  }

  // Reconstruct in original line order
  const allIncluded = new Set<number>([...mandatory, ...includedBody]);
  const result: string[] = [];

  // Module docstring block
  for (const idx of modDocKeep) {
    const line = lines[idx];
    if (line === undefined) continue;
    result.push(line);
  }
  if (modDocOmitted > 0) {
    // modDocKeep has the kept indices, modDocIndices has all docstring indices
    const docOmitStart = modDocKeep[modDocKeep.length - 1]! + 1;
    const docOmitEnd = modDocIndices[modDocIndices.length - 1]!;
    result.push(`[TRUNCATED: lines ${docOmitStart + 1}-${docOmitEnd + 1}]`);
  }

  // Scan remaining lines in order, inserting omission markers at cut points
  let pendingBlanks: string[] = [];
  let omitStart = -1;  // Track where omission began (0-indexed)
  let omitIndent = '    ';

  for (const [idx, line] of lines.entries()) {
    if (modDocSet.has(idx)) continue;

    if (!line.trim()) {
      pendingBlanks.push(line);
      continue;
    }

    if (allIncluded.has(idx)) {
      if (omitStart >= 0) {
        // Emit marker for lines omitStart through idx-1 (1-based)
        result.push(`${omitIndent}[TRUNCATED: lines ${omitStart + 1}-${idx}]`);
        omitStart = -1;
      }
      result.push(...pendingBlanks);
      pendingBlanks = [];
      result.push(line);
      omitIndent = ' '.repeat(line.length - line.trimStart().length + 4);
    } else {
      pendingBlanks = []; // discard blanks belonging to omitted section
      if (omitStart < 0) omitStart = idx;  // Start new omission range
    }
  }

  if (omitStart >= 0) {
    result.push(`${omitIndent}[TRUNCATED: lines ${omitStart + 1}-${lines.length}]`);
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Structured Source Compression (tree-sitter metadata path)
// ---------------------------------------------------------------------------

function _stripDocBlocksBeforeBlocks(
  lines: string[],
  topLevelLines: number[],
  structure: StructureBlock[],
): number[] {
  const topLevelSet = new Set(topLevelLines);
  const remove = new Set<number>();

  for (const block of structure) {
    let scan = block.startLine - 1;
    const span: number[] = [];
    let hasDocTags = false;

    while (scan >= 0 && topLevelSet.has(scan)) {
      const scanLine = lines[scan];
      if (scanLine === undefined || !_isCommentOnlyLine(scanLine)) break;
      span.push(scan);
      if (_DOC_TAG_RE.test(scanLine)) {
        hasDocTags = true;
      }
      scan--;
    }

    if (hasDocTags) {
      for (const s of span) remove.add(s);
    }
  }

  return topLevelLines.filter((idx) => !remove.has(idx));
}

// Minimum anchor groups to trigger SageRank for structured source code
const _SAGERANK_STRUCTURED_THRESHOLD = 4;

function _compressSourceStructured(
  text: string,
  budget: number,
  structure: StructureBlock[],
  context?: CompressionContext,
): string {
  const lines = text.split('\n');
  const n = lines.length;

  if (structure.length === 0) {
    return compressString(text, budget);
  }

  if (budget >= text.length) {
    return text;
  }

  // Pre-compute export set from context for O(1) lookups
  const exportedSet = context?.exportedSymbols
    ? new Set(context.exportedSymbols)
    : null;

  // Score each block — mutate a local copy to avoid affecting caller
  const workingStructure: Array<StructureBlock & { priority: number }> = structure.map((block) => {
    const name = (block.name ?? '').trim();
    const exported = block.exported ?? false;
    let priority: number;

    if (name === '__main__' || name.startsWith('test_') || name.startsWith('Test')) {
      priority = 10;
    } else if (_ENTRY_POINT_NAMES.has(name.toLowerCase()) || _DUNDER_KEEPERS.has(name) || exported) {
      priority = 300;
    } else if (name.startsWith('_')) {
      priority = 100;
    } else if (exportedSet?.has(name)) {
      // Context-provided export signal boosts non-trivially
      priority = 280;
    } else {
      priority = 200;
    }

    return { ...block, priority };
  });

  // Identify lines that belong to at least one block
  const allBlockLines = new Set<number>();
  for (const block of workingStructure) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    for (let ln = start; ln <= end; ln++) {
      allBlockLines.add(ln);
    }
  }

  // Top-level lines (imports, constants, module-level code) → always first
  const resultLines = new Map<number, string>();
  let topLevelLines = Array.from({ length: n }, (_, i) => i).filter((i) => !allBlockLines.has(i));
  topLevelLines = _stripDocBlocksBeforeBlocks(lines, topLevelLines, workingStructure);

  const lineAt = (idx: number): string => {
    const line = lines[idx];
    if (line === undefined) {
      throw new Error(`invariant: lines[${idx}] out of range (n=${n})`);
    }
    return line;
  };

  // Fix 1: reclassify `if __name__ == '__main__':` block
  const mainStart = topLevelLines.find((i) => lineAt(i).trim().startsWith('if __name__')) ?? null;
  if (mainStart !== null) {
    const mainLines = topLevelLines.filter((i) => i >= mainStart);
    topLevelLines = topLevelLines.filter((i) => i < mainStart);
    const mainEnd = mainLines[mainLines.length - 1];
    if (mainEnd === undefined) {
      throw new Error('invariant: mainLines is non-empty (mainStart was found in topLevelLines)');
    }
    workingStructure.push({
      type: 'main_block',
      name: '__main__',
      kind: 'main_block',
      startLine: mainStart,
      endLine: mainEnd,
      exported: false,
      anchors: [],
      priority: 10,
    });
  }

  // Fix 2: Hard budget cap on top-level lines (40% of budget max)
  const topLevelCap = Math.floor(budget * 40 / 100);
  const topLevelCost = topLevelLines.reduce((sum, i) => sum + lineAt(i).length + 1, 0);
  if (topLevelCost > topLevelCap) {
    const importSet = new Set(topLevelLines.filter((i) => _SOURCE_IMPORT_RE.test(lineAt(i))));
    const importCost = [...importSet].reduce((sum, i) => sum + lineAt(i).length + 1, 0);
    let rem = topLevelCap - importCost;
    const kept: number[] = [...importSet];
    for (const i of topLevelLines) {
      if (importSet.has(i)) continue;
      const cost = lineAt(i).length + 1;
      if (rem <= 0) break;
      kept.push(i);
      rem -= cost;
    }
    topLevelLines = kept.sort((a, b) => a - b);
  }

  for (const i of topLevelLines) {
    resultLines.set(i, lineAt(i));
  }
  let used = topLevelLines.reduce((sum, i) => sum + lineAt(i).length + 1, 0);

  // Resolve edges: context-provided edges take priority, fall back to callGraph
  let finalEdges: ASTEdge[] | undefined = context?.astEdges;
  if ((!finalEdges || finalEdges.length === 0) && context?.callGraph && context.callGraph.length > 0) {
    const nameToIndex = new Map(workingStructure.map((b, idx) => [b.name, idx]));
    const edges: ASTEdge[] = [];
    for (const entry of context.callGraph) {
      const fromIdx = nameToIndex.get(entry.caller);
      const toIdx = nameToIndex.get(entry.callee);
      if (fromIdx !== undefined && toIdx !== undefined) {
        edges.push({ from: fromIdx, to: toIdx, weight: entry.weight, kind: 'call' });
      }
    }
    if (edges.length > 0) finalEdges = edges;
  }

  // Rank blocks using SageRank with AST edges (if available) or priority-only
  let sortedBlocks: Array<StructureBlock & { priority: number }>;

  if (workingStructure.length <= _SAGERANK_STRUCTURED_THRESHOLD) {
    sortedBlocks = [...workingStructure].sort((a, b) => b.priority - a.priority);
  } else {
    const blockTexts = workingStructure.map((block) => {
      const start = Math.max(0, block.startLine);
      const end = Math.min(n - 1, block.endLine);
      const blockLines: string[] = [];
      for (let ln = start; ln <= Math.min(end, start + 15); ln++) {
        const line = lines[ln];
        if (line !== undefined) blockLines.push(line);
      }
      return blockLines.join('\n');
    });

    const sagerank = new SageRank(
      1.5, 0.75, 0.85, 50, 1e-6, 0.35, 20, true
    );

    const result = finalEdges && finalEdges.length > 0
      ? sagerank.rankWithAST(blockTexts, workingStructure.length, finalEdges, null)
      : sagerank.rankSentences(blockTexts, workingStructure.length, null);

    const combinedScores = result.scores.map((score, idx) => {
      const block = workingStructure[idx]!;
      const normalizedPriority = block.priority / 300;
      const combined = 0.55 * score + 0.45 * normalizedPriority;
      return { block, score: combined };
    });

    sortedBlocks = combinedScores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.block);
  }

  const lineCost = (idx: number): number => lineAt(idx).length + 1;
  const renderedSignature = (idx: number): string => lineAt(idx) + `  # L${idx + 1}`;
  const renderedSignatureCost = (idx: number): number => renderedSignature(idx).length + 1;

  for (const block of sortedBlocks) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    if (start > end) continue;

    const newIndices = Array.from({ length: end - start + 1 }, (_, k) => start + k)
      .filter((i) => !resultLines.has(i));
    if (newIndices.length === 0) continue;

    const sigText = renderedSignature(start);
    const sigSize = renderedSignatureCost(start);
    const newSize = sigSize + newIndices.filter((i) => i !== start).reduce((sum, i) => sum + lineCost(i), 0);
    const rangeMarker = `    # ... [lines ${start + 2}-${end + 1} omitted]`;
    const rangeMarkerCost = rangeMarker.length + 1;

    if (used + newSize <= budget) {
      for (const i of newIndices) {
        resultLines.set(i, lineAt(i));
      }
      resultLines.set(start, sigText);
      used += newSize;
    } else if (!resultLines.has(start) && used + sigSize + rangeMarkerCost <= budget) {
      const bodyIndices = newIndices.filter((i) => i !== start);
      
      const MARKER_COST = 45;
      const selectedSet = new Set<number>();
      let selectedBodyCost = 0;
      const remaining = budget - used - sigSize;

      for (const idx of bodyIndices) {
        const cost = lineCost(idx);
        if (selectedBodyCost + cost + MARKER_COST > remaining) break;
        selectedSet.add(idx);
        selectedBodyCost += cost;
      }

      if (selectedSet.size > 0) {
        const omittedLines = bodyIndices.filter((idx) => !selectedSet.has(idx));
        const omittedCount = omittedLines.length;
        
        // Never truncate tiny blocks, even if it puts us slightly over budget
        if (omittedCount > 0 && omittedCount < _MIN_OMISSION_THRESHOLD) {
          for (const idx of omittedLines) {
            selectedSet.add(idx);
            selectedBodyCost += lineCost(idx);
          }
        }

        resultLines.set(start, sigText);
        for (const idx of selectedSet) {
          resultLines.set(idx, lineAt(idx));
        }
        used += sigSize + selectedBodyCost;
      } else {
        resultLines.set(start, sigText);
        const markerLine = start + 1;
        if (markerLine <= end && !resultLines.has(markerLine)) {
          // Instead of adding rangeMarker to resultLines (which causes issues in the loop),
          // we just omit the rest. The reassembly loop will naturally emit an omission marker!
        }
        used += sigSize;
      }
    }
  }

  // Reassemble in original line order with gap markers exactly like text version
  const output: string[] = [];
  let omitCount = 0;
  let omitIndent = '    ';
  let pendingBlanks: string[] = [];

  for (let idx = 0; idx < n; idx++) {
    const line = lines[idx];
    if (line === undefined) continue;

    if (!line.trim()) {
      pendingBlanks.push(line);
      continue;
    }

    if (resultLines.has(idx)) {
      if (omitCount > 0) {
        // If we skipped a small amount of lines that somehow bypassed the threshold logic
        if (omitCount < _MIN_OMISSION_THRESHOLD) {
          for (let prevIdx = idx - omitCount; prevIdx < idx; prevIdx++) {
            if (lines[prevIdx] && lines[prevIdx]!.trim()) {
              output.push(lines[prevIdx]!);
            }
          }
        } else {
          output.push(`${omitIndent}# ... [${omitCount} lines omitted]`);
        }
        omitCount = 0;
      }
      output.push(...pendingBlanks);
      pendingBlanks = [];
      output.push(resultLines.get(idx)!);
      omitIndent = ' '.repeat(line.length - line.trimStart().length + 4);
    } else {
      pendingBlanks = []; // discard blanks belonging to omitted section
      omitCount++;
    }
  }

  if (omitCount > 0) {
    if (omitCount < _MIN_OMISSION_THRESHOLD) {
      for (let prevIdx = n - omitCount; prevIdx < n; prevIdx++) {
        if (lines[prevIdx] && lines[prevIdx]!.trim()) {
          output.push(lines[prevIdx]!);
        }
      }
    } else {
      output.push(`${omitIndent}# ... [${omitCount} lines omitted]`);
    }
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// Default: Content-Aware Truncation
// ---------------------------------------------------------------------------

function _contentAwareTruncate(text: string, budget: number): string {
  // Detect if error/result info is at the tail
  const tail20pct = text.slice(Math.floor(text.length * 0.8));
  const tailHasError = [..._ERROR_KEYWORDS].some((kw) => tail20pct.toLowerCase().includes(kw));

  const head10pct = text.slice(0, Math.max(1, Math.floor(text.length * 0.1)));
  const headHasStructure = head10pct.split('\n').length - 1 < 3 && head10pct.includes(':');

  let headRatio: number;
  if (tailHasError) {
    headRatio = 0.4;
  } else if (headHasStructure) {
    headRatio = 0.8;
  } else {
    headRatio = 0.5;
  }

  // Compute line numbers for the truncation marker
  const totalLines = text.split('\n').length;
  const markerTemplate = '\n[TRUNCATED: lines X-Y]\n';
  const usable = budget - markerTemplate.length;
  if (usable <= 0) {
    return text.slice(0, budget);
  }
  const headBudget = Math.floor(usable * headRatio);
  const tailBudget = usable - headBudget;

  // Count lines in head and tail portions
  const headText = text.slice(0, headBudget);
  const tailText = text.slice(-tailBudget);
  const headLines = headText.split('\n').length;
  const tailLines = tailText.split('\n').length;
  const firstOmitted = headLines + 1;
  const lastOmitted = totalLines - tailLines;
  
  const marker = `\n[TRUNCATED: lines ${firstOmitted}-${lastOmitted}]\n`;

  return headText + marker + tailText;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function compressString(text: string, budget: number, maxUserFrames = 10): string {
  // Enforce 70% retention floor — never compress below 70% of original
  const minBudget = Math.max(1, Math.floor(text.length * 0.70));
  budget = Math.max(budget, minBudget);
  if (text.length <= budget) return text;

  if (_isSourceCode(text)) {
    return _compressSourceCode(text, budget);
  }

  if (_isStackTrace(text)) {
    return _compressStackTrace(text, budget, maxUserFrames);
  }

  if (_isJsonString(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      return _compressJson(parsed, budget, 0);
    } catch (e: unknown) {
      if (e instanceof SyntaxError || e instanceof RangeError) {
        // json.JSONDecodeError / RecursionError equivalents — fall through
      } else {
        throw e;
      }
    }
  }

  if (_isLogOutput(text)) {
    return _compressLog(text, budget);
  }

  return _contentAwareTruncate(text, budget);
}

/**
 * Compress source code using pre-parsed tree-sitter block structure.
 *
 * structure contains StructureBlock items with camelCase fields:
 *   startLine (0-based), endLine (0-based inclusive), name, type, exported, anchors
 */
export function compressSourceStructured(
  text: string,
  budget: number,
  structure: StructureBlock[],
  context?: CompressionContext,
): string {
  // Enforce 70% retention floor — never compress below 70% of original
  const minBudget = Math.max(1, Math.floor(text.length * 0.70));
  budget = Math.max(budget, minBudget);
  if (text.length <= budget) return text;
  return _compressSourceStructured(text, budget, structure, context);
}
