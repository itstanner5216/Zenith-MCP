// ---------------------------------------------------------------------------
// tests/stride/pointer.test.ts — invariant I8, STRICT POINTERS
//
// I8 is four claims: "" is the document, "/" is the member named "", ~0/~1
// round-trip, leading-zero array indices are rejected. Each is a defect that
// shipped in a real library, so each is asserted against ground truth computed
// here rather than against the module's own idea of the answer.
//
// The escaping ORDER is the part implementations get wrong, and RFC 6901 §4 is
// unusually explicit about it: decode "~1" to "/" FIRST, then "~0" to "~", and
// the RFC states the consequence in its own words — "~01" correctly becomes
// "~1", not "/". The wrong order is not a near-miss, it silently retargets any
// path containing "~01". So the test does not merely assert the right answer:
// it computes the WRONG-ORDER answer independently, right here, and requires
// the module to disagree with it. An assertion that only states the expected
// string cannot tell a correct implementation from one that never had a "~01"
// in its fixtures.
//
// Escaping on the way OUT is the mirror image and the same trap: escape "~"
// before "/", or the "~" introduced by "/" -> "~1" gets escaped a second time.
// The witness key here carries both characters so the two orders differ.
//
// The governing rule for the whole project is that every address STRIDE EMITS
// must be an address STRIDE ACCEPTS. That is a round trip in two directions, so
// it is tested in two directions: build a pointer for an awkward member name
// with the module's own constructor, parse it back and require the token to be
// the original name byte for byte; then hand the same pointer to a real
// `Resolver` over a real document and require it to land on the member whose
// value `JSON.parse` says belongs to that name. The second direction is the one
// that catches an implementation which is self-consistently wrong.
//
// RFC 6901 §7 declines to define error handling and leaves it to the
// application, so the application's choices are pinned here as choices: which
// failure code each rejection carries, and what "-" does on a read path. A
// pinned choice is a choice someone can find and change on purpose. An
// unpinned one changes by accident.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from 'vitest';
import {
    childPointer,
    escapeToken,
    indexPointer,
    lastToken,
    parentPointer,
    parsePointer,
    tokenToIndex,
    unescapeToken,
} from '../../src/core/stride/pointer.js';
import { StrideIndex } from '../../src/core/stride/index.js';
import { Resolver } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import { DENSE_CHILD_LIMIT, StrideError, type StrideFailure } from '../../src/core/stride/types.js';

// ── coverage accounting ────────────────────────────────────────────────────
// Reported at the end of the run, because "we tested a lot of pointers" is a
// claim and a count is a fact.

const POINTERS_SEEN = new Set<string>();
const TOKENS_SEEN = new Set<string>();

function seenPointer(pointer: string): string {
    POINTERS_SEEN.add(pointer);
    return pointer;
}

function seenToken(token: string): string {
    TOKENS_SEEN.add(token);
    return token;
}

afterAll(() => {
    console.log(
        `[coverage] ${POINTERS_SEEN.size} distinct pointers and ${TOKENS_SEEN.size} distinct reference tokens exercised`,
    );
});

// ── the closed failure set, restated so membership can be asserted ────────
// Written out rather than derived, because the point of the assertion is that
// a NEW failure code cannot appear without a test noticing.

const FAILURES: readonly StrideFailure[] = [
    'not_found', 'bad_pointer', 'bad_cursor', 'malformed_json',
    'not_a_container', 'not_a_scalar', 'empty_query', 'too_large',
];

type Outcome =
    | { readonly kind: 'returned' }
    | { readonly kind: 'stride'; readonly error: StrideError }
    | { readonly kind: 'other'; readonly error: unknown };

function run(fn: () => void): Outcome {
    try {
        fn();
        return { kind: 'returned' };
    } catch (e) {
        return e instanceof StrideError ? { kind: 'stride', error: e } : { kind: 'other', error: e };
    }
}

/** A one-line description of an outcome, so a failed expect names what happened. */
function describeOutcome(o: Outcome): string {
    if (o.kind === 'returned') return 'returned normally';
    if (o.kind === 'stride') return `StrideError(${o.error.failure})`;
    const e = o.error;
    return e instanceof Error
        ? `bare ${e.name}: ${e.message}`
        : `thrown non-Error: ${String(e)}`;
}

function expectStrideFailure(fn: () => void, failure: StrideFailure, label: string): void {
    const o = run(fn);
    expect(describeOutcome(o), `${label}: expected StrideError(${failure}), got ${describeOutcome(o)}`)
        .toBe(`StrideError(${failure})`);
    if (o.kind !== 'stride') return;
    expect(
        FAILURES.includes(o.error.failure),
        `${label}: failure ${JSON.stringify(o.error.failure)} is not in the closed StrideFailure set`,
    ).toBe(true);
    expect(
        o.error.recovery.length > 0,
        `${label}: recovery must tell the caller what to do instead, got ${JSON.stringify(o.error.recovery)}`,
    ).toBe(true);
    expect(o.error instanceof Error, `${label}: a StrideError must still be an Error`).toBe(true);
    expect(o.error.name, `${label}: name must identify the error class`).toBe('StrideError');
}

// ── ground truth, written here and sharing no code with the module ────────

/**
 * Unescape a reference token in the order RFC 6901 §4 requires, expressed as a
 * single left-to-right pass so it cannot accidentally reproduce the module's
 * two-replace strategy. A "~" not followed by 0 or 1 is copied through, which
 * is what pointer.ts does; the divergence from the RFC's ABNF that this implies
 * is asserted separately below.
 */
