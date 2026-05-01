import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { setSetting } from "../services/settings";

interface OnboardingProps {
  onComplete: () => void;
}

export function OnboardingWizard({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateData(updates: Record<string, string>) {
    setData((prev) => ({ ...prev, ...updates }));
  }

  async function handleStep1(kendallHome: string) {
    setLoading(true);
    setError(null);
    try {
      // Create the directory if it doesn't exist
      const { exists } = await import("@tauri-apps/plugin-fs");
      if (!(await exists(kendallHome))) {
        await mkdir(kendallHome, { recursive: true });
      }
      // Create Dump folder
      const dumpPath = await join(kendallHome, "Dump");
      if (!(await exists(dumpPath))) {
        await mkdir(dumpPath);
      }
      updateData({ kendall_home: kendallHome });
      setStep(2);
    } catch (err) {
      setError("Failed to create directory. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2(provider: string, apiKeyOrUrl: string) {
    setLoading(true);
    setError(null);
    try {
      if (provider === "gemini") {
        // Validate Gemini API key
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKeyOrUrl}`,
        );
        if (!res.ok) {
          setError("Invalid Gemini API key. Please check and try again.");
          setLoading(false);
          return;
        }
        updateData({
          provider: "gemini",
          gemini_api_key: apiKeyOrUrl,
          bot_provider: "gemini",
          chat_provider: "gemini",
          work_provider: "gemini",
          autosort_provider: "gemini",
        });
      } else {
        // Validate Ollama URL
        const res = await fetch(`${apiKeyOrUrl}/api/tags`);
        if (!res.ok) {
          setError("Cannot reach Ollama. Make sure it's running and the URL is correct.");
          setLoading(false);
          return;
        }
        updateData({
          provider: "ollama",
          ollama_url: apiKeyOrUrl,
          bot_provider: "ollama",
          chat_provider: "ollama",
          work_provider: "ollama",
          autosort_provider: "ollama",
        });
      }
      setStep(3);
    } catch {
      setError("Connection failed. Please check your input and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep3(botToken: string, userId: string) {
    setLoading(true);
    setError(null);
    try {
      if (botToken) {
        // Validate bot token
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        if (!res.ok) {
          setError("Invalid Telegram bot token. Please check and try again.");
          setLoading(false);
          return;
        }
        updateData({
          telegram_bot_token: botToken,
          telegram_allowed_user_id: userId,
        });
      }
      setStep(4);
    } catch {
      setError("Failed to validate bot token. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFinish() {
    setLoading(true);
    try {
      // Save all collected data to settings
      for (const [key, value] of Object.entries(data)) {
        if (value) {
          await setSetting(key, value);
        }
      }
      await setSetting("onboarding_complete", "true");
      onComplete();
    } catch (err) {
      setError("Failed to save settings. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-screen w-screen bg-[#18181b] flex items-center justify-center">
      <div className="max-w-lg w-full mx-4">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                s === step
                  ? "bg-[#adc6ff]"
                  : s < step
                    ? "bg-green-400"
                    : "bg-[#474848]/30"
              }`}
            />
          ))}
        </div>

        {/* Step 1: Welcome + Kendall Home */}
        {step === 1 && <Step1Welcome onNext={handleStep1} loading={loading} error={error} />}

        {/* Step 2: AI Configuration */}
        {step === 2 && <Step2AI onNext={handleStep2} onSkip={() => setStep(3)} loading={loading} error={error} />}

        {/* Step 3: Telegram Bot */}
        {step === 3 && <Step3Telegram onNext={handleStep3} onSkip={() => setStep(4)} loading={loading} error={error} />}

        {/* Step 4: Done */}
        {step === 4 && <Step4Done data={data} onFinish={handleFinish} loading={loading} error={error} />}
      </div>
    </div>
  );
}

// ── Step 1: Welcome + Kendall Home Directory ──

