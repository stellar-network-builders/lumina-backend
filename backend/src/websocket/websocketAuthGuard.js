const authService = require('../services/authService');
const auditLogger = require('../services/auditLogger');

/**
 * WebSocketConnectionGuard
 *
 * Socket.IO connection guard (issue #6) that:
 *  - validates a JWT/SEP-10 access token on the handshake and REJECTS the
 *    connection before it is established when the token is missing/invalid/expired,
 *  - enforces per-IP (default 5) and per-user (default 3) concurrent connection
 *    limits, and
 *  - writes a connection audit trail (accepted / rejected / disconnected).
 *
 * Usage:
 *   const guard = new WebSocketConnectionGuard();
 *   io.use(guard.middleware());
 *   io.on('connection', (socket) => {
 *     // socket.auth = { address, role } is set and verified
 *     socket.on('disconnect', () => guard.release(socket));
 *   });
 */
class WebSocketConnectionGuard {
  constructor(options = {}) {
    this.maxConnectionsPerIp =
      options.maxConnectionsPerIp ||
      parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '5', 10);
    this.maxConnectionsPerUser =
      options.maxConnectionsPerUser ||
      parseInt(process.env.WS_MAX_CONNECTIONS_PER_USER || '3', 10);

    // Injectable for testing.
    this.authService = options.authService || authService;
    this.audit =
      options.audit || ((entry) => auditLogger.logWebsocketEvent(entry));

    this.ipConnections = new Map(); // ip -> count
    this.userConnections = new Map(); // address -> Set<socketId>
  }

  /**
   * Extract the bearer/access token from a Socket.IO handshake. Supports the
   * standard `auth: { token }`, an Authorization: Bearer header, and a query
   * param fallback.
   */
  extractToken(socket) {
    const handshake = socket.handshake || {};
    if (handshake.auth && handshake.auth.token) {
      return String(handshake.auth.token).replace(/^Bearer\s+/i, '');
    }
    const header = handshake.headers && handshake.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    if (handshake.query && handshake.query.token) {
      return String(handshake.query.token);
    }
    return null;
  }

  /**
   * Best-effort client IP, honoring X-Forwarded-For when behind a proxy.
   */
  getClientIp(socket) {
    const handshake = socket.handshake || {};
    const xff = handshake.headers && handshake.headers['x-forwarded-for'];
    if (xff) {
      return String(xff).split(',')[0].trim();
    }
    return (
      handshake.address ||
      (socket.conn && socket.conn.remoteAddress) ||
      'unknown'
    );
  }

  /**
   * Returns the Socket.IO middleware. Rejecting via next(err) prevents the
   * connection from ever being established.
   */
  middleware() {
    return async (socket, next) => {
      const ip = this.getClientIp(socket);
      try {
        const token = this.extractToken(socket);
        if (!token) {
          return this.deny(socket, ip, null, 'missing_token', next, 'Authentication required');
        }

        let decoded;
        try {
          decoded = await this.authService.verifyAccessToken(token);
        } catch (err) {
          return this.deny(socket, ip, null, 'invalid_token', next, 'Invalid or expired token');
        }

        const address = decoded && decoded.address;
        if (!address) {
          return this.deny(socket, ip, null, 'invalid_token', next, 'Invalid token payload');
        }

        // Per-IP connection limit.
        const ipCount = this.ipConnections.get(ip) || 0;
        if (ipCount >= this.maxConnectionsPerIp) {
          return this.deny(socket, ip, address, 'ip_limit', next, 'Too many connections from this IP');
        }

        // Per-user concurrent connection limit.
        const userSet = this.userConnections.get(address) || new Set();
        if (userSet.size >= this.maxConnectionsPerUser) {
          return this.deny(socket, ip, address, 'user_limit', next, 'Too many concurrent connections for this user');
        }

        // Accept: attach verified identity and track the connection.
        socket.auth = { address, role: decoded.role };
        socket.userAddress = address;
        socket.clientIp = ip;

        this.ipConnections.set(ip, ipCount + 1);
        userSet.add(socket.id);
        this.userConnections.set(address, userSet);

        this.audit({ event: 'connected', socketId: socket.id, ip, address, reason: null });
        return next();
      } catch (err) {
        return this.deny(socket, ip, null, 'error', next, 'Authentication failed');
      }
    };
  }

  deny(socket, ip, address, reason, next, message) {
    this.audit({ event: 'rejected', socketId: socket && socket.id, ip, address, reason });
    const error = new Error(message);
    error.data = { reason };
    return next(error);
  }

  /**
   * Release the connection's IP/user slots. Call on socket 'disconnect'.
   */
  release(socket) {
    const ip = socket.clientIp;
    const address = socket.userAddress;

    if (ip && this.ipConnections.has(ip)) {
      const remaining = this.ipConnections.get(ip) - 1;
      if (remaining <= 0) this.ipConnections.delete(ip);
      else this.ipConnections.set(ip, remaining);
    }

    if (address && this.userConnections.has(address)) {
      const set = this.userConnections.get(address);
      set.delete(socket.id);
      if (set.size === 0) this.userConnections.delete(address);
    }

    this.audit({ event: 'disconnected', socketId: socket.id, ip, address, reason: null });
  }

  /**
   * Authorize a subscription/data request: a user may only access events for
   * their own (verified) address.
   */
  authorizeUserAccess(socket, requestedAddress) {
    const owner = socket.auth && socket.auth.address;
    if (!owner) return false;
    // Default to the socket's own verified address when none is supplied.
    if (!requestedAddress) return true;
    return requestedAddress === owner;
  }

  getStats() {
    return {
      maxConnectionsPerIp: this.maxConnectionsPerIp,
      maxConnectionsPerUser: this.maxConnectionsPerUser,
      uniqueIps: this.ipConnections.size,
      uniqueUsers: this.userConnections.size,
      totalConnections: Array.from(this.ipConnections.values()).reduce((a, b) => a + b, 0),
    };
  }
}

module.exports = WebSocketConnectionGuard;
