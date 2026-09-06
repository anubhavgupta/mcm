import type { Interceptor } from '../src/server/interceptors';

const requestTag: Interceptor = {
  beforeRequest(context, outbound) {
    outbound.headers['x-mcm-request-id'] = context.requestId;
  },
};

export default [requestTag];
