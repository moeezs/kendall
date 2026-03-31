import { useState } from "react";
import { mkdir } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { SystemLog } from "../App";

interface HomeProps {
  activeFolders: string[];
  setActiveFolders?: React.Dispatch<React.SetStateAction<string[]>>;
  logs: SystemLog[];
  setLogs: React.Dispatch<React.SetStateAction<SystemLog[]>>;
}

export function HomeSection({ activeFolders, setActiveFolders, logs, setLogs }: HomeProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const handleOpenDump = async () => {
    try {
      const desktop = await desktopDir();
      const dumpPath = await join(desktop, "kendall", "Dump");
      await revealItemInDir(dumpPath);
    } catch (err) {
      console.error(err);
    }
  };

  const handleOpenFolder = async (folderName: string) => {
    try {
      const desktop = await desktopDir();
      const path = await join(desktop, "kendall", folderName);
      await revealItemInDir(path);
    } catch (err) {
      console.error(err);
    }
  };

  const createFolder = async () => {
    const folderName = newFolderName.trim();
    if (!folderName) {
      setIsModalOpen(false);
      return;
    }

    try {
      const desktop = await desktopDir();
      const newFolderPath = await join(desktop, "kendall", folderName);
      await mkdir(newFolderPath);
      
      if (setActiveFolders) {
        setActiveFolders(prev => [...prev, folderName]);
      }

      setLogs(prev => [{
        action: `Created new folder: ${folderName}`,
        path: `/${folderName}`,
        time: "Just now",
        icon: "create_new_folder",
        color: "text-[#adc6ff]"
      }, ...prev]);
    } catch (err) {
      console.error(err);
      alert("Failed to create folder. It might already exist.");
    } finally {
      setIsModalOpen(false);
      setNewFolderName("");
    }
  };

  return (
    <main className="w-full flex-1 overflow-y-auto pb-12">
      {/* Bento Grid of Directories */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 pt-4">
        {/* Specialized Folder: Dump */}
        <div className="group relative col-span-1 md:col-span-2 row-span-2 bg-[#202022] rounded-xl p-8 hover:bg-[#28282a] transition-colors border border-transparent hover:border-[#474848]/10 overflow-hidden">
          <div className="flex justify-between items-start mb-16">
            <div className="p-4 bg-[#adc6ff]/10 rounded-xl z-10">
              <span className="material-symbols-outlined text-[#adc6ff] text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>auto_mode</span>
            </div>
            <span className="bg-[#adc6ff]/10 text-[#adc6ff] text-[10px] font-bold px-2 py-1 rounded tracking-widest uppercase z-10">
              Auto-Sorting Active
            </span>
          </div>
          <div className="z-10 relative">
            <h3 className="text-2xl font-bold tracking-tight text-[#e7e5e5] mb-2">Dump (Auto-Sort)</h3>
            <div className="flex items-center gap-4 mt-6">
              <button 
                onClick={handleOpenDump}
                className="bg-[#adc6ff] text-[#003d87] text-xs font-bold px-4 py-2 rounded-full hover:bg-[#97b9ff] transition-colors cursor-pointer"
              >
                Open Location
              </button>
              <span className="text-[#acabab] text-[11px] font-mono">kendall/Dump</span>
            </div>
          </div>
          <div className="absolute -right-8 -bottom-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <span className="material-symbols-outlined text-[12rem]">folder_zip</span>
          </div>
        </div>

        {/* Dynamic Folders */}
        {activeFolders.map((folderName) => (
          <div 
            key={folderName} 
            onClick={() => handleOpenFolder(folderName)}
            className="bg-[#202022] cursor-pointer rounded-xl p-6 flex flex-col justify-between hover:bg-[#28282a] transition-all border border-transparent hover:border-[#474848]/10 group"
          >
            <div className="flex justify-between items-start">
              <span className="material-symbols-outlined text-[#acabab] group-hover:text-[#adc6ff] transition-colors text-2xl">folder</span>
            </div>
            <div className="mt-8">
              <h4 className="font-bold text-[#e7e5e5] wrap-break-word">{folderName}</h4>
            </div>
          </div>
        ))}

        {/* Add New Folder Placeholder */}
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-transparent border border-dashed border-[#474848]/30 rounded-xl p-6 flex flex-col items-center justify-center gap-3 hover:border-[#adc6ff]/40 hover:bg-[#202022] transition-all group cursor-pointer"
        >
          <span className="material-symbols-outlined text-[#acabab] group-hover:text-[#adc6ff] transition-colors">add_circle</span>
          <span className="text-xs font-semibold text-[#acabab] group-hover:text-[#e7e5e5]">New Folder</span>
        </button>
      </div>

      {/* Recent Activity / System Log */}
      <section className="mt-16">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold tracking-tight text-[#e7e5e5]">System Watch Log</h2>
          <span className="text-[10px] font-bold text-[#adc6ff] tracking-widest uppercase bg-[#adc6ff]/10 px-2 py-0.5 rounded">
            Live Agent Active
          </span>
        </div>
        <div className="bg-[#202022] rounded-xl overflow-hidden border border-[#474848]/20 h-[25vh] overflow-y-auto">
          <table className="w-full text-left text-sm relative">
            <thead className="sticky top-0 bg-[#28282a] z-10">
              <tr className="border-b border-[#474848]/20">
                <th className="px-6 py-3 font-semibold text-[#acabab]">Action</th>
                <th className="px-6 py-3 font-semibold text-[#acabab]">Source Directory</th>
                <th className="px-6 py-3 font-semibold text-[#acabab] text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#474848]/10">
              {logs.map((log, i) => (
                <tr key={i} className="hover:bg-white/5 transition-colors">
                  <td className="px-6 py-4 flex items-center gap-3">
                    <span className={`material-symbols-outlined ${log.color} text-lg`}>{log.icon}</span>
                    <span className="font-medium">{log.action}</span>
                  </td>
                  <td className="px-6 py-4 text-[#acabab] font-mono text-xs">{log.path}</td>
                  <td className="px-6 py-4 text-[#acabab]/60 text-right text-xs">{log.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Custom Folder Creation Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-[#18181b] border border-[#474848]/30 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold text-[#e7e5e5] mb-4">Create New Folder</h3>
            <input
              type="text"
              autoFocus
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFolder()}
              className="w-full bg-[#202022] border border-[#474848]/30 rounded-lg p-3 text-[#e7e5e5] placeholder:text-[#acabab] focus:outline-none focus:border-[#adc6ff] transition-colors mb-6"
            />
            <div className="flex items-center justify-end gap-3">
              <button 
                onClick={() => {
                  setIsModalOpen(false);
                  setNewFolderName("");
                }}
                className="px-4 py-2 text-sm font-semibold text-[#acabab] hover:text-[#e7e5e5] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={createFolder}
                className="px-4 py-2 bg-[#adc6ff] text-[#003d87] text-sm font-bold rounded-lg hover:bg-[#97b9ff] transition-colors cursor-pointer"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}