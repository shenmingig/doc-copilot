// ============================================================
// Storage Utility - Chrome extension storage wrapper
// ============================================================

import { AppSettings, DEFAULT_SETTINGS, DEFAULT_QUICK_PROMPTS, ModelConfig } from '../types/index';

const SETTINGS_KEY = 'doc_copilot_settings';
const LEGACY_DEFAULT_BASE_URL_HASHES = new Set(['3232b486', '18f6277', 'f7f9def1']);
const LEGACY_DEFAULT_MODEL_ID_HASHES = new Set(['6a72156', 'e25a8c25', 'ee928742', '9618e172', '19225768']);

const LEGACY_DEFAULT_QUICK_PROMPTS = new Set([
  'optimize|优化选中内容|优化',
  'fix|修正错误|修正语法和拼写错误',
  'translate-en|翻译成英文|翻译成英文',
  'translate-zh|翻译成中文|翻译成中文',
]);

export class SettingsStorage {
  private cache: AppSettings | null = null;
  private listeners: Array<(settings: AppSettings) => void> = [];

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cloneSettings(this.cache);

    const stored = await this.readStoredSettings();
    this.cache = stored ? this.mergeWithDefaults(stored) : this.cloneSettings(DEFAULT_SETTINGS);
    return this.cloneSettings(this.cache);
  }

  async set(settings: Partial<AppSettings>): Promise<void> {
    const current = await this.get();
    const updated = this.mergeSettingsPatch(current, settings);
    this.cache = this.cloneSettings(updated);

    const local = this.getChromeStorageArea('local');
    if (local) {
      await local.set({ [SETTINGS_KEY]: updated });
    } else {
      this.writeLocalStorage(updated);
    }

    this.listeners.forEach(cb => cb(this.cloneSettings(updated)));
  }

  async updateModel(role: keyof AppSettings['models'], config: Partial<AppSettings['models'][typeof role]>): Promise<void> {
    const current = await this.get();
    const updated = {
      ...current,
      models: {
        ...current.models,
        [role]: { ...current.models[role], ...config },
      },
    };
    await this.set(updated);
  }

  async updateFeatures(features: Partial<AppSettings['features']>): Promise<void> {
    const current = await this.get();
    await this.set({
      features: { ...current.features, ...features },
    });
  }

  onChange(callback: (settings: AppSettings) => void): () => void {
    this.listeners.push(callback);

    // Also listen for chrome.storage changes
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' && areaName !== 'sync') return;
        if (changes[SETTINGS_KEY]) {
          const newValue = changes[SETTINGS_KEY].newValue;
          this.cache = newValue ? this.mergeWithDefaults(newValue) : this.cloneSettings(DEFAULT_SETTINGS);
          callback(this.cloneSettings(this.cache));
        }
      });
    } catch {
      // Not in extension context
    }

    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  private async readStoredSettings(): Promise<Partial<AppSettings> | null> {
    const local = this.getChromeStorageArea('local');
    if (local) {
      const localStored = await this.readChromeStorage(local);
      if (localStored) return localStored;
    }

    const sync = this.getChromeStorageArea('sync');
    if (sync) {
      const syncStored = await this.readChromeStorage(sync);
      if (syncStored) {
        const migrated = this.mergeWithDefaults(syncStored);
        if (local) {
          try {
            await local.set({ [SETTINGS_KEY]: migrated });
          } catch {
            // Keep reading the sync copy if local migration fails.
          }
        }
        return syncStored;
      }
    }

    return this.readLocalStorage();
  }

  private async readChromeStorage(area: chrome.storage.StorageArea): Promise<Partial<AppSettings> | null> {
    try {
      const result = await area.get(SETTINGS_KEY);
      const stored = result?.[SETTINGS_KEY];
      return stored && typeof stored === 'object' ? stored as Partial<AppSettings> : null;
    } catch {
      return null;
    }
  }

  private getChromeStorageArea(areaName: 'local' | 'sync'): chrome.storage.StorageArea | null {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.[areaName]) return null;
      return chrome.storage[areaName];
    } catch {
      return null;
    }
  }

  private readLocalStorage(): Partial<AppSettings> | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Partial<AppSettings> : null;
    } catch {
      return null;
    }
  }

  private writeLocalStorage(settings: AppSettings): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      }
    } catch {
      // No fallback available in service worker-like contexts.
    }
  }

  private mergeSettingsPatch(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
    const patchModels = patch.models as Partial<AppSettings['models']> | undefined;
    return this.mergeWithDefaults({
      ...current,
      ...patch,
      models: {
        ...current.models,
        ...patchModels,
        smart: {
          ...current.models.smart,
          ...patchModels?.smart,
        },
        image: {
          ...current.models.image,
          ...patchModels?.image,
        },
      },
      features: {
        ...current.features,
        ...patch.features,
      },
      quickPrompts: patch.quickPrompts ?? current.quickPrompts,
    });
  }

  private cloneSettings(settings: AppSettings): AppSettings {
    return JSON.parse(JSON.stringify(settings)) as AppSettings;
  }

  private mergeWithDefaults(stored: Partial<AppSettings>): AppSettings {
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      models: {
        smart: this.mergeModelConfig(DEFAULT_SETTINGS.models.smart, this.getStoredSmartModel(stored)),
        image: this.getStoredImageModel(stored),
      },
      features: {
        ...DEFAULT_SETTINGS.features,
        ...stored.features,
      },
      quickPrompts: this.mergeQuickPrompts(stored.quickPrompts),
      chatHistoryEnabled: typeof stored.chatHistoryEnabled === 'boolean'
        ? stored.chatHistoryEnabled
        : DEFAULT_SETTINGS.chatHistoryEnabled,
      chatHistoryTtlDays: this.mergePositiveNumber(
        stored.chatHistoryTtlDays,
        DEFAULT_SETTINGS.chatHistoryTtlDays,
      ),
      autocompleteMinConfidence: this.mergeNumberInRange(
        stored.autocompleteMinConfidence,
        DEFAULT_SETTINGS.autocompleteMinConfidence,
        0,
        1,
      ),
      chatHistoryMaxSessionsPerPage: this.mergePositiveNumber(
        stored.chatHistoryMaxSessionsPerPage,
        DEFAULT_SETTINGS.chatHistoryMaxSessionsPerPage,
      ),
      imageGenerationSize: this.mergeImageSize(stored.imageGenerationSize, DEFAULT_SETTINGS.imageGenerationSize),
      agentMaxContextChars: this.mergeAgentContextChars(stored.agentMaxContextChars),
      modelContextTokens: this.mergePositiveNumber(
        stored.modelContextTokens,
        DEFAULT_SETTINGS.modelContextTokens,
      ),
    };
  }

  private mergeImageSize(stored: unknown, fallback: string): string {
    const value = typeof stored === 'string' ? stored.trim() : '';
    return /^\d+x\d+$/.test(value) ? value : fallback;
  }

  private mergeAgentContextChars(stored: unknown): number {
    const fallback = DEFAULT_SETTINGS.agentMaxContextChars;
    if (typeof stored !== 'number' || !Number.isFinite(stored) || stored <= 0) return fallback;
    // 0.2.80 and earlier shipped 8192 as the default and capped the control at 32000.
    if (stored === 8192) return fallback;
    return stored;
  }

  private mergePositiveNumber(stored: unknown, fallback: number): number {
    return typeof stored === 'number' && Number.isFinite(stored) && stored > 0
      ? stored
      : fallback;
  }

  private mergeNumberInRange(stored: unknown, fallback: number, min: number, max: number): number {
    return typeof stored === 'number' && Number.isFinite(stored) && stored >= min && stored <= max
      ? stored
      : fallback;
  }

  private mergeQuickPrompts(stored?: AppSettings['quickPrompts']): AppSettings['quickPrompts'] {
    if (!Array.isArray(stored) || stored.length === 0) {
      return DEFAULT_QUICK_PROMPTS;
    }

    const seen = new Set<string>();
    const prompts = stored
      .map(prompt => ({
        id: String(prompt.id || '').trim(),
        label: String(prompt.label || '').trim(),
        prompt: String(prompt.prompt || '').trim(),
      }))
      .filter(prompt => prompt.label || prompt.prompt)
      .filter(prompt => {
        const key = `${prompt.id}|${prompt.label}|${prompt.prompt}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    const isLegacyDefault = prompts.length > 0
      && prompts.every(prompt => LEGACY_DEFAULT_QUICK_PROMPTS.has(`${prompt.id}|${prompt.label}|${prompt.prompt}`));

    return isLegacyDefault || prompts.length === 0 ? DEFAULT_QUICK_PROMPTS : prompts;
  }

  /** Merge model config while dropping older built-in demo/default credentials. */
  private mergeModelConfig(
    defaults: ModelConfig,
    stored?: Partial<ModelConfig>,
    options: { dropLegacyDefaults?: boolean } = {},
  ): ModelConfig {
    if (!stored) return { ...defaults };

    const merged = { ...defaults };
    const dropLegacyDefaults = options.dropLegacyDefaults ?? true;
    const looksLikeLegacyDefault = dropLegacyDefaults && this.isLegacyDefaultModelConfig(stored);
    for (const key of Object.keys(stored) as Array<keyof typeof stored>) {
      const val = stored[key];
      if (typeof val === 'string') {
        if (this.shouldKeepStoredString(key, val, looksLikeLegacyDefault, dropLegacyDefaults)) {
          (merged as any)[key] = val;
        }
      } else if (val !== undefined && val !== null) {
        (merged as any)[key] = val;
      }
    }
    return merged;
  }

  private getStoredSmartModel(stored: Partial<AppSettings>): Partial<ModelConfig> | undefined {
    const models = stored.models as Partial<AppSettings['models']> & { fast?: Partial<ModelConfig> } | undefined;
    const smart = models?.smart;
    const fast = models?.fast;

    if (smart && !this.isModelConfigEmpty(smart) && !this.isLegacyDefaultModelConfig(smart)) return smart;
    if (fast && !this.isLegacyDefaultModelConfig(fast) && !this.isModelConfigEmpty(fast)) {
      return {
        ...fast,
        role: 'smart',
        name: DEFAULT_SETTINGS.models.smart.name,
      };
    }
    return smart;
  }

  private getStoredImageModel(stored: Partial<AppSettings>): ModelConfig {
    const models = stored.models as Partial<AppSettings['models']> & { balanced?: Partial<ModelConfig> } | undefined;

    // Image settings were added after removing built-in credentials, so an
    // explicit image config is user-entered. Do not treat a matching old text
    // endpoint as disposable; users may intentionally reuse that API for images.
    if (models?.image) {
      return this.mergeModelConfig(DEFAULT_SETTINGS.models.image, models.image, {
        dropLegacyDefaults: false,
      });
    }

    return this.mergeModelConfig(DEFAULT_SETTINGS.models.image, models?.balanced, {
      dropLegacyDefaults: true,
    });
  }

  private isModelConfigEmpty(config: Partial<ModelConfig>): boolean {
    return !String(config.baseUrl || '').trim()
      && !String(config.apiKey || '').trim()
      && !String(config.modelId || '').trim();
  }

  private isLegacyDefaultModelConfig(stored: Partial<ModelConfig>): boolean {
    const baseUrl = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : '';
    const modelId = typeof stored.modelId === 'string' ? stored.modelId.trim() : '';
    return LEGACY_DEFAULT_BASE_URL_HASHES.has(this.hashString(baseUrl))
      || LEGACY_DEFAULT_MODEL_ID_HASHES.has(this.hashString(modelId));
  }

  private shouldKeepStoredString(
    key: string,
    value: string,
    looksLikeLegacyDefault: boolean,
    dropLegacyDefaults: boolean,
  ): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (dropLegacyDefaults && key === 'baseUrl' && LEGACY_DEFAULT_BASE_URL_HASHES.has(this.hashString(trimmed))) return false;
    if (looksLikeLegacyDefault && key === 'modelId' && LEGACY_DEFAULT_MODEL_ID_HASHES.has(this.hashString(trimmed))) return false;
    if (looksLikeLegacyDefault && key === 'apiKey' && /^sk-[A-Za-z0-9_-]{12,}$/.test(trimmed)) return false;
    return true;
  }

  private hashString(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }
}

export const settingsStorage = new SettingsStorage();
