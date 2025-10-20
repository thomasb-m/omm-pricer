import { z } from "zod";

export const FeaturesSchema = z.object({
  enablePricing: z.boolean(),
  enableFitter: z.boolean(),
  enableShadow: z.boolean(),
  usePythonGoldens: z.boolean().optional(),
});

export const PrimitivesSchema = z.object({
  daycount: z.enum(["ACT_365","ACT_365_25","BUS_252"]),
  // secondsPerYear removed - derive from daycount
  epsilonT: z.number().positive(),
});

export const GuardsSchema = z.object({
  enforceStaticNoArb: z.boolean(),
  maxWingSlope: z.number().positive(),
  minTotalVariance: z.number().nonnegative(),
});

export const TermSchema = z.object({
  method: z.literal("monotone_convex_tv"),
  shortDatedBlend: z.object({
    enabled: z.boolean(),
    T_blend: z.number().nonnegative(),
  }).optional()
});

export const RiskSchema = z.object({
  covariance: z.object({
    sources: z.array(z.enum(["factor_returns","pnl_innovations"])),
    alpha_structural: z.number().min(0).max(1),
    alpha_pc: z.number().min(0).max(1),
    shrinkage: z.literal("ledoit_wolf"),
    robust: z.object({
      huberDeltaBps: z.number().positive(),
      hampel: z.object({ k: z.number(), t0: z.number(), t1: z.number() })
    }).optional(),
    regime: z.object({
      decayOnShock: z.boolean(),
      maxEigenRatio: z.number().positive()
    }).optional()
  }),
  lambda: z.object({
    learningRate: z.number().positive(),
    capAbs: z.number().positive(),
    targetVolBps: z.number().nonnegative(),
    floorBps: z.number().nonnegative()
  })
});

export const AppConfigSchema = z.object({
  features: FeaturesSchema,
  primitives: PrimitivesSchema,
  guards: GuardsSchema,
  term: TermSchema,
  risk: RiskSchema
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
