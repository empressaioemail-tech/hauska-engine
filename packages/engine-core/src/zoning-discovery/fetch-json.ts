/**
 * Resilient JSON GET for discovery.
 * Mirrors Factory 1 sweep posture: Node leaf-cert failures fall back to curl.exe
 * (system CA store) before recording a transport error.
 */

import { spawn } from "node:child_process";

export type FetchJsonResult = {
  status: number;
  body: unknown;
  transportError?: string;
};

function curlJson(url: string): Promise<FetchJsonResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "curl.exe",
      ["-sS", "-L", "--max-time", "60", "-w", "\n__HTTP_STATUS__:%{http_code}", url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      const marker = "\n__HTTP_STATUS__:";
      const idx = stdout.lastIndexOf(marker);
      if (idx < 0) {
        resolve({
          status: 0,
          body: {},
          transportError: `curl exit ${code}: ${stderr || "no status marker"}`,
        });
        return;
      }
      const bodyText = stdout.slice(0, idx);
      const status = Number(stdout.slice(idx + marker.length).trim()) || 0;
      try {
        resolve({ status, body: bodyText ? JSON.parse(bodyText) : {} });
      } catch (err) {
        resolve({
          status,
          body: {},
          transportError: `curl JSON parse: ${String(err instanceof Error ? err.message : err)}`,
        });
      }
    });
  });
}

export async function fetchJsonResilient(url: string): Promise<FetchJsonResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const body = await res.json();
    return { status: res.status, body };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    const cause = err instanceof Error && "cause" in err ? String((err as Error & { cause?: unknown }).cause) : "";
    const tls =
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify the first certificate|certificate/i.test(
        `${msg}\n${cause}`,
      );
    if (tls || process.platform === "win32") {
      return curlJson(url);
    }
    return { status: 0, body: {}, transportError: msg };
  }
}
