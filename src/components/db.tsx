import { useEffect, useState } from "react";
import { getAllFilesMetadata, deleteFileRecord, getChats, deleteChat } from "../services/database";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export function DbSection({ onOpenChat }: { onOpenChat?: (id: string) => void }) {
  const [activeTab, setActiveTab] = useState<"files" | "chats">("files");
  const [dbFiles, setDbFiles] = useState<any[]>([]);
  const [chatList, setChatList] = useState<any[]>([]);

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

  return (
    <div className="flex-1 p-5 overflow-y-auto bg-[#18181b] text-[#e7e5e5]">
      <div className="flex justify-between items-center mb-6">
        <div className="flex gap-4">
          <button 
            onClick={() => setActiveTab("files")} 
            className={`text-xl font-bold ${activeTab === "files" ? "text-white" : "text-gray-500"}`}
          >
            File Embeddings
          </button>
          <button 
            onClick={() => setActiveTab("chats")} 
            className={`text-xl font-bold ${activeTab === "chats" ? "text-white" : "text-gray-500"}`}
          >
            Chat History
          </button>
        </div>
        <button 
          onClick={activeTab === "files" ? refreshDbFiles : refreshChats}
          className="px-3 py-1 bg-[#202022] hover:bg-[#2b2c2c] rounded text-sm cursor-pointer border border-[#474848]/30"
        >
          Refresh
        </button>
      </div>
      
      {activeTab === "files" && (
        dbFiles.length === 0 ? (
          <p className="text-[#acabab] text-center mt-10">No files indexed yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {dbFiles.map((f, idx) => (
              <div key={idx} className="flex flex-col gap-2 p-4 border border-[#474848]/30 rounded-lg bg-[#202022] shadow-sm">
                <div className="flex justify-between items-start">
                  <div className="font-semibold text-[#adc6ff]">{f.filename}</div>
                  <div className="flex gap-2 text-xs">
                    <button 
                      onClick={() => revealItemInDir(f.path)}
                      className="px-2 py-1 bg-[#191a1a] hover:bg-[#2b2c2c] text-[#e7e5e5] border border-[#474848]/30 rounded cursor-pointer transition-colors"
                    >
                      Reveal
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
                      className="px-2 py-1 bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/30 rounded cursor-pointer transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="text-sm text-[#acabab] truncate" title={f.path}>
                  {f.path}
                </div>
                <div className="text-xs text-[#acabab]/60">
                  Tokens: {(f.content_length || 0).toLocaleString()} chars
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {activeTab === "chats" && (
        chatList.length === 0 ? (
          <p className="text-[#acabab] text-center mt-10">No chat history yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {chatList.map((c, idx) => (
              <div 
                key={c.id} 
                className="flex items-center justify-between p-4 border border-[#474848]/30 rounded-lg bg-[#202022] hover:bg-[#2b2c2c] transition-colors shadow-sm cursor-pointer"
                onClick={() => onOpenChat && onOpenChat(c.id)}
              >
                <div className="flex-1">
                  <div className="font-semibold text-[#e7e5e5]">{c.title}</div>
                  <div className="text-xs text-[#acabab] mt-1">{new Date(c.created_at).toLocaleString()}</div>
                </div>
                <button 
                  onClick={async (e) => {
                    e.stopPropagation();
                    await deleteChat(c.id);
                    await refreshChats();
                  }}
                  className="px-2 py-1 bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/30 rounded text-xs cursor-pointer transition-colors ml-4"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
