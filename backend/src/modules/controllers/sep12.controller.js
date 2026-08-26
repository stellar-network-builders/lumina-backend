const logger = require('../utils/logger');
const SEP12Service = require("../services/sep12.service");
const { KycStatus } = require("../../models");
const sep10Auth = require("../../middleware/sep10Auth.middleware");

class SEP12Controller {
  constructor(dbManager) {
    this.sep12Service = new SEP12Service(dbManager);
  }

  async getCustomer(req, res) {
    try {
      const { account, memo, memo_type, type } = req.query;

      // Validate required account parameter
      if (!account) {
        return res.status(400).json({
          error: "Bad Request",
          message: "account parameter is required",
        });
      }

      // Get KYC status from internal database (KycStatus model)
      const kycStatus = await KycStatus.findOne({
        where: { user_address: account },
      });

      if (!kycStatus) {
        // User not found in system
        return res.status(404).json({
          error: "Not Found",
          message: "Customer not found",
        });
      }

      // Map internal status to SEP-12 status
      const statusMapping = {
        VERIFIED: "ACCEPTED",
        PENDING: "PENDING",
        REJECTED: "REJECTED",
        EXPIRED: "REJECTED",
        SOFT_LOCKED: "REJECTED",
        NEEDS_INFO: "NEEDS_INFO",
      };

      const sep12Status = statusMapping[kycStatus.kyc_status] || "PENDING";

      // Return SEP-12 compliant response
      const response = {
        id: kycStatus.id.toString(),
        status: sep12Status,
      };

      // If status is NEEDS_INFO, include required fields
      if (sep12Status === "NEEDS_INFO") {
        response.fields = {
          first_name: {
            description: "First name of the customer",
            type: "string",
          },
          last_name: {
            description: "Last name of the customer",
            type: "string",
          },
          email_address: {
            description: "Email address of the customer",
            type: "string",
          },
          birth_date: {
            description: "Date of birth (YYYY-MM-DD)",
            type: "string",
          },
          tax_id: {
            description: "Tax identification number",
            type: "string",
            optional: true,
          },
          address: {
            description: "Residential address",
            type: "string",
          },
        };
      }

      res.json(response);
    } catch (error) {
      logger.error("Error in getCustomer:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to retrieve customer information",
      });
    }
  }

  async updateCustomer(req, res) {
    try {
      const customerData = req.body;
      const result = await this.sep12Service.updateCustomer(customerData);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: "Failed to update customer",
        message: error.message,
      });
    }
  }

  registerRoutes(app) {
    // SEP-12 standard endpoints with SEP-10 authentication
    app.get("/customer", sep10Auth.authenticate(), this.getCustomer.bind(this));
    app.put(
      "/customer",
      sep10Auth.authenticate(),
      this.updateCustomer.bind(this),
    );

    // Legacy endpoints (keeping for backward compatibility) with SEP-10 authentication
    app.get(
      "/kyc/customer",
      sep10Auth.authenticate(),
      this.getCustomer.bind(this),
    );
    app.put(
      "/kyc/customer",
      sep10Auth.authenticate(),
      this.updateCustomer.bind(this),
    );

    app.get("/kyc/health", (req, res) => {
      res.json({
        status: "healthy",
        module: "SEP-12 KYC",
        timestamp: new Date().toISOString(),
      });
    });
  }
}

module.exports = SEP12Controller;
