import { useEffect, useState, useMemo } from "react";
import { getAllFilesMetadata, deleteFileRecord, getChats, deleteChat } from "../services/database";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export function DbSection({ onOpenChat }: { onOpenChat?: (id: string) => void }) {
  const [activeTab, setActiveTab] = useState<"files" | "chats">("files");
  const [dbFiles, setDbFiles] = useState<any[]>([]);
  const [chatList, setChatList] = useState<any[]>([]);
  const [fileSearch, setFileSearch] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [dirFilter, setDirFilter] = useState("all");

  useEffect(() => {
    if (activeTab === "files") refreshDbFiles();
    else refreshChats();
  }, [activeTab]);

  const refreshDbFiles = async () => {
    try {
      const files = await getAllFilesMetadata();
      setDbFiles(files);
    } catch (err) {
      console.error("Failed to load DB files:", err);
    }
  };

  const refreshChats = async () => {
    try {
      const chats = await getChats();
      setChatList(chats);
    } catch (err) {
      console.error("Failed to load DB chats:", err);
    }
  };

  // Extract unique directory names from file paths
  const directories = useMemo(() => {
    const dirs = new Set<string>();
    dbFiles.forEach((f) => {
      const parts = f.path.replace(/\\/g, "/").split("/");
      // Get the parent folder name (second to last segment)
      if (parts.length >= 2) dirs.add(parts[parts.length - 2]);
    });
    return Array.from(dirs).sort();
  }, [dbFiles]);

  // Filtered file list
  const filteredFiles = useMemo(() => {
    let list = dbFiles;
    if (fileSearch.trim()) {
      const q = fileSearch.toLowerCase();
      list = list.filter(
        (f) => f.filename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
      );
    }
    if (dirFilter !== "all") {
      list = list.filter((f) => f.path.replace(/\\/g, "/").includes(`/${dirFilter}/`));
    }
    return list;
  }, [dbFiles, fileSearch, dirFilter]);

  // Filtered chat list
  const filteredChats = useMemo(() => {
    if (!chatSearch.trim()) return chatList;
    const q = chatSearch.toLowerCase();
    return chatList.filter((c) => c.title.toLowerCase().includes(q));
  }, [chatList, chatSearch]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#18181b] text-[#e7e5e5] pb-12">
      {/* Header */}
      <div className="flex items-center justify-between pt-4 mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveTab("files")}
            className={`px-4 py-2 text-sm font-bold rounded-full transition-colors cursor-pointer ${
              activeTab === "files"
                ? "bg-[#adc6ff]/10 text-[#adc6ff]"
                : "text-[#acabab] hover:text-[#e7e5e5]"
            }`}
          >
            Embeddings
          </button>
          <button
            onClick={() => setActiveTab("chats")}
            className={`px-4 py-2 text-sm font-bold rounded-full transition-colors cursor-pointer ${
              activeTab === "chats"
                ? "bg-[#adc6ff]/10 text-[#adc6ff]"
                : "text-[#acabab] hover:text-[#e7e5e5]"
            }`}
          >
            Chats
          </button>
        </div>
        <button
          onClick={activeTab === "files" ? refreshDbFiles : refreshChats}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#acabab] hover:text-[#e7e5e5] bg-[#202022] hover:bg-[#28282a] rounded-full border border-[#474848]/20 transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
          Refresh
        </button>
      </div>

      {/* Files Tab */}
      {activeTab === "files" && (
        dbFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 opacity-60">
            <span className="material-symbols-outlined text-5xl text-[#acabab] mb-4">database</span>
            <p className="text-[#acabab] text-sm">No files indexed yet.</p>
            <p className="text-[#acabab]/50 text-xs mt-1">Drop files into Dump to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Search + Filter bar */}
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 flex items-center gap-2 border border-[#474848]/30 rounded-lg px-3 h-9">
                <span className="material-symbols-outlined text-sm text-[#acabab]">search</span>
                <input
                  type="text"
                  placeholder="Search files..."
                  value={fileSearch}
                  onChange={(e) => setFileSearch(e.target.value)}
                  style={{ background: 'transparent' }}
                  className="flex-1 text-xs text-[#e7e5e5] placeholder:text-[#acabab]/50 outline-none caret-[#adc6ff] border-none"
                />
              </div>
              <select
                value={dirFilter}
                onChange={(e) => setDirFilter(e.target.value)}
                className="bg-[#202022] text-xs text-[#acabab] border border-[#474848]/20 rounded-lg px-3 h-9 outline-none cursor-pointer hover:text-[#e7e5e5] transition-colors appearance-none"
              >
                <option value="all">All folders</option>
                {directories.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <span className="text-[10px] text-[#acabab]/50 font-mono whitespace-nowrap">
                {filteredFiles.length}/{dbFiles.length}
              </span>
            </div>

            {/* File rows — compact single-line */}
            {filteredFiles.map((f) => (
              <div
                key={f.id}
                className="group flex items-center gap-3 bg-[#202022] rounded-lg px-4 py-2.5 border border-transparent hover:border-[#474848]/20 hover:bg-[#28282a] transition-all"
              >
                <span className="material-symbols-outlined text-[#acabab] group-hover:text-[#adc6ff] transition-colors text-base shrink-0">
                  {f.filename.endsWith(".pdf") ? "description" : f.filename.match(/\.(png|jpg|jpeg)$/i) ? "image" : "article"}
                </span>
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  <span className="text-sm font-medium text-[#e7e5e5] truncate">{f.filename}</span>
                  <span className="text-[10px] text-[#acabab]/30 shrink-0 bg-[#28282a] px-1.5 py-0.5 rounded">
                    {f.path.replace(/\\/g, "/").split("/").slice(-2, -1)[0]}
                  </span>
                  <span className="text-[10px] text-[#acabab]/40 font-mono shrink-0">
                    {(f.content_length || 0).toLocaleString()} chars
                  </span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={() => revealItemInDir(f.path)}
                    className="flex items-center justify-center w-7 h-7 text-[#acabab] hover:text-[#adc6ff] rounded-md hover:bg-[#18181b] transition-colors cursor-pointer"
                    title="Reveal in Finder"
                  >
                    <span className="material-symbols-outlined text-[16px] leading-none">open_in_new</span>
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await deleteFileRecord(f.id);
                        await refreshDbFiles();
                      } catch (err) {
                        console.error("Could not delete:", err);
                      }
                    }}
                    className="flex items-center justify-center w-7 h-7 text-red-400/60 hover:text-red-400 rounded-md hover:bg-[#18181b] transition-colors cursor-pointer"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[16px] leading-none">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Chats Tab */}
      {activeTab === "chats" && (
        chatList.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 opacity-60">
            <span className="material-symbols-outlined text-5xl text-[#acabab] mb-4">forum</span>
            <p className="text-[#acabab] text-sm">No chat history yet.</p>
            <p className="text-[#acabab]/50 text-xs mt-1">Start a conversation in the Chat tab.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Search bar */}
            <div className="flex items-center gap-2 border border-[#474848]/30 rounded-lg px-3 h-9 mb-3">
              <span className="material-symbols-outlined text-sm text-[#acabab]">search</span>
              <input
                type="text"
                placeholder="Search chats..."
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                style={{ background: 'transparent' }}
                className="flex-1 text-xs text-[#e7e5e5] placeholder:text-[#acabab]/50 outline-none caret-[#adc6ff] border-none"
              />
              <span className="text-[10px] text-[#acabab]/50 font-mono">
                {filteredChats.length}
              </span>
            </div>

            {filteredChats.map((c) => (
              <div
                key={c.id}
                onClick={() => onOpenChat && onOpenChat(c.id)}
                className="group flex items-center gap-3 bg-[#202022] rounded-lg px-4 py-2.5 border border-transparent hover:border-[#474848]/20 hover:bg-[#28282a] transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[#acabab] group-hover:text-[#adc6ff] transition-colors text-base shrink-0">
                  {c.id === "telegram-bot" ? "smart_toy" : "chat_bubble"}
                </span>
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  <span className="text-sm font-medium text-[#e7e5e5] truncate">{c.title}</span>
                  <span className="text-[10px] text-[#acabab]/40 shrink-0">
                    {new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await deleteChat(c.id);
                    await refreshChats();
                  }}
                  className="flex items-center justify-center w-7 h-7 text-red-400/60 hover:text-red-400 rounded-md hover:bg-[#18181b] opacity-0 group-hover:opacity-100 transition-all cursor-pointer shrink-0"
                  title="Delete"
                >
                  <span className="material-symbols-outlined text-[16px] leading-none">delete</span>
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
