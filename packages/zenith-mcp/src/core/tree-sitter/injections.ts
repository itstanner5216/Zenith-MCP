// ---------------------------------------------------------------------------
// tree-sitter/injections.ts — Embedded-language injection span extraction
//
// Invariant: Runs injections.scm for languages that ship one. Returns empty
// array (not null) if the language has no injections.scm. Operates on a
// pre-parsed tree rootNode from extract.ts.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
import { getCompiledModularQuery } from './runtime.js';

export interface InjectionSpan {
    hostLang: string;
    injectedLang: string;
    startLine: number;    // 1-based
    endLine: number;      // 1-based
    startByte: number;
    endByte: number;
}

/**
 * Run injections.scm for a language and extract embedded-language spans.
 * Returns [] if no injections.scm exists (graceful no-op).
 *
 * Captures consumed:
 *   @injection.content  — the node containing injected text
 *   @injection.language — node whose text IS the language name (markdown fenced blocks)
 *   #set! injection.language "..." — predicate setting the language statically
 *
 * @param rootNode Pre-parsed tree root
 * @param langName Host language name
 */
export async function extractInjections(rootNode: Node, langName: string): Promise<InjectionSpan[]> {
    const query = await getCompiledModularQuery(langName, 'injections.scm');
    if (!query) return [];

    const matches = query.matches(rootNode);
    const spans: InjectionSpan[] = [];

    for (const match of matches) {
        let contentNode: Node | null = null;
        let injectedLang: string | null = null;

        for (const cap of match.captures) {
            if (cap.name === 'injection.content') {
                contentNode = cap.node;
            }
            if (cap.name === 'injection.language') {
                injectedLang = cap.node.text.trim();
            }
        }

        // Resolve `#set! injection.language "..."` predicates.
        //
        // web-tree-sitter 0.26.9 exposes set! properties in TWO places, both
        // natively typed (verified against
        // node_modules/.pnpm/web-tree-sitter@0.26.9/node_modules/web-tree-sitter/web-tree-sitter.d.ts):
        //   - QueryProperties = Record<string, string | null>           (d.ts:807)
        //   - QueryMatch.patternIndex: number                           (d.ts:838)
        //   - QueryMatch.setProperties?: QueryProperties                (d.ts:842)
        //   - Query.setProperties: QueryProperties[]                    (d.ts:905)
        //
        //   (a) Match-level:   QueryMatch.setProperties
        //                      — used when the predicate references a capture and
        //                        therefore evaluates per match.
        //   (b) Pattern-level: Query.setProperties[patternIndex]
        //                      — used when `#set!` is a constant on the pattern,
        //                        which is how nearly every injections.scm writes
        //                        `(#set! injection.language "sql")`.
        //
        // We check (a) first, then fall back to (b). Both fields are well-typed,
        // so the lookups need zero casts.
        if (!injectedLang) {
            const v = match.setProperties?.['injection.language'];
            if (typeof v === 'string') injectedLang = v;
        }
        if (!injectedLang) {
            const v = query.setProperties[match.patternIndex]?.['injection.language'];
            if (typeof v === 'string') injectedLang = v;
        }

        if (contentNode && injectedLang) {
            spans.push({
                hostLang: langName,
                injectedLang,
                startLine: contentNode.startPosition.row + 1,
                endLine: contentNode.endPosition.row + 1,
                startByte: contentNode.startIndex,
                endByte: contentNode.endIndex,
            });
        }
    }

    return spans;
}
