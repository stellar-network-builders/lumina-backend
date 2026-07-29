const { Server } = require('socket.io');
const { sequelize } = require('../database/connection');
const Vault = require('../models/vault');
const SubSchedule = require('../models/subSchedule');
const Beneficiary = require('../models/beneficiary');
const { claimEventEmitter } = require('../services/indexingService');
const WebSocketConnectionGuard = require('./websocketAuthGuard');

/**
 * DashboardGateway - Enhanced real-time WebSocket Gateway for dashboard updates
 * Uses Socket.io for better browser compatibility and enhanced real-time features
 * Provides instant updates when users claim tokens on-chain
 */
class DashboardGateway {
  constructor(httpServer, options = {}) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["GET", "POST"]
      },
      transports: ['websocket', 'polling']
    });

    this.connectedUsers = new Map(); // Map<userAddress, Set<socketId>>
    this.userSockets = new Map(); // Map<socketId, userAddress>
    this.updateIntervalMs = 5000; // Soroban ledger closes every 5 seconds

    // Connection guard: JWT auth + per-IP/per-user rate limits + audit (issue #6).
    this.guard = options.guard || new WebSocketConnectionGuard();
    this.io.use(this.guard.middleware());

    this.initialize();
  }

  initialize() {
    this.io.on('connection', (socket) => {
      // By the time we get here the guard has authenticated the socket and set
      // socket.auth = { address, role } and socket.userAddress.
      console.log(`Client connected: ${socket.id} (user ${socket.userAddress})`);

      // Bind the verified identity immediately so the user receives their updates.
      this.userSockets.set(socket.id, socket.userAddress);

      // Handle user authentication and subscription
      socket.on('authenticate', async (data) => {
        await this.handleAuthentication(socket, data);
      });

      // Handle subscription to user-specific updates
      socket.on('subscribe_user', (data) => {
        this.handleUserSubscription(socket, data);
      });

      // Handle unsubscription
      socket.on('unsubscribe_user', (data) => {
        this.handleUserUnsubscription(socket, data);
      });

      // Handle request for current vesting state
      socket.on('get_vesting_state', async (data) => {
        await this.handleGetVestingState(socket, data);
      });

      // Handle dashboard data request
      socket.on('get_dashboard_data', async (data) => {
        await this.handleGetDashboardData(socket, data);
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        this.handleDisconnection(socket);
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
      });
    });

    // Listen for claim events from indexing service
    claimEventEmitter.on('claim', (claimData) => {
      this.onClaimEvent(claimData);
    });

    // Start periodic updates for live dashboard
    this.startPeriodicUpdates();

    console.log('Dashboard WebSocket Gateway initialized successfully');
  }

  async handleAuthentication(socket, data) {
    // Connections are already authenticated by the guard middleware at the
    // handshake (a JWT is required to establish the socket at all). This handler
    // simply confirms the verified identity; the client-supplied address is
    // never trusted over the token.
    try {
      const userAddress = socket.userAddress;
      if (!userAddress) {
        socket.emit('error', { message: 'Not authenticated' });
        return;
      }

      this.userSockets.set(socket.id, userAddress);
      socket.emit('authenticated', { success: true, userAddress, role: socket.auth && socket.auth.role });
      console.log(`User ${userAddress} confirmed on socket ${socket.id}`);
    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('error', { message: 'Authentication failed' });
    }
  }

  handleUserSubscription(socket, data) {
    // A user may only subscribe to events for their own verified address.
    const userAddress = (data && data.userAddress) || socket.userAddress;

    if (!this.guard.authorizeUserAccess(socket, data && data.userAddress)) {
      socket.emit('error', { message: 'Forbidden: cannot subscribe to another user' });
      return;
    }

    // Add socket to user's connected sockets
    if (!this.connectedUsers.has(userAddress)) {
      this.connectedUsers.set(userAddress, new Set());
    }
    this.connectedUsers.get(userAddress).add(socket.id);

    // Join socket to user-specific room
    socket.join(`user:${userAddress}`);

    socket.emit('subscribed', { userAddress });
    console.log(`Socket ${socket.id} subscribed to updates for ${userAddress}`);
  }

  handleUserUnsubscription(socket, data) {
    const { userAddress } = data;
    
    if (userAddress && this.connectedUsers.has(userAddress)) {
      this.connectedUsers.get(userAddress).delete(socket.id);
      if (this.connectedUsers.get(userAddress).size === 0) {
        this.connectedUsers.delete(userAddress);
      }
      socket.leave(`user:${userAddress}`);
    }

    socket.emit('unsubscribed', { userAddress });
  }

  async handleGetVestingState(socket, data) {
    try {
      const userAddress = (data && data.userAddress) || socket.userAddress;

      if (!this.guard.authorizeUserAccess(socket, data && data.userAddress)) {
        socket.emit('error', { message: 'Forbidden: cannot access another user' });
        return;
      }

      const vestingState = await this.calculateUserVestingState(userAddress);
      socket.emit('vesting_state', vestingState);
    } catch (error) {
      console.error('Error getting vesting state:', error);
      socket.emit('error', { message: 'Failed to get vesting state' });
    }
  }

  async handleGetDashboardData(socket, data) {
    try {
      const userAddress = (data && data.userAddress) || socket.userAddress;

      if (!this.guard.authorizeUserAccess(socket, data && data.userAddress)) {
        socket.emit('error', { message: 'Forbidden: cannot access another user' });
        return;
      }

      const dashboardData = await this.calculateDashboardData(userAddress);
      socket.emit('dashboard_data', dashboardData);
    } catch (error) {
      console.error('Error getting dashboard data:', error);
      socket.emit('error', { message: 'Failed to get dashboard data' });
    }
  }

  handleDisconnection(socket) {
    const userAddress = this.userSockets.get(socket.id);

    if (userAddress && this.connectedUsers.has(userAddress)) {
      this.connectedUsers.get(userAddress).delete(socket.id);
      if (this.connectedUsers.get(userAddress).size === 0) {
        this.connectedUsers.delete(userAddress);
      }
    }

    this.userSockets.delete(socket.id);

    // Free the per-IP / per-user connection slots and audit the disconnect.
    this.guard.release(socket);
    console.log(`Client disconnected: ${socket.id}`);
  }

  onClaimEvent(claimData) {
    if (claimData && claimData.user_address) {
      // Emit instant claim event to user's dashboard
      this.io.to(`user:${claimData.user_address}`).emit('claim_event', {
        type: 'CLAIM_EVENT',
        data: claimData,
        timestamp: new Date().toISOString(),
        message: 'Tokens claimed successfully!'
      });

      // Also emit updated vesting state
      this.emitUpdatedVestingState(claimData.user_address);
    }
  }

  async emitUpdatedVestingState(userAddress) {
    try {
      const vestingState = await this.calculateUserVestingState(userAddress);
      this.io.to(`user:${userAddress}`).emit('vesting_state_updated', vestingState);
    } catch (error) {
      console.error('Error emitting updated vesting state:', error);
    }
  }

  startPeriodicUpdates() {
    setInterval(async () => {
      await this.broadcastLiveUpdates();
    }, this.updateIntervalMs);
  }

  async broadcastLiveUpdates() {
    try {
      const userAddresses = Array.from(this.connectedUsers.keys());
      
      if (userAddresses.length === 0) {
        return; // No connected users
      }

      // Calculate and broadcast updates for each connected user
      for (const userAddress of userAddresses) {
        try {
          const vestingState = await this.calculateUserVestingState(userAddress);
          
          this.io.to(`user:${userAddress}`).emit('live_update', {
            type: 'LIVE_UPDATE',
            data: vestingState,
            timestamp: new Date().toISOString(),
            ledgerCloseTime: new Date().toISOString()
          });
        } catch (error) {
          console.error(`Error broadcasting update for ${userAddress}:`, error);
        }
      }

      console.debug(`Broadcasted live updates to ${userAddresses.length} users`);
    } catch (error) {
      console.error('Error broadcasting live updates:', error);
    }
  }

  async calculateUserVestingState(userAddress) {
    try {
      // Find all vaults where user is beneficiary
      const beneficiaryRecords = await Beneficiary.findAll({
        where: { address: userAddress },
        include: [{
          model: Vault,
          as: 'vault',
          where: { is_active: true },
          include: [{
            model: SubSchedule,
            as: 'subSchedules',
            where: { is_active: true }
          }]
        }]
      });

      const vaults = [];
      let totalAvailableToClaim = 0;
      let totalVested = 0;
      let totalUnvested = 0;
      let totalClaimed = 0;

      for (const beneficiary of beneficiaryRecords) {
        const vault = beneficiary.vault;
        if (!vault || !vault.subSchedules) continue;

        for (const subSchedule of vault.subSchedules) {
          const vestedAmount = this.calculateVestedAmount(subSchedule);
          const claimedAmount = parseFloat(subSchedule.cumulative_claimed_amount || '0');
          const availableToClaim = vestedAmount - claimedAmount;

          totalAvailableToClaim += availableToClaim;
          totalVested += vestedAmount;
          totalUnvested += (parseFloat(subSchedule.top_up_amount) - vestedAmount);
          totalClaimed += claimedAmount;

          vaults.push({
            vaultAddress: vault.address,
            vaultName: vault.name,
            tokenAddress: vault.token_address,
            availableToClaim: availableToClaim.toString(),
            vestedAmount: vestedAmount.toString(),
            unvestedAmount: (parseFloat(subSchedule.top_up_amount) - vestedAmount).toString(),
            claimedAmount: claimedAmount.toString(),
            vestingStartDate: subSchedule.vesting_start_date,
            cliffDate: subSchedule.cliff_date,
            vestingEndDate: new Date(
              subSchedule.vesting_start_date.getTime() + (subSchedule.vesting_duration * 1000)
            ),
            progressPercentage: (vestedAmount / parseFloat(subSchedule.top_up_amount)) * 100,
            isCliffActive: subSchedule.cliff_date && new Date() < subSchedule.cliff_date,
            isVestingComplete: new Date() >= new Date(
              subSchedule.vesting_start_date.getTime() + (subSchedule.vesting_duration * 1000)
            )
          });
        }
      }

      return {
        userAddress,
        timestamp: new Date().toISOString(),
        summary: {
          totalAvailableToClaim: totalAvailableToClaim.toString(),
          totalVested: totalVested.toString(),
          totalUnvested: totalUnvested.toString(),
          totalClaimed: totalClaimed.toString(),
          totalVaults: vaults.length,
          hasClaimableTokens: totalAvailableToClaim > 0
        },
        vaults,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error calculating vesting state:', error);
      throw error;
    }
  }

  async calculateDashboardData(userAddress) {
    try {
      const vestingState = await this.calculateUserVestingState(userAddress);
      
      // Add additional dashboard-specific data
      return {
        ...vestingState,
        dashboard: {
          totalValue: parseFloat(vestingState.summary.totalVested) + parseFloat(vestingState.summary.totalUnvested),
          claimableValue: parseFloat(vestingState.summary.totalAvailableToClaim),
          claimedValue: parseFloat(vestingState.summary.totalClaimed),
          vestingProgress: vestingState.summary.totalVaults > 0 
            ? (parseFloat(vestingState.summary.totalVested) / 
               (parseFloat(vestingState.summary.totalVested) + parseFloat(vestingState.summary.totalUnvested))) * 100
            : 0,
          nextClaimableAmount: vestingState.summary.totalAvailableToClaim,
          activeVaults: vestingState.vaults.filter(v => !v.isVestingComplete).length,
          completedVaults: vestingState.vaults.filter(v => v.isVestingComplete).length
        }
      };
    } catch (error) {
      console.error('Error calculating dashboard data:', error);
      throw error;
    }
  }

  calculateVestedAmount(subSchedule) {
    const now = new Date();
    
    // Check if cliff has passed
    if (subSchedule.cliff_date && now < subSchedule.cliff_date) {
      return 0;
    }

    // Check if vesting hasn't started
    if (now < subSchedule.vesting_start_date) {
      return 0;
    }

    // Check if vesting has completed
    const vestingEnd = new Date(
      subSchedule.vesting_start_date.getTime() + (subSchedule.vesting_duration * 1000)
    );
    if (now >= vestingEnd) {
      return parseFloat(subSchedule.top_up_amount);
    }

    // Calculate linear vesting
    const elapsedSeconds = Math.floor((now.getTime() - subSchedule.vesting_start_date.getTime()) / 1000);
    const totalSeconds = subSchedule.vesting_duration;
    const totalAllocation = parseFloat(subSchedule.top_up_amount);
    
    return (elapsedSeconds * totalAllocation) / totalSeconds;
  }

  // Public method to broadcast custom events
  broadcastToUser(userAddress, event, data) {
    this.io.to(`user:${userAddress}`).emit(event, data);
  }

  // Get connection statistics
  getConnectionStats() {
    return {
      totalConnections: this.io.sockets.sockets.size,
      connectedUsers: this.connectedUsers.size,
      users: Array.from(this.connectedUsers.keys()),
      limits: this.guard.getStats()
    };
  }
}

module.exports = DashboardGateway;
