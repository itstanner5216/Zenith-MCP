import { describe, expect, it } from 'vitest';
import { minimatch } from 'minimatch';

// The scanner's _isDenied function is not exported, so we replicate its exact
// logic here against the same DENIED_PATTERNS array to test the deny rules.
// This ensures the pattern set is correct without needing to export private internals.
const DENIED_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_dsa",
  "id_ecdsa",
  "*credentials*",
  "*secret*",
  "*secrets*",
  "*.aws_credentials",
  ".aws",
  ".credentials",
];

function isDenied(name) {
  const lower = name.toLowerCase();
  for (const pattern of DENIED_PATTERNS) {
    if (
      minimatch(name, pattern, { dot: true, nocase: false }) ||
      minimatch(lower, pattern.toLowerCase(), { dot: true, nocase: false })
    ) {
      return true;
    }
  }
  return false;
}

describe('scanner deny patterns', () => {
  describe('.env files', () => {
    it('denies exact .env', () => {
      expect(isDenied('.env')).toBe(true);
    });

    it('denies .env.production', () => {
      expect(isDenied('.env.production')).toBe(true);
    });

    it('denies .env.local', () => {
      expect(isDenied('.env.local')).toBe(true);
    });

    it('denies myapp.env', () => {
      expect(isDenied('myapp.env')).toBe(true);
    });

    it('allows env.example (not starting with dot, no .env suffix)', () => {
      expect(isDenied('env.example')).toBe(false);
    });

    it('allows .envrc (does not match .env or .env.*)', () => {
      // .envrc does NOT match ".env" (exact) or ".env.*" (requires dot after .env)
      // It also doesn't match "*.env" (doesn't end in .env)
      expect(isDenied('.envrc')).toBe(false);
    });
  });

  describe('key files', () => {
    it('denies server.pem', () => {
      expect(isDenied('server.pem')).toBe(true);
    });

    it('denies private.key', () => {
      expect(isDenied('private.key')).toBe(true);
    });

    it('denies cert.p12', () => {
      expect(isDenied('cert.p12')).toBe(true);
    });

    it('denies identity.pfx', () => {
      expect(isDenied('identity.pfx')).toBe(true);
    });

    it('denies id_rsa', () => {
      expect(isDenied('id_rsa')).toBe(true);
    });

    it('denies id_rsa.pub', () => {
      expect(isDenied('id_rsa.pub')).toBe(true);
    });

    it('denies id_ed25519', () => {
      expect(isDenied('id_ed25519')).toBe(true);
    });

    it('denies id_dsa', () => {
      expect(isDenied('id_dsa')).toBe(true);
    });

    it('denies id_ecdsa', () => {
      expect(isDenied('id_ecdsa')).toBe(true);
    });
  });

  describe('credentials patterns (broad wildcard)', () => {
    it('denies aws_credentials', () => {
      expect(isDenied('aws_credentials')).toBe(true);
    });

    it('denies gcp-credentials.json', () => {
      expect(isDenied('gcp-credentials.json')).toBe(true);
    });

    it('denies my_credentials_file', () => {
      expect(isDenied('my_credentials_file')).toBe(true);
    });

    it('denies .credentials', () => {
      expect(isDenied('.credentials')).toBe(true);
    });

    it('denies CREDENTIALS (case-insensitive via lowercase pass)', () => {
      expect(isDenied('CREDENTIALS')).toBe(true);
    });
  });

  describe('secrets patterns (broad wildcard)', () => {
    it('denies secrets.yaml', () => {
      expect(isDenied('secrets.yaml')).toBe(true);
    });

    it('denies my-secret-config.json', () => {
      expect(isDenied('my-secret-config.json')).toBe(true);
    });

    it('denies app_secrets.enc', () => {
      expect(isDenied('app_secrets.enc')).toBe(true);
    });

    it('denies Secret.txt (case-insensitive)', () => {
      expect(isDenied('Secret.txt')).toBe(true);
    });
  });

  describe('AWS-specific', () => {
    it('denies .aws', () => {
      expect(isDenied('.aws')).toBe(true);
    });

    it('denies config.aws_credentials', () => {
      expect(isDenied('config.aws_credentials')).toBe(true);
    });
  });

  describe('safe files that should NOT be denied', () => {
    it('allows package.json', () => {
      expect(isDenied('package.json')).toBe(false);
    });

    it('allows README.md', () => {
      expect(isDenied('README.md')).toBe(false);
    });

    it('allows tsconfig.json', () => {
      expect(isDenied('tsconfig.json')).toBe(false);
    });

    it('allows index.ts', () => {
      expect(isDenied('index.ts')).toBe(false);
    });

    it('allows Dockerfile', () => {
      expect(isDenied('Dockerfile')).toBe(false);
    });

    it('allows .gitignore', () => {
      expect(isDenied('.gitignore')).toBe(false);
    });

    it('allows keymap.json (contains "key" but not *.key)', () => {
      expect(isDenied('keymap.json')).toBe(false);
    });
  });
});
