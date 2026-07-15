export default function primaryFn(n: number): number {
    return n;
}

export function importHelper(n: number): number {
    return n + 1;
}

export function plainFn(n: number): number {
    return n;
}

export interface OnlyType {
    tag: string;
}

export type PureType = { id: number };
