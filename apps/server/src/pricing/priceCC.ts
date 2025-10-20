import { Quote, PriceBreakdown, SVIParams } from "@core-types";
import { timeToExpiryYears } from "@vol-core/units";
import { sviIV } from "@vol-core/smile";
import { black76Call, black76Put } from "@vol-core/black76";
import { assertFinite } from "@vol-core/utils";
import { kRel } from "@vol-core/conventions";
import { EPS_T } from "@vol-core/constants";
import { loadConfig } from "../config/configManager";

export interface PriceCCOptions {
  nowSec?: number;
  df?: number;
  returnPV?: boolean;
}

export function priceCC(
  quote: Quote,
  svi: SVIParams,
  options: PriceCCOptions = {}
): PriceBreakdown {
  const cfg = loadConfig();
  const now = options.nowSec ?? quote.timestampSec;
  const T = timeToExpiryYears(
    now,
    quote.instrument.expirySec,
    cfg.primitives.daycount,
    cfg.primitives.epsilonT
  );

  if (quote.forward <= 0 || quote.instrument.strike <= 0) {
    throw new Error(
      `Invalid inputs: F=${quote.forward}, K=${quote.instrument.strike}`
    );
  }

  const df =
    options.df ??
    (quote.rate != null ? Math.exp(-(quote.rate as number) * T) : 1.0);

  const k = kRel(quote.forward, quote.instrument.strike);
  const iv = sviIV(k, T, svi);

  if (T * iv < EPS_T) {
    const intrinsic = Math.max(
      quote.instrument.isCall
        ? quote.forward - quote.instrument.strike
        : quote.instrument.strike - quote.forward,
      0
    );
    return {
      intrinsic: intrinsic * df,
      tv: 0,
      price: intrinsic * df,
      iv: 0,
      df,
      T,
    };
  }

  const pricer = quote.instrument.isCall ? black76Call : black76Put;
  const forwardPrice = pricer(
    quote.forward,
    quote.instrument.strike,
    T,
    iv,
    1.0
  );

  const intrinsic = Math.max(
    quote.instrument.isCall
      ? quote.forward - quote.instrument.strike
      : quote.instrument.strike - quote.forward,
    0
  );

  if (quote.instrument.isCall) {
    if (
      forwardPrice < intrinsic - 1e-10 ||
      forwardPrice > quote.forward + 1e-10
    ) {
      console.warn("Invariant breach in forward price", {
        F: quote.forward,
        K: quote.instrument.strike,
        T,
        iv,
        forwardPrice,
        intrinsic,
      });
    }
  }

  const returnPV = options.returnPV ?? true;
  const finalPrice = returnPV ? forwardPrice * df : forwardPrice;
  const finalIntrinsic = returnPV ? intrinsic * df : intrinsic;
  const tv = finalPrice - finalIntrinsic;

  assertFinite(finalPrice, `priceCC: finalPrice at K=${quote.instrument.strike}`);
  assertFinite(tv, `priceCC: tv at K=${quote.instrument.strike}`);

  return {
    intrinsic: finalIntrinsic,
    tv,
    price: finalPrice,
    iv,
    df,
    T,
  };
}
