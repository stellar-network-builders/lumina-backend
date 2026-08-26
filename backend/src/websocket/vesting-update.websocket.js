const logger = require('../utils/logger');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { sequelize } = require('../database/connection');
const Vault = require('../models/vault');
const SubSchedule = require('../models/subSchedule');
const Beneficiary = require('../models/beneficiary');
const { claimEventEmitter } = require('../services/indexingService');

/**
 * VestingUpdateWebSocket - Real-time vesting updates via WebSocket
 * Broadcasts live vesting updates to connected clients every Soroban ledger close (5 seconds)
 * Creates a "hypnotic UX" where users can see their wealth growing second-by-second
 */
class VestingUpdateWebSocket {
  constructor(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/vesting-updates',
      clientTracking: true
    });
    
    this.clients = new Map(); // Map<userAddress, Set<WebSocket>>
    this.updateIntervalMs = 5000; // Soroban ledger closes every 5 seconds
    
    this.initialize();
  }

  initialize() {
    this.wss.on('connection', (ws) => {
      logger.info('Client connected to vesting updates WebSocket');
      
      ws.isAlive = true;
      ws.subscriptions = new Set(); // Track which user addresses this client is subscribed to
      
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleMessage(ws, data);
        } catch (error) {
          logger.error('Error processing WebSocket message:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        logger.info('Client disconnected from vesting updates WebSocket');
        this.cleanupClient(ws);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    // Listen for claim events
    claimEventEmitter.on('claim', (claimData) => {
      if (claimData && claimData.user_address) {
        this.broadcastToUser(claimData.user_address, {
          type: 'CLAIM_EVENT',
          data: claimData,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Start periodic vesting updates
    this.startPeriodicUpdates();

    // Start heartbeat to detect stale connections
    this.startHeartbeat();
  }

  handleMessage(ws, data) {
    const { type, payload } = data;

    switch (type) {
      case 'SUBSCRIBE':
        this.handleSubscribe(ws, payload);
        break;
      
      case 'UNSUBSCRIBE':
        this.handleUnsubscribe(ws, payload);
        break;
      
      case 'GET_VESTING_STATE':
        this.handleGetVestingState(ws, payload);
        break;
      
      default:
        ws.send(JSON.stringify({ 
          type: 'ERROR', 
          message: `Unknown message type: ${type}` 
        }));
    }
  }

  async handleSubscribe(ws, payload) {
    const { userAddress } = payload;
    
    if (!userAddress) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'userAddress is required' }));
      return;
    }

    // Add client to user's subscription
    if (!this.clients.has(userAddress)) {
      this.clients.set(userAddress, new Set());
    }
    this.clients.get(userAddress).add(ws);
    ws.subscriptions.add(userAddress);

    logger.info(`Client subscribed to ${userAddress}`);

    // Send initial vesting state
    try {
      const vestingState = await this.calculateUserVestingState(userAddress);
      ws.send(JSON.stringify({ 
        type: 'VESTING_STATE', 
        data: vestingState 
      }));
    } catch (error) {
      logger.error('Error sending initial vesting state:', error);
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  }

  handleUnsubscribe(ws, payload) {
    const { userAddress } = payload;
    
    if (userAddress) {
      const userClients = this.clients.get(userAddress);
      if (userClients) {
        userClients.delete(ws);
        if (userClients.size === 0) {
          this.clients.delete(userAddress);
        }
      }
      ws.subscriptions.delete(userAddress);
    }

    logger.info(`Client unsubscribed from ${userAddress}`);
  }

  async handleGetVestingState(ws, payload) {
    const { userAddress } = payload;
    
    if (!userAddress) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'userAddress is required' }));
      return;
    }

    try {
      const vestingState = await this.calculateUserVestingState(userAddress);
      ws.send(JSON.stringify({ 
        type: 'VESTING_STATE', 
        data: vestingState 
      }));
    } catch (error) {
      logger.error('Error getting vesting state:', error);
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  }

  startPeriodicUpdates() {
    setInterval(async () => {
      await this.broadcastLiveVestingUpdates();
    }, this.updateIntervalMs);
  }

  async broadcastLiveVestingUpdates() {
    try {
      const userAddresses = Array.from(this.clients.keys());
      
      if (userAddresses.length === 0) {
        return; // No active subscribers
      }

      // Calculate and broadcast vesting updates for each user
      for (const userAddress of userAddresses) {
        const vestingState = await this.calculateUserVestingState(userAddress);
        
        // Broadcast to all clients subscribed to this user
        this.broadcastToUser(userAddress, {
          type: 'LIVE_UPDATE',
          data: vestingState,
          timestamp: new Date().toISOString(),
          ledgerCloseTime: new Date().toISOString()
        });
      }

      console.debug(`Broadcasted vesting updates to ${userAddresses.length} users`);
    } catch (error) {
      logger.error('Error broadcasting vesting updates:', error);
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
            progressPercentage: (vestedAmount / parseFloat(subSchedule.top_up_amount)) * 100
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
          totalVaults: vaults.length
        },
        vaults
      };
    } catch (error) {
      logger.error('Error calculating vesting state:', error);
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

  broadcastToUser(userAddress, message) {
    const userClients = this.clients.get(userAddress);
    if (!userClients || userClients.size === 0) {
      return;
    }

    const messageStr = JSON.stringify(message);
    userClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }

  cleanupClient(ws) {
    // Remove client from all subscriptions
    ws.subscriptions.forEach(userAddress => {
      const userClients = this.clients.get(userAddress);
      if (userClients) {
        userClients.delete(ws);
        if (userClients.size === 0) {
          this.clients.delete(userAddress);
        }
      }
    });
    ws.subscriptions.clear();
  }

  startHeartbeat() {
    const interval = setInterval(() => {
      this.wss.clients.forEach(ws => {
        if (!ws.isAlive) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // Every 30 seconds

    this.wss.on('close', () => {
      clearInterval(interval);
    });
  }
}

module.exports = VestingUpdateWebSocket;