function unescapeGroundTruth(token: string): string {
    let out = '';
    for (let i = 0; i < token.length; i++) {
        const c = token.charAt(i);
        if (c !== '~' || i + 1 >= token.length) { out += c; continue; }
        const next = token.charAt(i + 1);
        if (next === '0') { out += '~'; i++; continue; }
        if (next === '1') { out += '/'; i++; continue; }
        out += c;
    }
    return out;
}

/** The WRONG order: "~0" before "~1". Kept so the module can be required to differ. */
function unescapeWrongOrder(token: string): string {
    return token.replace(/~0/g, '~').replace(/~1/g, '/');
}

/** The WRONG order on the way out: "/" before "~". */
function escapeWrongOrder(key: string): string {
    return key.replace(/\//g, '~1').replace(/~/g, '~0');
}

/** RFC 6901 array-index ABNF, anchored: %x30 / (%x31-39 *(%x30-39)). */
const RFC_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * The index predicate the module must implement: the anchored ABNF, plus the
 * representable-integer bound the module documents.
 */
function isRfcIndex(token: string): boolean {
    if (!RFC_INDEX.test(token)) return false;
    return Number(token) <= Number.MAX_SAFE_INTEGER;
}

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

/** Every string of length 0..maxLen over `alphabet`. */
function allStrings(alphabet: readonly string[], maxLen: number): string[] {
    let level: string[] = [''];
    const out: string[] = [''];
    for (let n = 1; n <= maxLen; n++) {
        const next: string[] = [];
        for (const prefix of level) for (const c of alphabet) next.push(prefix + c);
        out.push(...next);
        level = next;
    }
    return out;
}

// ── the awkward member names every round trip has to survive ──────────────
// Written with explicit escapes so the names are what they say they are
// regardless of how this file is stored or normalised on disk.

/** U+00E9: "e-acute" as ONE composed code point. Annotated as `string` so
 *  the comparison against the decomposed form below stays a real runtime
 *  comparison instead of one the compiler folds away on literal types. */
const NFC_E_ACUTE: string = '\u00e9';
/** The same grapheme as U+0065 U+0301: a different string, a different member. */
const NFD_E_ACUTE: string = 'e\u0301';
/** Man + ZWJ + woman + ZWJ + girl: five code points, three of them astral. */
const ZWJ_FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
/** "a" + combining acute + combining cedilla. */
const COMBINING = 'a\u0301\u0327';

const UGLY_KEYS: readonly string[] = [
    '',
    '/',
    '~',
    '~0',
    '~1',
    'a/b',
    'a~b',
    "'",
    '\\',
    '"',
    '\n\t',
    'ключ',             // Cyrillic
    ZWJ_FAMILY,
    NFC_E_ACUTE,
    NFD_E_ACUTE,
    COMBINING,
    'x'.repeat(10_000),
    '~01~10~00~11/~',                       // every escape sequence at once
    ' leading and trailing ',
    '0',                                    // a name that looks like an index
    '01',                                   // a name that looks like a REJECTED index
    '-',                                    // a name that looks like the append token
];

/** A document whose members are exactly `keys`, plus JSON.parse ground truth. */
function documentOf(keys: readonly string[]): { text: string; truth: Record<string, unknown> } {
    const obj: Record<string, unknown> = {};
    keys.forEach((k, i) => { obj[k] = { tag: `value-${i}`, ordinal: i }; });
    return { text: JSON.stringify(obj), truth: obj };
}

function resolverOver(text: string, id: string): { resolver: Resolver; source: BufferSource } {
    const source = new BufferSource(Buffer.from(text, 'utf8'), id);
    return { resolver: new Resolver(StrideIndex.build(source)), source };
}

// ---------------------------------------------------------------------------

describe('the empty pointer and the member named ""', () => {
    it('reads "" as the whole document and "/" as one member whose name is empty', () => {
        expect(parsePointer(seenPointer('')), '"" is the document: no reference tokens at all').toEqual([]);
        expect(parsePointer(seenPointer('/')), '"/" is ONE reference token, and that token is the empty string')
            .toEqual([seenToken('')]);
    });

    it('keeps the two apart rather than treating "/" as another spelling of the root', () => {
        const doc = parsePointer('');
        const emptyMember = parsePointer('/');
        expect(doc.length, '"" must yield zero tokens').toBe(0);
        expect(emptyMember.length, '"/" must yield exactly one token').toBe(1);
        expect(
            doc.length === emptyMember.length,
            '"" and "/" must not parse to the same token list; conflating them is the classic defect',
        ).toBe(false);
    });

    it('reads "//" as two members each named the empty string', () => {
        expect(parsePointer(seenPointer('//')), '"//" is two empty-named tokens, not one and not zero')
            .toEqual(['', '']);
        expect(parsePointer(seenPointer('///')), '"///" is three empty-named tokens').toEqual(['', '', '']);
    });

    it('builds "/" as the pointer for the empty member name and parses it straight back', () => {
        const built = seenPointer(childPointer('', ''));
        expect(built, 'the pointer for the empty member name is "/" and nothing else').toBe('/');
        expect(parsePointer(built), 'the pointer just built must parse back to the name it was built from')
            .toEqual(['']);
    });

    it('places the empty member under the document, not beside it', () => {
        expect(parentPointer(''), 'the document has no parent').toBeNull();
        expect(lastToken(''), 'the document has no last reference token').toBeNull();
        expect(parentPointer('/'), 'the parent of the empty member is the document, spelled ""').toBe('');
        expect(lastToken('/'), 'the last token of "/" is the empty name, not null').toBe('');
        expect(parentPointer('//'), 'the parent of "//" is "/", the first empty member').toBe('/');
        expect(lastToken('//'), 'the last token of "//" is the empty name').toBe('');
    });

    it('rejects the empty reference token as an array index instead of reading element 0', () => {
        // cJSON's decoder treats "" as index 0, so `remove` at path "/" deletes
        // an array's first element. -1 here means "not an index at all".
        expect(tokenToIndex(seenToken('')), 'the empty token is not index 0; it is not an index').toBe(-1);
    });
});

describe('escape and unescape, in the order RFC 6901 section 4 requires', () => {
    it('decodes ~1 to a slash and ~0 to a tilde', () => {
        expect(unescapeToken(seenToken('~1')), '~1 decodes to "/"').toBe('/');
        expect(unescapeToken(seenToken('~0')), '~0 decodes to "~"').toBe('~');
    });

    it('decodes ~01 to ~1, which is the worked example RFC 6901 section 4 gives', () => {
        // The RFC states the wrong order's result explicitly so nobody has to
        // guess: unescaping ~0 first turns ~01 into ~1 and then into "/".
        const wrong = unescapeWrongOrder('~01');
        expect(wrong, 'sanity: the wrong order really does produce "/" for ~01').toBe('/');
        expect(unescapeToken(seenToken('~01')), 'RFC 6901 section 4: "~01" correctly becomes "~1"').toBe('~1');
        expect(
            unescapeToken('~01') === wrong,
            'the module must NOT agree with the ~0-first order, which yields "/" instead of "~1"',
        ).toBe(false);
    });

    it('decodes every two-character escape pair the way the RFC pass would', () => {
        for (const token of ['~', '/', '~0', '~1', '~01', '~10', '~00', '~11', '~0~1', '~1~0', '~001', '~011']) {
            expect(unescapeToken(seenToken(token)), `unescaping ${JSON.stringify(token)} must match an RFC-order pass`)
                .toBe(unescapeGroundTruth(token));
        }
        expect(unescapeToken('~10'), '~10 is "/" followed by a literal 0').toBe('/0');
        expect(unescapeToken('~00'), '~00 is "~" followed by a literal 0').toBe('~0');
        expect(unescapeToken('~11'), '~11 is "/" followed by a literal 1').toBe('/1');
    });

    it('escapes the tilde before the slash so the tilde it introduces is not escaped twice', () => {
        const witness = 'a~/b';
        const right = escapeToken(witness);
        const wrong = escapeWrongOrder(witness);
        expect(right, 'the tilde-first order gives a~0~1b').toBe('a~0~1b');
        expect(wrong, 'sanity: the slash-first order gives a different, broken token').toBe('a~0~01b');
        expect(right === wrong, 'the module must not use the slash-first order').toBe(false);
        expect(unescapeToken(right), 'only the tilde-first token round-trips').toBe(witness);
        expect(unescapeToken(wrong) === witness, 'the slash-first token does not round-trip, which is the bug').toBe(false);
    });

    it('round-trips a name that carries every escape sequence at once', () => {
        const key = '~01~10~00~11/~';
        const token = escapeToken(key);
        expect(token, 'every "~" becomes ~0 and every "/" becomes ~1').toBe('~001~010~000~011~1~0');
        expect(unescapeToken(token), 'the name survives the round trip byte for byte').toBe(key);
        expect(parsePointer(seenPointer(`/${token}`)), 'and survives it through a whole pointer').toEqual([key]);
    });

    it('round-trips every name of up to four characters drawn from the escaping alphabet', () => {
        // 781 names over {~ / 0 1 a}: exhaustive over the only characters that
        // can interact, which is stronger than a hand-picked list.
        const names = allStrings(['~', '/', '0', '1', 'a'], 4);
        expect(names.length, 'the sweep must actually be exhaustive over the alphabet').toBe(781);
        let checked = 0;
        for (const key of names) {
            const token = escapeToken(key);
            seenToken(token);
            expect(
                token.includes('/'),
                `escaped token for ${JSON.stringify(key)} must contain no raw slash, or it would split the pointer`,
            ).toBe(false);
            expect(unescapeToken(token), `unescape(escape(${JSON.stringify(key)})) must be the original name`).toBe(key);
            expect(
                parsePointer(seenPointer(`/${token}`)),
                `the pointer for ${JSON.stringify(key)} must parse back to exactly that one name`,
            ).toEqual([key]);
            checked++;
        }
        expect(checked, 'every name in the sweep was checked').toBe(names.length);
    });

    it('unescapes each token of a multi-token pointer independently', () => {
        const keys = ['a~b', 'c/d', '~', '/'];
        const pointer = seenPointer(keys.reduce((acc, k) => childPointer(acc, k), ''));
        expect(pointer, 'the assembled pointer escapes each name in place').toBe('/a~0b/c~1d/~0/~1');
        expect(parsePointer(pointer), 'each token unescapes to its own original name').toEqual(keys);
    });
});

describe('array reference tokens', () => {
    it('accepts the indices the RFC ABNF allows', () => {
        for (const [token, value] of [['0', 0], ['1', 1], ['9', 9], ['10', 10], ['4294967296', 4294967296],
            ['9007199254740991', 9007199254740991]] as const) {
            expect(tokenToIndex(seenToken(token)), `${JSON.stringify(token)} is a valid index`).toBe(value);
        }
    });

    it('rejects leading zeros, which the RFC ABNF forbids and an unanchored regex lets through', () => {
        // python-json-pointer validated with re.compile('0|[1-9][0-9]*$'). The
        // "0" alternative is unanchored, so it matched at position 0 of "01".
        // Reproduced here so the test states the defect instead of describing it.
        const unanchored = /0|[1-9][0-9]*$/;
        for (const token of ['01', '0123', '00', '000', '0000000001', '007']) {
            expect(
                unanchored.test(token),
                `sanity: the unanchored regex wrongly accepts ${JSON.stringify(token)}, which is why this matters`,
            ).toBe(true);
            expect(
                tokenToIndex(seenToken(token)),
                `${JSON.stringify(token)} has a leading zero and is not a valid array index`,
            ).toBe(-1);
        }
    });

    it('rejects signs, decimals, exponents, whitespace, the empty token and non-ASCII digits', () => {
        const rejected = [
            '+1', '-1', '1.0', '1e0', '1E0', ' 1', '1 ', '\t1', '1\n', '', '-', '+0', '-0',
            '0x1', '1_0', '1,0', 'NaN', 'Infinity', '1e+21', '.1', '1.', '٠', '１', '1٢', 'l', 'O',
        ];
        for (const token of rejected) {
            expect(
                tokenToIndex(seenToken(token)),
                `${JSON.stringify(token)} is not an array index and must not resolve to one`,
            ).toBe(-1);
        }
    });

    it('rejects an index past the largest integer a double represents exactly', () => {
        expect(tokenToIndex(seenToken('9007199254740991')), 'MAX_SAFE_INTEGER itself is representable').toBe(9007199254740991);
        for (const token of ['9007199254740992', '9007199254740993', '99999999999999999999',
            '1'.repeat(30), '9'.repeat(400)]) {
            expect(
                tokenToIndex(seenToken(token)),
                `${JSON.stringify(token)} exceeds MAX_SAFE_INTEGER and must be rejected, not silently rounded`,
            ).toBe(-1);
        }
    });

    it('agrees with the anchored RFC ABNF on every token of up to four digits', () => {
        // 11,110 tokens against a predicate written from the ABNF, not from the
        // implementation. Any answer that is right for the wrong reason shows up
        // as a disagreement somewhere in the sweep rather than nowhere.
        let checked = 0;
        let accepted = 0;
        for (let len = 1; len <= 4; len++) {
            const count = 10 ** len;
            for (let n = 0; n < count; n++) {
                const token = String(n).padStart(len, '0');
                const got = tokenToIndex(token);
                const want = isRfcIndex(token) ? Number(token) : -1;
                expect(got, `tokenToIndex(${JSON.stringify(token)}) must agree with the anchored RFC ABNF`).toBe(want);
                if (want >= 0) accepted++;
                checked++;
            }
        }
        expect(checked, 'the digit sweep must cover every 1-to-4 digit string').toBe(11110);
        expect(accepted, 'exactly the leading-zero-free tokens are accepted: 10 + 90 + 900 + 9000').toBe(10000);
    });

    it('builds the pointer for an index so that the index parses back out of it', () => {
        for (const i of [0, 1, 9, 10, 99, 1000, 4294967296, 9007199254740991]) {
            const pointer = seenPointer(indexPointer('', i));
            const tokens = parsePointer(pointer);
            expect(tokens.length, `the pointer for element ${i} must be one token`).toBe(1);
            expect(
                tokenToIndex(tokens[0] ?? ''),
                `the index STRIDE emits for element ${i} must be the index STRIDE reads back`,
            ).toBe(i);
        }
    });

    it('does not guard indexPointer against a caller passing something that is not an index', () => {
        // Pinned as a lenience, not endorsed: indexPointer interpolates whatever
        // number it is handed, so a caller with a non-integer ordinal would emit
        // an address tokenToIndex rejects. Every call site in the package passes
        // a counted ordinal, so this is latent; the assertion exists so that if a
        // guard is added, or a caller starts passing something else, one of the
        // two halves of this test changes and the change is visible.
        for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
            const pointer = seenPointer(indexPointer('', bad));
            const tokens = parsePointer(pointer);
            expect(tokens.length, `indexPointer emits a single token even for ${String(bad)}`).toBe(1);
            expect(
                tokenToIndex(tokens[0] ?? ''),
                `and that token is NOT readable back as an index, so ${String(bad)} must never reach it`,
            ).toBe(-1);
        }
    });
});

