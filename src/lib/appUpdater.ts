import { getVersion } from "@tauri-apps/api/app";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type UpdateAvailability = {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
};

let pendingUpdate: Update | null = null;

/** Check GitHub Releases (`latest.json`) for a newer build than the installed app. */
export async function fetchUpdateAvailability(): Promise<UpdateAvailability> {
  if (!isTauriRuntime()) {
    return { available: false, currentVersion: "0.0.0", latestVersion: null };
  }

  const currentVersion = await getVersion();

  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      return {
        available: true,
        currentVersion: update.currentVersion || currentVersion,
        latestVersion: update.version,
      };
    }
    pendingUpdate = null;
    return { available: false, currentVersion, latestVersion: null };
  } catch (err) {
    console.error("[updater] check failed:", err);
    pendingUpdate = null;
    return { available: false, currentVersion, latestVersion: null };
  }
}

/** Download, install, and relaunch using the update from the last successful check. */
export async function installPendingUpdate(
  onProgress?: (percent: number | null) => void,
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Updates are only available in the desktop app.");
  }
  if (!pendingUpdate) {
    throw new Error("No update is available to install.");
  }

  const update = pendingUpdate;
  let downloaded = 0;
  let contentLength: number | undefined;

  const onEvent = (event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        downloaded = 0;
        contentLength = event.data.contentLength;
        onProgress?.(contentLength ? 0 : null);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        if (contentLength && contentLength > 0) {
          onProgress?.(Math.min(100, Math.round((downloaded / contentLength) * 100)));
        }
        break;
      case "Finished":
        onProgress?.(100);
        break;
    }
  };

  await update.downloadAndInstall(onEvent);
  await relaunch();
}
