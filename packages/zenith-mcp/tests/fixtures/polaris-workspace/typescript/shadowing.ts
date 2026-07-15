export function shFormat(value: number): string {
    return `${value}`;
}

export function shReport(shFormat: (n: number) => string, n: number): string {
    return shFormat(n);
}
