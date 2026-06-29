import { SageRank } from './packages/zenith-toon/dist/sagerank.js';

// Simulate 8 functions with a clear call hierarchy
const blockTexts = [
  'function main() { init(); process(); cleanup(); }',      // 0: entry - calls 1,2,3
  'function init() { loadConfig(); }',                      // 1: calls 4
  'function process() { fetchData(); transform(); save(); }', // 2: calls 5,6,7
  'function cleanup() { }',                                 // 3: leaf
  'function loadConfig() { }',                              // 4: leaf
  'function fetchData() { }',                               // 5: leaf
  'function transform() { }',                               // 6: leaf  
  'function save() { }',                                    // 7: leaf
];

// Call graph: main->init->loadConfig, main->process->fetchData/transform/save, main->cleanup
const astEdges = [
  { from: 0, to: 1, weight: 1.0 },  // main -> init
  { from: 0, to: 2, weight: 1.0 },  // main -> process
  { from: 0, to: 3, weight: 1.0 },  // main -> cleanup
  { from: 1, to: 4, weight: 1.0 },  // init -> loadConfig
  { from: 2, to: 5, weight: 1.0 },  // process -> fetchData
  { from: 2, to: 6, weight: 1.0 },  // process -> transform
  { from: 2, to: 7, weight: 1.0 },  // process -> save
];

const sagerank = new SageRank(1.5, 0.75, 0.85, 50, 1e-6, 0.35, 5, true);

const textOnly = sagerank.rankSentences(blockTexts, 8, null);
const withAST = sagerank.rankWithAST(blockTexts, 8, astEdges, null);

console.log('SageRank AST Integration Test');
console.log('=============================');
console.log('Call graph: main -> {init, process, cleanup}');
console.log('            init -> loadConfig');
console.log('            process -> {fetchData, transform, save}');
console.log('');
console.log('Function'.padEnd(18) + 'Text   AST    Delta    Expected');
console.log('-'.repeat(60));

const names = ['main', 'init', 'process', 'cleanup', 'loadConfig', 'fetchData', 'transform', 'save'];
const expected = ['hub', 'mid', 'hub', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf'];

for (let i = 0; i < 8; i++) {
  const t = textOnly.scores[i], a = withAST.scores[i], d = a - t;
  const arrow = d > 0.02 ? 'UP' : d < -0.02 ? 'DN' : '  ';
  console.log(names[i].padEnd(18) + t.toFixed(3) + '  ' + a.toFixed(3) + '  ' + arrow + (d>=0?'+':'')+d.toFixed(3) + '   ' + expected[i]);
}

console.log('');
console.log('Text edges: ' + textOnly.stats?.edges);
console.log('AST edges:  ' + withAST.stats?.ast_edges);
console.log('Merged:     ' + withAST.stats?.merged_edges);
console.log('');
console.log('Selection order (text):  ' + textOnly.selectedIndices.map(i => names[i]).join(' > '));
console.log('Selection order (AST):   ' + withAST.selectedIndices.map(i => names[i]).join(' > '));
