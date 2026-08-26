// ---------------------------------------------------------------------------
// tests/stride/terms.test.ts
//
// The tokeniser is the vocabulary the whole search shares, so the property
// under test is never "the output looks reasonable" — it is "the query side and
// the document side produce a term in common". Every match assertion below goes
// through `sharedTerms`, which runs `tokenizeBytes` over the document's UTF-8
// (the exact path `BlockIndex.build` takes) and `tokenize` over the query, and
// intersects them. A tokeniser that shredded both sides identically would pass
// a "looks reasonable" test and fail every one of these.
//
// The named forms in the build brief — ISO-8601 timestamps, UUIDs, dotted-quad
// IPv4, decimals, emails, URLs, dotted and slashed paths and hex digests — are
// each asserted to survive whole, and the two derived-term rules (`error` finds
// `error_timeout_failure`, `192.168.1.1` finds `192.168.1.1:8080`) are asserted
// as searches rather than as token lists.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import {
    TOKEN_MAX_BYTES,
    pathTerms,
    splitIdentifier,
    tokenize,
    tokenizeBytes,
} from '../../src/core/stride/terms.js';

/** Distinct terms the INDEX would store for a stretch of document text. */
function documentTerms(text: string): Set<string> {
    const buf = Buffer.from(text, 'utf8');
    const out: string[] = [];
    tokenizeBytes(buf, 0, buf.length, out);
    return new Set(out);
}

/**
 * The terms a query and a document actually share. A search can only match
 * through one of these, so an empty result is a silent miss no matter how
 * sensible either side's tokens look on their own.
 */
function sharedTerms(query: string, documentText: string): string[] {
    const doc = documentTerms(documentText);
    const shared: string[] = [];
    for (const term of new Set(tokenize(query))) {
        if (doc.has(term)) shared.push(term);
    }
    return shared;
}

