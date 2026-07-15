import primaryFn, { importHelper as aliasedHelper, type OnlyType, plainFn } from './import-target';
import * as targetNs from './import-target';
import type { PureType } from './import-target';

export function useImports(n: number): number {
    return aliasedHelper(plainFn(primaryFn(n))) + targetNs.importHelper(n);
}
