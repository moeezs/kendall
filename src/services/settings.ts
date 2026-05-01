import { getDb } from "./database";

export interface AppSettings {
  provider: string;
  gemini_api_key: string;
  ollama_url: string;
  bot_provider: string;
  chat_provider: string;
  work_provider: string;
  autosort_provider: string;
  bot_gemini_model: string;
  bot_ollama_model: string;
  chat_gemini_model: string;
  chat_ollama_model: string;
  work_gemini_model: string;
  work_ollama_model: string;
  autosort_gemini_model: string;
  autosort_ollama_model: string;
  kendall_home: string;
  telegram_bot_token: string;
  telegram_allowed_user_id: string;
  [key: string]: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  provider: "gemini",
  gemini_api_key: "",
  ollama_url: "http://localhost:11434",
  bot_provider: "",
  chat_provider: "",
  work_provider: "",
  autosort_provider: "",
  bot_gemini_model: "gemini-2.5-flash-lite",
  bot_ollama_model: "llama3.1",
  chat_gemini_model: "gemini-2.5-flash-lite",
  chat_ollama_model: "llama3.1",
  work_gemini_model: "gemini-2.5-flash-lite",
  work_ollama_model: "llama3.1",
  autosort_gemini_model: "gemini-2.5-flash-lite",
  autosort_ollama_model: "llama3.1",
  kendall_home: "",
  telegram_bot_token: "",
  telegram_allowed_user_id: "",
};

// Ensure the settings table exists and has defaults
export async function initSettings(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await db.select<{ _row: number }[]>(
      "SELECT 1 FROM settings WHERE key = $1",
      [key],
    );
    if (existing.length === 0) {
      await db.execute("INSERT INTO settings (key, value) VALUES ($1, $2)", [
        key,
        value,
      ]);
    }
  }
}

export async function getSetting(key: string): Promise<string> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key],
  );
  return rows.length > 0 ? rows[0].value : DEFAULT_SETTINGS[key] || "";
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)",
    [key, value],
  );
}

export async function getAllSettings(): Promise<AppSettings> {
  const db = await getDb();
  const rows = await db.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings",
  );
  const stored: Record<string, string> = {};
  for (const row of rows) {
    stored[row.key] = row.value;
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}