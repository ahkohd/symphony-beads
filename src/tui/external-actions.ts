import { exec } from "../exec.ts";

export async function openExternalUrl(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const result = await exec(command, {
    cwd: process.cwd(),
    timeout: 5000,
  });

  return result.code === 0;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const commands =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["cmd", "/c", "clip"]]
        : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

  for (const command of commands) {
    const result = await exec(command, {
      cwd: process.cwd(),
      timeout: 5000,
      stdin: text,
    });

    if (result.code === 0) {
      return true;
    }
  }

  return false;
}
