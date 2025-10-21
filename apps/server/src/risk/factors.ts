// apps/server/src/risk/factors.ts
/**
 * Factor Registry - Central definition of all risk factors
 * 
 * Version 2: Added Gamma factor
 * Order: [F, Gamma, L0, S0, C0, Sneg, Spos]
 */

export type FactorLabel =
  | "F"           // Forward/Delta
  | "Gamma"       // Convexity
  | "L0"          // Level (ATM vol)
  | "S0"          // Skew
  | "C0"          // Curvature
  | "Sneg"        // Left wing
  | "Spos"        // Right wing
  ;

export type FactorSpec = {
  label: FactorLabel;
  unit: string;
  description: string;
  enabled?: boolean;
  priorVariance?: number;
};

export type FactorRegistry = {
  version: number;
  specs: FactorSpec[];
};

// SINGLE SOURCE OF TRUTH
export const FACTORS: FactorRegistry = {
  version: 2,  // ← Bumped from 1 to 2
  specs: [
    {
      label: "F",
      unit: "$/Δ",
      description: "Forward price sensitivity (delta-like)",
    },
    {
      label: "Gamma",
      unit: "$/Γ",
      description: "Convexity exposure to underlying moves",
    },
    {
      label: "L0",
      unit: "$/L0",
      description: "ATM vol level sensitivity",
    },
    {
      label: "S0",
      unit: "$/S0",
      description: "Skew parameter sensitivity",
    },
    {
      label: "C0",
      unit: "$/C0",
      description: "Curvature sensitivity",
    },
    {
      label: "Sneg",
      unit: "$/Sneg",
      description: "Left wing sensitivity",
    },
    {
      label: "Spos",
      unit: "$/Spos",
      description: "Right wing sensitivity",
    },
  ],
};

// Derived constants
export const ENABLED_FACTORS = FACTORS.specs.filter(s => s.enabled ?? true);
export const d = ENABLED_FACTORS.length;
export const FACTOR_LABELS = ENABLED_FACTORS.map(s => s.label);

// Runtime validation
if (d < 2) {
  throw new Error(`Factor registry needs ≥2 enabled factors, got ${d}`);
}
if (d > 32) {
  throw new Error(`Factor dimension ${d} too large (max 32). Use block-diagonal Λ.`);
}

// ============================================================================
// Vector/Matrix Types (with metadata)
// ============================================================================

export type FactorVector = {
  version: number;
  labels: FactorLabel[];
  values: number[];
};

export type FactorMatrix = {
  version: number;
  labels: FactorLabel[];
  matrix: number[][];
};

// Helper: create zero vector
export function zeroVector(): FactorVector {
  return {
    version: FACTORS.version,
    labels: [...FACTOR_LABELS],
    values: new Array(d).fill(0),
  };
}

// Helper: create identity matrix
export function identityMatrix(): FactorMatrix {
  const mat: number[][] = [];
  for (let i = 0; i < d; i++) {
    const row = new Array(d).fill(0);
    row[i] = 1;
    mat.push(row);
  }
  return {
    version: FACTORS.version,
    labels: [...FACTOR_LABELS],
    matrix: mat,
  };
}

// Helper: validate vector shape
export function validateVector(v: FactorVector): void {
  if (v.labels.length !== d || v.values.length !== d) {
    throw new Error(
      `Vector dimension mismatch: expected ${d}, got labels=${v.labels.length} values=${v.values.length}`
    );
  }
  if (v.version !== FACTORS.version) {
    console.warn(
      `Vector version mismatch: registry=${FACTORS.version}, data=${v.version}`
    );
  }
}

// Helper: validate matrix shape
export function validateMatrix(m: FactorMatrix): void {
  if (m.labels.length !== d || m.matrix.length !== d) {
    throw new Error(
      `Matrix dimension mismatch: expected ${d}×${d}, got ${m.matrix.length}×${m.matrix[0]?.length}`
    );
  }
  for (const row of m.matrix) {
    if (row.length !== d) {
      throw new Error(`Matrix row length mismatch: expected ${d}, got ${row.length}`);
    }
  }
  if (m.version !== FACTORS.version) {
    console.warn(
      `Matrix version mismatch: registry=${FACTORS.version}, data=${m.version}`
    );
  }
}