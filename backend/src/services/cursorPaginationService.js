const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * Cursor-based pagination service for efficient pagination of large datasets
 * Replaces offset-based pagination which gets exponentially slower with large datasets
 */

/**
 * Encode cursor data into a base64 string
 * @param {Object} cursorData - Data to encode in cursor
 * @returns {string} - Base64 encoded cursor
 */
function encodeCursor(cursorData) {
  const cursorString = JSON.stringify(cursorData);
  return Buffer.from(cursorString).toString('base64url');
}

/**
 * Decode cursor data from base64 string
 * @param {string} cursor - Base64 encoded cursor
 * @returns {Object|null} - Decoded cursor data or null if invalid
 */
function decodeCursor(cursor) {
  try {
    if (!cursor) return null;
    const cursorString = Buffer.from(cursor, 'base64url').toString('utf8');
    return JSON.parse(cursorString);
  } catch (error) {
    logger.error('Invalid cursor format:', error);
    return null;
  }
}

/**
 * Build cursor-based query for Sequelize
 * @param {Object} options - Query options
 * @param {Object} options.cursor - Decoded cursor data
 * @param {string} options.orderField - Field to order by (must be unique or combined with other fields)
 * @param {string} options.orderDirection - 'ASC' or 'DESC'
 * @param {number} options.limit - Number of results per page
 * @param {Object} options.where - Additional where conditions
 * @returns {Object} - Sequelize query object
 */
function buildCursorQuery({ cursor, orderField, orderDirection = 'DESC', limit = 50, where = {} }) {
  const query = {
    where: { ...where },
    order: [[orderField, orderDirection]],
    limit: limit + 1, // Fetch one extra to determine if there are more results
  };

  // Add cursor condition if cursor is provided
  if (cursor && cursor[orderField]) {
    const operator = orderDirection === 'DESC' ? '<' : '>';
    query.where[orderField] = {
      [operator]: cursor[orderField]
    };
  }

  return query;
}

/**
 * Process cursor-based query results
 * @param {Array} results - Query results (includes one extra item)
 * @param {Object} options - Processing options
 * @param {string} options.orderField - Field used for ordering
 * @param {number} options.limit - Original limit
 * @returns {Object} - Processed results with pagination metadata
 */
function processCursorResults(results, { orderField, limit }) {
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, -1) : results;

  // Build next cursor if there are more results
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeCursor({ [orderField]: lastItem[orderField] });
  }

  return {
    items,
    pagination: {
      has_more: hasMore,
      next_cursor: nextCursor,
      limit: limit
    }
  };
}

/**
 * Apply cursor-based pagination to a Sequelize model
 * @param {Object} model - Sequelize model
 * @param {Object} options - Pagination options
 * @returns {Object} - Paginated results
 */
async function paginateWithCursor(model, options) {
  const {
    cursor,
    orderField,
    orderDirection = 'DESC',
    limit = 50,
    where = {},
    include = [],
    attributes = null
  } = options;

  const query = buildCursorQuery({
    cursor,
    orderField,
    orderDirection,
    limit,
    where
  });

  if (include.length > 0) {
    query.include = include;
  }

  if (attributes) {
    query.attributes = attributes;
  }

  const results = await model.findAll(query);

  return processCursorResults(results, { orderField, limit });
}

/**
 * Apply cursor-based pagination with count (for total count)
 * @param {Object} model - Sequelize model
 * @param {Object} options - Pagination options
 * @returns {Object} - Paginated results with total count
 */
async function paginateWithCursorAndCount(model, options) {
  const {
    cursor,
    orderField,
    orderDirection = 'DESC',
    limit = 50,
    where = {},
    include = [],
    attributes = null
  } = options;

  // Get total count
  const totalCount = await model.count({ where });

  // Get paginated results
  const paginatedResults = await paginateWithCursor(model, {
    cursor,
    orderField,
    orderDirection,
    limit,
    where,
    include,
    attributes
  });

  return {
    ...paginatedResults,
    pagination: {
      ...paginatedResults.pagination,
      total: totalCount
    }
  };
}

/**
 * Validate cursor parameters
 * @param {Object} req - Express request object
 * @param {string} orderField - Expected order field
 * @returns {Object} - Validated cursor and options
 */
function validateCursorParams(req, orderField) {
  const { cursor, limit = 50 } = req.query;

  // Decode cursor
  const decodedCursor = decodeCursor(cursor);

  // Validate limit
  const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 1000); // Between 1 and 1000

  return {
    cursor: decodedCursor,
    limit: parsedLimit,
    orderField
  };
}

module.exports = {
  encodeCursor,
  decodeCursor,
  buildCursorQuery,
  processCursorResults,
  paginateWithCursor,
  paginateWithCursorAndCount,
  validateCursorParams
};
