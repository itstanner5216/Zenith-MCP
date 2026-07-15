import { originFn } from './direct';
import * as starNs from './star';

export function useOrigin(): number {
    return originFn() + starNs.originFn();
}
