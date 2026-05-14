function _fastSigmoid(x) {
  if (x >= 8.0) return 1.0;
  if (x <= -8.0) return 0.0;
  const x2 = x * x;
  const x3 = x2 * x;
  return (x3 + 6.0 * x + 12.0) / (x3 + 12.0 * x + 48.0);
}
console.log(_fastSigmoid(0));
console.log(1 / (1 + Math.exp(0)));
