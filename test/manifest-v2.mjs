import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../espack/espack-build.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

for (const arch of ['x64', 'x86']) {
  const manifest = JSON.parse(readFileSync(join(DIST, `eshttp.accel-${arch}.manifest.json`), 'utf8'));
  const bundle = readFileSync(join(DIST, `eshttp.accel-${arch}.jsx`), 'utf8');
  validateManifest(manifest, `eshttp ${arch}`);

  assert.equal(manifest.version, 2, `${arch}: manifest version`);
  assert.equal(manifest.composer.version, '0.5.0', `${arch}: composer pin`);
  assert.deepEqual(manifest.entries, [{ id: 'eshttp', range: '=1.2.0' }], `${arch}: stable root`);
  assert.deepEqual(manifest.libraries.map((lib) => lib.id), ['esb64', 'eson', 'eshttp'], `${arch}: dependency-first closure`);
  assert.equal(manifest.libraries[0].version, '1.3.0', `${arch}: ESB64 identity`);
  assert.equal(manifest.libraries[1].version, '1.3.0', `${arch}: ESON identity`);
  assert.deepEqual(manifest.libraries[1].requires, [{ id: 'esb64', range: '^1.3.0', optional: false }]);
  assert.deepEqual(manifest.libraries[2].requires, [{ id: 'eson', range: '^1.3.0', optional: false }]);
  assert.deepEqual(manifest.libraries.map((lib) => lib.activation.global), ['ESB64', 'ESON', 'eshttp']);
  assert.deepEqual(manifest.libraries[0].activation.contract.map((row) => row.name),
    ['atob', 'btoa', 'utf8Decode', 'utf8Encode']);
  assert.deepEqual(manifest.libraries[1].activation.contract.map((row) => row.name), ['parse', 'stringify']);
  assert.deepEqual(manifest.libraries[2].activation.contract.map((row) => row.name),
    ['configure', 'get', 'json', 'request']);
  assert.match(Buffer.from(manifest.libraries[1].artifact.b64, 'base64').toString('utf8'), /owned:\s*false/,
    `${arch}: ESON borrows the ESPAK-managed native library`);

  for (const lib of manifest.libraries) {
    const bytes = Buffer.from(lib.artifact.b64, 'base64');
    const artifactPath = lib.id === 'eshttp'
      ? join(DIST, '.eshttp-v2-facade.jsx')
      : join(ROOT, '..', lib.id === 'eson' ? 'eson' : 'esb64', 'dist', lib.artifact.fileName);
    const sourceBytes = readFileSync(artifactPath);
    assert.equal(bytes.length, lib.artifact.len, `${arch}: ${lib.id} UTF-8 length`);
    assert.equal(bytes.equals(sourceBytes), true, `${arch}: ${lib.id} exact source bytes`);

    assert.equal(sha256(bytes), lib.artifact.sha256, `${arch}: ${lib.id} SHA-256`);
    assert.equal(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), true, `${arch}: ${lib.id} canonical UTF-8`);
  }

  const caps = manifest.capabilities;
  assert.deepEqual(caps.map((cap) => [cap.id, cap.provider, cap.mode, cap.payloads, cap.accel]), [
    ['eshttp.cli.file', 'eshttp', 'required', [arch === 'x86' ? 'eshttp-cli-x86' : 'eshttp-cli'], null],
    ['eshttp.ipc.native', 'eshttp', 'required', [`eshttp-ipc-${arch}`], null],
    ['eshttp.esb64-native', 'esb64', 'optional', [], 'ESB64Native'],
    ['eshttp.eson-native', 'eson', 'optional', ['ESONJson'], null]
  ]);
  assert.equal(manifest.payloads.find((p) => p.name === (arch === 'x86' ? 'eshttp-cli-x86' : 'eshttp-cli')).sha256.length, 64);
  assert.equal(manifest.payloads.find((p) => p.name === `eshttp-ipc-${arch}`).sha256.length, 64);
  const payloadFiles = new Map([
    ['ESONJson', join(ROOT, '..', 'eson', 'native', 'build', 'ESONJson.dll')],
    [arch === 'x86' ? 'eshttp-cli-x86' : 'eshttp-cli', join(ROOT, 'native', arch === 'x86' ? 'eshttp-cli-x86.exe' : 'eshttp-cli.exe')],
    [`eshttp-ipc-${arch}`, join(ROOT, 'native', `eshttp-ipc-${arch}.dll`)]
  ]);
  for (const payload of manifest.payloads) {
    const bytes = Buffer.from(payload.b64, 'base64');
    assert.equal(sha256(bytes), payload.sha256, `${arch}: ${payload.name} SHA-256`);
    if (payloadFiles.has(payload.name)) {
      assert.equal(bytes.equals(readFileSync(payloadFiles.get(payload.name))), true,
        `${arch}: ${payload.name} exact native input bytes`);
    }
  }
  const cliPayload = manifest.payloads.find((p) => p.name === (arch === 'x86' ? 'eshttp-cli-x86' : 'eshttp-cli'));
  assert.equal(cliPayload.kind, 'file', `${arch}: CLI is a file capability`);
  assert.equal(manifest.payloads.find((p) => p.name === `eshttp-ipc-${arch}`).kind, undefined,
    `${arch}: IPC is a native DLL capability`);
  assert.equal((bundle.match(/ESPACK library composition v2/g) || []).length, 1, `${arch}: single composition control plane`);
  assert.equal(bundle.split('var ESPACK = (function () {').length - 1, 1, `${arch}: single ESPAK loader`);
  assert.equal(bundle.includes('var ESON_ACCEL_BUNDLE=""'), true, `${arch}: no ad-hoc ESON bundle data`);
  assert.equal(bundle.includes('var ESB64_ACCEL_BUNDLE=""'), true, `${arch}: no ad-hoc ESB64 bundle data`);
  assert.equal(bundle.indexOf('ESPACK library esb64@1.3.0') < bundle.indexOf('ESPACK library eson@1.3.0'), true);
  assert.equal(bundle.indexOf('ESPACK library eson@1.3.0') < bundle.indexOf('ESPACK library eshttp@1.2.0'), true);
}

console.log('[manifest-v2] PASS x64+x86 identity, provenance, capabilities, ordering, and dedup/control-plane assertions');
