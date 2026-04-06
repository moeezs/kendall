import { useEffect, useState } from "react";

const STATUS_PORT = 3721;
const SETTINGS_URL = `http://127.0.0.1:${STATUS_PORT}/settings`;

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
  const [botOnline, setBotOnline] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaOnline, setOllamaOnline] = useState(false);

  useEffect(() => { loadSettings(); }, []);
  useEffect(() => {
    if (settings?.ollama_url) checkOllama(settings.ollama_url);
  }, [settings?.ollama_url]);

  async function loadSettings() {
    setLoading(true);
    try {
      const res = await fetch(SETTINGS_URL, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error();
      setSettings(await res.json());
      setBotOnline(true);
    } catch {
      setError("Bot server is offline.");
      setBotOnline(false);
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
      const res = await fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error();
      setToast("Saved");
      setTimeout(() => setToast(null), 1200);
    } catch {
      // On failure reload from server to revert to actual saved state
      loadSettings();
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
      <main className="flex-1 flex items-center justify-center bg-[#18181b] -mx-8 -mb-20">
        <p className="text-gray-500 text-sm">Loading...</p>
      </main>
    );
  }

  const ollamaList = ollamaModels.length > 0 ? ollamaModels : FALLBACK_OLLAMA;

  return (
    <main className="flex-1 flex flex-col bg-[#18181b] overflow-y-auto -mx-8 -mb-20 pt-24 pb-12 px-6">
      <div className="max-w-2xl mx-auto w-full space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-white">Settings</h1>
          <div className="flex gap-2 items-center">
            {toast && <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded">{toast}</span>}
            {error && <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded">{error}</span>}
          </div>
        </div>

        {!botOnline ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center">
            <p className="text-gray-400 text-sm">Bot server is offline</p>
            <p className="text-gray-500 text-xs mt-1">Start the bot from the Work tab first</p>
          </div>
        ) : settings && (
          <>
            {/* Connection row */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
              <div className="flex gap-2 items-center">
                <input
                  type="password"
                  value={settings.gemini_api_key}
                  onChange={(e) => setSettings({ ...settings, gemini_api_key: e.target.value })}
                  placeholder="Gemini API Key"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500/40"
                />
                <button onClick={() => save({ gemini_api_key: settings.gemini_api_key })}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white text-xs rounded-lg transition-colors">Save</button>
              </div>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={settings.ollama_url}
                  onChange={(e) => setSettings({ ...settings, ollama_url: e.target.value })}
                  placeholder="Ollama URL"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-emerald-500/40"
                />
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ollamaOnline ? "bg-green-400" : "bg-red-400"}`} />
                <button onClick={() => { save({ ollama_url: settings.ollama_url }); checkOllama(settings.ollama_url); }}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white text-xs rounded-lg transition-colors">Save</button>
              </div>
            </div>

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
    </main>
  );
}