describe('the "-" token, whose handling RFC 6901 leaves to the application', () => {
    // RFC 6901: "-" "will always result in [an] error condition because by
    // definition it refers to a nonexistent array element. Thus, applications of
    // JSON Pointer need to specify how that character is to be handled". STRIDE
    // is a READ path, so it specifies: "-" is not an index, and resolving it
    // against an array is `not_found` — never the last element, never index 0,
    // never a silent append slot. These tests pin that choice.

    it('reads "-" as a legal reference token that is not an array index', () => {
        expect(parsePointer(seenPointer('/-')), '"-" parses as an ordinary reference token').toEqual([seenToken('-')]);
        expect(tokenToIndex('-'), '"-" is not an array index').toBe(-1);
    });

    it('fails to resolve "-" against an array instead of returning the last element', () => {
        const { resolver, source } = resolverOver('[10,20,30]', 'dash-array');
        const last = resolver.resolve(seenPointer('/2'));
        expect(source.slice(last.start, last.end).toString('utf8'), 'element 2 is the last element').toBe('30');
        expectStrideFailure(() => { resolver.resolve('/-'); }, 'not_found', 'resolving "/-" against an array');
        expectStrideFailure(() => { resolver.resolve('/3'); }, 'not_found', 'resolving one past the last element');
    });

    it('still resolves "-" as an object member name, because it is only special for arrays', () => {
        const { resolver, source } = resolverOver(JSON.stringify({ '-': 'dash-member', a: 1 }), 'dash-object');
        const node = resolver.resolve(seenPointer('/-'));
        expect(source.slice(node.start, node.end).toString('utf8'), 'an object member literally named "-" resolves')
            .toBe('"dash-member"');
    });

    it('fails to resolve every rejected index token against an array, one by one', () => {
        const { resolver } = resolverOver('[10,20,30]', 'rejected-tokens');
        for (const token of ['', '-', '01', '00', '007', '+1', '-1', '1.0', '1e0', ' 1', '1 ',
            '3', '9007199254740992']) {
            expectStrideFailure(
                () => { resolver.resolve(seenPointer(`/${token}`)); },
                'not_found',
                `resolving array token ${JSON.stringify(token)}`,
            );
        }
    });
});

