// Standalone health probe for the three local agent runtimes. Bundled with an electron stub so it
// can run under plain node (outside the Electron main process).
import { probeEngines } from '../electron/adapters/index';

probeEngines(process.env.NEXUS_BOT_PROBE_TOKEN ?? 'smoke-token')
  .then((results) => console.log(JSON.stringify(results, null, 2)))
  .catch((e) => { console.error(e); process.exitCode = 1; });
