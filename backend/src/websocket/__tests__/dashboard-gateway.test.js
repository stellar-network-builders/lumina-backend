const { createServer } = require('http');
const Client = require('socket.io-client');
const DashboardGateway = require('../dashboard-gateway.gateway');
const WebSocketConnectionGuard = require('../websocketAuthGuard');

/**
 * Integration tests for the secured Socket.IO dashboard gateway (issue #6):
 * authenticated vs unauthenticated connections, per-user connection limiting,
 * and event-level authorization.
 */
describe('DashboardGateway (secured)', () => {
  let httpServer;
  let gateway;
  let port;

  // Mock auth service: token "tok:<ADDRESS>" is valid; anything else fails.
  const authService = {
    verifyAccessToken: jest.fn(async (token) => {
      const m = /^tok:(.+)$/.exec(token || '');
      if (m) return { address: m[1], role: 'user' };
      throw new Error('Invalid or expired access token');
    }),
  };

  const connect = (opts = {}) =>
    Client(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false, ...opts });

  beforeAll((done) => {
    httpServer = createServer();
    const guard = new WebSocketConnectionGuard({
      authService,
      audit: () => {},
      maxConnectionsPerUser: 3,
      maxConnectionsPerIp: 50, // high so the per-user test isn't masked by the IP cap
    });
    gateway = new DashboardGateway(httpServer, { guard });
    httpServer.listen(() => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll(() => {
    gateway.io.close();
    httpServer.close();
  });

  it('rejects a connection with no token', (done) => {
    const c = connect();
    c.on('connect', () => { c.close(); done(new Error('should not connect without a token')); });
    c.on('connect_error', (err) => {
      expect(err.message).toMatch(/Authentication required/);
      c.close();
      done();
    });
  });

  it('rejects a connection with an invalid token', (done) => {
    const c = connect({ auth: { token: 'garbage' } });
    c.on('connect', () => { c.close(); done(new Error('should not connect with a bad token')); });
    c.on('connect_error', (err) => {
      expect(err.message).toMatch(/Invalid or expired token/);
      c.close();
      done();
    });
  });

  it('accepts a connection with a valid token and confirms the verified identity', (done) => {
    const c = connect({ auth: { token: 'tok:GALICE' } });
    c.on('connect_error', (err) => { c.close(); done(err); });
    c.on('connect', () => {
      c.emit('authenticate', {});
      c.on('authenticated', (data) => {
        expect(data.success).toBe(true);
        expect(data.userAddress).toBe('GALICE');
        c.close();
        done();
      });
    });
  });

  it('forbids subscribing to another user\'s events', (done) => {
    const c = connect({ auth: { token: 'tok:GALICE' } });
    c.on('connect', () => {
      c.emit('get_vesting_state', { userAddress: 'GBOB' });
      c.on('error', (err) => {
        expect(err.message).toMatch(/Forbidden/);
        c.close();
        done();
      });
    });
  });

  it('enforces the per-user concurrent connection limit (max 3)', (done) => {
    const conns = [];
    let connected = 0;
    let rejected = 0;
    const token = { auth: { token: 'tok:GLIMIT' } };

    let settled = 0;
    const onSettled = () => {
      settled += 1;
      if (settled === 4) {
        conns.forEach((c) => c.close());
        try {
          expect(connected).toBe(3);
          expect(rejected).toBeGreaterThanOrEqual(1);
          done();
        } catch (e) {
          done(e);
        }
      }
    };

    for (let i = 0; i < 4; i++) {
      const c = connect(token);
      conns.push(c);
      c.on('connect', () => { connected += 1; onSettled(); });
      c.on('connect_error', (err) => {
        if (/concurrent/.test(err.message)) rejected += 1;
        onSettled();
      });
    }
  });
});
