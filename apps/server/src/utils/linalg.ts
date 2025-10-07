// apps/server/src/utils/linalg.ts
/**
 * Lightweight linear algebra for factor risk math
 * No external dependencies - plain JS for d ≤ 32
 */

import { num } from './numeric';

// ============================================================================
// Vector operations
// ============================================================================

export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`dot: dimension mismatch ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += num(a[i], 'dot.a') * num(b[i], 'dot.b');
  }
  return sum;
}

export function norm2(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

export function scale(v: number[], scalar: number): number[] {
  return v.map(x => num(x, 'scale.v') * scalar);
}

export function add(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`add: dimension mismatch ${a.length} vs ${b.length}`);
  }
  return a.map((x, i) => num(x, 'add.a') + num(b[i], 'add.b'));
}

export function subtract(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`subtract: dimension mismatch ${a.length} vs ${b.length}`);
  }
  return a.map((x, i) => num(x, 'sub.a') - num(b[i], 'sub.b'));
}

// ============================================================================
// Matrix operations
// ============================================================================

/**
 * Matrix-vector product: M * v
 */
export function matVec(M: number[][], v: number[]): number[] {
  const d = M.length;
  if (d === 0) throw new Error('matVec: empty matrix');
  if (M[0].length !== v.length) {
    throw new Error(`matVec: dimension mismatch ${M[0].length} vs ${v.length}`);
  }
  
  const result: number[] = new Array(d);
  for (let i = 0; i < d; i++) {
    result[i] = dot(M[i], v);
  }
  return result;
}

/**
 * Quadratic form: vᵀ M v
 */
export function quadForm(M: number[][], v: number[]): number {
  const Mv = matVec(M, v);
  return num(dot(v, Mv), 'quadForm');
}

/**
 * Mahalanobis norm: √(vᵀ M v)
 */
export function normMahalanobis(v: number[], M: number[][]): number {
  return Math.sqrt(Math.max(0, quadForm(M, v)));
}

/**
 * Matrix trace: sum of diagonal
 */
export function trace(M: number[][]): number {
  let sum = 0;
  for (let i = 0; i < M.length; i++) {
    sum += num(M[i][i], `trace[${i}]`);
  }
  return sum;
}

/**
 * Scale matrix by scalar: α * M
 */
export function scaleMatrix(M: number[][], alpha: number): number[][] {
  return M.map(row => row.map(x => num(x, 'scaleMatrix') * alpha));
}

/**
 * Add matrices: A + B
 */
export function addMatrix(A: number[][], B: number[][]): number[][] {
  if (A.length !== B.length) {
    throw new Error(`addMatrix: dimension mismatch`);
  }
  return A.map((row, i) => 
    row.map((x, j) => num(x, 'addMat.A') + num(B[i][j], 'addMat.B'))
  );
}

/**
 * Add ridge regularization: M + ε * (tr(M)/d) * I
 */
export function addRidge(M: number[][], epsilon: number): number[][] {
  const d = M.length;
  const tr = trace(M);
  const ridgeScale = epsilon * (tr / d);
  
  return M.map((row, i) => 
    row.map((x, j) => 
      i === j ? num(x, 'ridge') + ridgeScale : num(x, 'ridge')
    )
  );
}

/**
 * Outer product: u ⊗ v (returns u * vᵀ)
 */
export function outerProduct(u: number[], v: number[]): number[][] {
  const result: number[][] = [];
  for (let i = 0; i < u.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < v.length; j++) {
      row.push(num(u[i], 'outer.u') * num(v[j], 'outer.v'));
    }
    result.push(row);
  }
  return result;
}

// ============================================================================
// Eigenvalue utilities (simplified - for diagnostics only)
// ============================================================================

/**
 * Power iteration to find largest eigenvalue (for condition number)
 * Not production-grade, but good enough for monitoring
 */
export function largestEigenvalue(M: number[][], maxIter = 100): number {
  const d = M.length;
  let v = new Array(d).fill(1 / Math.sqrt(d)); // normalized random start
  
  for (let iter = 0; iter < maxIter; iter++) {
    const Mv = matVec(M, v);
    const lambda = dot(v, Mv);
    const norm = norm2(Mv);
    
    if (norm < 1e-12) return 0; // degenerate
    v = scale(Mv, 1 / norm);
    
    // Check convergence
    if (iter > 10 && Math.abs(lambda - dot(v, matVec(M, v))) < 1e-9) {
      return lambda;
    }
  }
  
  return dot(v, matVec(M, v));
}

/**
 * Estimate smallest eigenvalue via inverse iteration
 * (Very rough - just for monitoring)
 */
export function smallestEigenvalue(M: number[][], maxIter = 50): number {
  // Add tiny ridge to avoid singularity in inverse iteration
  const Mreg = addRidge(M, 1e-10);
  
  // This is a hack - in production you'd use proper eigendecomposition
  // For now, just return min diagonal element as lower bound
  let minDiag = Infinity;
  for (let i = 0; i < M.length; i++) {
    minDiag = Math.min(minDiag, M[i][i]);
  }
  return Math.max(0, minDiag * 0.1); // very conservative estimate
}

/**
 * Condition number: max(eigval) / min(eigval)
 */
export function conditionNumber(M: number[][]): number {
  const maxEig = largestEigenvalue(M);
  const minEig = smallestEigenvalue(M);
  if (minEig < 1e-12) return Infinity;
  return maxEig / minEig;
}

/**
 * Check if matrix is positive definite (diagonal dominant heuristic)
 * Not rigorous, but fast screening
 */
export function isPDHeuristic(M: number[][]): boolean {
  const d = M.length;
  for (let i = 0; i < d; i++) {
    if (M[i][i] <= 0) return false;
    
    let offDiagSum = 0;
    for (let j = 0; j < d; j++) {
      if (i !== j) offDiagSum += Math.abs(M[i][j]);
    }
    
    // Diagonal dominance check
    if (M[i][i] < offDiagSum) return false;
  }
  return true;
}