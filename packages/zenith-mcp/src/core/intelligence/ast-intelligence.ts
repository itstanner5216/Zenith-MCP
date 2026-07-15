/**
 * POLARIS — the single public door to AST intelligence (plan §Public
 * contracts; facade frozen after Wave 2).
 *
 * Exactly three functions cross this boundary: openAstSession and the two
 * advisory lifecycle functions. Every public type is defined in ./types.js
 * and re-exported ONLY here. The advisory functions hold their frozen
 * signatures and return typed `unavailable` outcomes until Wave 6 implements
 * the two-stage capture/evaluate protocol.
 *
 * No SQLite row ID, storage key, connection, or internal session state
 * crosses this file.
 */

import type {
    EditAfterInput, EditAdvisoryResult, EditBaselineCaptureResult,
    EditBaselineInput, EditBaselineToken, FsContext, OpenSessionRequest, OpenSessionResult,
} from './types.js';
import { openAstSessionWithDeps } from './session.js';

export type * from './types.js';
export { FACT_LEDGER, PERSISTENCE_FAMILY_DOMAINS } from './types.js';
export { LOCKED_BOUNDS, PROVISIONAL_LIMITS } from './limits.js';

/**
 * Open a structural intelligence session: route the anchor through
 * ProjectContext, enumerate and freshen the requested domain, apply exact
 * in-hand content, pin the source-domain digest and fact epoch, and return
 * the seven-query session. Never throws for in-domain inputs — failures are
 * typed OpenSessionResult arms with a partial-content receipt.
 */
export function openAstSession(
    ctx: FsContext,
    request: OpenSessionRequest,
): Promise<OpenSessionResult> {
    return openAstSessionWithDeps(ctx, request);
}

/**
 * Stage one of the edit-advisory protocol (Wave 6). The signature is frozen
 * now; until the advisory engine exists this returns a typed unavailable
 * outcome so clients can already integrate against the real contract.
 */
export async function captureEditBaseline(
    ctx: FsContext,
    files: readonly EditBaselineInput[],
): Promise<EditBaselineCaptureResult> {
    void ctx;
    void files;
    return {
        status: 'unavailable',
        reason: 'question_kind_unsupported',
        issues: ['semantic_pending'],
    };
}

/**
 * Stage two of the edit-advisory protocol (Wave 6). Frozen signature; typed
 * unavailable until the advisory engine lands.
 */
export async function evaluateEditAdvisories(
    baseline: EditBaselineToken,
    files: readonly EditAfterInput[],
): Promise<EditAdvisoryResult> {
    void baseline;
    void files;
    return {
        status: 'unavailable',
        advisories: [],
        suppressedCount: 0,
        reason: 'semantic_unavailable',
        issues: ['semantic_pending'],
    };
}
