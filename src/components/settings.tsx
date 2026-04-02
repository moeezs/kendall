import { useEffect, useState } from "react";
import {
  type AISettings,
  type AIProvider,
  getAISettings,
  saveAISettings,
} from "../services/settings";
import { getOllamaModels, isOllamaRunning, type OllamaModel } from "../services/ollama";

const TASKS: { key: "autosort" | "chat" | "work"; label: string }[] = [
  { key: "autosort", label: "Auto-Sort" },
  { key: "chat", label: "Chat" },
  { key: "work", label: "Work" },
];

export function SettingsSection() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getAISettings().then(setSettings);
    refreshOllama();
  }, []);

  const refreshOllama = async () => {
    const online = await isOllamaRunning();
    setOllamaOnline(online);
    if (online) {
      const models = await getOllamaModels();
      setOllamaModels(models);
    } else {
      setOllamaModels([]);
    }
  };

  const update = (key: keyof AISettings, value: string) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
  };

  const handleProviderChange = (task: "autosort" | "chat" | "work", provider: AIProvider) => {
    if (!settings) return;
    const updated = { ...settings, [`${task}_provider`]: provider };
    if (provider === "gemini") {
      updated[`${task}_model`] = "gemini-2.5-flash-lite";
    } else if (ollamaModels.length > 0) {
      updated[`${task}_model`] = ollamaModels[0].name;
    }
    setSettings(updated);
  };

  const handleSave = async () => {
    if (!settings) return;
    await saveAISettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) return null;

  return (
    <main className="w-full flex-1 overflow-y-auto pb-12">
      <div className="max-w-xl mx-auto pt-4 space-y-6">

        {/* Ollama status — single line */}
        <div className="flex items-center justify-between text-xs text-[#acabab]">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${ollamaOnline ? "bg-green-400" : "bg-red-400"}`} />
            <span>Ollama {ollamaOnline ? `· ${ollamaModels.length} model${ollamaModels.length !== 1 ? "s" : ""}` : "· offline"}</span>
          </div>
          <button onClick={refreshOllama} className="text-[#acabab] hover:text-white transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        </div>

        {/* Model config rows */}
        <div className="bg-[#202022] rounded-xl divide-y divide-[#2a2a2d]">
          {TASKS.map((task) => {
            const provider = settings[`${task.key}_provider`];
            const model = settings[`${task.key}_model`];

            return (
              <div key={task.key} className="flex items-center gap-4 px-5 py-4">
                <span className="text-sm font-medium text-[#e7e5e5] w-20 shrink-0">{task.label}</span>

                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(task.key, e.target.value as AIProvider)}
                  className="bg-[#18181b] text-[#e7e5e5] text-xs rounded-lg px-3 py-2 border border-[#333] focus:border-[#adc6ff]/50 focus:outline-none appearance-none cursor-pointer flex-1"
                >
                  <option value="gemini">Gemini</option>
                  <option value="ollama" disabled={!ollamaOnline}>Ollama{!ollamaOnline ? " (offline)" : ""}</option>
                </select>

                <select
                  value={model}
                  onChange={(e) => update(`${task.key}_model`, e.target.value)}
                  className="bg-[#18181b] text-[#e7e5e5] text-xs rounded-lg px-3 py-2 border border-[#333] focus:border-[#adc6ff]/50 focus:outline-none appearance-none cursor-pointer flex-[2]"
                >
                  {provider === "gemini" ? (
                    <>
                      <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
                      <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                      <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                    </>
                  ) : ollamaModels.length === 0 ? (
                    <option value="">No models</option>
                  ) : (
                    ollamaModels.map((m) => (
                      <option key={m.name} value={m.name}>{m.name}</option>
                    ))
                  )}
                </select>
              </div>
            );
          })}
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="bg-[#adc6ff] text-[#003d87] text-xs font-bold px-5 py-2 rounded-full hover:bg-[#97b9ff] transition-colors cursor-pointer"
          >
            Save
          </button>
          {saved && <span className="text-green-400 text-xs">Saved</span>}
        </div>
      </div>
    </main>
  );
}
