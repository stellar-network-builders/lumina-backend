const { ApolloServer } = require('apollo-server-express');
const { typeDefs } = require('./schema');
const vestingTypeDefs = require('./vestingSchema');
const { vaultResolver } = require('./resolvers/vaultResolver');
const { userResolver } = require('./resolvers/userResolver');
const { proofResolver } = require('./resolvers/proofResolver');
const { anchorResolver } = require('./resolvers/anchorResolver');
const vestingResolvers = require('./vestingResolvers');
const capTableResolvers = require('./capTableResolvers');
const { authMiddleware, vaultAccessMiddleware } = require('./middleware/auth');
const { adaptiveRateLimitMiddleware } = require('./middleware/rateLimit');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { applyMiddleware } = require('graphql-middleware');
const TracingUtils = require('../tracing/tracingUtils');

/**
 * Wrap a resolver with OpenTelemetry tracing.
 * Creates a span per resolver with operationName and fieldName attributes.
 */
function wrapResolverWithTracing(operationName, fieldName, resolverFn) {
  if (typeof resolverFn !== 'function') return resolverFn;
  return async (parent, args, context, info) => {
    return TracingUtils.traceGraphQLResolver(operationName, fieldName, () => {
      return resolverFn(parent, args, context, info);
    }, args);
  };
}

/**
 * Recursively wrap all resolvers in an object with tracing spans.
 */
function wrapResolversWithTracing(resolversObj, operationName) {
  const wrapped = {};
  for (const [key, value] of Object.entries(resolversObj)) {
    if (typeof value === 'function') {
      wrapped[key] = wrapResolverWithTracing(operationName, key, value);
    } else if (typeof value === 'object' && value !== null) {
      wrapped[key] = wrapResolversWithTracing(value, operationName);
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped;
}

const resolvers = {
  Query: {
    ...wrapResolversWithTracing(vaultResolver.Query || {}, 'Query'),
    ...wrapResolversWithTracing(userResolver.Query || {}, 'Query'),
    ...wrapResolversWithTracing(proofResolver.Query || {}, 'Query'),
    ...wrapResolversWithTracing(anchorResolver.Query || {}, 'Query'),
    ...wrapResolversWithTracing(vestingResolvers.Query || {}, 'Query'),
    ...wrapResolversWithTracing(capTableResolvers.Query || {}, 'Query')
  },
  Mutation: {
    ...wrapResolversWithTracing(vaultResolver.Mutation || {}, 'Mutation'),
    ...wrapResolversWithTracing(userResolver.Mutation || {}, 'Mutation'),
    ...wrapResolversWithTracing(proofResolver.Mutation || {}, 'Mutation'),
    ...wrapResolversWithTracing(vestingResolvers.Mutation || {}, 'Mutation'),
    ...wrapResolversWithTracing(capTableResolvers.Mutation || {}, 'Mutation')
  },
  Vault: vaultResolver.Vault,
  Beneficiary: userResolver.Beneficiary,
  VestingSchedule: vestingResolvers.VestingSchedule,
  VestingSummary: vestingResolvers.VestingSummary,
  ClaimHistory: vestingResolvers.ClaimHistory,
  VestingMilestone: vestingResolvers.VestingMilestone,
  VestingStatistics: vestingResolvers.VestingStatistics,
  VestingAnalytics: vestingResolvers.VestingAnalytics,
  BigDecimal: capTableResolvers.BigDecimal
};

const executableSchema = makeExecutableSchema({
  typeDefs: [typeDefs, vestingTypeDefs],
  resolvers
});

const schemaWithMiddleware = applyMiddleware(
  executableSchema,
  adaptiveRateLimitMiddleware,
  vaultAccessMiddleware
);

const createApolloServer = () => {
  return new ApolloServer({
    schema: schemaWithMiddleware,
    context: ({ req, res }) => ({ req, res })
  });
};

module.exports = { createApolloServer };
