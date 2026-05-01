import { useEffect, useState } from "react";
import { getAllSettings, setSetting } from "../services/settings";

interface Settings {
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
  telegram_bot_token: string;
  telegram_allowed_user_id: string;
  [key: string]: string;
}

const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

const FALLBACK_OLLAMA = [
  "llama3.1", "llama3.2", "llama3.3", "mistral", "gemma3",
  "qwen2.5", "deepseek-r1", "phi3",
];

const FEATURES = [
  { key: "autosort", label: "Autosorting" },
  { key: "chat", label: "Chat" },
  { key: "work", label: "Work" },
  { key: "bot", label: "Telegram Bot" },
] as const;

export function SettingsSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaOnline, setOllamaOnline] = useState(false);
  const [showKeysModal, setShowKeysModal] = useState(false);

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      const s = await getAllSettings();
      setSettings(s);
      if (s.ollama_url) checkOllama(s.ollama_url);
    } catch (err) {
      console.error("Failed to load settings:", err);
      setError("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }

  async function checkOllama(url: string) {
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        setOllamaOnline(true);
        const data = await res.json();
        if (data.models) setOllamaModels(data.models.map((m: { name: string }) => m.name.replace(":latest", "")));
      } else { setOllamaOnline(false); }
    } catch { setOllamaOnline(false); }
  }

  async function save(updates: Partial<Settings>) {
    try {
      for (const [key, value] of Object.entries(updates)) {
        await setSetting(key, value as string);
      }
      setToast("Saved");
      setTimeout(() => setToast(null), 1200);
    } catch {
      await loadSettings();
      setError("Failed to save");
      setTimeout(() => setError(null), 2000);
    }
  }

  function set(key: string, value: string) {
    if (!settings) return;
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    save({ [key]: value });
  }

  if (loading) {
    return (
      <main className="flex-1 flex items-center justify-center bg-[#18181b]">
        <p className="text-gray-500 text-sm">Loading...</p>
      </main>
    );
  }

  const ollamaList = ollamaModels.length > 0 ? ollamaModels : FALLBACK_OLLAMA;

  return (
    <main className="flex-1 flex flex-col bg-[#18181b] overflow-y-auto pb-12">
      <div className="max-w-2xl mx-auto w-full space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-white">Settings</h1>
          <div className="flex items-center gap-3">
            {toast && <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded">{toast}</span>}
            {error && <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded">{error}</span>}
            <button
              onClick={() => setShowKeysModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">key</span>
              Keys
            </button>
          </div>
        </div>

        {settings && (
          <>
            {/* Feature table */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center px-4 py-2 border-b border-white/[0.06] bg-white/[0.02]">
                <span className="text-[11px] text-gray-500 uppercase tracking-wider w-28 shrink-0">Feature</span>
                <span className="text-[11px] text-gray-500 uppercase tracking-wider w-32 shrink-0">Provider</span>
                <span className="text-[11px] text-gray-500 uppercase tracking-wider flex-1">Model</span>
              </div>

              {FEATURES.map(({ key, label }, i) => {
                const featureProvider = settings[`${key}_provider`] || settings.provider || "gemini";
                const isGemini = featureProvider === "gemini";
                const modelKey = isGemini ? `${key}_gemini_model` : `${key}_ollama_model`;
                const currentModel = settings[modelKey] || (isGemini ? GEMINI_MODELS[0] : ollamaList[0]);
                const modelList = isGemini ? GEMINI_MODELS : ollamaList;
                const isLast = i === FEATURES.length - 1;

                return (
                  <div key={key} className={`flex items-center px-4 py-2.5 ${!isLast ? "border-b border-white/[0.04]" : ""}`}>
                    <span className="text-sm text-gray-300 w-28 shrink-0">{label}</span>

                    {/* Provider select */}
                    <div className="w-32 shrink-0 pr-3">
                      <select
                        value={featureProvider}
                        onChange={(e) => set(`${key}_provider`, e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer"
                      >
                        <option value="gemini" className="bg-[#1e1e22]">Gemini</option>
                        <option value="ollama" className="bg-[#1e1e22]">Ollama</option>
                      </select>
                    </div>

                    {/* Model select */}
                    <div className="flex-1">
                      <select
                        value={modelList.includes(currentModel) ? currentModel : ""}
                        onChange={(e) => set(modelKey, e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer"
                      >
                        {!modelList.includes(currentModel) && currentModel && (
                          <option value="" disabled className="bg-[#1e1e22]">{currentModel} (unavailable)</option>
                        )}
                        {modelList.map((m) => (
                          <option key={m} value={m} className="bg-[#1e1e22]">{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── Keys Modal ── */}
      {showKeysModal && settings && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-[#18181b] border border-[#474848]/30 rounded-xl p-6 w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-[#e7e5e5]">API Keys & Connections</h3>
              <button onClick={() => setShowKeysModal(false)} className="text-[#acabab] hover:text-[#e7e5e5] cursor-pointer">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="space-y-5">
              {/* Gemini API Key */}
              <div>
                <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
                  Google Gemini API Key
                </label>
                <p className="text-[10px] text-[#acabab]/60 mb-2">
                  Required for Gemini. Get a free key at{" "}
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-[#adc6ff] hover:underline">
                    Google AI Studio
                  </a>
                </p>
                <div className="flex gap-2 items-center">
                  <input
                    type="password"
                    value={settings.gemini_api_key}
                    onChange={(e) => setSettings({ ...settings, gemini_api_key: e.target.value })}
                    placeholder="Enter your Gemini API key"
                    className="flex-1 bg-[#202022] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-[#adc6ff]/50"
                  />
                  <button onClick={() => save({ gemini_api_key: settings.gemini_api_key })}
                    className="px-3 py-2 bg-[#adc6ff] text-[#003d87] text-xs font-bold rounded-lg hover:bg-[#97b9ff] transition-colors cursor-pointer">Save</button>
                </div>
              </div>

              {/* Ollama URL */}
              <div>
                <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
                  Ollama URL
                </label>
                <p className="text-[10px] text-[#acabab]/60 mb-2">
                  URL of your running Ollama instance.{" "}
                  <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-[#adc6ff] hover:underline">
                    Download Ollama
                  </a>
                </p>
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={settings.ollama_url}
                    onChange={(e) => setSettings({ ...settings, ollama_url: e.target.value })}
                    placeholder="http://localhost:11434"
                    className="flex-1 bg-[#202022] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-emerald-500/40"
                  />
                  <span className={`w-2 h-2 rounded-full shrink-0 ${ollamaOnline ? "bg-green-400" : "bg-red-400"}`} />
                  <button onClick={() => { save({ ollama_url: settings.ollama_url }); checkOllama(settings.ollama_url); }}
                    className="px-3 py-2 bg-[#adc6ff] text-[#003d87] text-xs font-bold rounded-lg hover:bg-[#97b9ff] transition-colors cursor-pointer">Save</button>
                </div>
              </div>

              {/* Telegram Bot Token */}
              <div>
                <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
                  Telegram Bot Token
                </label>
                <p className="text-[10px] text-[#acabab]/60 mb-2">
                  Message <span className="text-[#adc6ff]">@BotFather</span> on Telegram to create a bot and get its token.
                </p>
                <div className="flex gap-2 items-center">
                  <input
                    type="password"
                    value={settings.telegram_bot_token}
                    onChange={(e) => setSettings({ ...settings, telegram_bot_token: e.target.value })}
                    placeholder="Paste your Telegram Bot Token"
                    className="flex-1 bg-[#202022] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-[#adc6ff]/50"
                  />
                  <button onClick={() => save({ telegram_bot_token: settings.telegram_bot_token })}
                    className="px-3 py-2 bg-[#adc6ff] text-[#003d87] text-xs font-bold rounded-lg hover:bg-[#97b9ff] transition-colors cursor-pointer">Save</button>
                </div>
              </div>

              {/* Telegram User ID */}
              <div>
                <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
                  Your Telegram User ID
                </label>
                <p className="text-[10px] text-[#acabab]/60 mb-2">
                  Message <span className="text-[#adc6ff]">@userinfobot</span> on Telegram to get your numeric user ID.
                </p>
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={settings.telegram_allowed_user_id}
                    onChange={(e) => setSettings({ ...settings, telegram_allowed_user_id: e.target.value })}
                    placeholder="Your numeric Telegram User ID"
                    className="flex-1 bg-[#202022] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-[#adc6ff]/50"
                  />
                  <button onClick={() => save({ telegram_allowed_user_id: settings.telegram_allowed_user_id })}
                    className="px-3 py-2 bg-[#adc6ff] text-[#003d87] text-xs font-bold rounded-lg hover:bg-[#97b9ff] transition-colors cursor-pointer">Save</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}