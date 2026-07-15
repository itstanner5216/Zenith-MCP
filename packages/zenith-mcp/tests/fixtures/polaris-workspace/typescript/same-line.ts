export function slAdd(n: number): number {
    return n + 1;
}

export function slDouble(n: number): number {
    return slAdd(n) + slAdd(n);
}
