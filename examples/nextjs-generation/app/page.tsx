"use client";

import { useEffect, useRef, useState } from "react";

export default function Page() {
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState("image");
  const [prompt, setPrompt] = useState("A small sailboat on a quiet lake at sunrise");
  const [taskId, setTaskId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [media, setMedia] = useState<{ url: string; kind: string }>();
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => () => { if (media?.url.startsWith("blob:")) URL.revokeObjectURL(media.url); }, [media]);

  async function run(resume = false) {
    const ctrl = new AbortController();
    active.current = ctrl;
    setBusy(true); setError(""); setMedia(undefined);
    const headers = { Authorization: `Bearer ${password}`, "Content-Type": "application/json" };
    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(10 * 60_000)]);
    async function request(path: string, init?: RequestInit) {
      const response = await fetch(`/api/generate${path}`, { ...init, headers, signal });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(typeof result?.error === "string" ? result.error : `HTTP ${response.status}`);
      }
      return response;
    }
    try {
      let id = taskId;
      if (!resume) {
        setTaskId(""); setStatus("Submitting…");
        const result = await (await request("", { method: "POST", body: JSON.stringify({ kind, prompt }) })).json();
        if (kind === "image") {
          const image = result.data?.[0];
          const url = image?.url ?? (image?.b64_json ? `data:image/png;base64,${image.b64_json}` : undefined);
          if (!url || !/^(https?:\/\/|data:image\/)/.test(url)) throw new Error("The API returned no usable image.");
          setMedia({ url, kind: "image" }); setStatus("Completed"); return;
        }
        id = result.id;
        if (typeof id !== "string" || !id) throw new Error("The API returned no task ID.");
        setTaskId(id);
      }
      for (;;) {
        const result = await (await request(`?id=${encodeURIComponent(id)}`)).json();
        setStatus(`Video: ${result.status}`);
        if (result.status === "failed") throw new Error("Video generation failed. Check the request in your TokPort dashboard.");
        if (result.status === "completed") break;
        if (!["queued", "in_progress"].includes(result.status)) throw new Error("Unexpected video status; resume later with the task ID.");
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 5000);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      setStatus("Downloading video…");
      const response = await request(`?id=${encodeURIComponent(id)}&download=1`);
      setMedia({ url: URL.createObjectURL(await response.blob()), kind: "video" });
      setStatus("Completed");
    } catch (e) {
      setStatus("");
      setError(signal.aborted ? "Stopped waiting. The server job may continue; resume with the task ID below. Do not submit again unless you want another billed generation." : e instanceof Error ? e.message : "Request failed.");
    } finally { active.current = null; setBusy(false); }
  }

  return <main>
    <h1>Image & video generation</h1>
    <p>A Next.js starter using TokPort. Generations use your account balance.</p>
    <form onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <label>Starter password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} /></label>
      <label>Output<select value={kind} onChange={e => setKind(e.target.value)} disabled={busy}><option value="image">Image</option><option value="video">Video · 5 seconds</option></select></label>
      <label>Prompt<textarea rows={4} maxLength={4000} required value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} /></label>
      <button disabled={busy}>Generate</button>
      {busy && <button type="button" onClick={() => active.current?.abort()}>Stop waiting</button>}
      <label>Video task ID<input value={taskId} onChange={e => setTaskId(e.target.value)} disabled={busy} placeholder="Paste an existing task ID to resume" /></label>
      <button type="button" disabled={busy || !taskId || !password} onClick={() => void run(true)}>Resume video</button>
    </form>
    <p role="status">{status}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {/* Provider image URLs are dynamic; this minimal starter does not proxy or optimize them. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {media?.kind === "image" && <><img src={media.url} alt={prompt} /><p><a href={media.url} target="_blank" rel="noreferrer">Open image</a></p></>}
    {media?.kind === "video" && <><video src={media.url} controls /><p><a href={media.url} download="tokport-video.mp4">Download video</a></p></>}
  </main>;
}