function Step1Welcome({
  onNext,
  loading,
  error,
}: {
  onNext: (path: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}) {
  const [kendallHome, setKendallHome] = useState("");

  async function initDefault() {
    const desktop = await desktopDir();
    setKendallHome(await join(desktop, "kendall"));
  }
  // Initialize default on mount
  if (!kendallHome) initDefault();

  async function pickFolder() {
    const folder = await open({
      directory: true,
      title: "Choose Kendall Home Directory",
    });
    if (folder) setKendallHome(folder);
  }

  return (
    <div className="bg-[#202022] border border-[#474848]/20 rounded-xl p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-3 bg-[#adc6ff]/10 rounded-xl">
          <span
            className="material-symbols-outlined text-[#adc6ff] text-3xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            auto_mode
          </span>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[#e7e5e5]">Welcome to Kendall</h1>
          <p className="text-sm text-[#acabab] mt-1">
            Your personal AI OS that lives on your machine.
          </p>
        </div>
      </div>

      <div className="mb-6">
        <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
          Kendall Home Directory
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={kendallHome}
            readOnly
            className="flex-1 bg-[#18181b] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none"
          />
          <button
            onClick={pickFolder}
            className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white text-xs rounded-lg transition-colors cursor-pointer"
          >
            Browse
          </button>
        </div>
        <p className="text-xs text-[#acabab]/60 mt-2">
          This is where all your files, folders, and projects will live. You can change it later in Settings.
        </p>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg mb-4">{error}</p>
      )}

      <button
        onClick={() => onNext(kendallHome)}
        disabled={loading || !kendallHome}
        className="w-full px-4 py-2.5 bg-[#adc6ff] text-[#003d87] text-sm font-bold rounded-lg hover:bg-[#97b9ff] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {loading ? "Setting up..." : "Continue"}
      </button>
    </div>
  );
}

// ── Step 2: AI Configuration ──

