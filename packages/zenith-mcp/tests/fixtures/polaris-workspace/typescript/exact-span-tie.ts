export const tieBreaker = (n: number): number => n * 2;

export function useTie(): number {
    return tieBreaker(4);
}
