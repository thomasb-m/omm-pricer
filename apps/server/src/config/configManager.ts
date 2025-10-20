import fs from "fs";
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

export function loadConfig(configPath = "config/default.yaml"): AppConfig {
  if (cached) return cached;
  const real = fs.existsSync(configPath)
    ? configPath
    : fs.existsSync("config.default.yaml")
    ? "config.default.yaml"
    : configPath;
  const raw = fs.readFileSync(real, "utf-8");
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