function Step2AI({
  onNext,
  onSkip,
  loading,
  error,
}: {
  onNext: (provider: string, value: string) => Promise<void>;
  onSkip: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [provider, setProvider] = useState<"gemini" | "ollama">("gemini");
  const [apiKey, setApiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);

  async function checkOllama() {
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      setOllamaOnline(res.ok);
    } catch {
      setOllamaOnline(false);
    }
  }

  return (
    <div className="bg-[#202022] border border-[#474848]/20 rounded-xl p-8">
      <h2 className="text-lg font-bold text-[#e7e5e5] mb-2">Choose Your AI Provider</h2>
      <p className="text-sm text-[#acabab] mb-6">
        Kendall needs an AI to sort files, answer questions, and generate documents.
      </p>

      {/* Provider toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setProvider("gemini")}
          className={`flex-1 px-4 py-2.5 text-sm font-bold rounded-lg transition-colors cursor-pointer ${
            provider === "gemini"
              ? "bg-[#adc6ff] text-[#003d87]"
              : "bg-white/5 text-[#acabab] hover:bg-white/10"
          }`}
        >
          Google Gemini
        </button>
        <button
          onClick={() => setProvider("ollama")}
          className={`flex-1 px-4 py-2.5 text-sm font-bold rounded-lg transition-colors cursor-pointer ${
            provider === "ollama"
              ? "bg-[#adc6ff] text-[#003d87]"
              : "bg-white/5 text-[#acabab] hover:bg-white/10"
          }`}
        >
          Ollama (Local)
        </button>
      </div>

      {provider === "gemini" ? (
        <div className="space-y-3">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your Gemini API Key"
            className="w-full bg-[#18181b] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-[#adc6ff]/50"
          />
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#adc6ff] hover:underline block"
          >
            Get a free API key at Google AI Studio →
          </a>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="Ollama URL"
              className="flex-1 bg-[#18181b] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-emerald-500/40"
            />
            <button
              onClick={checkOllama}
              className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white text-xs rounded-lg transition-colors cursor-pointer"
            >
              Test
            </button>
          </div>
          {ollamaOnline !== null && (
            <p className={`text-xs ${ollamaOnline ? "text-green-400" : "text-red-400"}`}>
              {ollamaOnline ? "● Ollama is online" : "○ Ollama is offline"}
            </p>
          )}
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#adc6ff] hover:underline block"
          >
            Download Ollama →
          </a>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg mt-4">{error}</p>
      )}

      <div className="flex gap-2 mt-6">
        <button
          onClick={onSkip}
          className="flex-1 px-4 py-2.5 text-sm font-semibold text-[#acabab] hover:text-[#e7e5e5] transition-colors cursor-pointer"
        >
          Skip for now
        </button>
        <button
          onClick={() => {
            if (provider === "gemini") onNext("gemini", apiKey);
            else onNext("ollama", ollamaUrl);
          }}
          disabled={
            loading ||
            (provider === "gemini" && !apiKey) ||
            (provider === "ollama" && !ollamaUrl)
          }
          className="flex-1 px-4 py-2.5 bg-[#adc6ff] text-[#003d87] text-sm font-bold rounded-lg hover:bg-[#97b9ff] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {loading ? "Checking..." : "Continue"}
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Telegram Bot Setup ──

function Step3Telegram({
  onNext,
  onSkip,
  loading,
  error,
}: {
  onNext: (token: string, userId: string) => Promise<void>;
  onSkip: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [botToken, setBotToken] = useState("");
  const [userId, setUserId] = useState("");

  return (
    <div className="bg-[#202022] border border-[#474848]/20 rounded-xl p-8">
      <h2 className="text-lg font-bold text-[#e7e5e5] mb-2">Telegram Bot (Optional)</h2>
      <p className="text-sm text-[#acabab] mb-6">
        Control Kendall from your phone. Your data stays local — the bot connects directly to your database.
      </p>

      <div className="space-y-4 mb-6">
        <div>
          <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
            Step 1: Create a bot
          </label>
          <p className="text-xs text-[#acabab]/60 mb-2">
            Message <span className="text-[#adc6ff]">@BotFather</span> on Telegram to create a new bot. Copy the token it gives you.
          </p>
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="Paste your Telegram Bot Token"
            className="w-full bg-[#18181b] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-[#adc6ff]/50"
          />
        </div>

        <div>
          <label className="text-xs font-bold text-[#acabab] uppercase tracking-widest mb-2 block">
            Step 2: Get your User ID
          </label>
          <p className="text-xs text-[#acabab]/60 mb-2">
            Message <span className="text-[#adc6ff]">@userinfobot</span> on Telegram to get your numeric user ID.
          </p>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="Your numeric Telegram User ID"
            className="w-full bg-[#18181b] border border-[#474848]/30 rounded-lg px-3 py-2 text-sm text-[#e7e5e5] placeholder:text-[#acabab]/50 focus:outline-none focus:border-[#adc6ff]/50"
          />
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg mb-4">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={onSkip}
          className="flex-1 px-4 py-2.5 text-sm font-semibold text-[#acabab] hover:text-[#e7e5e5] transition-colors cursor-pointer"
        >
          Skip
        </button>
        <button
          onClick={() => onNext(botToken, userId)}
          disabled={loading || !botToken}
          className="flex-1 px-4 py-2.5 bg-[#adc6ff] text-[#003d87] text-sm font-bold rounded-lg hover:bg-[#97b9ff] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {loading ? "Validating..." : "Continue"}
        </button>
      </div>
    </div>
  );
}

// ── Step 4: Done ──

function Step4Done({
  data,
  onFinish,
  loading,
  error,
}: {
  data: Record<string, string>;
  onFinish: () => Promise<void>;
  loading: boolean;
  error: string | null;
}) {
  const providerLabel = data.provider === "gemini" ? "Google Gemini" : "Ollama (Local)";
  const hasTelegram = !!data.telegram_bot_token;

  return (
    <div className="bg-[#202022] border border-[#474848]/20 rounded-xl p-8 text-center">
      <div className="p-4 bg-green-500/10 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
        <span
          className="material-symbols-outlined text-green-400 text-3xl"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          check_circle
        </span>
      </div>

      <h2 className="text-xl font-bold text-[#e7e5e5] mb-2">You're All Set!</h2>
      <p className="text-sm text-[#acabab] mb-6">Here's your configuration:</p>

      <div className="space-y-2 text-left mb-6">
        <div className="flex items-center gap-2 bg-[#18181b] rounded-lg px-4 py-2.5">
          <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
          <span className="text-sm text-[#e7e5e5]">
            Kendall Home: <span className="text-[#acabab]">{data.kendall_home || "~/Desktop/kendall"}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 bg-[#18181b] rounded-lg px-4 py-2.5">
          <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
          <span className="text-sm text-[#e7e5e5]">
            AI: <span className="text-[#acabab]">{providerLabel}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 bg-[#18181b] rounded-lg px-4 py-2.5">
          <span className={`material-symbols-outlined text-sm ${hasTelegram ? "text-green-400" : "text-[#acabab]"}`}>
            {hasTelegram ? "check_circle" : "radio_button_unchecked"}
          </span>
          <span className="text-sm text-[#e7e5e5]">
            Telegram Bot:{" "}
            <span className="text-[#acabab]">
              {hasTelegram ? "Configured" : "Skipped — set up later in Settings"}
            </span>
          </span>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg mb-4">{error}</p>
      )}

      <button
        onClick={onFinish}
        disabled={loading}
        className="w-full px-4 py-2.5 bg-[#adc6ff] text-[#003d87] text-sm font-bold rounded-lg hover:bg-[#97b9ff] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {loading ? "Saving..." : "Start Using Kendall"}
      </button>
    </div>
  );
}