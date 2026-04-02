import { getDb } from "./database";

export type AIProvider = "gemini" | "ollama";
export type TaskType = "autosort" | "chat" | "work";

export interface AISettings {
  autosort_provider: AIProvider;
  autosort_model: string;
  chat_provider: AIProvider;
  chat_model: string;
  work_provider: AIProvider;
  work_model: string;
}

const DEFAULTS: AISettings = {
  autosort_provider: "gemini",
  autosort_model: "gemini-2.5-flash-lite",
  chat_provider: "gemini",
  chat_model: "gemini-2.5-flash-lite",
  work_provider: "gemini",
  work_model: "gemini-2.5-flash-lite",
};

export async function initSettingsTable() {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM ai_settings WHERE key = $1",
    [key],
  );
  return rows.length > 0 ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO ai_settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function getAISettings(): Promise<AISettings> {
  await initSettingsTable();
  const settings = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS) as (keyof AISettings)[]) {
    const val = await getSetting(key);
    if (val !== null) {
      (settings as any)[key] = val;
    }
  }

  return settings;
}

export async function saveAISettings(settings: Partial<AISettings>): Promise<void> {
  await initSettingsTable();
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) {
      await setSetting(key, value);
    }
  }
}

export async function getProviderAndModel(task: TaskType): Promise<{ provider: AIProvider; model: string }> {
  const settings = await getAISettings();
  return {
    provider: settings[`${task}_provider`],
    model: settings[`${task}_model`],
  };
}
