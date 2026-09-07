import { reportError } from './ErrorBanner';
import { logCrash } from './src/services/crashLog';
import useEmpireStore from './src/store/useEmpireStore';

// Also drop every uncaught error into the top banner (NudgeBar) so nothing
// fails silently. Fatal → the big red ErrorBanner too; non-fatal → a banner
// chip that fades after 15 min.
function toBanner(key, label, error, fatal) {
  try {
    useEmpireStore.getState().flagFirmIssue(
      key,
      `${label}: ${String(error && error.message || error).slice(0, 100)}`,
      String(error && error.stack || '').slice(0, 1200) || null,
      'error',
      fatal ? 0 : 15 * 60000,
    );
  } catch {}
}

const defaultHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  if (isFatal) reportError(`FATAL: ${error.message}`);
  toBanner('crash:global', isFatal ? 'App crashed' : 'Background error', error, isFatal);
  logCrash(isFatal ? 'fatal' : 'global', error && error.message, error && error.stack);
  console.log('Global error:', error);
  defaultHandler(error, isFatal);
});

const rejectionTracking = require('promise/setimmediate/rejection-tracking');
rejectionTracking.enable({
  allRejections: true,
  onUnhandled: (id, error) => {
    toBanner('crash:rejection', 'Unhandled error', error, false);
    logCrash('rejection', error && error.message, error && error.stack);
    console.log('Unhandled rejection:', error);
  },
});
