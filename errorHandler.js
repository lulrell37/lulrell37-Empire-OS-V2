import { reportError } from './ErrorBanner';

const defaultHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  reportError(`${isFatal ? 'FATAL: ' : ''}${error.message}`);
  console.log('Global error:', error);
  defaultHandler(error, isFatal);
});

const rejectionTracking = require('promise/setimmediate/rejection-tracking');
rejectionTracking.enable({
  allRejections: true,
  onUnhandled: (id, error) => {
    reportError(`Unhandled: ${error.message}`);
    console.log('Unhandled rejection:', error);
  },
});
