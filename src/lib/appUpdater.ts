import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Check GitHub Releases for a newer build; download, install, and relaunch if found. */
export async function checkAndInstallUpdates(): Promise<void> {
  if (!isTauriRuntime()) return;

  try {
    const update = await check();
    if (!update) return;

    console.log(`[updater] Installing ${update.version}…`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.error("[updater]", err);
  }
}