describe('pointers that are not RFC 6901 at all', () => {
    it('rejects a pointer that is neither empty nor slash-led, naming a recovery', () => {
        for (const bad of ['foo', '~', 'a/b', ' /a', '#/a', '0', '-', 'records/0', '\\/a', '\u00a0/a']) {
            expectStrideFailure(() => { parsePointer(bad); }, 'bad_pointer', `parsing ${JSON.stringify(bad)}`);
        }
    });

    it('quotes the offending pointer in the message so the caller can see what was received', () => {
        const o = run(() => { parsePointer('records/0'); });
        expect(o.kind, 'a non-slash-led pointer must raise a StrideError').toBe('stride');
        if (o.kind !== 'stride') return;
        expect(
            o.error.message.includes(JSON.stringify('records/0')),
            `the message must quote the received pointer, got ${JSON.stringify(o.error.message)}`,
        ).toBe(true);
        expect(o.error.at, 'a pointer syntax failure is not positional in the document').toBeNull();
    });

    it('never lets a bare Error escape any pointer entry point, over a random sweep', () => {
        // The failure mode being excluded is a TypeError or RangeError leaking
        // out of a parse. Seeded so a failing input is reproducible.
        const rnd = mulberry32(0x5eed_1234);
        const alphabet = ['/', '~', '0', '1', '-', '+', 'a', ' ', '\t', '\n', '\\', '"',
            'é', '\u{1f600}', '\u0301', '\ud800', '\udfff', '.', 'e', ' '];
        for (let i = 0; i < 4000; i++) {
            const len = Math.floor(rnd() * 12);
            let s = '';
            for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)] ?? 'a';
            seenPointer(s);
            for (const [name, fn] of [
                ['parsePointer', () => { parsePointer(s); }],
                ['parentPointer', () => { parentPointer(s); }],
                ['lastToken', () => { lastToken(s); }],
                ['tokenToIndex', () => { tokenToIndex(s); }],
                ['escapeToken', () => { escapeToken(s); }],
                ['unescapeToken', () => { unescapeToken(s); }],
                ['childPointer', () => { childPointer('', s); }],
            ] as readonly [string, () => void][]) {
                const o = run(fn);
                expect(
                    o.kind === 'other',
                    `${name}(${JSON.stringify(s)}) leaked a non-StrideError: ${describeOutcome(o)}`,
                ).toBe(false);
                if (o.kind === 'stride') {
                    expect(
                        FAILURES.includes(o.error.failure),
                        `${name}(${JSON.stringify(s)}) raised failure ${JSON.stringify(o.error.failure)}, which is outside the closed set`,
                    ).toBe(true);
                    expect(
                        o.error.recovery.length > 0,
                        `${name}(${JSON.stringify(s)}) raised a StrideError with an empty recovery`,
                    ).toBe(true);
                }
            }
        }
    });

    it('treats a "~" not followed by 0 or 1 as a literal, which the RFC ABNF does not permit', () => {
        // RFC 6901 section 3: unescaped excludes %x7E, and escaped is
        // "~" ( "0" / "1" ) -- so "~2", a trailing "~", and "~9" are not valid
        // reference tokens and a strict reader would reject them. pointer.ts
        // instead copies them through as literal characters. That is a LENIENCE,
        // not a wrong answer: "/~2" resolves to a member literally named "~2",
        // and STRIDE's own canonical pointer for that member is "/~02", so the
        // lenient form is an accepted alias for a correct address rather than a
        // route to the wrong one. It is pinned here because resolve.ts carries a
        // cache guard that exists only because of it, so anyone tightening the
        // parser needs to find this test first.
        expect(parsePointer(seenPointer('/~2')), '"~2" is copied through as two literal characters').toEqual(['~2']);
        expect(parsePointer(seenPointer('/~')), 'a trailing "~" is copied through').toEqual(['~']);
        expect(parsePointer(seenPointer('/a~')), 'a "~" at the end of a token is copied through').toEqual(['a~']);
        expect(parsePointer(seenPointer('/~9')), '"~9" is copied through').toEqual(['~9']);

        const { resolver, source } = resolverOver(JSON.stringify({ '~2': 'tilde-two' }), 'tilde-two');
        const canonical = seenPointer(childPointer('', '~2'));
        expect(canonical, 'the canonical pointer for the member named "~2" escapes the tilde').toBe('/~02');
        const viaCanonical = resolver.resolve(canonical);
        const viaAlias = resolver.resolve(seenPointer('/~2'));
        expect(
            source.slice(viaCanonical.start, viaCanonical.end).toString('utf8'),
            'the canonical pointer reaches the member',
        ).toBe('"tilde-two"');
        expect(
            viaAlias.start === viaCanonical.start && viaAlias.end === viaCanonical.end,
            'the lenient alias reaches the SAME member, so the lenience never returns a wrong node',
        ).toBe(true);
        expect(viaCanonical.pointer, 'the node reports its canonical pointer').toBe('/~02');
    });

    it('does not validate the pointer handed to parentPointer or lastToken', () => {
        // Pinned as a lenience. resolve.ts calls parsePointer BEFORE it calls
        // parentPointer for exactly this reason, and says so in a comment; this
        // assertion is what makes that ordering a tested requirement rather than
        // a remark, because on its own parentPointer maps a stray "foo" to the
        // document root, which is the quiet failure parsePointer exists to stop.
        expect(parentPointer('foo'), 'parentPointer does not reject a non-slash-led pointer').toBe('');
        expect(lastToken('foo'), 'lastToken reads the whole string as one token').toBe('foo');
        expectStrideFailure(() => { parsePointer('foo'); }, 'bad_pointer', 'parsePointer, which does reject it');
    });
});

