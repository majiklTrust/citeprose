// =================================================================
// Display catalog port (2.4.41). The route-facing neutral surface:
// callers never learn which provider, if any, supplied the data.
// Non-stripe providers have no live catalog: null, static display.
// =================================================================

import { getPaymentsProviderName } from "./provider.js";
import { fetchStripeCatalog } from "./stripe-catalog.js";

export async function getCatalogForDisplay() {
  if (getPaymentsProviderName() !== "stripe") return null;
  return fetchStripeCatalog();
}
