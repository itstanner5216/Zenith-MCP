function runPageRank(fwdWeight, bwdWeight) {
  const n = 5;
  const edges = [
    { from: 0, to: 1 }, // main -> run
    { from: 1, to: 2 }, // run -> A
    { from: 1, to: 3 }, // run -> B
    { from: 1, to: 4 }, // run -> C
  ];

  const adj = Array(n).fill(0).map(() => new Map());
  
  // Add base text weights (very small to simulate shared tokens)
  edges.forEach(e => {
    adj[e.from].set(e.to, 0.1);
    adj[e.to].set(e.from, 0.1);
  });

  // Add AST edges
  edges.forEach(e => {
    const fwd = (adj[e.from].get(e.to) || 0) + fwdWeight;
    adj[e.from].set(e.to, fwd);
    
    const bwd = (adj[e.to].get(e.from) || 0) + bwdWeight;
    adj[e.to].set(e.from, bwd);
  });

  // PR loop
  const outTotal = Array(n).fill(0);
  for (let i=0; i<n; i++) {
    for (const w of adj[i].values()) outTotal[i] += w;
  }

  let pr = Array(n).fill(1/n);
  const d = 0.85;

  for (let it=0; it<50; it++) {
    const nextPr = Array(n).fill((1-d)/n);
    for (let i=0; i<n; i++) {
      if (outTotal[i] > 0) {
        for (const [j, w] of adj[i].entries()) {
          nextPr[j] += d * pr[i] * (w / outTotal[i]);
        }
      }
    }
    pr = nextPr;
  }

  const max = Math.max(...pr);
  return pr.map(v => v / max);
}

console.log("0.5 / 2.0 (Aggressive Upward):");
const aggr = runPageRank(0.5, 2.0);
console.log(`main: ${aggr[0].toFixed(3)}, run: ${aggr[1].toFixed(3)}, leaf: ${aggr[2].toFixed(3)}`);

console.log("\n0.75 / 1.5 (Moderate Upward):");
const mod = runPageRank(0.75, 1.5);
console.log(`main: ${mod[0].toFixed(3)}, run: ${mod[1].toFixed(3)}, leaf: ${mod[2].toFixed(3)}`);

console.log("\n1.0 / 1.0 (Symmetric):");
const sym = runPageRank(1.0, 1.0);
console.log(`main: ${sym[0].toFixed(3)}, run: ${sym[1].toFixed(3)}, leaf: ${sym[2].toFixed(3)}`);
