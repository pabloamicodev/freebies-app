/**
 * UI contract for "restore the offers archived at uninstall". The implementation lives in
 * restore-archived-offers.server.ts (WS-C); the dashboard banner and the /app/restore-offers action
 * only depend on the two functions re-exported here.
 */
export interface RestorableOffers {
  /** Offers archived by the uninstall webhook that are still archived. 0 hides the banner. */
  count: number;
}

export interface RestoreResult {
  restored: number;
  /** Offers that could not be restored (e.g. a live offer now holds the same code). */
  failed: number;
}

export {
  dismissRestorableOffers,
  getRestorableOffers,
  restoreArchivedOffers,
} from "./restore-archived-offers.server.js";
