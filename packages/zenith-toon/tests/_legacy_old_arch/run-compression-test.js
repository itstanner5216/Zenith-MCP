import fs from 'node:fs';
import path from 'node:path';
import { compressString, compressSourceStructured } from '../packages/zenith-toon/dist/string-codec.js';
import { getCompressionStructure } from '../packages/zenith-mcp/dist/core/tree-sitter/compression-structure.js';

const files = [
  { name: 'test-python.py', lang: 'python' },
  { name: 'test-rust.rs', lang: 'rust' },
  { name: 'test-typescript.ts', lang: 'typescript' }
];

async function main() {
  for (const file of files) {
    console.log(`Processing ${file.name}...`);
    const sourcePath = path.join('tests', file.name);
    const source = fs.readFileSync(sourcePath, 'utf8');

    const budget = Math.floor(source.length * 0.3); // Compress to 30%

    // Text-only compression
    console.log(`  Text compression (budget: ${budget}/${source.length} chars)`);
    const textCompressed = compressString(source, budget);
    fs.writeFileSync(path.join('tests/compression-text', file.name), textCompressed);

    // AST compression
    console.log(`  Extracting AST structure...`);
    const structure = await getCompressionStructure(source, file.lang);
    
    console.log(`  AST compression...`);
    let astCompressed;
    if (structure) {
      astCompressed = compressSourceStructured(source, budget, structure);
    } else {
      console.log(`  No structure returned, falling back to text`);
      astCompressed = textCompressed;
    }
    fs.writeFileSync(path.join('tests/compression-ast', file.name), astCompressed);

    console.log(`  Done.`);
    console.log(`  Text compressed length: ${textCompressed.length}`);
    console.log(`  AST compressed length:  ${astCompressed.length}`);
    console.log('');
  }
}

main().catch(console.error);
