// ═══════════════════════════════════════════════════════════════
// activation-middleware.js - annotates a router's requests with
// their workflow. The activation ROW is minted lazily on first
// spend; annotated requests that never spend cost nothing.
// ═══════════════════════════════════════════════════════════════
import { runWithActivation } from "./activation-context.js";

export function annotateActivation(workflow) {
  return (req, _res, next) => {
    runWithActivation(
      { workflow, createdBy: req.user && req.user.sub ? req.user.sub : null },
      () => next()
    );
  };
}
