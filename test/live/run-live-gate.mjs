#!/usr/bin/env node
/*
 * run-live-gate.mjs — deterministic real-Illustrator gate for ESHTTP.
 * ============================================================================
 * 1. starts the project's local mock server (test/mock-server.js, port 0);
 * 2. renders test/live/live-estc-gate.jsx with the artifact / base-URL /
 *    result-path tokens substituted and submits it through the bundled
 *    Illustrator COM tool (attach-first; --launch starts the host if needed);
 * 3. asserts the JSON side-channel: facade surface, pure in-engine
 *    _selftest(), __noNetwork hook, and ONE localhost request through the
 *    normally-resolved transport (status 200 + parsed body ok:true).
 *
 * No external network is used. Exit 0 = gate PASS.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const ARTIFACT = path.join(DIST, 'eshttp.jsx');
const COM_TOOL = path.join(ROOT, '..', 'agent-skills', 'illustrator-com-automation-skill', 'comtool', 'ILLUSTRATOR_COM_TOOL.py');
const require = createRequire(import.meta.url);
const mock = require(path.join(HERE, '..', 'mock-server.js'));

function fail(msg) {
    console.error('[live-gate] FAIL: ' + msg);
    process.exit(1);
}

// Async spawn (NOT spawnSync): the in-process mock server must keep servicing
// localhost while the COM tool drives Illustrator + eshttp-cli.exe.
function runComTool(args, options) {
    return new Promise((resolve) => {
        const child = spawn('python', args, options);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => resolve({ error: err, status: -1, stdout: stdout, stderr: stderr }));
        child.on('close', (code) => resolve({ status: code, stdout: stdout, stderr: stderr }));
    });
}

if (!fs.existsSync(ARTIFACT)) fail('canonical artifact missing: ' + ARTIFACT + ' (run npm run build)');
if (!fs.existsSync(COM_TOOL)) fail('COM tool missing: ' + COM_TOOL);

// Self-contained precondition: the cli tier resolves eshttp-cli.exe from the
// per-user runtime root. The deterministic QA harness stages a fake shim
// there and may leave the target absent or non-canonical after a run, so
// before every live run enforce BYTE IDENTITY with the canonical built
// worker (native/eshttp-cli.exe, PE-verified). Harness precondition only -
// never touches product transport code.
function ensureStagedCliWorker() {
    const src = path.join(ROOT, 'native', 'eshttp-cli.exe');
    const localAppData = process.env.LOCALAPPDATA || '';
    if (!localAppData) return;
    const destDir = path.join(localAppData, 'eshttp');
    const dest = path.join(destDir, 'eshttp-cli.exe');
    if (!fs.existsSync(src)) {
        console.log('[live-gate] note: native/eshttp-cli.exe missing; cli tier may degrade');
        return;
    }
    const canonical = fs.readFileSync(src);
    if (canonical.length < 2 || canonical[0] !== 0x4D || canonical[1] !== 0x5A) {
        fail('native/eshttp-cli.exe is not a PE executable; refusing to stage');
    }
    if (fs.existsSync(dest)) {
        try {
            const current = fs.readFileSync(dest);
            if (current.length === canonical.length && current.equals(canonical)) {
                return; // already byte-identical
            }
        } catch (e) { /* unreadable -> overwrite below */ }
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, canonical);
    console.log('[live-gate] staged canonical eshttp-cli.exe (' + canonical.length + ' bytes) -> ' + dest);
}
ensureStagedCliWorker();

const server = await mock.start({ name: 'live-gate', port: 0 });
const resultPath = path.join(DIST, '.live-estc-gate.result.json');
const probePath = path.join(DIST, '.live-estc-gate.probe.jsx');
let exitCode = 0;

try {
    const probeSrc = fs.readFileSync(path.join(HERE, 'live-estc-gate.jsx'), 'utf8')
        .split('__RESULT__').join(resultPath.replace(/\\/g, '/'))
        .split('__ARTIFACT__').join(ARTIFACT.replace(/\\/g, '/'))
        .split('__BASE_URL__').join(server.url);
    fs.writeFileSync(probePath, probeSrc, 'utf8');
    try { fs.unlinkSync(resultPath); } catch (e) {}

    console.log('[live-gate] mock server: ' + server.url);
    const r = await runComTool([COM_TOOL, 'eval', '--file', probePath, '--launch', '--timeout', '180'], {
        cwd: path.join(ROOT, '..'),
        windowsHide: true
    });
    if (r.error) fail('COM tool spawn failed: ' + r.error.message);

    let envelope = null;
    const raw = String(r.stdout || '').trim();
    const start = raw.indexOf('{');
    if (start >= 0) {
        try { envelope = JSON.parse(raw.slice(start)); } catch (e) {}
    }
    if (!envelope) {
        fail('COM tool produced no JSON envelope (exit ' + r.status + ')\nstdout: ' + raw.slice(0, 1200) +
            '\nstderr: ' + String(r.stderr || '').slice(0, 1200));
    }
    if (envelope.ok !== true) {
        fail('COM eval failed: ' + JSON.stringify(envelope).slice(0, 1200));
    }

    if (!fs.existsSync(resultPath)) fail('probe result side-channel missing at ' + resultPath);
    const out = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    const checks = [];
    const add = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });

    add('no probe errors', out.errors.length === 0, JSON.stringify(out.errors));
    add('facade global object', out.facade.isObject && out.facade.typeofGlobal === 'object', out.facade.typeofGlobal);
    add('request/get/post/put/del are functions',
        out.facade.request === 'function' && out.facade.get === 'function' && out.facade.post === 'function' &&
        out.facade.put === 'function' && out.facade.del === 'function',
        JSON.stringify([out.facade.request, out.facade.get, out.facade.post, out.facade.put, out.facade.del]));
    add('json.parse/stringify are functions',
        out.facade.jsonParse === 'function' && out.facade.jsonStringify === 'function', out.facade.jsonParse + '/' + out.facade.jsonStringify);
    add('transport readable', out.facade.transportType === 'string', out.facade.transportValue);
    add('DEFAULTS.timeout = 30000', out.facade.defaultsTimeout === 30000, out.facade.defaultsTimeout);
    add('in-engine _selftest passes', out.selftest && out.selftest.pass === true,
        out.selftest ? (out.selftest.count + ' checks') : 'not run');
    add('json round-trip + base64 helper', out.facade.jsonRoundtrip === true && out.facade.b64 === true,
        out.facade.jsonRoundtrip + '/' + out.facade.b64);
    add('__noNetwork returns unsupported', out.facade.noNetwork === true, out.facade.noNetwork);
    add('localhost request 200 + parsed body ok:true',
        out.local && out.local.ok === true && out.local.status === 200 && out.local.bodyParsedOk === true,
        JSON.stringify(out.local));

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) {
        console.log('[live-gate] ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '  (' + c.detail + ')' : ''));
    }
    console.log('[live-gate] transport: ' + JSON.stringify(out.transport) + ' local path: ' + (out.local ? out.local.path : '-'));
    if (failed.length) {
        console.error('[live-gate] ' + failed.length + ' check(s) failed');
        exitCode = 1;
    } else {
        console.log('[live-gate] PASS (' + checks.length + ' checks, artifact ' + path.basename(ARTIFACT) + ')');
    }
} catch (e) {
    console.error('[live-gate] FAIL: ' + (e && e.stack ? e.stack : e));
    exitCode = 1;
} finally {
    try { fs.unlinkSync(probePath); } catch (e) {}
    try { fs.unlinkSync(resultPath); } catch (e) {}
    try { await server.stop(); } catch (e) {}
}
process.exit(exitCode);
