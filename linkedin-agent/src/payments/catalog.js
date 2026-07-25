// =================================================================
// Display catalog port (2.4.41). The route-facing neutral surface:
// callers never learn which provider, if any, supplied the data.
// Non-stripe providers have no live catalog: null, static display.
// =================================================================

import { fetchStripeCatalog } from "./stripe-catalog.js";

// 2.4.44 ruling: pricing display is read-only information and is
// deliberately DECOUPLED from the payments provider, so devenv on
// the local provider can still render live prices. The gate is the
// catalog key alone: no key, no catalog, static fallback.
export async function getCatalogForDisplay() {
  return fetchStripeCatalog();
}
