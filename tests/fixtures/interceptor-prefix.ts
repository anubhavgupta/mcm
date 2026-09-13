import type { Interceptor } from '../../src/server/interceptors';

const prefix: Interceptor = {
  beforeRequest(_context, outbound) {
    outbound.headers['x-mcm-request-id'] = `tagged:${outbound.headers['x-mcm-request-id'] ?? 'unset'}`;
  },
};

export default prefix;
