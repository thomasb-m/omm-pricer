export type VolModelParams = {
  vol: number;        // Base vol level (affects all strikes)
  skew: number;       // Put-call spread (max at 25Δ)
  pump: number;       // Symmetric smile (max at 15Δ)
  wingPut: number;    // Put wing (max at 10Δ)
  wingCall: number;   // Call wing (max at 10Δ)
  volPathRate: number; // dVol/dSpot tangent at ATM
};

export type VolModel = {
  getIV(moneyness: number, params: VolModelParams): number;
  calibrate(strikes: number[], ivs: number[], spot: number): VolModelParams;
  reprice(strikes: number[], spot: number, params: VolModelParams): number[];
};