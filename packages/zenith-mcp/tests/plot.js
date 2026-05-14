function f(x) {
  return (x*x*x + 6.0*x + 12.0) / (x*x*x + 12.0*x + 48.0);
}
for(let x=0; x<=8; x++) {
  console.log(`x=${x}, f=${f(x).toFixed(4)}, sig=${(1/(1+Math.exp(-x))).toFixed(4)}`);
}
