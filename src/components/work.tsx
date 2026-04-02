import { useEffect, useRef, useState } from "react";
import { Command, type Child } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  createProject, getProjects, deleteProject,
  getProjectFiles, addProjectFile, removeProjectFile,
  getAllFilesMetadata, getProjectFileContents,
} from "../services/database";
import { generateDocument, reviseDocument, type AgentStep } from "../services/rag";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { jsPDF } from "jspdf";

// Bot status helpers (unchanged)

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

// Main

export function WorkSection() {
  // Bot state
  const [botStatus, setBotStatus] = useState<BotStatus>("unknown");
  const childRef = useRef<Child | null>(null);

  // Projects state
  const [projects, setProjects] = useState<any[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  // Project detail state
  const [projectFiles, setProjectFiles] = useState<any[]>([]);
  const [allFiles, setAllFiles] = useState<any[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileSearch, setFileSearch] = useState("");

  // Document generation state
  const [prompt, setPrompt] = useState("");
  const [generatedContent, setGeneratedContent] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [isRevising, setIsRevising] = useState(false);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Bot polling
  const botStatusRef = useRef<BotStatus>("unknown");
  botStatusRef.current = botStatus;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      // Skip the health fetch entirely when we know the bot is stopped — avoids console spam
      if (botStatusRef.current === "stopped") return;
      const alive = await checkHealth();
      if (!cancelled) {
        setBotStatus((prev) => {
          // Only update during stable states — let start/stop sequences own their transitions
          if (prev === "starting") return prev;
          if (prev === "stopping") return alive ? prev : "stopped";
          return alive ? "running" : "stopped";
        });
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Load projects on mount
  useEffect(() => {
    refreshProjects();
  }, []);

  // Load project files when active project changes
  useEffect(() => {
    if (activeProjectId) {
      refreshProjectFiles(activeProjectId);
    } else {
      setProjectFiles([]);
    }
    setGeneratedContent("");
    setPrompt("");
    setAgentSteps([]);
    setRevisionPrompt("");
  }, [activeProjectId]);

  async function refreshProjects() {
    try {
      const p = await getProjects();
      setProjects(p);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }

  async function refreshProjectFiles(projectId: string) {
    try {
      const files = await getProjectFiles(projectId);
      setProjectFiles(files);
    } catch (err) {
      console.error("Failed to load project files:", err);
    }
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    await createProject(id, name);
    setNewProjectName("");
    setShowNewProject(false);
    await refreshProjects();
    setActiveProjectId(id);
  }

  async function handleDeleteProject(id: string) {
    await deleteProject(id);
    if (activeProjectId === id) setActiveProjectId(null);
    await refreshProjects();
  }

  async function openFilePicker() {
    try {
      const files = await getAllFilesMetadata();
      setAllFiles(files);
    } catch (err) {
      console.error("Failed to load files:", err);
    }
    setFileSearch("");
    setShowFilePicker(true);
  }

  async function toggleFileLink(fileId: number) {
    if (!activeProjectId) return;
    const numId = Number(fileId);
    const isLinked = projectFiles.some((f) => Number(f.id) === numId);
    try {
      if (isLinked) {
        await removeProjectFile(activeProjectId, numId);
      } else {
        await addProjectFile(activeProjectId, numId);
      }
      await refreshProjectFiles(activeProjectId);
    } catch (err) {
      console.error("Failed to toggle file link:", err);
    }
  }

  // Agentic
  async function handleGenerate() {
    if (!prompt.trim() || !activeProjectId) return;
    setIsGenerating(true);
    setGeneratedContent("");
    setAgentSteps([]);

    try {
      // Fetch full file contents for linked project files
      const fileContents = await getProjectFileContents(activeProjectId);
      const formatted = fileContents.map((f: any) => ({
        filename: f.filename as string,
        content: (f.content || "") as string,
      }));

      const result = await generateDocument(
        prompt,
        activeProject?.name || "Document",
        formatted,
        (step) => setAgentSteps((prev) => [...prev, step]),
      );
      setGeneratedContent(result);
    } catch (err: any) {
      setAgentSteps((prev) => [...prev, { phase: "error", message: `Error: ${err.message}` }]);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleRevise() {
    if (!revisionPrompt.trim() || !generatedContent || !activeProjectId) return;
    setIsRevising(true);
    setAgentSteps([]);
    try {
      const fileContents = await getProjectFileContents(activeProjectId);
      const formatted = fileContents.map((f: any) => ({
        filename: f.filename as string,
        content: (f.content || "") as string,
      }));
      const result = await reviseDocument(
        generatedContent,
        revisionPrompt,
        activeProject?.name || "Document",
        formatted,
        (step) => setAgentSteps((prev) => [...prev, step]),
      );
      setGeneratedContent(result);
      setRevisionPrompt("");
    } catch (err: any) {
      setAgentSteps((prev) => [...prev, { phase: "error", message: `Error: ${err.message}` }]);
    } finally {
      setIsRevising(false);
    }
  }

  async function exportPDF() {
    if (!generatedContent) return;
    const doc = new jsPDF();
    const title = activeProject?.name || "Document";
    doc.setFontSize(18);
    doc.text(title, 20, 20);
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(generatedContent, 170);
    doc.text(lines, 20, 35);
    const pdfBytes = doc.output("arraybuffer");

    const desktop = await desktopDir();
    const outPath = await join(desktop, "kendall", `${title.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`);
    await writeFile(outPath, new Uint8Array(pdfBytes));
    await revealItemInDir(outPath);
  }

  async function exportDOCX() {
    if (!generatedContent) return;
    const title = activeProject?.name || "Document";
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...generatedContent.split("\n").map((line) =>
            new Paragraph({ children: [new TextRun({ text: line, size: 22 })] })
          ),
        ],
      }],
    });
    const blob = await Packer.toBlob(doc);
    const arrayBuffer = await blob.arrayBuffer();

    const desktop = await desktopDir();
    const outPath = await join(desktop, "kendall", `${title.replace(/[^a-zA-Z0-9]/g, "_")}.docx`);
    await writeFile(outPath, new Uint8Array(arrayBuffer));
    await revealItemInDir(outPath);
  }

  // Bot controls
  async function startBot() {
    setBotStatus("starting");
    try {
      const scriptPath = await getServerScriptPath();
      // Guard: if something is already listening on the health port, we're already running
      const alreadyRunning = await checkHealth();
      if (alreadyRunning) {
        setBotStatus("running");
        return;
      }

      const appId =
        import.meta.env.VITE_KENDALL_APP_ID ??
        import.meta.env.KENDALL_APP_ID;

      if (!appId) {
        console.error(
          "KENDALL_APP_ID is not configured. Please set VITE_KENDALL_APP_ID (or KENDALL_APP_ID) in your environment."
        );
        if (typeof window !== "undefined") {
          window.alert(
            "Unable to start Kendall bot: KENDALL_APP_ID is not configured.\n\n" +
            "Please set VITE_KENDALL_APP_ID (or KENDALL_APP_ID) in your environment and restart the application."
          );
        }
        setBotStatus("stopped");
        return;
      }
      const command = Command.create("node", [scriptPath], {
        env: { KENDALL_APP_ID: appId },
      });
      command.stdout.on("data", (line) => {
        console.log("[bot stdout]", line);
        if (line.includes("✅ Kendall Telegram bot running")) setBotStatus("running");
      });
      command.stderr.on("data", (line) => console.error("[bot stderr]", line));
      const child = await command.spawn();
      childRef.current = child;

      let attempts = 0;
      const wait = setInterval(async () => {
        attempts++;
        const alive = await checkHealth();
        if (alive) { clearInterval(wait); setBotStatus("running"); }
        else if (attempts >= 20) { clearInterval(wait); setBotStatus((p) => p === "starting" ? "stopped" : p); }
      }, 1000);
    } catch (err) {
      console.error("Failed to start bot:", err);
      setBotStatus("stopped");
    }
  }

  async function stopBot() {
    setBotStatus("stopping");
    try {
      if (childRef.current) {
        // We have a direct reference — kill via Tauri child process
        await childRef.current.kill();
        childRef.current = null;
      } else {
        // No reference (e.g. app was reopened while bot was already running)
        // Ask the server to shut itself down via HTTP
        try {
          await fetch(`http://127.0.0.1:${STATUS_PORT}/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          // Server already gone or didn't respond — that's fine
        }
      }
      // Poll until the process is confirmed dead
      let attempts = 0;
      const wait = setInterval(async () => {
        attempts++;
        const alive = await checkHealth();
        if (!alive || attempts >= 15) {
          clearInterval(wait);
          setBotStatus(alive ? "running" : "stopped");
        }
      }, 300);
    } catch (err) {
      console.error("Failed to stop bot:", err);
      setBotStatus("unknown");
    }
  }

  function handleBotClick() {
    if (botStatus === "running") stopBot();
    else if (botStatus === "stopped") startBot();
  }

  const botLabel = botStatus === "running" ? `Bot · :${STATUS_PORT}` : botStatus === "starting" ? "Starting…" : botStatus === "stopping" ? "Stopping…" : "Bot offline";
  const botClickable = botStatus === "running" || botStatus === "stopped";
  const botTitle = botStatus === "running" ? `Telegram bot running on port ${STATUS_PORT} — click to stop` : botStatus === "stopped" ? "Telegram bot stopped — click to start" : "";

  const filteredPickerFiles = allFiles.filter((f) => {
    if (!fileSearch.trim()) return true;
    const q = fileSearch.toLowerCase();
    return f.filename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  });

  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* ── Slim Project Sidebar ── */}
      <aside className="w-52 shrink-0 flex flex-col border-r border-[#474848]/20 pr-4 pt-2 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-bold text-[#acabab] uppercase tracking-widest">Projects</h3>
          <button
            onClick={() => setShowNewProject(true)}
            className="flex items-center justify-center w-6 h-6 text-[#acabab] hover:text-[#adc6ff] rounded-md hover:bg-[#202022] transition-colors cursor-pointer"
            title="New project"
          >
            <span className="material-symbols-outlined text-base">add</span>
          </button>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {projects.length === 0 && !showNewProject && (
            <p className="text-[10px] text-[#acabab]/50 mt-4 text-center">No projects yet</p>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => setActiveProjectId(p.id)}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all text-sm ${
                activeProjectId === p.id
                  ? "bg-[#adc6ff]/10 text-[#adc6ff]"
                  : "text-[#e7e5e5] hover:bg-[#202022]"
              }`}
            >
              <span className="material-symbols-outlined text-sm shrink-0">folder_open</span>
              <span className="truncate flex-1 font-medium">{p.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }}
                className="hidden group-hover:flex items-center justify-center w-5 h-5 text-red-400/60 hover:text-red-400 rounded transition-colors cursor-pointer shrink-0"
                title="Delete project"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          ))}
        </div>

        {/* Bot toggle — bottom of sidebar */}
        <div className="shrink-0 mt-3 pt-3 pb-3 border-t border-[#474848]/20">
          <button
            onClick={botClickable ? handleBotClick : undefined}
            title={botTitle}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium select-none transition-colors ${
              botClickable ? "cursor-pointer hover:bg-[#202022]" : "cursor-default"
            }`}
          >
            <StatusDot status={botStatus} />
            <span className="text-[#acabab] truncate">{botLabel}</span>
          </button>
        </div>
      </aside>

      {/* ── Files Panel (visible when project active) ── */}
      {activeProject && (
        <div className="w-60 shrink-0 flex flex-col border-r border-[#474848]/20 px-4 pt-2 pb-4 overflow-hidden">
          {/* Project name */}
          <div className="shrink-0 mb-4">
            <h2 className="text-base font-bold text-[#e7e5e5] truncate">{activeProject.name}</h2>
          </div>

          {/* Files header */}
          <div className="shrink-0 flex items-center justify-between mb-2">
            <h3 className="text-[10px] font-bold text-[#acabab] uppercase tracking-widest">Files</h3>
            <button
              onClick={openFilePicker}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-[#acabab] hover:text-[#e7e5e5] bg-[#202022] hover:bg-[#28282a] rounded-full border border-[#474848]/20 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-xs">attach_file</span>
              Link
            </button>
          </div>

          {/* File list */}
          {projectFiles.length === 0 ? (
            <div className="rounded-xl p-4 text-center border border-dashed border-[#474848]/30">
              <p className="text-[10px] text-[#acabab]">No files linked yet.</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
              {projectFiles.map((f) => (
                <div
                  key={f.id}
                  className="group flex items-center gap-2 bg-[#202022] rounded-lg px-3 py-2 border border-transparent hover:border-[#474848]/20 transition-all"
                >
                  <span className="material-symbols-outlined text-[#acabab] text-sm shrink-0">
                    {f.filename.endsWith(".pdf") ? "description" : f.filename.match(/\.(png|jpg|jpeg)$/i) ? "image" : "article"}
                  </span>
                  <span className="text-xs font-medium text-[#e7e5e5] truncate flex-1">{f.filename}</span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => revealItemInDir(f.path)} className="flex items-center justify-center w-6 h-6 text-[#acabab] hover:text-[#adc6ff] rounded transition-colors cursor-pointer" title="Reveal in Finder">
                      <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                    </button>
                    <button onClick={() => toggleFileLink(f.id)} className="flex items-center justify-center w-6 h-6 text-red-400/60 hover:text-red-400 rounded transition-colors cursor-pointer" title="Unlink">
                      <span className="material-symbols-outlined text-[13px]">link_off</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Document Workspace ── */}
      <main className="flex-1 flex flex-col overflow-hidden pl-6 pr-4 pt-2 pb-4">
        {!activeProject ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full opacity-60">
            <span className="material-symbols-outlined text-5xl text-[#acabab] mb-4">work</span>
            <p className="text-[#acabab] text-sm">Select or create a project to get started.</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden gap-3 min-h-0">

            {/* Prompt input */}
            <div className="shrink-0">
              <div className="bg-[#202022] rounded-xl p-1 border border-[#474848]/30 focus-within:border-[#adc6ff]/50 transition-all">
                <div className="flex items-end gap-2 px-3 py-2">
                  <textarea
                    placeholder="Describe the document you want to create..."
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGenerate(); }
                    }}
                    rows={2}
                    disabled={isGenerating || isRevising}
                    className="flex-1 bg-transparent border-none text-[#e7e5e5] placeholder:text-[#acabab]/50 text-sm py-2 resize-none max-h-40 outline-none disabled:opacity-50"
                  />
                  <button
                    onClick={handleGenerate}
                    disabled={isGenerating || isRevising || !prompt.trim()}
                    className="mb-1 flex items-center justify-center h-8 w-8 bg-[#18181b] border border-[#2b2c2c] text-[#adc6ff] rounded-sm hover:border-[#adc6ff]/50 hover:bg-[#2b2c2c] transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {isGenerating ? "hourglass_top" : "arrow_upward"}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Agent step log */}
            {agentSteps.length > 0 && (
              <div className="shrink-0 bg-[#202022] rounded-xl border border-[#474848]/20 overflow-hidden">
                <div className="px-4 py-2 bg-[#28282a] border-b border-[#474848]/20 flex items-center gap-2">
                  <span className={`material-symbols-outlined text-sm ${isGenerating || isRevising ? "text-[#adc6ff] animate-pulse" : "text-green-400"}`}>
                    {isGenerating || isRevising ? "manufacturing" : "check_circle"}
                  </span>
                  <span className="text-[10px] font-bold text-[#acabab] uppercase tracking-widest">Agent Activity</span>
                </div>
                <div className="px-4 py-3 space-y-2 max-h-36 overflow-y-auto">
                  {agentSteps.map((step, i) => {
                    const isLatest = i === agentSteps.length - 1;
                    const isActive = isGenerating || isRevising;
                    const phaseIcon: Record<string, string> = {
                      researching: "search", planning: "edit_note", writing: "draw",
                      refining: "auto_fix_high", done: "check_circle", error: "error",
                    };
                    const phaseColor: Record<string, string> = {
                      researching: "text-yellow-400", planning: "text-[#adc6ff]",
                      writing: "text-purple-400", refining: "text-orange-400",
                      done: "text-green-400", error: "text-red-400",
                    };
                    return (
                      <div key={i} className={`flex items-start gap-2 ${isLatest && isActive ? "" : "opacity-60"}`}>
                        <span className={`material-symbols-outlined text-sm mt-0.5 shrink-0 ${isLatest && isActive ? phaseColor[step.phase] + " animate-pulse" : phaseColor[step.phase]}`}>
                          {phaseIcon[step.phase] || "circle"}
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs text-[#e7e5e5]">{step.message}</p>
                          {step.detail && (
                            <pre className="text-[10px] text-[#acabab]/60 mt-1 whitespace-pre-wrap font-mono">{step.detail}</pre>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Generated document — fills remaining vertical space */}
            {generatedContent && (
              <>
                <div className="flex-1 min-h-0 overflow-y-auto bg-[#202022] rounded-xl p-5 border border-[#474848]/20">
                  <p className="text-sm leading-7 text-[#e7e5e5] whitespace-pre-wrap">{generatedContent}</p>
                </div>

                {/* Revision input */}
                <div className="shrink-0">
                  <div className="bg-[#202022] rounded-xl p-1 border border-[#474848]/30 focus-within:border-[#adc6ff]/50 transition-all">
                    <div className="flex items-end gap-2 px-3 py-2">
                      <textarea
                        placeholder="Revise: describe what to change… (e.g. 'make the intro shorter', 'add a pricing section')"
                        value={revisionPrompt}
                        onChange={(e) => {
                          setRevisionPrompt(e.target.value);
                          e.target.style.height = "auto";
                          e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleRevise(); }
                        }}
                        rows={1}
                        disabled={isRevising || isGenerating}
                        className="flex-1 bg-transparent border-none text-[#e7e5e5] placeholder:text-[#acabab]/50 text-sm py-2 resize-none max-h-32 outline-none disabled:opacity-50"
                      />
                      <button
                        onClick={handleRevise}
                        disabled={isRevising || isGenerating || !revisionPrompt.trim()}
                        className="mb-1 flex items-center justify-center h-8 w-8 bg-[#18181b] border border-[#2b2c2c] text-[#adc6ff] rounded-sm hover:border-[#adc6ff]/50 hover:bg-[#2b2c2c] transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {isRevising ? "hourglass_top" : "edit_note"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Export buttons */}
                <div className="shrink-0 flex items-center gap-2">
                  <button
                    onClick={exportPDF}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-[#adc6ff] text-[#003d87] rounded-full hover:bg-[#97b9ff] transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                    Export PDF
                  </button>
                  <button
                    onClick={exportDOCX}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-[#202022] text-[#e7e5e5] rounded-full border border-[#474848]/20 hover:bg-[#28282a] transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-sm">description</span>
                    Export DOCX
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </main>



      {/* ── File Picker Modal ── */}
      {showFilePicker && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-[#18181b] border border-[#474848]/30 rounded-xl p-6 w-full max-w-lg shadow-2xl max-h-[70vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#e7e5e5]">Link Files</h3>
              <button onClick={() => setShowFilePicker(false)} className="text-[#acabab] hover:text-[#e7e5e5] cursor-pointer">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="flex items-center gap-2 border border-[#474848]/30 rounded-lg px-3 h-9 mb-3">
              <span className="material-symbols-outlined text-sm text-[#acabab]">search</span>
              <input
                autoFocus
                type="text"
                placeholder="Search indexed files..."
                value={fileSearch}
                onChange={(e) => setFileSearch(e.target.value)}
                style={{ background: "transparent" }}
                className="flex-1 text-xs text-[#e7e5e5] placeholder:text-[#acabab]/50 outline-none caret-[#adc6ff] border-none"
              />
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {filteredPickerFiles.length === 0 ? (
                <p className="text-xs text-[#acabab]/50 text-center mt-8">No indexed files found.</p>
              ) : (
                filteredPickerFiles.map((f) => {
                  const linked = projectFiles.some((pf) => Number(pf.id) === Number(f.id));
                  return (
                    <div
                      key={f.id}
                      onClick={() => toggleFileLink(f.id)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                        linked ? "bg-[#adc6ff]/10 border border-[#adc6ff]/30" : "hover:bg-[#202022] border border-transparent"
                      }`}
                    >
                      <span className={`material-symbols-outlined text-base ${linked ? "text-[#adc6ff]" : "text-[#acabab]"}`}>
                        {linked ? "check_circle" : "radio_button_unchecked"}
                      </span>
                      <span className="text-sm text-[#e7e5e5] truncate flex-1">{f.filename}</span>
                      <span className="text-[10px] text-[#acabab]/40 font-mono shrink-0">{(f.content_length || 0).toLocaleString()}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── New Project Modal ── */}
      {showNewProject && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-[#18181b] border border-[#474848]/30 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold text-[#e7e5e5] mb-4">New Project</h3>
            <input
              type="text"
              autoFocus
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
              className="w-full bg-[#202022] border border-[#474848]/30 rounded-lg p-3 text-[#e7e5e5] placeholder:text-[#acabab] focus:outline-none focus:border-[#adc6ff] transition-colors mb-6"
            />
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => { setShowNewProject(false); setNewProjectName(""); }}
                className="px-4 py-2 text-sm font-semibold text-[#acabab] hover:text-[#e7e5e5] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                className="px-4 py-2 bg-[#adc6ff] text-[#003d87] text-sm font-bold rounded-lg hover:bg-[#97b9ff] transition-colors cursor-pointer"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
