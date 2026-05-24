// PM2 entrypoint. Imports start() from index.js and invokes it
// without depending on the module-guard heuristic.
import { start } from "./index.js";
start().catch(err => {
  console.error("[FATAL] Startup failed.", err);
  process.exit(1);
});
