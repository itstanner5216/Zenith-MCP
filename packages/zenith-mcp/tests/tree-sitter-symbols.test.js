import { describe, expect, it } from 'vitest';
import { getDefinitions } from '../dist/core/tree-sitter.js';

describe('tree-sitter TS symbol queries', () => {
    it('captures wrapped arrow-function exports in TypeScript', async () => {
        const source = `
export const Button = React.memo((props) => {
    return props.label;
});

export const Input = forwardRef((props, ref) => {
    return ref;
});
`;

        const defs = await getDefinitions(source, 'typescript');
        const names = defs.map(def => def.name);

        expect(names).toContain('Button');
        expect(names).toContain('Input');
    });

    it('captures callable object properties in satisfies objects', async () => {
        const source = `
export const routes = {
    home: () => {
        return 'home';
    },
    about: () => {
        return 'about';
    },
} satisfies RouteMap;
`;

        const defs = await getDefinitions(source, 'typescript');
        const methods = defs
            .filter(def => def.type === 'method')
            .map(def => def.name);

        expect(methods).toContain('home');
        expect(methods).toContain('about');
    });

    it('captures wrapped arrow-function exports in TSX', async () => {
        const source = `
type Props = { label: string };

export const Button = React.memo((props: Props) => {
    return <button>{props.label}</button>;
});
`;

        const defs = await getDefinitions(source, 'tsx');
        const names = defs.map(def => def.name);

        expect(names).toContain('Button');
    });
});

describe('tree-sitter bash symbol queries', () => {
    it('captures bash functions and variable assignments', async () => {
        const source = `
CONFIG_PATH="/tmp/config.json"
PROMPT=$(cat)

json_field_or_empty() {
  local input="$1"
  printf '%s' "$input"
}
`;

        const defs = await getDefinitions(source, 'bash');
        const names = defs.map(def => `${def.name}:${def.type}`);

        expect(names).toContain('CONFIG_PATH:variable');
        expect(names).toContain('PROMPT:variable');
        expect(names).toContain('json_field_or_empty:function');
    });
});
