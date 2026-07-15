export interface Result {
    ok: boolean;
}

export function Result(ok: boolean): Result {
    return { ok };
}

export function makeResult(): Result {
    return Result(true);
}
