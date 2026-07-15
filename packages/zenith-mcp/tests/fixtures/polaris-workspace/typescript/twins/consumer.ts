import { fetchTwinData } from './twin-a';

export function loadTwins(): string {
    return fetchTwinData();
}