describe('every address STRIDE emits is an address STRIDE accepts', () => {
    it('parses a built pointer back to the exact member name it was built from', () => {
        for (const key of UGLY_KEYS) {
            const pointer = seenPointer(childPointer('', key));
            const tokens = parsePointer(pointer);
            expect(tokens.length, `the pointer for ${JSON.stringify(key.slice(0, 32))} must hold one token`).toBe(1);
            expect(
                tokens[0],
                `the token must equal the original name exactly, for ${JSON.stringify(key.slice(0, 32))}`,
            ).toBe(key);
        }
    });

    it('parses a built pointer back at depth, one awkward name per level', () => {
        const pointer = seenPointer(UGLY_KEYS.reduce((acc, k) => childPointer(acc, k), ''));
        expect(parsePointer(pointer), 'every level of a deep pointer of awkward names round-trips')
            .toEqual(UGLY_KEYS);
        expect(
            parentPointer(pointer),
            'and the parent of that pointer is the same pointer minus its last level',
        ).toBe(UGLY_KEYS.slice(0, -1).reduce((acc, k) => childPointer(acc, k), ''));
        expect(lastToken(pointer), 'and its last token is the last name, unescaped')
            .toBe(UGLY_KEYS[UGLY_KEYS.length - 1] ?? '');
    });

    it('lands on the member JSON.parse says the name belongs to, for every awkward name', () => {
        // The direction that catches a self-consistently wrong implementation:
        // ground truth is JSON.parse of the whole document, not another STRIDE
        // route. Note UGLY_KEYS[0] is "" -- see the KNOWN DEFECT block below for
        // the one name this cannot reach.
        const keys = UGLY_KEYS.filter((k) => k !== '');
        const { text, truth } = documentOf(keys);
        const { resolver, source } = resolverOver(text, 'ugly-members');
        for (const key of keys) {
            const pointer = seenPointer(childPointer('', key));
            const node = resolver.resolve(pointer);
            const bytes = source.slice(node.start, node.end).toString('utf8');
            expect(
                JSON.parse(bytes),
                `resolving ${JSON.stringify(pointer.slice(0, 40))} must land on the value JSON.parse puts at ${JSON.stringify(key.slice(0, 32))}`,
            ).toEqual(truth[key]);
            expect(
                node.pointer,
                `the resolved node must report the same canonical pointer it was reached by, for ${JSON.stringify(key.slice(0, 32))}`,
            ).toBe(pointer);
        }
    });

    it('reaches a nested awkward name through a pointer built one level at a time', () => {
        const inner = { 'a/b': { '~': { 'é': 'deep' } } };
        const { resolver, source } = resolverOver(JSON.stringify(inner), 'nested-ugly');
        const pointer = seenPointer(['a/b', '~', 'é'].reduce((acc, k) => childPointer(acc, k), ''));
        expect(pointer, 'each level is escaped independently').toBe('/a~1b/~0/é');
        const node = resolver.resolve(pointer);
        expect(
            source.slice(node.start, node.end).toString('utf8'),
            'the nested pointer lands on the innermost value',
        ).toBe('"deep"');
    });
});

