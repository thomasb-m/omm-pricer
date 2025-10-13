/**
 * Config Manager - Runtime Configuration
 * 
 * Manages production config + strategy profiles
 * Allows runtime profile switching
 */

import { ProductionConfig, loadConfigFromEnv } from './productionConfig';
import { StrategyProfile, selectProfile, getProfile } from './strategyProfiles';

export class ConfigManager {
  private prodConfig: ProductionConfig;
  private activeProfiles: Map<string, StrategyProfile> = new Map();
  private defaultProfileName: string = 'default';

  constructor(prodConfig?: ProductionConfig) {
    this.prodConfig = prodConfig || loadConfigFromEnv();
  }

  /**
   * Get production config
   */
  getProductionConfig(): ProductionConfig {
    return this.prodConfig;
  }

  /**
   * Get or select strategy profile for instrument
   */
  getStrategyProfile(params: {
    instrumentId: string;
    strike: number;
    forward: number;
    T: number;
    iv: number;
    rvZ?: number;
    forceProfile?: string;
  }): StrategyProfile {
    const { instrumentId, forceProfile } = params;

    // Check if profile is cached
    if (this.activeProfiles.has(instrumentId)) {
      return this.activeProfiles.get(instrumentId)!;
    }

    // Use forced profile if specified
    let profile: StrategyProfile;
    if (forceProfile) {
      profile = getProfile(forceProfile);
    } else {
      // Auto-select based on characteristics
      profile = selectProfile(params);
    }

    // Cache it
    this.activeProfiles.set(instrumentId, profile);
    
    return profile;
  }

  /**
   * Override profile for specific instrument
   */
  setProfileForInstrument(instrumentId: string, profileName: string): void {
    const profile = getProfile(profileName);
    this.activeProfiles.set(instrumentId, profile);
    console.log(`[ConfigManager] Set ${instrumentId} to profile: ${profileName}`);
  }

  /**
   * Clear profile cache (forces re-selection)
   */
  clearProfileCache(): void {
    this.activeProfiles.clear();
  }

  /**
   * Get all active profiles (for monitoring)
   */
  getActiveProfiles(): Map<string, StrategyProfile> {
    return new Map(this.activeProfiles);
  }

  /**
   * Summary for logging
   */
  getSummary(): string {
    return `ConfigManager: ${this.prodConfig.environment}/${this.prodConfig.product}/${this.prodConfig.venue}, ` +
           `Alpha: ${this.prodConfig.enableAlpha}, ` +
           `MMP: ${this.prodConfig.mmpEnabled}, ` +
           `Active Profiles: ${this.activeProfiles.size}`;
  }
}

/**
 * Global singleton instance
 */
let globalConfigManager: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
  if (!globalConfigManager) {
    globalConfigManager = new ConfigManager();
  }
  return globalConfigManager;
}

export function initConfigManager(prodConfig?: ProductionConfig): ConfigManager {
  globalConfigManager = new ConfigManager(prodConfig);
  return globalConfigManager;
}