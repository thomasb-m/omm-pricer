#!/usr/bin/env python3
"""
Generate multi-tenor synthetic fixtures from a base result.
Reuses same SVI params, computes IVs for different T values.
"""
import json
import math
from pathlib import Path
import sys

def svi_w(k, p):
    """SVI total variance w(k) = a + b*(ρ*(k-m) + √((k-m)² + σ²))"""
    x = k - p["m"]
    return p["a"] + p["b"] * (p["rho"] * x + math.sqrt(x * x + p["sigma"] * p["sigma"]))

def generate_tenor(base_path: Path, tenor_days: int, output_dir: Path):
    """Generate a synthetic fixture for a given tenor in days."""
    # Load base result
    base = json.loads(base_path.read_text())
    
    F = float(base.get("forward") or base["F"])
    T_new = tenor_days / 365.0
    Ks = [float(k) for k in base["strikes"]]
    
    p_in = base.get("svi_params") or base.get("svi")
    p = {
        "a": float(p_in["a"]),
        "b": float(p_in["b"]),
        "rho": float(p_in["rho"]),
        "m": float(p_in["m"]),
        "sigma": float(p_in["sigma"]),
    }
    
    # Compute IVs for new tenor using same SVI
    ivs_new = []
    for K in Ks:
        k = math.log(K / F)
        w = max(1e-12, svi_w(k, p))
        ivs_new.append(math.sqrt(w / T_new))
    
    # Create synthetic result
    fixture_id = base_path.stem.replace("_result", "") + f"_synthetic_{tenor_days}d"
    
    out = {
        "fixtureId": fixture_id,
        "forward": F,
        "T": T_new,
        "strikes": Ks,
        "svi_params": p,
        "ivs": ivs_new,
        "df": float(base.get("df", 1.0)),
    }
    
    # Write to output
    output_file = output_dir / f"{fixture_id}_result.json"
    output_file.write_text(json.dumps(out, indent=2))
    print(f"✅ Generated: {output_file}")
    return output_file

def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_multi_tenor.py <base_result.json> [tenor_days...]")
        print("Example: python generate_multi_tenor.py vol-core-validation/output/btc_2025-01-03_7d_result.json 14 30")
        sys.exit(1)
    
    base_path = Path(sys.argv[1])
    if not base_path.exists():
        print(f"❌ Base file not found: {base_path}")
        sys.exit(1)
    
    # Default tenors if none specified
    tenors = [int(t) for t in sys.argv[2:]] if len(sys.argv) > 2 else [14, 30]
    
    output_dir = base_path.parent
    
    print(f"📊 Generating multi-tenor fixtures from {base_path.name}")
    print(f"   Tenors: {tenors} days")
    print()
    
    for tenor in tenors:
        generate_tenor(base_path, tenor, output_dir)
    
    print()
    print("✅ Done! Now run:")
    print("   npm run fixtures:python")
    print("   npm run test:noarb")

if __name__ == "__main__":
    main()
