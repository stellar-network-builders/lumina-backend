const WebSocketConnectionGuard = require('./websocketAuthGuard');

// Build a fake Socket.IO socket with a controllable handshake.
let socketSeq = 0;
function makeSocket({ token, ip = '1.2.3.4', headers = {}, auth } = {}) {
  socketSeq += 1;
  const handshake = { address: ip, headers: { ...headers }, auth: auth || {}, query: {} };
  if (token !== undefined && !auth) handshake.auth.token = token;
  return { id: `sock-${socketSeq}`, handshake };
}

describe('WebSocketConnectionGuard', () => {
  let guard;
  let verifyAccessToken;
  let auditEvents;

  beforeEach(() => {
    auditEvents = [];
    verifyAccessToken = jest.fn(async (token) => {
      if (token === 'valid-user') return { address: 'GUSER', role: 'user' };
      if (token === 'valid-admin') return { address: 'GADMIN', role: 'admin' };
      // Distinct-user tokens ("u0", "u1", ...) -> distinct addresses, for
      // isolating the per-IP limit from the per-user limit.
      const m = /^u(\d+)$/.exec(token || '');
      if (m) return { address: `GUSER${m[1]}`, role: 'user' };
      throw new Error('Invalid or expired access token');
    });
    guard = new WebSocketConnectionGuard({
      authService: { verifyAccessToken },
      audit: (e) => auditEvents.push(e),
      maxConnectionsPerIp: 5,
      maxConnectionsPerUser: 3,
    });
  });

  const run = (socket) =>
    new Promise((resolve) => guard.middleware()(socket, (err) => resolve(err)));

  describe('authentication', () => {
    it('rejects a connection with no token before it is established', async () => {
      const err = await run(makeSocket({ token: undefined }));
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/Authentication required/);
      expect(auditEvents.pop()).toMatchObject({ event: 'rejected', reason: 'missing_token' });
    });

    it('rejects an invalid/expired token', async () => {
      const err = await run(makeSocket({ token: 'bogus' }));
      expect(err.message).toMatch(/Invalid or expired token/);
      expect(auditEvents.pop()).toMatchObject({ event: 'rejected', reason: 'invalid_token' });
    });

    it('accepts a valid token and attaches the verified identity', async () => {
      const socket = makeSocket({ token: 'valid-user' });
      const err = await run(socket);
      expect(err).toBeUndefined();
      expect(socket.auth).toEqual({ address: 'GUSER', role: 'user' });
      expect(socket.userAddress).toBe('GUSER');
      expect(auditEvents.pop()).toMatchObject({ event: 'connected', address: 'GUSER' });
    });

    it('reads a Bearer token from the Authorization header', async () => {
      const socket = makeSocket({ headers: { authorization: 'Bearer valid-admin' } });
      const err = await run(socket);
      expect(err).toBeUndefined();
      expect(socket.auth.role).toBe('admin');
    });
  });

  describe('per-IP connection limit', () => {
    it('rejects the 6th connection from the same IP', async () => {
      const errors = [];
      // Distinct users so only the per-IP limit is exercised.
      for (let i = 0; i < 6; i++) {
        errors.push(await run(makeSocket({ auth: { token: `u${i}` }, ip: '9.9.9.9' })));
      }
      expect(errors.slice(0, 5).every((e) => e === undefined)).toBe(true);
      expect(errors[5]).toBeInstanceOf(Error);
      expect(errors[5].message).toMatch(/Too many connections from this IP/);
      expect(auditEvents.pop()).toMatchObject({ event: 'rejected', reason: 'ip_limit' });
    });
  });

  describe('per-user connection limit', () => {
    it('rejects the 4th concurrent connection for the same user (different IPs)', async () => {
      const errors = [];
      for (let i = 0; i < 4; i++) {
        errors.push(await run(makeSocket({ auth: { token: 'valid-user' }, ip: `10.0.0.${i}` })));
      }
      expect(errors.slice(0, 3).every((e) => e === undefined)).toBe(true);
      expect(errors[3]).toBeInstanceOf(Error);
      expect(errors[3].message).toMatch(/Too many concurrent connections/);
      expect(auditEvents.pop()).toMatchObject({ event: 'rejected', reason: 'user_limit' });
    });
  });

  describe('release', () => {
    it('frees IP and user slots so new connections are allowed again', async () => {
      const sockets = [];
      for (let i = 0; i < 3; i++) {
        const s = makeSocket({ auth: { token: 'valid-user' }, ip: '7.7.7.7' });
        await run(s);
        sockets.push(s);
      }
      // 4th user connection blocked.
      expect((await run(makeSocket({ auth: { token: 'valid-user' }, ip: '7.7.7.7' }))).message).toMatch(/concurrent/);

      guard.release(sockets[0]);
      expect(guard.getStats().totalConnections).toBe(2);

      // Now a new connection succeeds.
      const fresh = makeSocket({ auth: { token: 'valid-user' }, ip: '7.7.7.7' });
      expect(await run(fresh)).toBeUndefined();
      expect(auditEvents.some((e) => e.event === 'disconnected')).toBe(true);
    });
  });

  describe('authorizeUserAccess', () => {
    it('allows access to the socket owner address and denies others', async () => {
      const socket = makeSocket({ auth: { token: 'valid-user' } });
      await run(socket);
      expect(guard.authorizeUserAccess(socket, 'GUSER')).toBe(true);
      expect(guard.authorizeUserAccess(socket, undefined)).toBe(true); // defaults to own
      expect(guard.authorizeUserAccess(socket, 'GVICTIM')).toBe(false);
    });

    it('denies when the socket is unauthenticated', () => {
      expect(guard.authorizeUserAccess({}, 'GANY')).toBe(false);
    });
  });
});