/** Seeded so a failing case is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('tokenize keeps the strings people paste into a search box whole', () => {
    it('finds an address inside a host:port because the atom survives the colon', () => {
        const doc = '{"peer":"192.168.1.1:8080","up":true}';
        const shared = sharedTerms('192.168.1.1', doc);
        expect(shared, `searching 192.168.1.1 in ${doc} shared nothing; query terms were ${JSON.stringify(tokenize('192.168.1.1'))}`)
            .toContain('192.168.1.1');
    });

    it('keeps a UUID, an ISO-8601 timestamp, an email and a decimal as single terms', () => {
        const forms: readonly [string, string][] = [
            ['550e8400-e29b-41d4-a716-446655440000', 'uuid'],
            ['2024-01-15t10:30:00z', 'iso-8601 timestamp'],
            ['alice.smith+tag@example.co.uk', 'email'],
            ['1.5', 'decimal'],
            ['192.168.1.1', 'dotted-quad ipv4'],
            ['path/to/some/file.json', 'slashed path'],
            ['da39a3ee5e6b4b0d3255bfef95601890afd80709', 'hex digest, 40 chars'],
        ];
        for (const [form, label] of forms) {
            const terms = tokenize(form.toUpperCase());
            expect(terms, `${label} ${form} did not survive tokenisation whole; got ${JSON.stringify(terms)}`)
                .toContain(form);
            const doc = `{"field":"${form}","other":1}`;
            expect(sharedTerms(form, doc), `${label} ${form} embedded in JSON shared no term with a query for itself`)
                .toContain(form);
        }
    });

    it('keeps a scheme-qualified URL whole even though the atom rule cannot', () => {
        // `://` puts a joiner beside a non-word byte, so this is the one named
        // form the byte scanner cannot produce; it reaches the index as a
        // missing term and is answered by the literal scan instead.
        const url = 'https://example.com:8443/a/b?q=1';
        const terms = tokenize(`see ${url}.`);
        expect(terms, `the URL ${url} was not emitted whole; got ${JSON.stringify(terms)}`).toContain(url);
        expect(terms, `a trailing sentence stop leaked into a term: ${JSON.stringify(terms)}`)
            .not.toContain(`${url}.`);
        expect(documentTerms(url), `the byte scanner should keep the host/path remainder, which is what the index stores; got ${JSON.stringify([...documentTerms(url)])}`)
            .toContain('example.com:8443/a/b');
    });

    it('finds a word inside a snake_case identifier and inside a camelCase one', () => {
        for (const doc of ['{"code":"error_timeout_failure"}', '{"code":"errorTimeoutFailure"}', '{"code":"ERROR_TIMEOUT_FAILURE"}']) {
            for (const query of ['error', 'timeout', 'failure']) {
                expect(sharedTerms(query, doc), `searching ${query} in ${doc} shared no term`).toContain(query);
            }
        }
    });

    it('splits a run of capitals before the last one, so HTTPServer answers to server', () => {
        expect(splitIdentifier('HTTPServerError'), 'HTTPServerError did not split at the capital run boundary')
            .toEqual(['http', 'server', 'error']);
        expect(splitIdentifier('parseJSONValue'), 'parseJSONValue did not split at the capital run boundary')
            .toEqual(['parse', 'json', 'value']);
    });

    it('drops one-character pieces of a longer name but keeps a one-character atom', () => {
        expect(splitIdentifier('userId'), 'userId should split into two searchable parts').toEqual(['user', 'id']);
        expect(splitIdentifier('a.b.c'), 'single-character pieces discriminate nothing and must be dropped').toEqual([]);
        expect(tokenize('x'), 'a one-character atom is a real term, only one-character PIECES are noise').toEqual(['x']);
    });

    it('records the leading sign of a negative number in neither the query nor the index, so both still agree', () => {
        // A joiner cannot start an atom, so `-3.14` indexes and queries as
        // `3.14`. That loses the sign but it loses it on BOTH sides, which is
        // the only property that decides whether the search works.
        const doc = '{"delta":-3.14}';
        expect(sharedTerms('-3.14', doc), `a negative decimal query shared nothing with ${doc}`).toContain('3.14');
        expect(tokenize('-3.14'), 'the sign is dropped consistently, not sometimes').toContain('3.14');
    });
});

describe('tokenizeBytes never splits a codepoint', () => {
    it('keeps CJK, Cyrillic, accented Latin and emoji runs whole', () => {
        const cases: readonly [string, string][] = [
            ['你好世界', 'CJK'],
            ['日本語のテキスト', 'Japanese'],
            ['ЖУРНАЛ', 'Cyrillic, uppercase'],
            ['Ünïcödé', 'accented Latin'],
            ['🎉🎊🚀', 'emoji run'],
            ['👨‍👩‍👧‍👦', 'ZWJ emoji sequence'],
        ];
        for (const [text, label] of cases) {
            const terms = [...documentTerms(`{"t":"${text}"}`)];
            const folded = text.toLowerCase();
            expect(terms, `${label} ${JSON.stringify(text)} was not emitted as one term; got ${JSON.stringify(terms)}`)
                .toContain(folded);
            for (const term of terms) {
                expect(Buffer.from(term, 'utf8').toString('utf8'), `${label} produced the lone-surrogate/replacement term ${JSON.stringify(term)}, which means a codepoint was cut`)
                    .toBe(term);
                expect(term, `${label} produced a term containing U+FFFD, which only happens when a UTF-8 sequence is cut: ${JSON.stringify(term)}`)
                    .not.toContain('�');
            }
        }
    });

    it('cuts an over-long multi-byte atom on a codepoint boundary, not at the byte cap', () => {
        const long = '漢'.repeat(60);                       // 180 bytes, 3 per char
        const terms = [...documentTerms(long)];
        expect(terms, `an over-long CJK atom should yield exactly one capped term; got ${JSON.stringify(terms.length)}`)
            .toHaveLength(1);
        const term = terms[0] ?? '';
        const bytes = Buffer.byteLength(term, 'utf8');
        expect(bytes, `the cap must land on a codepoint boundary at or below ${TOKEN_MAX_BYTES}; got ${bytes} bytes`)
            .toBe(126);
        expect(term, `the capped term must be a whole-character prefix; got ${JSON.stringify(term)}`)
            .toBe('漢'.repeat(42));
    });

    it('tokenises only the requested byte range and clamps a range outside the buffer', () => {
        const buf = Buffer.from('aaa bbb ccc');
        const inner: string[] = [];
        tokenizeBytes(buf, 4, 7, inner);
        expect(inner, 'tokenizeBytes must not read outside [from, to)').toEqual(['bbb']);
        const clamped: string[] = [];
        tokenizeBytes(buf, -5, 999, clamped);
        expect(clamped, 'an out-of-range request must clamp to the buffer, not throw or read past it')
            .toEqual(['aaa', 'bbb', 'ccc']);
        const empty: string[] = [];
        tokenizeBytes(buf, 5, 5, empty);
        expect(empty, 'an empty range must emit nothing').toEqual([]);
    });
});

describe('the query side and the index side stay one vocabulary', () => {
    it('re-tokenises every indexed term back to itself, over a seeded mixed corpus', () => {
        // The user-facing form of this property: copy a token out of the
        // document, paste it into the search box, and it still matches. It is
        // asserted mechanically because the two sides are separate code paths
        // and nothing else would notice them drifting apart.
        const pieces = [
            'user', 'Id', 'ERROR', 'timeout_failure', '2024-01-15T10:30:00Z',
            '550e8400-e29b-41d4-a716-446655440000', '192.168.1.1:8080', '1.5', '-3.14',
            'a@b.com', 'alice.smith+tag@example.co.uk', 'https://x.dev/a/b?q=1',
            '你好世界', '🎉🎊', 'Ünïcödé', 'Straße', 'ЖУРНАЛ',
            'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'path/to/some/file.json',
            'v1.2.3-rc.1+build.5', 'iso8601', 'parseJSONValue', 'a'.repeat(200),
            'snake_case_thing', 'kebab-case-thing', '__init__', 'NaN', '0.0000001', '1e10', 'x',
        ];
        const rnd = mulberry32(0x5aFe);
        const words: string[] = [];
        for (let i = 0; i < 4000; i++) words.push(pieces[Math.floor(rnd() * pieces.length)] ?? 'x');
        const text = words.join(' ');
        const indexed = [...documentTerms(text)];
        expect(indexed.length, 'the corpus must actually produce a varied term set for this to mean anything')
            .toBeGreaterThan(50);

        const broken: string[] = [];
        for (const term of indexed) {
            // A term capped at exactly TOKEN_MAX_BYTES may end on a joiner,
            // which cannot start or end an atom on its own; the case below
            // covers that boundary directly.
            if (Buffer.byteLength(term, 'utf8') >= TOKEN_MAX_BYTES) continue;
            if (!new Set(tokenize(term)).has(term)) broken.push(term);
        }
        expect(broken, `seed 0x5aFe: ${broken.length} indexed terms cannot be searched for by pasting them back: ${JSON.stringify(broken.slice(0, 8))}`)
            .toHaveLength(0);
    });

    it('caps an over-long atom identically on both sides, joiner-terminated cap included', () => {
        for (const unit of ['abc.', 'abc-', 'abc/', 'ab:cd', 'ab@c', 'abcd.']) {
            const long = unit.repeat(80);                   // >= 320 bytes
            const indexed = [...documentTerms(long)];
            const capped = indexed[0] ?? '';
            expect(Buffer.byteLength(capped, 'utf8'), `unit ${JSON.stringify(unit)}: the indexed atom should be capped at ${TOKEN_MAX_BYTES} bytes`)
                .toBe(TOKEN_MAX_BYTES);
            expect(new Set(tokenize(long)).has(capped), `unit ${JSON.stringify(unit)}: a query for the whole ${long.length}-char string did not produce the capped term ${JSON.stringify(capped)} the index stored`)
                .toBe(true);
        }
    });
});

describe('pathTerms makes a pointer searchable by its member names', () => {
    it('contributes every member name and its parts, and no array index', () => {
        expect(pathTerms('/orders/9182/shippingAddress/city'), 'a pointer should contribute member-name parts and skip the ordinal')
            .toEqual(['orders', 'shipping', 'address', 'city']);
    });

    it('treats a leading-zero token as the member name it is, per RFC 6901', () => {
        expect(pathTerms('/007/status'), '"007" is not a valid array index, so it is a member name')
            .toEqual(['007', 'status']);
        expect(pathTerms('/0/1/2'), 'valid array indices contribute nothing a person would type')
            .toEqual([]);
    });

    it('unescapes ~0 and ~1 before splitting', () => {
        expect(pathTerms('/audit~1trail/tilde~0name'), 'escaped tokens must be unescaped before they are split')
            .toEqual(['audit', 'trail', 'tilde', 'name']);
    });

    it('contributes nothing for a pointer that is not RFC 6901 rather than failing the build', () => {
        for (const bad of ['', 'orders/1', 'no-leading-slash']) {
            expect(pathTerms(bad), `a bad pointer (${JSON.stringify(bad)}) must not throw or invent terms during an index build`)
                .toEqual([]);
        }
    });

    it('deduplicates a name that repeats along the path', () => {
        expect(pathTerms('/config/nested/config/value'), 'a repeated member name should contribute one term, not two')
            .toEqual(['config', 'nested', 'value']);
    });
});
