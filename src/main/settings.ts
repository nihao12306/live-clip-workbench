import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { AppSettings } from "../shared/types";
import { DatabaseService, defaultSettings } from "./database";

export class SettingsService {
  private readonly keyPath: string;
  private readonly feishuSecretPath: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly userDataPath: string,
    private readonly defaultFfmpegPath: string,
    private readonly defaultFfprobePath: string,
  ) {
    this.keyPath = path.join(userDataPath, "deepseek.key");
    this.feishuSecretPath = path.join(userDataPath, "feishu-app.secret");
  }

  get(): AppSettings {
    const defaults = defaultSettings(
      this.userDataPath,
      this.defaultFfmpegPath,
      this.defaultFfprobePath,
    );
    const saved = this.database.getSetting<Partial<AppSettings>>(
      "app-settings",
      {},
    );
    const merged = { ...defaults, ...saved };
    // A previous 32-bit build could persist an architecture-specific ffprobe
    // path that no longer exists after an update. Prefer the bundled helper
    // when a saved custom path is stale so preview generation self-heals.
    if (!fs.existsSync(merged.ffmpegPath) && fs.existsSync(this.defaultFfmpegPath)) {
      merged.ffmpegPath = this.defaultFfmpegPath;
    }
    if (!fs.existsSync(merged.ffprobePath) && fs.existsSync(this.defaultFfprobePath)) {
      merged.ffprobePath = this.defaultFfprobePath;
    }
    // Keep all content analysis on the selected DeepSeek V4.1 Flash model.
    // Migrate any stale local value so a previous Pro setting cannot silently
    // route requests to a different model.
    merged.deepseekModel = "deepseek-flash";
    // A key file can remain after an OS/Electron credential-store change but
    // still be impossible to decrypt. Only report “已配置” when the key can
    // actually be read and will be usable by the next API request.
    return { ...merged, hasApiKey: Boolean(this.getApiKey()) };
  }

  save(
    input: Partial<AppSettings> & { apiKey?: string; feishuAppSecret?: string },
  ): AppSettings {
    const { apiKey, feishuAppSecret, ...settingsInput } = input;
    const current = this.get();
    const next = { ...current, ...settingsInput };
    next.deepseekModel = "deepseek-flash";
    delete (next as Partial<AppSettings>).hasApiKey;
    this.database.setSetting("app-settings", next);
    if (apiKey !== undefined) {
      if (apiKey.trim()) {
        const encrypted = safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(apiKey.trim())
          : Buffer.from(apiKey.trim(), "utf8");
        fs.writeFileSync(this.keyPath, encrypted, { mode: 0o600 });
      } else if (fs.existsSync(this.keyPath)) {
        fs.unlinkSync(this.keyPath);
      }
    }
    if (feishuAppSecret !== undefined) {
      if (feishuAppSecret.trim()) {
        const encrypted = safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(feishuAppSecret.trim())
          : Buffer.from(feishuAppSecret.trim(), "utf8");
        fs.writeFileSync(this.feishuSecretPath, encrypted, { mode: 0o600 });
      } else if (fs.existsSync(this.feishuSecretPath)) {
        fs.unlinkSync(this.feishuSecretPath);
      }
    }
    const workspace = next.workspacePath || current.workspacePath;
    fs.mkdirSync(workspace, { recursive: true });
    return this.get();
  }

  getApiKey(): string {
    if (!fs.existsSync(this.keyPath)) return "";
    const encrypted = fs.readFileSync(this.keyPath);
    try {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(encrypted)
        : encrypted.toString("utf8");
    } catch {
      // Older builds wrote the raw key when Electron's credential store was
      // unavailable. Keep that backwards-compatible path, but never treat
      // arbitrary unreadable bytes as a valid API key.
      const legacy = encrypted.toString("utf8").trim();
      return legacy.startsWith("sk-") ? legacy : "";
    }
  }

  getFeishuAppSecret(): string {
    if (!fs.existsSync(this.feishuSecretPath)) return "";
    const encrypted = fs.readFileSync(this.feishuSecretPath);
    try {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(encrypted)
        : encrypted.toString("utf8");
    } catch {
      return encrypted.toString("utf8").trim();
    }
  }
}
