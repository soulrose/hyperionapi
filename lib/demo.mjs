// `hyperion demo` — mock API (target with introspection off + dev server) and a sample project, then the UI.
import { rm } from 'node:fs/promises';
import { startMocks } from './mock-servers.mjs';
import { startRealtimeMocks } from './mock-realtime.mjs';
import { writeSample } from './sample.mjs';
import { serve } from './server.mjs';

export async function demo({ dir, port = 4322, open = false }) {
  const mocks = await startMocks({ tokenTtlSec: 300, prodPort: 4391, devPort: 4392 });
  const realtime = await startRealtimeMocks({ port: 4393, grpcPort: 4394 });
  // the demo is disposable: start from the same sample every time
  await rm(dir, { recursive: true, force: true });
  await writeSample(dir, { ...mocks, realtime });
  console.log(`mock WebSocket / Socket.IO ${realtime.wsUrl} · mock gRPC ${realtime.grpcAddress}`);
  console.log(`mock target ${mocks.prodUrl} (introspection off) · mock dev ${mocks.devUrl}`);
  return serve({ dir, port, open, registry: false });
}
