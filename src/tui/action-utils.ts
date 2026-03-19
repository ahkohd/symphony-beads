import { exec } from "../exec.ts";

const ACTION_TIMEOUT_MS = 5000;

function openUrlCommand(url: string): string[] {
  if (process.platform === "darwin") {
    return ["open", url];
  }

  if (process.platform === "win32") {
    return ["cmd", "/c", "start", "", url];
  }

  return ["xdg-open", url];
}

function clipboardCommands(): string[][] {
  if (process.platform === "darwin") {
    return [["pbcopy"]];
  }

  if (process.platform === "win32") {
    return [["cmd", "/c", "clip"]];
  }

  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

export async function openExternalUrl(url: string): Promise<boolean> {
  const result = await exec(openUrlCommand(url), {
    cwd: process.cwd(),
    timeout: ACTION_TIMEOUT_MS,
  });

  return result.code === 0;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  for (const command of clipboardCommands()) {
    const result = await exec(command, {
      cwd: process.cwd(),
      timeout: ACTION_TIMEOUT_MS,
      stdin: text,
    });

    if (result.code === 0) {
      return true;
    }
  }

  return false;
}
