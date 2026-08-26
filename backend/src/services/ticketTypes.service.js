const logger = require('../utils/logger');
const { TicketType } = require('../models');
const { sequelize } = require('../models');

/**
 * Service for managing ticket types with atomic inventory operations
 * 
 * This service provides thread-safe methods for reserving and releasing tickets
 * to prevent overselling through database-level locking.
 */
class TicketTypesService {
  /**
   * Reserve tickets atomically with database-level locking
   * 
   * This method uses SELECT ... FOR UPDATE to lock the ticket type row,
   * preventing race conditions where multiple concurrent requests could
   * oversell the same tickets.
   * 
   * @param {string} ticketTypeId - ID of the ticket type to reserve from
   * @param {number} quantity - Number of tickets to reserve
   * @param {object} queryRunner - Optional QueryRunner for use in larger transactions
   * @returns {Promise<object>} Reservation result with updated ticket type
   * @throws {BadRequestException} When insufficient tickets are available
   * @throws {NotFoundException} When ticket type doesn't exist
   */
  async reserveTickets(ticketTypeId, quantity, queryRunner = null) {
    if (!ticketTypeId) {
      throw new Error('Ticket type ID is required');
    }
    
    if (!quantity || quantity <= 0) {
      throw new Error('Quantity must be a positive number');
    }

    const useProvidedQueryRunner = queryRunner !== null;
    const queryRunnerToUse = useProvidedQueryRunner ? queryRunner : sequelize;

    try {
      // Start transaction if not using provided query runner
      if (!useProvidedQueryRunner) {
        await queryRunnerToUse.transaction(async (transaction) => {
          return this._performReservation(ticketTypeId, quantity, queryRunnerToUse, transaction);
        });
      } else {
        // Use the provided query runner (assumed to be in a transaction)
        return this._performReservation(ticketTypeId, quantity, queryRunnerToUse, queryRunnerToUse);
      }
    } catch (error) {
      // Re-throw known exceptions
      if (error.name === 'BadRequestException' || error.name === 'NotFoundException') {
        throw error;
      }
      
      // Wrap other errors
      logger.error('Error reserving tickets:', error);
      throw new Error(`Failed to reserve tickets: ${error.message}`);
    }
  }

  /**
   * Internal method to perform the actual reservation
   * @private
   */
  async _performReservation(ticketTypeId, quantity, queryRunner, transaction) {
    // Lock the ticket type row for update to prevent race conditions
    const ticketType = await TicketType.findOne({
      where: { id: ticketTypeId, isActive: true },
      lock: transaction ? { type: transaction.LOCK.UPDATE } : true,
      transaction: transaction || undefined,
    });

    if (!ticketType) {
      const error = new Error('Ticket type not found or inactive');
      error.name = 'NotFoundException';
      throw error;
    }

    // Check if requested quantity is available
    const newSoldQuantity = ticketType.soldQuantity + quantity;
    if (newSoldQuantity > ticketType.totalQuantity) {
      const available = ticketType.totalQuantity - ticketType.soldQuantity;
      const error = new Error(
        `Insufficient tickets available. Requested: ${quantity}, Available: ${available}`
      );
      error.name = 'BadRequestException';
      error.details = {
        requested: quantity,
        available,
        totalQuantity: ticketType.totalQuantity,
        soldQuantity: ticketType.soldQuantity,
      };
      throw error;
    }

    // Update the sold quantity atomically
    await ticketType.update(
      { soldQuantity: newSoldQuantity },
      { 
        transaction: transaction || undefined,
        hooks: false, // Skip hooks to avoid validation conflicts during atomic update
      }
    );

    // Return updated ticket type and reservation info
    return {
      success: true,
      ticketType: ticketType.toJSON(),
      reservation: {
        ticketTypeId,
        quantity,
        remainingAvailable: ticketType.totalQuantity - newSoldQuantity,
        newSoldQuantity,
        timestamp: new Date(),
      },
    };
  }

  /**
   * Release tickets atomically with validation
   * 
   * This method decrements the sold quantity while ensuring
   * it never goes below zero.
   * 
   * @param {string} ticketTypeId - ID of the ticket type to release from
   * @param {number} quantity - Number of tickets to release
   * @param {object} queryRunner - Optional QueryRunner for use in larger transactions
   * @returns {Promise<object>} Release result with updated ticket type
   * @throws {BadRequestException} When trying to release more tickets than sold
   * @throws {NotFoundException} When ticket type doesn't exist
   */
  async releaseTickets(ticketTypeId, quantity, queryRunner = null) {
    if (!ticketTypeId) {
      throw new Error('Ticket type ID is required');
    }
    
    if (!quantity || quantity <= 0) {
      throw new Error('Quantity must be a positive number');
    }

    const useProvidedQueryRunner = queryRunner !== null;
    const queryRunnerToUse = useProvidedQueryRunner ? queryRunner : sequelize;

    try {
      // Start transaction if not using provided query runner
      if (!useProvidedQueryRunner) {
        await queryRunnerToUse.transaction(async (transaction) => {
          return this._performRelease(ticketTypeId, quantity, queryRunnerToUse, transaction);
        });
      } else {
        // Use the provided query runner (assumed to be in a transaction)
        return this._performRelease(ticketTypeId, quantity, queryRunnerToUse, queryRunnerToUse);
      }
    } catch (error) {
      // Re-throw known exceptions
      if (error.name === 'BadRequestException' || error.name === 'NotFoundException') {
        throw error;
      }
      
      // Wrap other errors
      logger.error('Error releasing tickets:', error);
      throw new Error(`Failed to release tickets: ${error.message}`);
    }
  }

