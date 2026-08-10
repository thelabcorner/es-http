/*
 * fake-cli.mjs — harness fake for the eshttp-cli.exe transport (T11).
 * ============================================================================
 * Mirrors the REAL eshttp-cli.exe job-file IPC contract (native/eshttp-cli.c,
 * ArcFit-style one-shot EXE path), so the QA harness can drive the "cli"
 * transport tier headlessly exactly as the shipping binary does:
 *
 *   - The wrapper writes ESHTTP_<id>.job to the CLI scan dir
 *     (%TEMP% + %TEMP%\opencode; wrapper writes %TEMP%\opencode), content:
 *       line 1: ESHTTP_CLI_1
 *       then   key=value lines: method, url, done (done-file path),
 *              headers (JSON object string), opts (JSON object string).
 *     NO body key in v1 — the CLI hardcodes an empty body, so the cli tier
 *     is GET/HEAD-only (non-empty body -> "unsupported").
 *   - The CLI claims the NEWEST ESHTTP_*.job by mtime (exclusive read), then
 *     DELETES the job file, and writes the http-v1 response envelope JSON to
 *     the done file named in the job.
 *   - The wrapper polls doneFile.exists && length>0 every 200 ms up to
 *     opts.timeout, then maps the envelope via the shared envelopeToResult()
 *     with meta.path overridden to "cli".
 *
 * The fake implements the same file protocol with the same envelope schema,
 * driven by a responder function + recorded calls (like the fake DLL stub),
 * so the 30-socket-wire-style cli wire tests and the tier tests exercise the
 * exact contract the real binary will satisfy.
 *
 * QA infrastructure only — NOT part of the eshttp library.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeFakeCli() {
    const scanDir = path.join(os.tmpdir(), 'opencode');
    const state = {
        jobsClaimed: [],      // { path, method, url, done, headers, opts }
        responder: function (job) {  // default: good envelope
            // NOTE: the REAL eshttp-cli.exe emits meta.path="native" (same
            // v2 engine as the DLL); the wrapper's envelopeToResult() forces
            // meta.path="cli" for the cli lane. The fake mimics the CLI.
            return {
                abi: "http-v1", ok: true, status: 200, statusText: "OK",
                headers: { "content-type": "application/json; charset=utf-8" },
                body: "{\"ok\":true}", bodyEncoding: "utf8", error: null,
                meta: { path: "native", method: job.method, finalUrl: null, redirects: 0,
                        timeMs: 1, bytes: 10, httpVersion: "1.1", tlsVersion: "1.2",
                        encodingWasApplied: false, nativeVersion: null,
                        winhttpError: null, backend: "cli" }
            };
        }
    };

    // Parse a job file buffer into { method, url, done, headers, opts }.
    function parseJob(text) {
        const job = { method: "GET", url: null, done: null, headers: "{}", opts: null };
        let headerSeen = false;
        const lines = String(text).split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, '');
            if (!headerSeen) {
                if (line.indexOf('ESHTTP_CLI_1') === 0) { headerSeen = true; }
                continue; // ignore preamble
            }
            const eq = line.indexOf('=');
            if (eq < 0) { continue; }
            const key = line.slice(0, eq);
            const val = line.slice(eq + 1);
            if (key === 'method') { job.method = val; }
            else if (key === 'url') { job.url = val; }
            else if (key === 'done') { job.done = val; }
            else if (key === 'headers') { job.headers = val; }
            else if (key === 'opts') { job.opts = val; }
        }
        return job;
    }

    // Claim the newest ESHTTP_*.job in the scan dir (mimics claim_job()).
    function claimNewest() {
        let best = null;
        let bestMtime = -1;
        let entries = [];
        try { entries = fs.readdirSync(scanDir); } catch (e) { return null; }
        for (const name of entries) {
            if (!/^ESHTTP_.*\.job$/.test(name)) { continue; }
            const p = path.join(scanDir, name);
            let st;
            try { st = fs.statSync(p); } catch (e) { continue; }
            if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; }
        }
        return best;
    }

    // Process exactly ONE job (like one CLI invocation). Returns the job
    // record or null if no job was claimable.
    function runOnce() {
        const jobPath = claimNewest();
        if (!jobPath) { return null; }
        let text;
        try { text = fs.readFileSync(jobPath, 'utf8'); } catch (e) { return null; }
        const job = parseJob(text);
        job.path = jobPath;
        state.jobsClaimed.push(job);
        // Claimed: delete the job file (the CLI consumes it).
        try { fs.unlinkSync(jobPath); } catch (e) {}
        // Build the envelope via the responder; write it to the done file.
        const res = state.responder(job);
        const envelope = res || {
            abi: "http-v1", ok: true, status: 200, statusText: "OK",
            headers: {}, body: "", bodyEncoding: "utf8", error: null,
            meta: { path: "native", method: job.method, finalUrl: job.url, redirects: 0,
                    timeMs: 1, bytes: 0, httpVersion: "1.1", tlsVersion: "1.2",
                    encodingWasApplied: false, nativeVersion: null,
                    winhttpError: null, backend: "cli" }
        };
        if (job.done) {
            try {
                fs.writeFileSync(job.done, JSON.stringify(envelope), 'utf8');
            } catch (e) { /* wrapper will see a missing/empty done file */ }
        }
        return job;
    }

    // Drain all pending jobs (mimics the wrapper waiting on the CLI).
    function drain() {
        const processed = [];
        let j;
        while ((j = runOnce()) !== null) { processed.push(j); }
        return processed;
    }

    return { state: state, runOnce: runOnce, drain: drain, scanDir: scanDir };
}
