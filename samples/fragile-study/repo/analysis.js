import { loadStudyRows } from "./src/load-study.js";

function logGamma(z) {
  const p = [676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.9999999999998099;
  const a = z - 1;
  for (let i = 0; i < p.length; i += 1) x += p[i] / (a + i + 1);
  const t = a + p.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (a + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaFraction(a, b, x) {
  const floor = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c; if (Math.abs(c) < floor) c = floor;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c; if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 3e-14) break;
  }
  return h;
}

function betaRegularized(x, a, b) {
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return front * betaFraction(a, b, x) / a;
  return 1 - front * betaFraction(b, a, 1 - x) / b;
}

function regress(rows) {
  const n = rows.length;
  const meanX = rows.reduce((s, r) => s + r.x, 0) / n;
  const meanY = rows.reduce((s, r) => s + r.y, 0) / n;
  const sxx = rows.reduce((s, r) => s + (r.x - meanX) ** 2, 0);
  const sxy = rows.reduce((s, r) => s + (r.x - meanX) * (r.y - meanY), 0);
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const sse = rows.reduce((s, r) => s + (r.y - intercept - slope * r.x) ** 2, 0);
  const df = n - 2;
  const standardError = Math.sqrt((sse / df) / sxx);
  const t = slope / standardError;
  const pValue = betaRegularized(df / (df + t ** 2), df / 2, 0.5);
  return { n, slope, intercept, standardError, t, degreesOfFreedom: df, pValue };
}

const baseline = regress(await loadStudyRows());
process.stdout.write(`${JSON.stringify({
  schemaVersion: "lighthouse.author-result.v1",
  n: baseline.n,
  coefficient: Number(baseline.slope.toFixed(6)),
  standardError: Number(baseline.standardError.toFixed(6)),
  pValue: Number(baseline.pValue.toFixed(8)),
})}\n`);