  /**
   * Internal method to perform the actual release
   * @private
   */
  async _performRelease(ticketTypeId, quantity, queryRunner, transaction) {
    // Lock the ticket type row for update
    const ticketType = await TicketType.findOne({
      where: { id: ticketTypeId },
      lock: transaction ? { type: transaction.LOCK.UPDATE } : true,
      transaction: transaction || undefined,
    });

    if (!ticketType) {
      const error = new Error('Ticket type not found');
      error.name = 'NotFoundException';
      throw error;
    }

    // Check if we can release the requested quantity
    const newSoldQuantity = ticketType.soldQuantity - quantity;
    if (newSoldQuantity < 0) {
      const error = new Error(
        `Cannot release more tickets than have been sold. Attempted to release: ${quantity}, Sold: ${ticketType.soldQuantity}`
      );
      error.name = 'BadRequestException';
      error.details = {
        requested: quantity,
        soldQuantity: ticketType.soldQuantity,
        maxReleasable: ticketType.soldQuantity,
      };
      throw error;
    }

    // Update the sold quantity atomically
    await ticketType.update(
      { soldQuantity: newSoldQuantity },
      { 
        transaction: transaction || undefined,
        hooks: false, // Skip hooks to avoid validation conflicts during atomic update
      }
    );

    // Return updated ticket type and release info
    return {
      success: true,
      ticketType: ticketType.toJSON(),
      release: {
        ticketTypeId,
        quantity,
        remainingAvailable: ticketType.totalQuantity - newSoldQuantity,
        newSoldQuantity,
        timestamp: new Date(),
      },
    };
  }

  /**
   * Get ticket type by ID with current inventory status
   * @param {string} ticketTypeId - ID of the ticket type
   * @returns {Promise<object>} Ticket type with inventory information
   */
  async getTicketTypeWithInventory(ticketTypeId) {
    const ticketType = await TicketType.findByPk(ticketTypeId);
    
    if (!ticketType) {
      const error = new Error('Ticket type not found');
      error.name = 'NotFoundException';
      throw error;
    }

    const ticketTypeData = ticketType.toJSON();
    
    // Add computed inventory fields
    ticketTypeData.remainingQuantity = ticketType.getRemainingCount();
    ticketTypeData.availabilityPercentage = ticketType.getAvailabilityPercentage();
    ticketTypeData.isAvailable = ticketType.isAvailable(1); // At least 1 ticket available
    
    return ticketTypeData;
  }

  /**
   * Get all ticket types with inventory status
   * @param {object} options - Query options
   * @returns {Promise<Array>} Array of ticket types with inventory information
   */
  async getAllTicketTypesWithInventory(options = {}) {
    const { includeInactive = false, ...queryOptions } = options;
    
    const whereClause = includeInactive ? {} : { isActive: true };
    
    const ticketTypes = await TicketType.findAll({
      where: whereClause,
      order: [['createdAt', 'DESC']],
      ...queryOptions,
    });

    return ticketTypes.map(ticketType => {
      const data = ticketType.toJSON();
      data.remainingQuantity = ticketType.getRemainingCount();
      data.availabilityPercentage = ticketType.getAvailabilityPercentage();
      data.isAvailable = ticketType.isAvailable(1);
      return data;
    });
  }

  /**
   * Create a new ticket type
   * @param {object} ticketTypeData - Ticket type data
   * @returns {Promise<object>} Created ticket type
   */
  async createTicketType(ticketTypeData) {
    const { name, totalQuantity, price, currency = 'USD', ...otherData } = ticketTypeData;

    if (!name) {
      throw new Error('Ticket type name is required');
    }

    if (!totalQuantity || totalQuantity <= 0) {
      throw new Error('Total quantity must be a positive number');
    }

    if (!price || price <= 0) {
      throw new Error('Price must be a positive number');
    }

    // Check for duplicate names
    const existingTicketType = await TicketType.findOne({ where: { name } });
    if (existingTicketType) {
      const error = new Error(`Ticket type with name '${name}' already exists`);
      error.name = 'BadRequestException';
      throw error;
    }

    const ticketType = await TicketType.create({
      name,
      totalQuantity,
      soldQuantity: 0,
      price,
      currency,
      ...otherData,
    });

    return ticketType.toJSON();
  }

  /**
   * Update ticket type inventory (admin operation)
   * @param {string} ticketTypeId - ID of the ticket type
   * @param {object} updateData - Data to update
   * @returns {Promise<object>} Updated ticket type
   */
  async updateTicketTypeInventory(ticketTypeId, updateData) {
    const { totalQuantity } = updateData;

    if (totalQuantity !== undefined && totalQuantity < 0) {
      throw new Error('Total quantity cannot be negative');
    }

    const ticketType = await TicketType.findByPk(ticketTypeId);
    if (!ticketType) {
      const error = new Error('Ticket type not found');
      error.name = 'NotFoundException';
      throw error;
    }

    // If updating total quantity, ensure it's not less than sold quantity
    if (totalQuantity !== undefined && totalQuantity < ticketType.soldQuantity) {
      const error = new Error(
        `Total quantity cannot be less than sold quantity. Total: ${totalQuantity}, Sold: ${ticketType.soldQuantity}`
      );
      error.name = 'BadRequestException';
      throw error;
    }

    await ticketType.update(updateData);
    return ticketType.toJSON();
  }
}

module.exports = new TicketTypesService();
