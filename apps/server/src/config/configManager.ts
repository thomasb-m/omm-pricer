import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import { AppConfigSchema, AppConfig } from "./schema";

function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const val = (obj as any)[prop];
    if (val && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  });
  return obj;
}

let cached: AppConfig | null = null;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

function resolveConfigPath(preferred: string): string {
  const candidates = [
    preferred,
    "config.default.yaml",
    path.resolve(process.cwd(), preferred),
    path.resolve(process.cwd(), "config.default.yaml"),
    path.join(REPO_ROOT, preferred),
    path.join(REPO_ROOT, "config.default.yaml"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate configuration file. Tried: ${candidates.join(", ")}`
  );
}

export function loadConfig(configPath = "config/default.yaml"): AppConfig {
  if (cached) return cached;

  const resolved = resolveConfigPath(configPath);
  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = YAML.parse(raw);
  const cfg = AppConfigSchema.parse(parsed);
  cached = deepFreeze(cfg);
  return cached;
}

export function resetConfigCache() {
  cached = null;
}

// Legacy export for backward compat
export function initConfigManager() {
  return loadConfig();
}
