import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'looprig-packed-consumer-'));
const tarballs = join(scratch, 'tarballs');
const consumer = join(scratch, 'consumer');
const vanilla = join(scratch, 'vanilla');
mkdirSync(tarballs);
mkdirSync(consumer);
mkdirSync(vanilla);
const run = (bin, args, cwd) => execFileSync(bin, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...(cwd !== workspace ? { npm_config_workspaces: 'false' } : {}) },
});
const provided = {
  client: process.env.LOOPRIG_CLIENT_TARBALL,
  react: process.env.LOOPRIG_REACT_TARBALL,
};
if (Boolean(provided.client) !== Boolean(provided.react)) throw new Error('provide both package tarballs');

try {
  const packed = [];
  for (const name of ['client', 'react']) {
    if (provided.client && provided.react) {
      packed.push({ name, tarball: provided[name], files: 'provided' });
      continue;
    }
    const output = run('npm', ['pack', '--workspace', `@looprig/${name}`, '--ignore-scripts', '--json', '--pack-destination', tarballs], workspace);
    const artifact = JSON.parse(output)[0];
    if (!artifact) throw new Error(`npm pack returned no @looprig/${name} artifact`);
    const paths = artifact.files.map(({ path }) => path);
    for (const required of ['LICENSE', 'NOTICE', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'package.json']) {
      if (!paths.includes(required)) throw new Error(`@looprig/${name} tarball lacks ${required}`);
    }
    if (paths.some((path) => !['LICENSE', 'NOTICE', 'README.md', 'package.json'].includes(path) && !path.startsWith('dist/'))) {
      throw new Error(`@looprig/${name} tarball contains files outside dist/ and attribution`);
    }
    packed.push({ name, tarball: join(tarballs, artifact.filename), files: paths.length });
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@looprig/client': `file:${packed[0].tarball}`,
      '@looprig/react': `file:${packed[1].tarball}`,
      react: '19.2.6',
      'react-dom': '19.2.6',
    },
    devDependencies: {
      typescript: '5.9.3',
      '@types/react': '19.2.14',
      '@types/react-dom': '19.2.3',
    },
  }, null, 2));
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true },
    include: ['consumer.tsx'],
  }));
  writeFileSync(join(consumer, 'consumer.tsx'), `import { createFactoryClient, createRefreshingFetch, createPublicEventFolder, PendingSlot, uuidV4, type FactoryClient } from '@looprig/client';\nimport { useFoldedEvents, useGateBoard, useLinkRecovery, usePendingInput, type UseFactorySessionViewResult } from '@looprig/react';\nconst client: FactoryClient = createFactoryClient({ idGenerator: uuidV4 });\nconst refresh = createRefreshingFetch(fetch, async () => true);\nconst folder = createPublicEventFolder();\nconst controller = PendingSlot;\nconst hooks = [useFoldedEvents, useGateBoard, useLinkRecovery, usePendingInput];\nconst previews: Pick<UseFactorySessionViewResult, 'liveText' | 'liveReasoning'> = { liveText: [], liveReasoning: [] };\n// @ts-expect-error liveReasoning is a required field\nconst missingReasoning: Pick<UseFactorySessionViewResult, 'liveText' | 'liveReasoning'> = { liveText: [] };\nvoid [client, refresh, folder, controller, hooks, previews, missingReasoning];\n// @ts-expect-error removed serve transport is not exported\nimport type { LooprigTransport } from '@looprig/client';\n// @ts-expect-error removed serve DTO is not exported\nimport type { RestoreResponse } from '@looprig/client';\n// @ts-expect-error removed React serve hook is not exported\nimport { useSessionView } from '@looprig/react';\n`);
  writeFileSync(join(consumer, 'consumer.mjs'), `import { uuidV4, createPublicEventFolder, decodeFactoryLiveDelta, placeLivePreviews, livePreviewKey } from '@looprig/client';\nimport { useFoldedEvents } from '@looprig/react';\nif (!/^[0-9a-f-]{36}$/.test(uuidV4()) || typeof createPublicEventFolder !== 'function' || typeof useFoldedEvents !== 'function' || typeof decodeFactoryLiveDelta !== 'function' || typeof placeLivePreviews !== 'function' || typeof livePreviewKey !== 'function') throw Error('runtime exports');\n`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const { name } of packed) {
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules', '@looprig', name, 'package.json'), 'utf8'));
    const installed = join(consumer, 'node_modules', '@looprig', name, 'dist');
    const forbidden = name === 'client'
      ? ['serve/v1', 'LooprigTransport', 'ThreadReconnectTransport', 'createHostTransport', 'restoreSession', 'SseFrame', 'class SessionViewStore']
      : ['LooprigTransport', 'SessionViewStore', 'useSessionView(', 'useSessionList(', 'useTranscriptRow('];
    for (const entry of readdirSync(installed, { recursive: true })) {
      if (!/\.(?:js|d\.ts)$/.test(entry)) continue;
      const contents = readFileSync(join(installed, entry), 'utf8');
      for (const symbol of forbidden) {
        if (new RegExp('\\b' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(contents)) throw new Error(`@looprig/${name} packed ${entry} contains removed surface: ${symbol}`);
      }
    }
    if (manifest.version !== '0.3.0' || manifest.license !== 'Apache-2.0') throw new Error(`@looprig/${name} version/license mismatch`);
    if (name === 'react' && manifest.dependencies?.['@looprig/client'] !== '0.3.0') throw new Error('React must depend on exact @looprig/client@0.3.0');
  }
  run(join(consumer, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], consumer);
  run(process.execPath, ['consumer.mjs'], consumer);
  writeFileSync(join(vanilla, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { '@looprig/client': `file:${packed[0].tarball}` },
    devDependencies: { typescript: '5.9.3' },
  }, null, 2));
  writeFileSync(join(vanilla, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
    include: ['consumer.ts'],
  }));
  writeFileSync(join(vanilla, 'consumer.ts'), `import { createFactoryClient, decodeFactoryLiveDelta, placeLivePreviews, livePreviewKey, uuidV4, type FactoryClient } from '@looprig/client';\nconst client: FactoryClient = createFactoryClient();\nvoid [client, decodeFactoryLiveDelta, placeLivePreviews, livePreviewKey, uuidV4];\n`);
  writeFileSync(join(vanilla, 'consumer.mjs'), `import { createFactoryClient, decodeFactoryLiveDelta, placeLivePreviews, livePreviewKey } from '@looprig/client';\nif (typeof createFactoryClient().idGenerator() !== 'string' || typeof decodeFactoryLiveDelta !== 'function' || typeof placeLivePreviews !== 'function' || typeof livePreviewKey !== 'function') throw Error('client runtime export');\n`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], vanilla);
  run(join(vanilla, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], vanilla);
  run(process.execPath, ['consumer.mjs'], vanilla);
  console.log(`Packed vanilla and React consumers passed (TypeScript 5.9.3, client ${packed[0].files} files, React ${packed[1].files} files).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
