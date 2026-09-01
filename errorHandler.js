import { reportError } from './ErrorBanner';
import { logCrash } from './src/services/crashLog';

const defaultHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  reportError(`${isFatal ? 'FATAL: ' : ''}${error.message}`);
  logCrash(isFatal ? 'fatal' : 'global', error && error.message, error && error.stack);
  console.log('Global error:', error);
  defaultHandler(error, isFatal);
});

const rejectionTracking = require('promise/setimmediate/rejection-tracking');
rejectionTracking.enable({
  allRejections: true,
  onUnhandled: (id, error) => {
    reportError(`Unhandled: ${error.message}`);
    logCrash('rejection', error && error.message, error && error.stack);
    console.log('Unhandled rejection:', error);
  },
});
