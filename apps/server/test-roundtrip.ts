import { SVI, SVIParams } from './src/volModels/dualSurfaceModel';

const testSVI: SVIParams = { a: 0.04, b: 0.3, rho: -0.2, sigma: 0.5, m: 0 };

const config = {
  bMin: 1e-6,
  sigmaMin: 1e-3,
  rhoMax: 0.995,
  sMax: 2.0,
  c0Min: 1e-4,
  buckets: [],
  edgeParams: new Map(),
  rbfWidth: 0.15,
  ridgeLambda: 1e-3,
  maxL0Move: 0.5,
  maxS0Move: 0.2,
  maxC0Move: 0.05
};

const metrics = SVI.toMetrics(testSVI);
const recovered = SVI.fromMetrics(metrics, config, { preserveBumps: true });

console.log('Original:', testSVI);
console.log('Metrics:', metrics);
console.log('Recovered:', recovered);
console.log('Difference:', {
  a: recovered.a - testSVI.a,
  b: recovered.b - testSVI.b,
  rho: recovered.rho - testSVI.rho,
  sigma: recovered.sigma - testSVI.sigma
});
