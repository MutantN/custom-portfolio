import quadprog from "quadprog";

const { solveQP } = quadprog;
const EPS = 1e-8;

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] || 0) * (b[i] || 0);
  return sum;
}

function portfolioStats(weights, mu, cov, riskFreeRate = 0.04) {
  const ret = dot(weights, mu);
  let variance = 0;
  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) variance += weights[i] * weights[j] * cov[i][j];
  }
  const vol = Math.sqrt(Math.max(variance, EPS));
  return {
    ret,
    vol,
    sharpe: (ret - riskFreeRate) / vol,
  };
}

function toOneBasedSquare(matrix) {
  const n = matrix.length;
  const out = Array.from({ length: n + 1 }, () => Array(n + 1).fill(0));
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) out[row + 1][col + 1] = matrix[row][col];
  }
  return out;
}

function toOneBasedColumns(columns, rows) {
  const out = Array.from({ length: rows + 1 }, () => Array(columns.length + 1).fill(0));
  for (let col = 0; col < columns.length; col++) {
    for (let row = 0; row < rows; row++) out[row + 1][col + 1] = columns[col][row];
  }
  return out;
}

function toOneBasedVector(values) {
  const out = Array(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = values[i];
  return out;
}

function normalizeWeights(solution) {
  const weights = solution.map((value) => Math.max(0, Number(value) || 0));
  const sum = weights.reduce((acc, value) => acc + value, 0);
  if (sum <= EPS) return Array.from({ length: weights.length }, () => 1 / weights.length);
  return weights.map((value) => value / sum);
}

export function regularizeCovariance(covariance, ridgeFactor = 1e-4) {
  const n = covariance.length;
  const symmetric = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => {
      const a = Number(covariance[row]?.[col]) || 0;
      const b = Number(covariance[col]?.[row]) || 0;
      return 0.5 * (a + b);
    }),
  );
  const averageDiag = symmetric.reduce((sum, row, idx) => sum + Math.max(Number(row[idx]) || 0, 0), 0) / Math.max(n, 1);
  const lambda = Math.max(averageDiag * ridgeFactor, EPS);
  const regularized = symmetric.map((row, idx) =>
    row.map((value, jdx) => (idx === jdx ? value + lambda : value)),
  );
  return { covariance: regularized, lambda };
}

function solveMinVarianceQP(mu, covariance, targetReturn = null) {
  const n = mu.length;
  const constraintColumns = [Array.from({ length: n }, () => 1)];
  const rhs = [1];

  if (Number.isFinite(targetReturn)) {
    constraintColumns.push([...mu]);
    rhs.push(targetReturn);
  }

  for (let i = 0; i < n; i++) {
    const col = Array.from({ length: n }, () => 0);
    col[i] = 1;
    constraintColumns.push(col);
    rhs.push(0);
  }

  const result = solveQP(
    toOneBasedSquare(covariance),
    toOneBasedVector(Array.from({ length: n }, () => 0)),
    toOneBasedColumns(constraintColumns, n),
    toOneBasedVector(rhs),
    1,
  );

  if (result.message) throw new Error(result.message);
  return normalizeWeights(result.solution.slice(1));
}

function solveMaxReturn(mu, covariance, riskFreeRate) {
  const bestIdx = mu.reduce((best, value, idx, arr) => (value > arr[best] ? idx : best), 0);
  const weights = Array.from({ length: mu.length }, (_, idx) => (idx === bestIdx ? 1 : 0));
  return {
    weights,
    ...portfolioStats(weights, mu, covariance, riskFreeRate),
  };
}

function buildEfficientFrontier(mu, solverCovariance, statsCovariance, riskFreeRate, trueMinVar, maxReturn, points = 64) {
  const frontier = [];

  const addCandidate = (weights) => {
    const stats = { weights, ...portfolioStats(weights, mu, statsCovariance, riskFreeRate) };
    const duplicate = frontier.some(
      (candidate) => Math.abs(candidate.ret - stats.ret) < 1e-8 && Math.abs(candidate.vol - stats.vol) < 1e-8,
    );
    if (!duplicate) frontier.push(stats);
  };

  addCandidate(trueMinVar.weights);

  const minTarget = trueMinVar.ret;
  const maxTarget = maxReturn.ret;
  const span = maxTarget - minTarget;
  if (span <= 1e-8) {
    addCandidate(maxReturn.weights);
    return frontier.sort((a, b) => a.vol - b.vol);
  }

  for (let idx = 0; idx < points; idx++) {
    const target = minTarget + (span * idx) / Math.max(points - 1, 1);
    try {
      addCandidate(solveMinVarianceQP(mu, solverCovariance, target));
    } catch {
      // Skip infeasible target-return points near the frontier endpoints.
    }
  }

  addCandidate(maxReturn.weights);
  return frontier.sort((a, b) => a.vol - b.vol);
}

function pickBestSharpe(candidates) {
  return candidates.reduce((best, candidate) => {
    if (!best || candidate.sharpe > best.sharpe) return candidate;
    return best;
  }, null);
}

export function solveDeterministicPortfolioSet(mu, covariance, volatilityCap, riskFreeRate = 0.04) {
  const { covariance: regularizedCovariance, lambda } = regularizeCovariance(covariance);
  const trueMinWeights = solveMinVarianceQP(mu, regularizedCovariance);
  const trueMinVar = { weights: trueMinWeights, ...portfolioStats(trueMinWeights, mu, covariance, riskFreeRate) };
  const maxReturn = solveMaxReturn(mu, covariance, riskFreeRate);
  const frontier = buildEfficientFrontier(mu, regularizedCovariance, covariance, riskFreeRate, trueMinVar, maxReturn);
  const maxSharpe = pickBestSharpe(frontier) || trueMinVar;
  const effectiveCap = Math.max(Number(volatilityCap) || 0, trueMinVar.vol);
  const feasible = frontier.filter((candidate) => candidate.vol <= effectiveCap + 1e-6);
  const minVarBySharpe = pickBestSharpe(feasible) || trueMinVar;

  return {
    minVar: {
      ...trueMinVar,
      method: "Quadratic programming (long-only minimum variance)",
    },
    minVarSharpeCap: {
      ...minVarBySharpe,
      method: "Quadratic programming frontier selection with volatility cap",
      volCap: effectiveCap,
      capBinding: maxSharpe.vol > effectiveCap + 1e-6,
    },
    maxSharpe: {
      ...maxSharpe,
      method: "Quadratic programming efficient-frontier selection",
    },
    frontier: frontier.map((point) => ({
      x: +(point.vol * 100).toFixed(3),
      y: +(point.ret * 100).toFixed(3),
    })),
    engineMeta: {
      regularizationLambda: lambda,
      volatilityCap: effectiveCap,
    },
  };
}