// ---------------------------------------------------------------------------
// The second half of invariant I8 ("/" is the member named "") and the
// governing emit/accept rule, on the route that used to break both.
//
// pointer.ts was always correct here -- parsePointer("/") returns [""] and
// childPointer("", "") returns "/". The break was downstream, in the index's
// dense child table: index.ts stored a member name by offset and length into a
// key blob and read it back as
//     key: kl === 0 ? null : this.keyBlob.toString(...)
// so a member whose name is the empty string was indistinguishable from an
// ARRAY ELEMENT, which legitimately has no name. `memberNamed` compares
// `k.key === key`, null never equals "", and the member could not be found.
// Recorded lengths are now biased by one, with 0 reserved for "no name at all",
// so the two cases no longer share a representation.
//
// It was route-dependent, which is why it survived so long: containers with
// more than DENSE_CHILD_LIMIT members are checkpointed rather than dense, and
// the checkpointed route reads names out of the document and always got ""
// right. So the wide case passed and the narrow case failed -- and almost every
// hand-written fixture is narrow. The last case here is that wide control, kept
// because it is what localises a future regression to one route.
// ---------------------------------------------------------------------------

describe('the member named "" is addressable in a densely indexed container', () => {
    it('resolves "/" to the empty-named member of a small object, as I8 requires', () => {
        const truth: Record<string, unknown> = { '': 'EMPTY-NAME', a: 1, b: 2 };
        const { resolver, source } = resolverOver(JSON.stringify(truth), 'dense-empty-name');
        const root = resolver.root();
        expect(
            root.count <= DENSE_CHILD_LIMIT,
            'the fixture must be small enough to take the dense route, which is the broken one',
        ).toBe(true);
        const node = resolver.resolve(seenPointer('/'));
        expect(
            JSON.parse(source.slice(node.start, node.end).toString('utf8')),
            'resolving "/" must land on the member named "", not fail: RFC 6901 and invariant I8',
        ).toBe('EMPTY-NAME');
    });

    it('enumerates the empty-named member of a small object with a name, not with null', () => {
        const { resolver } = resolverOver(JSON.stringify({ '': 1, a: 2 }), 'dense-empty-enumerate');
        const members = resolver.members(resolver.root(), 0, 8);
        expect(members.length, 'both members are enumerated').toBe(2);
        expect(
            members[0]?.key,
            'the empty-named member must report its name as "", not null; null means "array element, no name"',
        ).toBe('');
    });

    it('finds the empty-named member of a small object by name', () => {
        const { resolver } = resolverOver(JSON.stringify({ '': 1, a: 2 }), 'dense-empty-bykey');
        const member = resolver.memberByKey(resolver.root(), '');
        expect(
            member === null,
            'memberByKey("") must find the member named "" in a densely indexed object',
        ).toBe(false);
    });

    it('resolves "/a/" to the empty-named member nested inside a small object', () => {
        const { resolver, source } = resolverOver(JSON.stringify({ a: { '': 'NESTED-EMPTY' } }), 'dense-empty-nested');
        const node = resolver.resolve(seenPointer('/a/'));
        expect(
            JSON.parse(source.slice(node.start, node.end).toString('utf8')),
            'the trailing empty token addresses the member named "" one level down',
        ).toBe('NESTED-EMPTY');
    });

    it('accepts the pointer it emits for an empty-named member of a small object', () => {
        // The governing rule, stated as one assertion: build the address with
        // STRIDE's own constructor, hand it straight back to STRIDE.
        const { resolver } = resolverOver(JSON.stringify({ '': 'x', a: 1 }), 'dense-empty-emit-accept');
        const emitted = seenPointer(childPointer('', ''));
        const o = run(() => { resolver.resolve(emitted); });
        expect(
            describeOutcome(o),
            `STRIDE emits ${JSON.stringify(emitted)} for the empty member name, so it must accept it; got ${describeOutcome(o)}`,
        ).toBe('returned normally');
    });

    it('already handles the same member correctly once the container is checkpointed', () => {
        // The control. Same member name, same pointer, wide container: this
        // passes, which localises the defect to the dense route rather than to
        // pointer.ts or to the resolver's descent.
        const wide: Record<string, unknown> = { '': 'EMPTY-NAME-WIDE' };
        for (let i = 0; i < DENSE_CHILD_LIMIT * 4; i++) wide[`k${i}`] = 'p'.repeat(40);
        const { resolver, source } = resolverOver(JSON.stringify(wide), 'wide-empty-name');
        expect(
            resolver.root().count > DENSE_CHILD_LIMIT,
            'the control fixture must be wide enough to take the checkpointed route',
        ).toBe(true);
        const node = resolver.resolve(seenPointer('/'));
        expect(
            JSON.parse(source.slice(node.start, node.end).toString('utf8')),
            'the checkpointed route already resolves "/" to the member named ""',
        ).toBe('EMPTY-NAME-WIDE');
    });
});

