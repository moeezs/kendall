import { useEffect, useRef, useState } from "react";
import { Command, type Child } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";

const STATUS_PORT = 3721;
const HEALTH_URL = `http://127.0.0.1:${STATUS_PORT}/health`;
const POLL_INTERVAL = 3000;

type BotStatus = "running" | "stopped" | "starting" | "stopping" | "unknown";

async function getServerScriptPath(): Promise<string> {
  return invoke<string>("server_script_path");
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function StatusDot({ status }: { status: BotStatus }) {
  const colors: Record<BotStatus, string> = {
    running: "bg-green-400",
    stopped: "bg-red-400",
    starting: "bg-yellow-400 animate-pulse",
    stopping: "bg-yellow-400 animate-pulse",
    unknown: "bg-gray-400",
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[status]} shrink-0`} />
  );
}

export function WorkSection() {
  const [status, setStatus] = useState<BotStatus>("unknown");
  const childRef = useRef<Child | null>(null);

  // Poll health endpoint
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      // Only poll if not in a transition state
      setStatus((prev) => {
        if (prev === "starting" || prev === "stopping") return prev;
        return prev; // will be updated by checkHealth result
      });
      const alive = await checkHealth();
      if (!cancelled) {
        setStatus((prev) => {
          if (prev === "starting" || prev === "stopping") return prev;
          return alive ? "running" : "stopped";
        });
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function startBot() {
    setStatus("starting");
    try {
      const scriptPath = await getServerScriptPath();
      const command = Command.create("node", [scriptPath], {
        env: { KENDALL_APP_ID: "com.moeez.kendall" },
      });
      // Detect "running" from the success log line in stdout
      command.stdout.on("data", (line) => {
        console.log("[bot stdout]", line);
        if (line.includes("✅ Kendall Telegram bot running")) {
          setStatus("running");
        }
      });
      command.stderr.on("data", (line) => console.error("[bot stderr]", line));
      const child = await command.spawn();
      childRef.current = child;

      // Also poll health endpoint as a fallback (up to 20 s)
      let attempts = 0;
      const wait = setInterval(async () => {
        attempts++;
        const alive = await checkHealth();
        if (alive) {
          clearInterval(wait);
          setStatus("running");
        } else if (attempts >= 20) {
          clearInterval(wait);
          // If still not up after 20 s, something went wrong
          setStatus((prev) => (prev === "starting" ? "stopped" : prev));
        }
      }, 1000);
    } catch (err) {
      console.error("Failed to start bot:", err);
      setStatus("stopped");
    }
  }

  async function stopBot() {
    setStatus("stopping");
    try {
      if (childRef.current) {
        await childRef.current.kill();
        childRef.current = null;
      }
      // Confirm it's actually down
      let attempts = 0;
      const wait = setInterval(async () => {
        attempts++;
        const alive = await checkHealth();
        if (!alive) {
          clearInterval(wait);
          setStatus("stopped");
        } else if (attempts >= 10) {
          clearInterval(wait);
          setStatus("stopped");
        }
      }, 500);
    } catch (err) {
      console.error("Failed to stop bot:", err);
      setStatus("unknown");
    }
  }

  function handleClick() {
    if (status === "running") stopBot();
    else if (status === "stopped") startBot();
  }

  const label =
    status === "running"
      ? `Bot · :${STATUS_PORT}`
      : status === "starting"
        ? "Starting…"
        : status === "stopping"
          ? "Stopping…"
          : "Bot offline";

  const clickable = status === "running" || status === "stopped";
  const title =
    status === "running"
      ? `Telegram bot running on port ${STATUS_PORT} — click to stop`
      : status === "stopped"
        ? "Telegram bot stopped — click to start"
        : "";

  return (
    <div className="flex-1 flex items-center justify-center relative">
      <p className="text-gray-500 text-lg">Work space coming soon…</p>

      {/* Bot status indicator — top-right corner */}
      <button
        onClick={clickable ? handleClick : undefined}
        title={title}
        className={[
          "absolute top-3 right-3",
          "flex items-center gap-1.5 px-2.5 py-1 rounded-full",
          "text-xs font-medium select-none",
          "border border-white/10 bg-white/5 backdrop-blur-sm",
          clickable
            ? "cursor-pointer hover:bg-white/10 transition-colors"
            : "cursor-default",
        ].join(" ")}
      >
        <StatusDot status={status} />
        <span className="text-gray-300">{label}</span>
      </button>
    </div>
  );
}

