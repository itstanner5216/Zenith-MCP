/**
 * Static category defaults for Tier-4 and namespace priority for Tier-6.
 * Converted from src/zenithmcp/retrieval/static_categories.py
 */

export const STATIC_CATEGORIES: Record<string, { always: string[]; likely?: string[] }> = {
  node_web: {
    always: ["filesystem", "shell", "web_search"],
    likely: ["github", "npm", "docker", "jest"],
  },
  python_web: {
    always: ["filesystem", "shell", "web_search"],
    likely: ["github", "pip", "docker", "pytest"],
  },
  rust_cli: {
    always: ["filesystem", "shell", "web_search"],
    likely: ["github", "cargo"],
  },
  infrastructure: {
    always: ["filesystem", "shell", "web_search"],
    likely: ["terraform", "kubectl", "docker", "helm"],
  },
  generic: {
    always: ["filesystem", "shell", "web_search", "github"],
  },
};

export const TIER6_NAMESPACE_PRIORITY: string[] = [
  "filesystem", "shell", "web_search", "github",
  "docker", "npm", "pip", "cargo",
  "kubectl", "terraform", "slack", "context7",
];

