export class Outer {
    compute(): number { return this.nestHelper() + nestInner(); }
    nestHelper(): number { return 1; }
}

function nestInner(): number { return 2; }

export type Shape = { area: number };