describe('Unicode member names', () => {
    it('keeps names that differ only by normalisation form as the distinct names JSON says they are', () => {
        expect(NFC_E_ACUTE === NFD_E_ACUTE, 'sanity: the two forms are different JS strings').toBe(false);
        expect(
            NFC_E_ACUTE.normalize('NFC') === NFD_E_ACUTE.normalize('NFC'),
            'sanity: and they are the same string once normalised, which is the trap',
        ).toBe(true);

        const nfcPointer = seenPointer(childPointer('', NFC_E_ACUTE));
        const nfdPointer = seenPointer(childPointer('', NFD_E_ACUTE));
        expect(nfcPointer === nfdPointer, 'the two names must produce different pointers').toBe(false);
        expect(parsePointer(nfcPointer), 'the composed name round-trips as composed').toEqual([NFC_E_ACUTE]);
        expect(parsePointer(nfdPointer), 'the decomposed name round-trips as decomposed').toEqual([NFD_E_ACUTE]);

        const truth: Record<string, unknown> = {};
        truth[NFC_E_ACUTE] = 'composed';
        truth[NFD_E_ACUTE] = 'decomposed';
        expect(Object.keys(truth).length, 'sanity: JSON treats them as two members').toBe(2);
        const { resolver, source } = resolverOver(JSON.stringify(truth), 'normalisation');
        const a = resolver.resolve(nfcPointer);
        const b = resolver.resolve(nfdPointer);
        expect(
            source.slice(a.start, a.end).toString('utf8'),
            'the composed pointer reaches the composed member',
        ).toBe('"composed"');
        expect(
            source.slice(b.start, b.end).toString('utf8'),
            'the decomposed pointer reaches the decomposed member, not the composed one',
        ).toBe('"decomposed"');
        expect(a.start === b.start, 'the two members must occupy different spans').toBe(false);
    });

    it('round-trips names whose UTF-8 byte length differs from their code-unit length', () => {
        for (const key of [ZWJ_FAMILY, COMBINING, 'ключ', '\u{1f600}\ufe0f', 'あい']) {
            const pointer = seenPointer(childPointer('', key));
            expect(
                Buffer.byteLength(pointer, 'utf8') === pointer.length,
                `sanity: ${JSON.stringify(key)} must be a name where bytes and code units disagree`,
            ).toBe(false);
            expect(parsePointer(pointer), `the name ${JSON.stringify(key)} survives the round trip`).toEqual([key]);
        }
    });

    it('resolves an emoji ZWJ sequence and a combining-mark name to the right members', () => {
        const truth: Record<string, unknown> = {};
        truth[ZWJ_FAMILY] = 'family';
        truth[COMBINING] = 'combining';
        truth['a'] = 'plain';
        const { resolver, source } = resolverOver(JSON.stringify(truth), 'unicode-members');
        for (const [key, want] of Object.entries(truth)) {
            const node = resolver.resolve(seenPointer(childPointer('', key)));
            expect(
                JSON.parse(source.slice(node.start, node.end).toString('utf8')),
                `the pointer for ${JSON.stringify(key)} must land on its own member`,
            ).toBe(want);
        }
    });

    it('does not split a name on a character that merely looks like a separator', () => {
        // U+2044 FRACTION SLASH and U+FF0F FULLWIDTH SOLIDUS are not %x2F and
        // must be carried through untouched rather than escaped or split on.
        for (const key of ['a⁄b', 'a／b', 'a∼b']) {
            const token = escapeToken(key);
            expect(token, `${JSON.stringify(key)} contains no character needing an escape`).toBe(key);
            expect(parsePointer(seenPointer(`/${token}`)), `${JSON.stringify(key)} stays one token`).toEqual([key]);
        }
    });
});

