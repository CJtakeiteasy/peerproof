import { round } from "./utils.js";

// Lanczos approximation. It keeps the statistical core self-contained and makes the
// statistical verdict reproducible in both the sample analysis and verifier.
export function logGamma(z) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  let x = 0.9999999999998099;
  const adjusted = z - 1;
  for (let i = 0; i < coefficients.length; i += 1) {
    x += coefficients[i] / (adjusted + i + 1);
  }
  const t = adjusted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (adjusted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

export function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function twoSidedStudentTPValue(tValue, degreesOfFreedom) {
  const x = degreesOfFreedom / (degreesOfFreedom + tValue ** 2);
  return regularizedBeta(x, degreesOfFreedom / 2, 0.5);
}

export function linearRegression(rows) {
  if (!Array.isArray(rows) || rows.length < 3) {
    throw new Error("Linear regression requires at least three observations");
  }
  const n = rows.length;
  const meanX = rows.reduce((sum, row) => sum + row.x, 0) / n;
  const meanY = rows.reduce((sum, row) => sum + row.y, 0) / n;
  const sxx = rows.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0);
  const sxy = rows.reduce((sum, row) => sum + (row.x - meanX) * (row.y - meanY), 0);
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residualSumSquares = rows.reduce(
    (sum, row) => sum + (row.y - (intercept + slope * row.x)) ** 2,
    0,
  );
  const degreesOfFreedom = n - 2;
  const standardError = Math.sqrt(residualSumSquares / degreesOfFreedom / sxx);
  const tValue = slope / standardError;
  const pValue = twoSidedStudentTPValue(tValue, degreesOfFreedom);
  return {
    n,
    slope: round(slope, 6),
    intercept: round(intercept, 6),
    standardError: round(standardError, 6),
    tValue: round(tValue, 6),
    degreesOfFreedom,
    pValue: round(pValue, 8),
  };
}
