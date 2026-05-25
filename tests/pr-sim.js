function runPageRank(fwdWeight, bwdWeight) {
  const n = 8;
  const edges = [
    { from: 0, to: 1 },
    { from: 0, to: 2 },
    { from: 0, to: 3 },
    { from: 1, to: 4 },
    { from: 2, to: 5 },
    { from: 2, to: 6 },
    { from: 2, to: 7 },
  ];

  const adj = Array(n).fill(0).map(() => new Map());
  
  // Add base text weights (very small, say 0.1 to simulate shared tokens)
  // 0 shares with 1, 2, 3
  // 1 shares with 4
  // 2 shares with 5, 6, 7
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

console.log("Current (fwd=2.0, bwd=1.0):");
const cur = runPageRank(2.0, 1.0);
console.log(`main: ${cur[0].toFixed(3)}, init: ${cur[1].toFixed(3)}, process: ${cur[2].toFixed(3)}, leaf(cleanup): ${cur[3].toFixed(3)}`);

console.log("\nReversed (fwd=1.0, bwd=2.0):");
const rev = runPageRank(1.0, 2.0);
console.log(`main: ${rev[0].toFixed(3)}, init: ${rev[1].toFixed(3)}, process: ${rev[2].toFixed(3)}, leaf(cleanup): ${rev[3].toFixed(3)}`);

console.log("\nEqual (fwd=1.0, bwd=1.0):");
const eq = runPageRank(1.0, 1.0);
console.log(`main: ${eq[0].toFixed(3)}, init: ${eq[1].toFixed(3)}, process: ${eq[2].toFixed(3)}, leaf(cleanup): ${eq[3].toFixed(3)}`);

console.log("\nStrong Hub (fwd=0.5, bwd=2.0):");
const sh = runPageRank(0.5, 2.0);
console.log(`main: ${sh[0].toFixed(3)}, init: ${sh[1].toFixed(3)}, process: ${sh[2].toFixed(3)}, leaf(cleanup): ${sh[3].toFixed(3)}`);
