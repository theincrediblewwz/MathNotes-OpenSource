import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the current Mac replica tests against the unmodified host classes
// from a supplied Git revision. Only synthetic loopback libraries are touched.
// This validates cross-revision protocol behavior on macOS, not Windows OS UI.
const repository = process.cwd();
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr ?? ''}`);
  return result.stdout;
}
const ref = process.argv[2];
assert(ref && !ref.startsWith('-'), 'Pass the Windows host Git revision explicitly');
const revision = run('git', ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
const output = path.join(repository, 'output/macos-local-debug');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'windows-interop-'));
const upstream = path.join(root, 'upstream');
await mkdir(upstream);
const archive = path.join(root, 'host.tar');
run('git', ['archive', '--format=tar', `--output=${archive}`, revision, 'packages/core-server/src', 'packages/shared/src']);
run('tar', ['-xf', archive, '-C', upstream]);
await symlink(path.join(repository, 'node_modules'), path.join(upstream, 'node_modules'));
const currentCore = path.join(repository, 'packages/core-server/src');
const hostCore = path.join(upstream, 'packages/core-server/src');
const tests = ['replicaCatalogSync.test.ts', 'replicaWorkspaceService.test.ts'];
const hostModules = new Set(['../api/networkApiServer', './workspaceSyncService', './workspaceCatalogSyncService']);
const generated = [];
for (const name of tests) {
  const original = path.join(currentCore, 'sync', name);
  let source = await readFile(original, 'utf8');
  source = source.replace(/from "(\.[^"]+)"/g, (_, specifier) => {
    const base = hostModules.has(specifier) ? hostCore : currentCore;
    return `from ${JSON.stringify(path.resolve(base, 'sync', specifier))}`;
  });
  source = `import { SessionWriteCoordinator as WindowsHostWrites } from ${JSON.stringify(path.join(hostCore, 'session/sessionWriteCoordinator'))};\n` + source;
  if (name === 'replicaCatalogSync.test.ts') {
    const before = 'const hostWrites = new SessionWriteCoordinator();';
    assert(source.includes(before), 'Host coordinator fixture changed; inspect the adapter');
    source = source.replace(before, 'const hostWrites = new WindowsHostWrites();');
    // The previous Windows revision rejected encoded #/% destinations. Exercise
    // that regression through a real Mac outbox upload + notebook trash/restore.
    assert(source.includes('![photo](assets/photo.png)'), 'Image fixture changed; inspect the adapter');
    source = source.replaceAll('"photo.png"', '"photo#50% 中文(1).png"')
      .replace('![photo](assets/photo.png)', '![photo](assets/photo%2350%25%20%E4%B8%AD%E6%96%87%281%29.png)');
  } else {
    const before = 'const hostWrites = new SessionWriteCoordinator();';
    assert(source.includes(before), 'Body-sync host fixture changed; inspect the adapter');
    source = source.replace(before, 'const hostWrites = new WindowsHostWrites();');
  }
  const target = path.join(root, name);
  await writeFile(target, `// Host pinned to ${revision}; client is this working tree.\n${source}`);
  generated.push(target);
}
const config = path.join(root, 'vitest.config.mjs');
await writeFile(config, `const config = ${JSON.stringify({
  test: { include: generated, exclude: [], pool: 'forks', maxWorkers: 1, minWorkers: 1,
    testTimeout: 30000, hookTimeout: 30000, reporters: ['default', 'json'],
    outputFile: { json: path.join(root, 'results.json') } }
}, null, 2)};
config.plugins = [{name:'revision-specific-shared', enforce:'pre', resolveId(source, importer) {
  if (source === '@mathnotes/shared') return importer?.startsWith(${JSON.stringify(upstream + path.sep)})
    ? ${JSON.stringify(path.join(upstream, 'packages/shared/src/index.ts'))}
    : ${JSON.stringify(path.join(repository, 'packages/shared/src/index.ts'))};
}}];
export default config;\n`);
await writeFile(path.join(root, 'scope.json'), JSON.stringify({ revision,
  clientRevision: run('git', ['rev-parse', 'HEAD']).trim(),
  platform: process.platform, hostModules: [...hostModules],
  scope: 'Current replica/client tests; upstream network, catalog, snapshot and host write coordinator. Each revision resolves its own shared package. Synthetic fixtures and host-edit helpers remain local. Not Windows Electron or physical cross-machine acceptance.'
}, null, 2));
console.log(`INTEROP_HOST_REVISION=${revision}\nINTEROP_EVIDENCE=${root}`);
const result = spawnSync(process.execPath, [path.join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config],
  { cwd: repository, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