describe('deep pointers', () => {
    it('parses a two-thousand-token pointer without overflowing the stack', () => {
        const keys = Array.from({ length: 2000 }, (_, i) => `k${i}`);
        const pointer = seenPointer(`/${keys.join('/')}`);
        const tokens = parsePointer(pointer);
        expect(tokens.length, 'every one of the 2,000 reference tokens is returned').toBe(2000);
        expect(tokens[0], 'the first token is the first name').toBe('k0');
        expect(tokens[1999], 'the last token is the last name').toBe('k1999');
    });

    it('parses a two-thousand-token pointer whose every token carries escapes', () => {
        const key = '~01~1a';
        let built = '';
        for (let i = 0; i < 2000; i++) built = childPointer(built, key);
        const pointer = seenPointer(built);
        const tokens = parsePointer(pointer);
        expect(tokens.length, 'the escaped deep pointer yields 2,000 tokens').toBe(2000);
        const distinct = new Set(tokens);
        expect(distinct.size, 'every token unescapes to the same one name').toBe(1);
        expect(tokens[1999], 'and that name is the original, not a partially decoded form').toBe(key);
    });

    it('parses a twenty-thousand-token pointer, so the split is iterative rather than recursive', () => {
        const pointer = seenPointer('/k'.repeat(20_000));
        expect(parsePointer(pointer).length, 'a 20,000-token pointer parses').toBe(20_000);
    });

    it('fails a malformed deep pointer as a StrideError rather than a RangeError', () => {
        const deep = 'k'.concat('/k'.repeat(2000));
        expectStrideFailure(() => { parsePointer(deep); }, 'bad_pointer', 'a 2,000-token pointer missing its leading slash');
        const o = run(() => { parsePointer('~'.concat('/k'.repeat(5000))); });
        expect(
            describeOutcome(o),
            `a 5,000-token malformed pointer must not raise a RangeError; got ${describeOutcome(o)}`,
        ).toBe('StrideError(bad_pointer)');
    });

    it('fails a deep pointer whose last token is missing as not_found, naming how far it got', () => {
        let text = '1';
        for (let i = 0; i < 2000; i++) text = `{"k":${text}}`;
        const { resolver, source } = resolverOver(text, 'deep-doc');
        const good = seenPointer('/k'.repeat(2000));
        const node = resolver.resolve(good);
        expect(source.slice(node.start, node.end).toString('utf8'), 'the full-depth pointer resolves').toBe('1');
        expect(node.depth, 'and reports the depth it reached').toBe(2000);
        expectStrideFailure(
            () => { resolver.resolve(seenPointer('/k'.repeat(1999).concat('/nope'))); },
            'not_found',
            'a deep pointer whose last token names no member',
        );
        expectStrideFailure(
            () => { resolver.resolve(seenPointer('/k'.repeat(2000).concat('/further'))); },
            'not_found',
            'a pointer that descends past a scalar',
        );
    });
});
