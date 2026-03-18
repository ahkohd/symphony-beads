// ---------------------------------------------------------------------------
// Spawn a subprocess and collect stdout/stderr. Returns typed result.
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command and wait for it to exit. Resolves with the exit code,
 * stdout and stderr as strings. Never rejects — check `code` instead.
 */
export async function exec(
  cmd: string[],
  opts: { cwd?: string; timeout?: number; stdin?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin !== undefined ? "pipe" : undefined,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    });

    if (opts.stdin !== undefined && proc.stdin) {
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(opts.stdin));
      await writer.close();
    }

    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, opts.timeout);
    }

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timer) clearTimeout(timer);

    if (killed) {
      return { code: 124, stdout, stderr: `${stderr}\n(killed: timeout)` };
    }

    return { code, stdout, stderr };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 127, stdout: "", stderr: msg };
  }
}
