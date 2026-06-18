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
import type { StructureBlock, Anchor, ASTEdge, CompressionContext, RawFileFacts, CompressFileRequest } from './types.js';

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

const _MIN_OMISSION_THRESHOLD = 6;

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

  // Phase 2: Calculate header cost (headers always included).
  // Cost includes the `N. ` prefix width emitted per shown line.
  let headerCost = 0;
  for (const [hi, line] of headers) {
    headerCost += line.length + (String(hi + 1).length + 2) + 1;
  }
  const frameBudget = Math.max(0, budget - headerCost);

  // Phase 3: Select frames using SageRank if we have enough
  let selectedFrameIndices: number[];
  
  if (frames.length <= _SAGERANK_FRAME_THRESHOLD) {
    // Few frames: keep all that fit
    selectedFrameIndices = [];
    let used = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const lineLen = frames[fi]![1].length + (String(frames[fi]![0] + 1).length + 2) + 1;
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
      const lineLen = frames[fi]![1].length + (String(frames[fi]![0] + 1).length + 2) + 1;
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
        const lineLen = frames[fi]![1].length + (String(frames[fi]![0] + 1).length + 2) + 1;
        if (used + lineLen <= frameBudget) {
          selectedFrameIndices.push(fi);
          used += lineLen;
        }
      }
    }
  }

  // Phase 4: Build final selection (headers + selected frames, in original order)
  let selected: Array<[number, string]> = [...headers];
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

  // Add tiny gap lines to selected (within budget). Prefix width charged.
  let usedAfterGaps = selected.reduce((sum, [idx, line]) => sum + line.length + (String(idx + 1).length + 2) + 1, 0);
  for (const idx of [...tinyGapLines].sort((a, b) => a - b)) {
    const lineLen = lines[idx]!.length + (String(idx + 1).length + 2) + 1;
    if (usedAfterGaps + lineLen <= budget) {
      selected.push([idx, lines[idx]!]);
      usedAfterGaps += lineLen;
    }
  }

  // Backfill non-selected non-blank lines (skipped frames + context "other")
  // toward the retention floor. Headers+early-selected frames can leave real
  // budget unused while many candidates were dropped wholesale — measured:
  // JVM chained-exception case emitted at ~59% (no "other" lines, but the
  // greedy frameBudget cap skipped tail frames); Python tracebacks left every
  // context line untouched. The single crossing line is permitted while the
  // result stays within the 0.75 ceiling. NOTE (deviation from plan literal):
  // the plan snippet iterated `other` only — extended here to ALL unselected
  // non-blank lines (frames + other in line order) because the failing test
  // (JVM) has zero `other` lines, and the same "budget unused while
  // candidates were dropped" reasoning applies symmetrically to skipped
  // frames. Without this, JVM stays at 196/333 = 0.589 < 0.65 floor.
  const retentionCeiling = Math.floor(text.length * 0.75);
  const selectedIdxSet = new Set(selected.map(([idx]) => idx));
  const backfillCandidates: Array<[number, string]> = [...frames, ...other].sort((a, b) => a[0] - b[0]);
  for (const [oi, oline] of backfillCandidates) {
    if (selectedIdxSet.has(oi)) continue;
    const lineLen = oline.length + (String(oi + 1).length + 2) + 1;
    if (usedAfterGaps + lineLen <= budget ||
        (usedAfterGaps < budget && usedAfterGaps + lineLen <= retentionCeiling)) {
      selected.push([oi, oline]);
      selectedIdxSet.add(oi);
      usedAfterGaps += lineLen;
    }
  }

  // Header-preserving tiling rework. Per the wave-gate ruling, the swap/closing
  // passes must NEVER trade away header lines (the "always keep" classification
  // from Phase 1 — the single most valuable line of a stack trace, e.g.
  // `TypeError:` or `Traceback`). The prior edge-swap dropped lines without
  // header awareness; here we precompute the header index set and reject any
  // drop that would remove a header. Tail-side trades are preferred over
  // leading trades (see swap pass below).
  const headerIdxSet = new Set<number>(headers.map(([i]) => i));
  // Closing pass: enforce Priority-0 tiling on the remaining selection. For
  // every residual sub-threshold INTERNAL gap (0 < gap < _MIN_OMISSION_THRESHOLD,
  // between two consecutive selected indices), either:
  //   (a) show the gap lines if total stays within retentionCeiling, or
  //   (b) drop the SHORTER adjacent kept-run (by character cost) so the gap
  //       merges into a markable (>= threshold) omission.
  // Iterates until no sub-threshold internal gap remains.
  //
  // Guard: dropping is gated on retentionFloor — if dropping would push
  // total retention below 0.65 of the original input, the fixture genuinely
  // cannot satisfy both the band and the tiling rule under its budget (the
  // documented STOP condition). Leave the violation rather than break the
  // band; record-keepers note this conflict explicitly in the proof.
  // Also gated on header preservation: any candidate drop that contains a
  // header index is rejected outright. If both adjacent runs include a header,
  // (b) abstains and the gap stays for the swap pass to consider.
  // Leading/trailing sub-threshold gaps are NOT enforced here: Priority-0's
  // "every gap between consecutive selected indices" rule does not cover
  // gaps outside the selected range.
  const retentionFloor = Math.floor(text.length * 0.65);
  selected.sort((a, b) => a[0] - b[0]);
  let tilingChanged = true;
  let tilingIters = 0;
  while (tilingChanged && tilingIters++ < 100) {
    tilingChanged = false;
    const idxs = selected.map(([i]) => i);
    for (let gi = 0; gi < idxs.length - 1; gi++) {
      const prev = idxs[gi]!;
      const next = idxs[gi + 1]!;
      const gap = next - prev - 1;
      if (gap <= 0 || gap >= _MIN_OMISSION_THRESHOLD) continue;
      // Sub-threshold internal gap. Try (a): fit gap lines within ceiling.
      let gapCost = 0;
      for (let g = prev + 1; g < next; g++) {
        gapCost += lines[g]!.length + (String(g + 1).length + 2) + 1;
      }
      if (usedAfterGaps + gapCost <= retentionCeiling) {
        for (let g = prev + 1; g < next; g++) {
          selected.push([g, lines[g]!]);
          selectedIdxSet.add(g);
        }
        usedAfterGaps += gapCost;
        selected.sort((a, b) => a[0] - b[0]);
        tilingChanged = true;
        break;
      }
      // (b) Drop shorter adjacent kept-run (by character cost).
      // Find run boundaries in idxs around gi/gi+1 (consecutive indices form a run).
      let prevRunStart = gi;
      while (prevRunStart > 0 && idxs[prevRunStart - 1]! === idxs[prevRunStart]! - 1) prevRunStart--;
      let nextRunEnd = gi + 1;
      while (nextRunEnd < idxs.length - 1 && idxs[nextRunEnd + 1]! === idxs[nextRunEnd]! + 1) nextRunEnd++;
      // Header check: a run that includes any header index is OFF-LIMITS for
      // dropping. Identify which side(s) are droppable.
      let prevHasHeader = false;
      for (let k = prevRunStart; k <= gi; k++) {
        if (headerIdxSet.has(idxs[k]!)) { prevHasHeader = true; break; }
      }
      let nextHasHeader = false;
      for (let k = gi + 1; k <= nextRunEnd; k++) {
        if (headerIdxSet.has(idxs[k]!)) { nextHasHeader = true; break; }
      }
      if (prevHasHeader && nextHasHeader) continue; // neither side droppable
      let prevRunCost = 0;
      for (let k = prevRunStart; k <= gi; k++) {
        const li = idxs[k]!;
        prevRunCost += lines[li]!.length + (String(li + 1).length + 2) + 1;
      }
      let nextRunCost = 0;
      for (let k = gi + 1; k <= nextRunEnd; k++) {
        const li = idxs[k]!;
        nextRunCost += lines[li]!.length + (String(li + 1).length + 2) + 1;
      }
      // Choose which side to drop: must be header-free; among header-free
      // candidates pick the cheaper (smaller cost = less retention loss).
      let dropPrev: boolean;
      if (prevHasHeader) dropPrev = false;
      else if (nextHasHeader) dropPrev = true;
      else dropPrev = prevRunCost <= nextRunCost;
      const dropCost = dropPrev ? prevRunCost : nextRunCost;
      // Guard: don't drop if doing so would push retention below the 0.65
      // floor — that's the STOP condition the plan describes for genuinely
      // unsolvable fixtures (e.g. 9-line traces of 70+ char frames where no
      // selection can satisfy both the band and the tiling rule under the
      // budget). Accept the Priority-0 violation in this fixture rather than
      // bend the retention band.
      if (usedAfterGaps - dropCost < retentionFloor) continue;
      const dropStart = dropPrev ? prevRunStart : gi + 1;
      const dropEnd = dropPrev ? gi : nextRunEnd;
      const dropSet = new Set<number>();
      for (let k = dropStart; k <= dropEnd; k++) dropSet.add(idxs[k]!);
      selected = selected.filter(([i]) => !dropSet.has(i));
      for (const di of dropSet) selectedIdxSet.delete(di);
      usedAfterGaps -= dropCost;
      tilingChanged = true;
      break;
    }
  }
  selected.sort((a, b) => a[0] - b[0]);

  // Edge-trim + gap-fill swap pass: handles fixtures where the closing pass
  // was blocked by the retention-floor guard but a contiguous middle-section
  // selection would satisfy all constraints. For each remaining sub-threshold
  // internal gap, attempt to swap an OUTERMOST non-header kept-edge line
  // (walked inward past any header — header lines are NEVER traded per the
  // wave-gate ruling) for the gap content. Tail-side trades are preferred;
  // leading swaps are only attempted if no trailing swap suffices.
  let swapChanged = true;
  let swapIters = 0;
  while (swapChanged && swapIters++ < 100) {
    swapChanged = false;
    const idxs = selected.map(([i]) => i);
    if (idxs.length < 2) break;
    for (let gi = 0; gi < idxs.length - 1; gi++) {
      const prev = idxs[gi]!;
      const next = idxs[gi + 1]!;
      const gap = next - prev - 1;
      if (gap <= 0 || gap >= _MIN_OMISSION_THRESHOLD) continue;
      // Sub-threshold internal gap remains. Compute gap-fill cost.
      let gapCost = 0;
      for (let g = prev + 1; g < next; g++) {
        gapCost += lines[g]!.length + (String(g + 1).length + 2) + 1;
      }
      // We need (ceiling - usedAfterGaps + edgeDrops) >= gapCost.
      const needToFree = Math.max(0, usedAfterGaps + gapCost - retentionCeiling);
      if (needToFree === 0) {
        // No edge drop needed; the closing pass should have fit it already.
        continue;
      }
      // Walk inward from each side past any header to find the OUTERMOST
      // non-header kept line as the swap candidate. firstPos/lastPos are
      // positions into idxs; firstIdx/lastIdx are the underlying line indices.
      let firstPos = 0;
      while (firstPos < idxs.length && headerIdxSet.has(idxs[firstPos]!)) firstPos++;
      let lastPos = idxs.length - 1;
      while (lastPos >= 0 && headerIdxSet.has(idxs[lastPos]!)) lastPos--;
      // Also: the candidate must not be on the gap boundary (would be a no-op
      // swap that re-creates the same gap). And both candidates must be > the
      // gap boundary so we're truly dropping at an edge of the kept selection.
      const firstIdx = firstPos < idxs.length ? idxs[firstPos]! : -1;
      const lastIdx = lastPos >= 0 ? idxs[lastPos]! : -1;
      const firstCost = firstIdx >= 0
        ? lines[firstIdx]!.length + (String(firstIdx + 1).length + 2) + 1 : 0;
      const lastCost = lastIdx >= 0
        ? lines[lastIdx]!.length + (String(lastIdx + 1).length + 2) + 1 : 0;
      const tryDropLeading =
        firstIdx >= 0 && firstIdx !== prev && firstIdx !== next &&
        firstIdx < prev &&  // must be on the leading side of the gap
        usedAfterGaps - firstCost + gapCost <= retentionCeiling &&
        usedAfterGaps - firstCost + gapCost >= retentionFloor;
      const tryDropTrailing =
        lastIdx >= 0 && lastIdx !== prev && lastIdx !== next &&
        lastIdx > next &&  // must be on the trailing side of the gap
        usedAfterGaps - lastCost + gapCost <= retentionCeiling &&
        usedAfterGaps - lastCost + gapCost >= retentionFloor;
      const tryDropBoth =
        firstIdx >= 0 && lastIdx >= 0 &&
        firstIdx !== prev && firstIdx !== next &&
        lastIdx !== prev && lastIdx !== next &&
        firstIdx !== lastIdx && firstIdx < prev && lastIdx > next &&
        usedAfterGaps - firstCost - lastCost + gapCost <= retentionCeiling &&
        usedAfterGaps - firstCost - lastCost + gapCost >= retentionFloor;
      // Prefer tail-side trades: try drop-trailing first, then drop-leading,
      // then drop-both. Per the wave-gate ruling — trailing context is the
      // weakest signal of a stack trace; leading context (the exception
      // header + first user frame) is the strongest.
      let dropEdges: number[] | null = null;
      if (tryDropTrailing && lastCost >= needToFree) {
        dropEdges = [lastIdx];
      } else if (tryDropLeading && firstCost >= needToFree) {
        dropEdges = [firstIdx];
      } else if (tryDropBoth && firstCost + lastCost >= needToFree) {
        dropEdges = [firstIdx, lastIdx];
      }
      if (dropEdges === null) continue;
      const dropSet = new Set(dropEdges);
      selected = selected.filter(([i]) => !dropSet.has(i));
      let droppedCost = 0;
      for (const di of dropEdges) {
        droppedCost += lines[di]!.length + (String(di + 1).length + 2) + 1;
        selectedIdxSet.delete(di);
      }
      usedAfterGaps -= droppedCost;
      for (let g = prev + 1; g < next; g++) {
        selected.push([g, lines[g]!]);
        selectedIdxSet.add(g);
      }
      usedAfterGaps += gapCost;
      selected.sort((a, b) => a[0] - b[0]);
      swapChanged = true;
      break;
    }
  }
  selected.sort((a, b) => a[0] - b[0]);

  if (selected.length === 0 && lines.length > 0) {
    return `[TRUNCATED: lines 1-${lines.length}]`;
  }
  const finalKeptIndices = selected.map(([idx]) => idx);

  // Phase 6: Build result. Every shown line is `${idx+1}. <verbatim>`; gaps >=
  // threshold become a single flush-left `[TRUNCATED: lines X-Y]`. The
  // emit bound is aligned to selection via emitBudget = max(budget,
  // usedAfterGaps): the backfill above is permitted to push the selection
  // past `budget` by one ceiling-bounded line, and emission must follow that
  // decision — using the smaller `budget` here would strand a
  // selected-but-unemitted line behind a marker that claims it was shown.
  const emitBudget = Math.max(budget, usedAfterGaps);
  const resultParts: string[] = [];
  let emittedUsed = 0;

  // Check for leading gap
  if (finalKeptIndices[0]! >= _MIN_OMISSION_THRESHOLD) {
    const leadMarker = `[TRUNCATED: lines 1-${finalKeptIndices[0]!}]`;
    resultParts.push(leadMarker);
    emittedUsed += leadMarker.length + 1;
  }

  for (let i = 0; i < selected.length; i++) {
    const [idx, line] = selected[i]!;
    const shown = `${idx + 1}. ${line}`;
    if (emittedUsed + shown.length + 1 > emitBudget) break;
    resultParts.push(shown);
    emittedUsed += shown.length + 1;

    if (i < selected.length - 1) {
      const currentIdx = finalKeptIndices[i]!;
      const nextIdx = finalKeptIndices[i + 1]!;
      const gap = nextIdx - currentIdx - 1;
      if (gap >= _MIN_OMISSION_THRESHOLD) {
        const gapMarker = `[TRUNCATED: lines ${currentIdx + 2}-${nextIdx}]`;
        if (emittedUsed + gapMarker.length + 1 > emitBudget) break;
        resultParts.push(gapMarker);
        emittedUsed += gapMarker.length + 1;
      }
    }
  }

  // Check for trailing gap. Per the wave-gate ruling, trailing omissions get
  // a `[TRUNCATED: lines X-Y]` marker REGARDLESS of size — a single trailing
  // marker cannot fragment content (the sub-threshold-sliver anti-pattern
  // targets gaps BETWEEN markers), and without one the model cannot know the
  // trace continues. emitBudget already includes a relaxation past `budget`
  // up to usedAfterGaps; expand it once more so the marker always fits when a
  // trailing omission exists.
  const lastKept = finalKeptIndices[finalKeptIndices.length - 1]!;
  const trailingGap = lines.length - 1 - lastKept;
  if (trailingGap >= 1) {
    const trailMarker = `[TRUNCATED: lines ${lastKept + 2}-${lines.length}]`;
    resultParts.push(trailMarker);
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
    const fe = pattern.firstEntry;
    const lineCost = fe.line.length + (String(fe.originalIdx + 1).length + 2) + 1;

    if (used + lineCost > budget) continue;
    selectedPatterns.push(pattern);
    used += lineCost;
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
      const lastCost = lastEntry.line.length + (String(lastEntry.originalIdx + 1).length + 2) + 1;
      if (used + lastCost <= budget && !includedIndices.has(lastEntry.originalIdx)) {
        finalEntries.push(lastEntry);
        includedIndices.add(lastEntry.originalIdx);
        used += lastCost;
      }
    }
  }

  // Phase 6: Sort by original position and build output. Every shown line is
  // `${idx+1}. <verbatim>` (no `[repeated N]` suffix — Priority-0 forbids
  // appended annotations); gaps >= threshold get a flush-left
  // `[TRUNCATED: lines X-Y]`. Budget-break keeps output within budget.
  finalEntries.sort((a, b) => a.originalIdx - b.originalIdx);

  const outputParts: string[] = [];
  let emittedUsed = 0;
  let prevIdx = -1;

  for (const entry of finalEntries) {
    if (prevIdx >= 0 && entry.originalIdx - prevIdx - 1 >= _MIN_OMISSION_THRESHOLD) {
      const gapMarker = `[TRUNCATED: lines ${prevIdx + 2}-${entry.originalIdx}]`;
      if (emittedUsed + gapMarker.length + 1 <= budget) {
        outputParts.push(gapMarker);
        emittedUsed += gapMarker.length + 1;
      }
    }
    const shown = `${entry.originalIdx + 1}. ${entry.line}`;
    if (emittedUsed + shown.length + 1 > budget) break;
    outputParts.push(shown);
    emittedUsed += shown.length + 1;
    prevIdx = entry.originalIdx;
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
    // Cost includes the `N. ` prefix width emitted per shown line.
    return line.length + (String(idx + 1).length + 2) + 1;
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

  // Reconstruct in original line order. Every shown line is `${idx+1}. <verbatim>`;
  // every omitted gap becomes a single flush-left `[TRUNCATED: lines X-Y]`
  // (1-based inclusive). Budget-break keeps output within budget.
  const allIncluded = new Set<number>([...mandatory, ...includedBody]);
  const result: string[] = [];
  let emittedUsed = 0;

  const pushShown = (idx: number, line: string): boolean => {
    const shown = `${idx + 1}. ${line}`;
    if (emittedUsed + shown.length + 1 > budget) return false;
    result.push(shown);
    emittedUsed += shown.length + 1;
    return true;
  };
  const pushMarker = (x: number, y: number): boolean => {
    const marker = `[TRUNCATED: lines ${x}-${y}]`;
    if (emittedUsed + marker.length + 1 > budget) return false;
    result.push(marker);
    emittedUsed += marker.length + 1;
    return true;
  };

  // Module docstring block
  let broke = false;
  for (const idx of modDocKeep) {
    const line = lines[idx];
    if (line === undefined) continue;
    if (!pushShown(idx, line)) { broke = true; break; }
  }
  if (!broke && modDocOmitted > 0) {
    // modDocKeep has the kept indices, modDocIndices has all docstring indices
    const docOmitStart = modDocKeep[modDocKeep.length - 1]! + 1;
    const docOmitEnd = modDocIndices[modDocIndices.length - 1]!;
    if (!pushMarker(docOmitStart + 1, docOmitEnd + 1)) broke = true;
  }

  // Scan remaining lines in order, inserting omission markers at cut points.
  // Blank indices are buffered so they can be numbered when emitted.
  let pendingBlankIdx: number[] = [];
  let omitStart = -1;  // Track where omission began (0-indexed)

  for (const [idx, line] of lines.entries()) {
    if (broke) break;
    if (modDocSet.has(idx)) continue;

    if (!line.trim()) {
      pendingBlankIdx.push(idx);
      continue;
    }

    if (allIncluded.has(idx)) {
      if (omitStart >= 0) {
        // Emit marker for lines omitStart through (last omitted, exclusive of
        // any buffered blanks). When pendingBlankIdx is non-empty, those blanks
        // sit at indices [pendingBlankIdx[0]..pendingBlankIdx.at(-1)] and are
        // about to be SHOWN next — the marker must STOP at the line before the
        // first buffered blank, otherwise the marker range overlaps a visible
        // line number (BUG 4a). With no buffered blanks, omission runs to
        // idx-1 (0-based), i.e. line `idx` in 1-based.
        const omitEndOneBased = pendingBlankIdx.length > 0
          ? pendingBlankIdx[0]!  // 1-based number of (firstBlankIdx - 1) === firstBlankIdx
          : idx;
        if (!pushMarker(omitStart + 1, omitEndOneBased)) { broke = true; break; }
        omitStart = -1;
      }
      for (const bi of pendingBlankIdx) {
        if (!pushShown(bi, lines[bi]!)) { broke = true; break; }
      }
      pendingBlankIdx = [];
      if (broke) break;
      if (!pushShown(idx, line)) { broke = true; break; }
    } else {
      pendingBlankIdx = []; // discard blanks belonging to omitted section
      if (omitStart < 0) omitStart = idx;  // Start new omission range
    }
  }

  if (!broke && omitStart >= 0) {
    pushMarker(omitStart + 1, lines.length);
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
      const block = workingStructure[idx] ?? workingStructure[0];
      if (block === undefined) {
        throw new Error(`invariant: workingStructure empty while scoring index ${idx}`);
      }
      const normalizedPriority = block.priority / 300;
      const combined = 0.55 * score + 0.45 * normalizedPriority;
      return { block, score: combined };
    });

    sortedBlocks = combinedScores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.block);
  }

  // Per-line emit cost INCLUDES the `N. ` prefix width so budget accounting
  // matches what is actually emitted (Priority-0 / anti-bloat).
  const lineCost = (idx: number): number => lineAt(idx).length + (String(idx + 1).length + 2) + 1;

  // Marker byte cost for a 1-based inclusive range, matching the emitter's
  // template literal EXACTLY so selection accounting equals emitted output.
  const markerCost = (x: number, y: number): number => `[TRUNCATED: lines ${x}-${y}]`.length + 1;

  // AST-aware SHED weight per line. When the fully-rendered surface (every shown
  // line PLUS every [TRUNCATED] marker the emitter inserts — head, interior, and
  // tail) overshoots the budget, the selection must shrink. That shrink is a
  // DELIBERATE, ranking-driven compression decision — never the historical
  // emit-time blind cut that silently dropped the file's tail with no marker.
  // Higher weight = surrendered sooner. The weight is derived entirely from the
  // intelligence TOON already computed: the owning block's SageRank rank (later
  // in sortedBlocks = less central = shed sooner) and the line's role within its
  // block (a plain body line outranks both its signature and its anchor lines
  // for removal — the structural skeleton survives while predictable bodies fall
  // away first). Top-level lines (imports / module constants) carry no entry, so
  // they default to weight 0 and are the LAST content surrendered.
  const shedWeight = new Map<number, number>();
  {
    const rankOf = new Map<StructureBlock & { priority: number }, number>();
    sortedBlocks.forEach((b, r) => rankOf.set(b, r));
    const RANK_SPAN = sortedBlocks.length + 1;
    for (const blk of sortedBlocks) {
      const s = Math.max(0, blk.startLine);
      const e = Math.min(n - 1, blk.endLine);
      if (s > e) continue;
      const rank = rankOf.get(blk) ?? RANK_SPAN;
      const anchorLines = new Set<number>();
      for (const a of blk.anchors ?? []) {
        for (let al = a.startLine; al <= a.endLine; al++) anchorLines.add(al);
      }
      for (let ln = s; ln <= e; ln++) {
        // Signature (block start) and anchor lines ARE the structural skeleton:
        // shed them only after every plain body line of equal-or-lower-ranked
        // blocks. roleBias lifts plain body lines above them by a full rank span.
        const isSkeleton = ln === s || anchorLines.has(ln);
        const roleBias = isSkeleton ? 0 : RANK_SPAN;
        // +1 keeps the top-ranked block's skeleton at weight >= 1, strictly
        // above the weight-0 top-level floor.
        const w = rank + 1 + roleBias;
        const cur = shedWeight.get(ln);
        // A line shared by nested blocks keeps the MINIMUM weight (its most
        // protective owner wins) so we never shed a line some block ranks high.
        if (cur === undefined || w < cur) shedWeight.set(ln, w);
      }
    }
  }

  // True rendered byte cost of the CURRENT selection: every shown line plus
  // every marker the emitter will insert — the >= threshold head gap (lines
  // before the first shown line), every >= threshold interior gap, and the
  // closing tail gap (lines after the last shown line through EOF). This is the
  // SINGLE source of truth for "does the selection fit"; the selection is
  // reconciled against THIS value so the emitter renders the surface 1:1 and
  // never blind-cuts a selected line or an omission boundary.
  const renderedCost = (): number => {
    const keys = [...resultLines.keys()].sort((a, b) => a - b);
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (first === undefined || last === undefined) return 0;
    let cost = 0;
    if (first >= _MIN_OMISSION_THRESHOLD) cost += markerCost(1, first);
    let prevKey = -1;
    for (const ln of keys) {
      if (prevKey >= 0 && ln - prevKey - 1 >= _MIN_OMISSION_THRESHOLD) {
        cost += markerCost(prevKey + 2, ln);
      }
      cost += lineCost(ln);
      prevKey = ln;
    }
    if (n - 1 - last >= _MIN_OMISSION_THRESHOLD) cost += markerCost(last + 2, n);
    return cost;
  };

  for (const block of sortedBlocks) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    if (start > end) continue;

    const newIndices = Array.from({ length: end - start + 1 }, (_, k) => start + k)
      .filter((i) => !resultLines.has(i));
    if (newIndices.length === 0) continue;

    const sigSize = lineCost(start);
    const newSize = newIndices.reduce((sum, i) => sum + lineCost(i), 0);
    const rangeMarker = `[TRUNCATED: lines ${start + 2}-${end + 1}]`;
    const rangeMarkerCost = rangeMarker.length + 1;

    if (used + newSize <= budget) {
      for (const i of newIndices) {
        resultLines.set(i, lineAt(i));
      }
      used += newSize;
    } else if (!resultLines.has(start) && used + sigSize + rangeMarkerCost <= budget) {
      const bodyIndices = newIndices.filter((i) => i !== start);

      const MARKER_COST = rangeMarkerCost;
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

        // Never truncate tiny blocks (gap < threshold): include the omitted
        // lines so no sub-threshold gap is left inside this block.
        if (omittedCount > 0 && omittedCount < _MIN_OMISSION_THRESHOLD) {
          for (const idx of omittedLines) {
            selectedSet.add(idx);
            selectedBodyCost += lineCost(idx);
          }
        }

        resultLines.set(start, lineAt(start));
        for (const idx of selectedSet) {
          resultLines.set(idx, lineAt(idx));
        }
        used += sigSize + selectedBodyCost;
      } else {
        // Signature only; the rest of the block falls into a gap and is marked
        // by the emit walk below.
        resultLines.set(start, lineAt(start));
        used += sigSize;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Unified convergence (Priority-0). ONE fixpoint loop reconciles every trust
  // invariant together so they can never undo each other:
  //   (1) the rendered surface — lines + every [TRUNCATED] marker the emitter
  //       writes, including the HEAD and TAIL boundary markers — fits the budget;
  //   (2) no sub-threshold gap sits between two selected lines (a gap < the
  //       threshold cannot earn a marker, so it is shown or merged away);
  //   (3) no sub-threshold SHOWN run sits between two markers (Rule 1);
  //   (4) any leftover budget is refilled with the highest-value omitted lines
  //       (lowest shedWeight) — so honest marker accounting does not undershoot
  //       the 70% retention floor.
  //
  // The historical bug lived in letting the EMITTER resolve (1) by breaking
  // mid-walk and silently dropping the file tail with no marker. We resolve it
  // HERE instead, by deliberately shedding the LOWEST-VALUE line per the
  // AST-derived shedWeight — never by file position — and re-checking all the
  // invariants. The emitter then renders the settled surface 1:1.
  //
  // Each pass fixes the single highest-priority violation it finds and restarts;
  // a guard caps the iteration count. All budget comparisons use renderedCost()
  // so the fill (4) and shed (1) cannot ping-pong on mismatched metrics.
  {
    // Worst shed-eligible selected line (max shedWeight); -1 if none remain.
    const worstSheddable = (): number => {
      let victim = -1;
      let worst = -1;
      for (const idx of resultLines.keys()) {
        const w = shedWeight.get(idx);
        if (w === undefined) continue; // top-level / protected — never shed
        if (w > worst) { worst = w; victim = idx; }
      }
      return victim;
    };
    // Drop one boundary of a sub-threshold gap, preferring the more-sheddable
    // side; never drop a protected line when a sheddable one borders the gap.
    const dropGapBoundary = (a: number, b: number): void => {
      const aShed = shedWeight.get(a);
      const bShed = shedWeight.get(b);
      let dropIdx: number;
      if (aShed === undefined && bShed === undefined) dropIdx = a;
      else if (aShed === undefined) dropIdx = b;
      else if (bShed === undefined) dropIdx = a;
      else dropIdx = aShed >= bShed ? a : b;
      used -= lineCost(dropIdx);
      resultLines.delete(dropIdx);
    };

    let guard = (resultLines.size + n + 1) * 6;
    let converged = false;
    while (!converged && guard-- > 0) {
      const keys = [...resultLines.keys()].sort((a, b) => a - b);
      if (keys.length === 0) { converged = true; break; }

      // (1) Budget: shed the worst line until the rendered surface fits.
      if (renderedCost() > budget) {
        const victim = worstSheddable();
        if (victim < 0) { converged = true; break; } // only protected left
        used -= lineCost(victim);
        resultLines.delete(victim);
        continue;
      }

      // (2) Sub-threshold gap between consecutive selected lines. Fill if the
      // post-fill rendered cost still fits (a sub-threshold gap never carried a
      // marker, so filling only adds its line bytes); else merge it away by
      // dropping the more-sheddable boundary. Same metric as (1) — no ping-pong.
      let gapFixed = false;
      for (let ki = 1; ki < keys.length; ki++) {
        const ln = keys[ki] ?? 0;
        const prev = keys[ki - 1] ?? 0;
        const gap = ln - prev - 1;
        if (gap <= 0 || gap >= _MIN_OMISSION_THRESHOLD) continue;
        let fillCost = 0;
        for (let g = prev + 1; g < ln; g++) fillCost += lineCost(g);
        if (renderedCost() + fillCost <= budget) {
          for (let g = prev + 1; g < ln; g++) {
            resultLines.set(g, lineAt(g));
            used += lineCost(g);
          }
        } else {
          dropGapBoundary(prev, ln);
        }
        gapFixed = true;
        break;
      }
      if (gapFixed) continue;

      // (3) Sub-threshold SHOWN run sandwiched between two markers (Rule 1).
      // Partition into runs; drop the first marker-bounded run shorter than the
      // threshold (merge it into the surrounding truncation). Growing it would
      // re-inflate the budget just settled, so removal is the correct resolution.
      const runs: number[][] = [];
      let run: number[] = [];
      for (const k of keys) {
        const tail = run.length === 0 ? -1 : run[run.length - 1] ?? -1;
        if (run.length === 0 || k === tail + 1) run.push(k);
        else { runs.push(run); run = [k]; }
      }
      if (run.length > 0) runs.push(run);

      let runFixed = false;
      for (let r = 0; r < runs.length; r++) {
        const cur = runs[r];
        if (cur === undefined || cur.length === 0) continue;
        if (cur.length >= _MIN_OMISSION_THRESHOLD) continue;
        const first = cur[0] ?? 0;
        const last = cur[cur.length - 1] ?? 0;
        const prevRun = r > 0 ? runs[r - 1] : undefined;
        const prevLast = prevRun ? (prevRun[prevRun.length - 1] ?? -1) : -1;
        const omitBefore = r === 0 ? first : first - prevLast - 1;
        const nextRun = r < runs.length - 1 ? runs[r + 1] : undefined;
        const nextFirst = nextRun ? (nextRun[0] ?? n) : n;
        const omitAfter = r === runs.length - 1 ? n - 1 - last : nextFirst - last - 1;
        if (omitBefore < _MIN_OMISSION_THRESHOLD || omitAfter < _MIN_OMISSION_THRESHOLD) continue;
        for (const i of cur) {
          used -= lineCost(i);
          resultLines.delete(i);
        }
        runFixed = true;
        break;
      }
      if (runFixed) continue;

      // (4) Refill leftover budget with the single highest-value omitted line
      // (lowest shedWeight) that EXTENDS an existing shown run — i.e. the line
      // immediately before or after a selected line. Extending a run never opens
      // a new gap; it only shrinks an adjacent omission, which we guard to stay
      // either zero or >= threshold so no marker becomes sub-threshold and no
      // shown run becomes marker-sandwiched. This recovers retention lost to
      // honest marker accounting without violating any invariant.
      const selected = new Set(keys);
      let bestIdx = -1;
      let bestW = Infinity;
      const considerNeighbor = (cand: number, anchor: number): void => {
        if (cand < 0 || cand >= n) return;
        if (selected.has(cand)) return;
        const w = shedWeight.get(cand) ?? 0;
        if (w >= bestW) return;
        // Adding `cand` shrinks the omission between it and the nearest selected
        // line on the far side (away from `anchor`). Guard: that residual
        // omission must stay either 0 (runs merge) or >= threshold (a legal
        // marker remains) so we never create a sub-threshold gap.
        if (cand < anchor) {
          // Extending a run leftward: nearest selected line below cand.
          let p = cand - 1;
          while (p >= 0 && !selected.has(p)) p--;
          const residual = p < 0 ? cand : cand - p - 1;
          if (residual !== 0 && residual < _MIN_OMISSION_THRESHOLD) return;
        } else {
          // Extending a run rightward: nearest selected line above cand.
          let q = cand + 1;
          while (q < n && !selected.has(q)) q++;
          const residual = q >= n ? n - 1 - cand : q - cand - 1;
          if (residual !== 0 && residual < _MIN_OMISSION_THRESHOLD) return;
        }
        if (renderedCost() + lineCost(cand) > budget) return;
        bestW = w;
        bestIdx = cand;
      };
      for (const k of keys) {
        considerNeighbor(k - 1, k);
        considerNeighbor(k + 1, k);
      }
      if (bestIdx >= 0) {
        resultLines.set(bestIdx, lineAt(bestIdx));
        used += lineCost(bestIdx);
        continue;
      }

      converged = true;
    }
  }

  // Phase H: inline assertion over the final selected set (Priority-0). Asserts
  // every trust invariant the emitter relies on: indices in range, strictly
  // ascending, no sub-threshold gap left unselected, no sub-threshold SHOWN run
  // sandwiched between two markers, and the rendered surface fits the budget so
  // the emitter renders 1:1 without ever dropping selected content.
  {
    const finalKeys = [...resultLines.keys()].sort((a, b) => a - b);
    const runs: number[][] = [];
    let run: number[] = [];
    for (const k of finalKeys) {
      const tail = run.length === 0 ? -1 : run[run.length - 1] ?? -1;
      if (run.length === 0 || k === tail + 1) run.push(k);
      else { runs.push(run); run = [k]; }
    }
    if (run.length > 0) runs.push(run);

    for (let ki = 0; ki < finalKeys.length; ki++) {
      const idx = finalKeys[ki] ?? -1;
      if (idx < 0 || idx >= n) {
        throw new Error(`Priority-0 violation: selected index ${idx} out of range (n=${n})`);
      }
      if (ki > 0) {
        const prevIdx = finalKeys[ki - 1] ?? -1;
        if (idx <= prevIdx) {
          throw new Error(`Priority-0 violation: selected indices not strictly ascending (${prevIdx} >= ${idx})`);
        }
        const gap = idx - prevIdx - 1;
        if (gap > 0 && gap < _MIN_OMISSION_THRESHOLD) {
          throw new Error(`Priority-0 violation: gap ${prevIdx + 2}-${idx} is ${gap} lines (< ${_MIN_OMISSION_THRESHOLD}) but not fully selected`);
        }
      }
    }
    for (let r = 0; r < runs.length; r++) {
      const cur = runs[r];
      if (cur === undefined || cur.length === 0) continue;
      const first = cur[0] ?? 0;
      const last = cur[cur.length - 1] ?? 0;
      const prevRun = r > 0 ? runs[r - 1] : undefined;
      const prevLast = prevRun ? (prevRun[prevRun.length - 1] ?? -1) : -1;
      const omitBefore = r === 0 ? first : first - prevLast - 1;
      const nextRun = r < runs.length - 1 ? runs[r + 1] : undefined;
      const nextFirst = nextRun ? (nextRun[0] ?? n) : n;
      const omitAfter = r === runs.length - 1 ? n - 1 - last : nextFirst - last - 1;
      const markerBefore = omitBefore >= _MIN_OMISSION_THRESHOLD;
      const markerAfter = omitAfter >= _MIN_OMISSION_THRESHOLD;
      if (markerBefore && markerAfter && cur.length < _MIN_OMISSION_THRESHOLD) {
        throw new Error(`Priority-0 violation: shown run ${first + 1}-${last + 1} is ${cur.length} lines (< ${_MIN_OMISSION_THRESHOLD}) between two markers`);
      }
    }
    if (renderedCost() > budget) {
      throw new Error(`Priority-0 violation: rendered surface ${renderedCost()} exceeds budget ${budget}`);
    }
  }

  // Faithful emit. The selected surface has already been reconciled to fit the
  // budget (lines + markers), so the emitter is a 1:1 renderer: it writes EVERY
  // selected line at its true line number, and a single flush-left
  // `[TRUNCATED: lines X-Y]` marker for every >= threshold omission — at the
  // HEAD boundary (lines before the first shown line), at every interior gap,
  // and at the TAIL boundary (lines after the last shown line through EOF).
  // There is no budget-break that could drop a selected line: every boundary
  // omission is the product of the deliberate AST-aware reconciliation above,
  // never an emit-time accident. A final guard re-asserts the emitted line count
  // equals the selected count, so any future regression that lets emission
  // diverge from selection fails loudly instead of silently losing a boundary.
  const output: string[] = [];
  const sortedKeys = [...resultLines.keys()].sort((a, b) => a - b);
  let prev = -1;
  let emittedShown = 0;

  for (const ln of sortedKeys) {
    if (prev < 0) {
      if (ln >= _MIN_OMISSION_THRESHOLD) {
        output.push(`[TRUNCATED: lines 1-${ln}]`);
      }
    } else if (ln - prev - 1 >= _MIN_OMISSION_THRESHOLD) {
      output.push(`[TRUNCATED: lines ${prev + 2}-${ln}]`);
    }
    const line = resultLines.get(ln);
    if (line === undefined) {
      throw new Error(`invariant: resultLines lost key ${ln} before emit`);
    }
    output.push(`${ln + 1}. ${line}`);
    emittedShown++;
    prev = ln;
  }
  // TAIL marker: lines after the last shown line are a real, deliberate omission
  // and MUST be marked — never silently cut.
  if (prev >= 0 && n - 1 - prev >= _MIN_OMISSION_THRESHOLD) {
    output.push(`[TRUNCATED: lines ${prev + 2}-${n}]`);
  }

  // Emit/selection agreement guard (Priority-0): the emitted shown lines must be
  // exactly the selected set. Diverging is the historical bug class.
  if (emittedShown !== sortedKeys.length) {
    throw new Error(`Priority-0 violation: emitted ${emittedShown} lines but selected ${sortedKeys.length}`);
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

  // Line-based selection so every shown line carries its true 1-based number and
  // is verbatim (no mid-line cuts). The head/tail char budgets keep the original
  // head-vs-tail heuristic; emission is whole numbered lines + one flush-left
  // `[TRUNCATED: lines X-Y]` for the omitted middle. Prefix width is charged and
  // the budget-break keeps output within budget.
  const lines = text.split('\n');
  const totalLines = lines.length;
  const lineCost = (idx: number): number => lines[idx]!.length + (String(idx + 1).length + 2) + 1;

  const markerReserve = `[TRUNCATED: lines ${totalLines}-${totalLines}]`.length + 1;
  const usable = Math.max(0, budget - markerReserve);
  const headBudget = Math.floor(usable * headRatio);
  const tailBudget = usable - headBudget;

  // Take whole lines from the head up to headBudget.
  const headIdx: number[] = [];
  let headUsed = 0;
  for (let i = 0; i < totalLines; i++) {
    const c = lineCost(i);
    if (headUsed + c > headBudget) break;
    headIdx.push(i);
    headUsed += c;
  }
  // Take whole lines from the tail up to tailBudget, not overlapping the head.
  const tailIdx: number[] = [];
  let tailUsed = 0;
  const headEnd = headIdx.length > 0 ? headIdx[headIdx.length - 1]! : -1;
  for (let i = totalLines - 1; i > headEnd; i--) {
    const c = lineCost(i);
    if (tailUsed + c > tailBudget) break;
    tailIdx.push(i);
    tailUsed += c;
  }
  tailIdx.reverse();

  const selected = [...headIdx, ...tailIdx];
  const output: string[] = [];
  let prev = -1;

  if (selected.length === 0) {
    // Budget too small for even one whole line. Never cut mid-line: emit the
    // first (and, if distinct, the last) whole numbered line verbatim with a
    // real-range marker between them. This degenerate output is intentionally
    // not budget-clamped — clamping would corrupt line content.
    const degenerate = totalLines > 1 ? [0, totalLines - 1] : [0];
    for (const idx of degenerate) {
      if (prev >= 0 && idx - prev - 1 >= _MIN_OMISSION_THRESHOLD) {
        output.push(`[TRUNCATED: lines ${prev + 2}-${idx}]`);
      }
      output.push(`${idx + 1}. ${lines[idx]!}`);
      prev = idx;
    }
    return output.join('\n');
  }

  // Normal path: whole numbered lines bounded by the head/tail budgets, with a
  // single flush-left marker for the omitted middle. Budget-break ensures the
  // emitted output never exceeds budget.
  let emittedUsed = 0;
  for (const idx of selected) {
    if (prev >= 0 && idx - prev - 1 >= _MIN_OMISSION_THRESHOLD) {
      const marker = `[TRUNCATED: lines ${prev + 2}-${idx}]`;
      if (emittedUsed + marker.length + 1 <= budget) {
        output.push(marker);
        emittedUsed += marker.length + 1;
      }
    }
    const shown = `${idx + 1}. ${lines[idx]!}`;
    if (emittedUsed + shown.length + 1 > budget) break;
    output.push(shown);
    emittedUsed += shown.length + 1;
    prev = idx;
  }

  return output.join('\n');
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

/**
 * Compress a single file from raw structural facts.
 *
 * Shapes the caller-supplied facts into the structured-source inputs and
 * delegates to compressSourceStructured (the real engine). Owns no compression
 * logic of its own — only fact-shaping and the usefulness gate.
 */
export function compressFile(req: CompressFileRequest): string | null {
  if (req.source.length === 0) return null;
  if (req.facts.langName === null && req.facts.defs.length === 0) {
    // Rule 12: TOON must NEVER deny a compression request. An unsupported
    // language (no tree-sitter lang, no structural defs) is a MANDATORY
    // fallback to the unstructured text engine — the same engine
    // _compressSourceStructured delegates to when structure is empty
    // (compressString, which auto-detects content type, enforces the 70%
    // floor, and emits the verbatim/line-number/[TRUNCATED] invariants).
    // We do NOT early-return null and force the caller into plain truncation.
    const unstructured = compressString(req.source, req.maxChars);
    // Match the structured path's usefulness gate: if even the unstructured
    // output isn't shorter than the source, return null so the caller emits
    // raw (TOON owns the "not useful" decision; the floor may keep them equal).
    if (unstructured.length >= req.source.length) return null;
    return unstructured;
  }
  const facts: RawFileFacts = req.facts;
  // Public-API hardening: never let facts reference lines the source doesn't
  // contain (callers are contracted to pass the full file, but facts can be
  // momentarily stale across an edit boundary). Window clamp.
  const lineCount = req.source.split('\n').length;
  const structure: StructureBlock[] = facts.defs
    .filter((d) => d.line >= 1 && d.line - 1 < lineCount)
    .map((d) => ({
      name: d.name, kind: d.kind, type: d.type,
      startLine: d.line - 1, endLine: Math.min(d.endLine - 1, lineCount - 1),
      exported: d.visibility === 'public', anchors: [] as Anchor[],
    }));
  // Anchor weighting is TOON's decision (Priority 0.5): derive priority from
  // anchor kind — the flat `300` it replaces erased the extractor's signal
  // ladder (return > throw > if > switch > try > catch > loop > await > call).
  // Mirrors the extractor's rule ladder so SageRank can distinguish "this
  // block returns" from "this block contains a low-value call".
  const ANCHOR_KIND_PRIORITY: Readonly<Record<string, number>> = {
    return: 400, throw: 380, if: 320, switch: 300, try: 280, catch: 270,
    loop: 260, await: 180, call: 140,
  };
  for (const a of facts.anchors) {
    // anchors arrive 1-BASED across the seam (extractor persists 1-based),
    // so `a.line - 1` converts to 0-based for the structured-source engine.
    const anchorLine = a.line - 1;
    if (anchorLine < 0 || anchorLine >= lineCount) continue;
    // Tightest containing block — not first/outermost. A method anchor inside
    // a class should attach to the method, not the class, so SageRank
    // weighting lands on the right block.
    let owner: StructureBlock | undefined;
    for (const b of structure) {
      if (anchorLine < b.startLine || anchorLine > b.endLine) continue;
      if (owner === undefined || (b.endLine - b.startLine) < (owner.endLine - owner.startLine)) owner = b;
    }
    if (owner === undefined) continue;
    owner.anchors.push({
      startLine: anchorLine, endLine: anchorLine, kind: a.kind,
      priority: ANCHOR_KIND_PRIORITY[a.kind] ?? 300,
    });
  }
  const context: CompressionContext = {
    // SageRank tuning transform: damp raw call counts with sqrt so a hot edge
    // (many calls) doesn't linearly dominate AST ranking. Per Priority 0.5 this
    // edge-weighting decision lives in TOON; MCP hands across the raw callCount.
    callGraph: facts.edges.map((e) => ({ caller: e.callerName, callee: e.calleeName, weight: Math.sqrt(e.callCount) })),
    exportedSymbols: facts.defs.filter((d) => d.visibility === 'public').map((d) => d.name),
  };
  const out = compressSourceStructured(req.source, req.maxChars, structure, context);
  if (out.length >= req.source.length) return null; // compression not useful (TOON owns this decision); caller falls back
  // The 70% retention floor in compressSourceStructured is intentional and may
  // push the output above req.maxChars: tests (compression-core ×2,
  // compression-utils ×1) assert that floor as the contract — output MAY
  // exceed the requested maxChars because the floor overrides the budget by
  // design. Transport bounding is handled caller-side; TOON does not gate on
  // fit here.
  return out;
}
