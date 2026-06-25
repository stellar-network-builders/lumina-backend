const { sequelize } = require("../database/connection");

const ClaimsHistory = require("./claimsHistory");
const Vault = require("./vault");
const SubSchedule = require("./subSchedule");
const TVL = require("./tvl");
const Beneficiary = require("./beneficiary");
const Organization = require("./organization");
const Notification = require("./notification");
const RefreshToken = require("./refreshToken");
const RevocationProposal = require("./revocationProposal");
const RevocationSignature = require("./revocationSignature");
const MultiSigConfig = require("./multiSigConfig");
const DividendRound = require("./dividendRound");
const DividendDistribution = require("./dividendDistribution");
const DividendSnapshot = require("./dividendSnapshot");
const DeviceToken = require("./deviceToken");
const VaultLegalDocument = require("./vaultLegalDocument");
const VaultLiquidityAlert = require("./vaultLiquidityAlert");
const AnnualVestingStatement = require("./annualVestingStatement");
const VestingMilestone = require("./vestingMilestone");
const HistoricalTokenPrice = require("./historicalTokenPrice");
const HistoricalTVL = require("./historicalTVL");
const CostBasisReport = require("./costBasisReport");
const AuditorToken = require("./auditorToken");
const VaultRegistry = require("./vaultRegistry");
const Rule144Compliance = require("./rule144Compliance");
const TaxCalculation = require("./taxCalculation");
const TaxJurisdiction = require("./taxJurisdiction");
const KycStatus = require("./kycStatus");
const KycNotification = require("./kycNotification");
const ContractUpgradeProposal = require("./contractUpgradeProposal");
const CertifiedBuild = require("./certifiedBuild");
const ConversionEvent = require("./conversionEvent");
const MilestoneCelebrationWebhook = require("./milestoneCelebrationWebhook");
const GrantStream = require("./grantStream");
const FutureLien = require("./futureLien");
const LienRelease = require("./lienRelease");
const LienMilestone = require("./lienMilestone");
const DAOProposal = require("./daoProposal");
const DAOVote = require("./daoVote");
const ContractUpgradeSignature = require("./contractUpgradeSignature");
const ContractUpgradeAuditLog = require("./contractUpgradeAuditLog");
const VaultBalanceMonitorState = require("./vaultBalanceMonitorState");
const TicketType = require("./TicketType");
const SorobanEvent = require("./sorobanEvent");
const AdminAuditLog = require("./adminAuditLog");
const GrantPriceSnapshot = require("./grantPriceSnapshot");
const RoiCalculation = require("./roiCalculation");
const ClaimWebhookDelivery = require("./claimWebhookDelivery");
const VestingStateReconciliation = require("./vestingStateReconciliation");

const IdempotencyKey = require("./idempotencyKey");
const { Token, initTokenModel } = require("./token");
const {
  OrganizationWebhook,
  initOrganizationWebhookModel,
} = require("./organizationWebhook");

initTokenModel(sequelize);
initOrganizationWebhookModel(sequelize);

// Initialize TicketType model (it seems to be a function in this codebase)
const TicketTypeModel = typeof TicketType === 'function' ? TicketType(sequelize) : TicketType;

const models = {
  ClaimsHistory,
  Vault,
  SubSchedule,
  TVL,
  Beneficiary,
  Organization,
  Notification,
  RefreshToken,
  DeviceToken,
  VaultLegalDocument,
  VaultLiquidityAlert,
  Rule144Compliance,
  TaxCalculation,
  TaxJurisdiction,
  KycStatus,
  KycNotification,
  RevocationProposal,
  RevocationSignature,
  MultiSigConfig,
  DividendRound,
  DividendDistribution,
  DividendSnapshot,
  Token,
  OrganizationWebhook,
  VestingMilestone,
  HistoricalTokenPrice,
  HistoricalTVL,
  CostBasisReport,
  AuditorToken,
  AnnualVestingStatement,
  ClaimWebhookDelivery,
  VaultRegistry,
  ContractUpgradeProposal,
  ContractUpgradeSignature,
  ContractUpgradeAuditLog,
  VaultBalanceMonitorState,
  CertifiedBuild,
  ConversionEvent,
  MilestoneCelebrationWebhook,
  GrantStream,
  FutureLien,
  LienRelease,
  LienMilestone,
  DAOProposal,
  DAOVote,
  TicketType: TicketTypeModel,
  SorobanEvent,
  AdminAuditLog,
  GrantPriceSnapshot,
  RoiCalculation,
  VestingStateReconciliation,
  IdempotencyKey,
  sequelize,
};

// Setup associations
Object.keys(models).forEach((modelName) => {
  if (models[modelName] && models[modelName].associate) {
    models[modelName].associate(models);
  }
});

module.exports = models;
