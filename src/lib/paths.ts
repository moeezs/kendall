import { desktopDir, join } from "@tauri-apps/api/path";
import { getSetting } from "../services/settings";

// Resolves the kendall home directory.
// Falls back to ~/Desktop/kendall if not configured.
export async function getKendallHome(): Promise<string> {
  const configured = await getSetting("kendall_home");
  if (configured) return configured;
  const desktop = await desktopDir();
  return await join(desktop, "kendall");
}

// Helper: resolve a path relative to kendall home
export async function kendallPath(...segments: string[]): Promise<string> {
  const home = await getKendallHome();
  return join(home, ...segments);
}

// Helper: get the dump folder path
export async function getDumpPath(): Promise<string> {
  return kendallPath("Dump");
}

// Helper: get projects directory path
export async function getProjectsDir(): Promise<string> {
  return kendallPath("Projects");
}

// Helper: ensure kendall home + Dump folder exist
export async function ensureKendallDirs(): Promise<void> {
  const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
  const home = await getKendallHome();
  const dump = await getDumpPath();
  if (!(await exists(home))) await mkdir(home);
  if (!(await exists(dump))) await mkdir(dump);
}