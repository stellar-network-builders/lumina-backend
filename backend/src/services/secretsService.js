const logger = require('../utils/logger');
const vault = require('node-vault');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

class SecretsService {
  constructor() {
    this.vaultClient = null;
    this.secretsManagerClient = null;
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.defaultCacheTTL = 300000; // 5 minutes in milliseconds
    this.initialized = false;
  }

  /**
   * Initialize secrets service with HashiCorp Vault or AWS Secrets Manager
   */
  async initialize() {
    try {
      // Try HashiCorp Vault first
      if (process.env.VAULT_ENABLED === 'true') {
        await this.initializeVault();
        logger.info('HashiCorp Vault initialized successfully');
      } 
      // Fallback to AWS Secrets Manager
      else if (process.env.AWS_SECRETS_MANAGER_ENABLED === 'true') {
        await this.initializeAWSSecretsManager();
        logger.info('AWS Secrets Manager initialized successfully');
      } 
      // Local development fallback with environment variables
      else {
        logger.info('Using environment variables for secrets (development mode)');
      }

      this.initialized = true;
      return true;
    } catch (error) {
      logger.error('Failed to initialize secrets service:', error);
      throw error;
    }
  }

  /**
   * Initialize HashiCorp Vault client
   */
  async initializeVault() {
    const vaultUrl = process.env.VAULT_URL;
    const vaultToken = process.env.VAULT_TOKEN;
    const vaultRole = process.env.VAULT_ROLE;

    if (!vaultUrl) {
      throw new Error('VAULT_URL is required when Vault is enabled');
    }

    // Initialize Vault client
    this.vaultClient = vault({
      apiVersion: 'v1',
      endpoint: vaultUrl,
      token: vaultToken
    });

    try {
      // Test Vault connection
      await this.vaultClient.health();
      logger.info('Vault connection established');

      // If role is specified, try to authenticate with AppRole
      if (vaultRole && !vaultToken) {
        await this.authenticateWithAppRole();
      }

    } catch (error) {
      throw new Error(`Failed to connect to Vault: ${error.message}`);
    }
  }

  /**
   * Authenticate with Vault using AppRole
   */
  async authenticateWithAppRole() {
    const roleId = process.env.VAULT_ROLE_ID;
    const secretId = process.env.VAULT_SECRET_ID;

    if (!roleId || !secretId) {
      throw new Error('VAULT_ROLE_ID and VAULT_SECRET_ID are required for AppRole authentication');
    }

    try {
      const result = await this.vaultClient.auth.approle.login({
        role_id: roleId,
        secret_id: secretId
      });

      this.vaultClient.token = result.auth.client_token;
      logger.info('Vault AppRole authentication successful');
    } catch (error) {
      throw new Error(`Vault AppRole authentication failed: ${error.message}`);
    }
  }

  /**
   * Initialize AWS Secrets Manager client
   */
  async initializeAWSSecretsManager() {
    const region = process.env.AWS_REGION || 'us-east-1';
    
    this.secretsManagerClient = new SecretsManagerClient({
      region: region,
      // Use environment variables for AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
      // Or IAM role if running on EC2/ECS
    });

    try {
      // Test connection by listing secrets (limited)
      const command = new GetSecretValueCommand({ SecretId: 'test-connection' });
      await this.secretsManagerClient.send(command).catch(() => {
        // Expected to fail for test connection, but validates configuration
      });
      logger.info('AWS Secrets Manager connection established');
    } catch (error) {
      throw new Error(`Failed to connect to AWS Secrets Manager: ${error.message}`);
    }
  }

  /**
   * Get secret from Vault or AWS Secrets Manager
   * @param {string} secretPath - Path to secret in Vault or name in AWS Secrets Manager
   * @param {string} key - Specific key within the secret (optional)
   * @returns {Promise<string>} Secret value
   */
  async getSecret(secretPath, key = null) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check cache first
    const cacheKey = `${secretPath}:${key || 'default'}`;
    const cached = this.getCachedSecret(cacheKey);
    if (cached !== null) {
      return cached;
    }

    let secret = null;

    try {
      // Try HashiCorp Vault first
      if (this.vaultClient) {
        secret = await this.getVaultSecret(secretPath, key);
      }
      // Fallback to AWS Secrets Manager
      else if (this.secretsManagerClient) {
        secret = await this.getAWSSecret(secretPath, key);
      }
      // Fallback to environment variables
      else {
        secret = this.getEnvironmentSecret(secretPath);
      }

      // Cache the secret
      this.setCachedSecret(cacheKey, secret);
      return secret;

    } catch (error) {
      logger.error(`Failed to get secret ${secretPath}:`, error);
      
      // Try environment variables as ultimate fallback
      const envSecret = this.getEnvironmentSecret(secretPath);
      if (envSecret) {
        logger.info(`Using environment variable fallback for ${secretPath}`);
        this.setCachedSecret(cacheKey, envSecret);
        return envSecret;
      }

      throw new Error(`Secret not found: ${secretPath}`);
    }
  }

  /**
   * Get secret from HashiCorp Vault
   */
  async getVaultSecret(secretPath, key = null) {
    try {
      const result = await this.vaultClient.read(secretPath);
      
      if (!result || !result.data) {
        throw new Error(`Secret not found at path: ${secretPath}`);
      }

      // Handle different Vault secret engines
      let secretData = result.data;
      
      // For KV v2, the actual data is nested
      if (secretData.data) {
        secretData = secretData.data;
      }

      if (key) {
        if (!secretData[key]) {
          throw new Error(`Key '${key}' not found in secret: ${secretPath}`);
        }
        return secretData[key];
      }

      // Return the entire secret object as JSON string
      return JSON.stringify(secretData);
    } catch (error) {
      throw new Error(`Vault secret retrieval failed: ${error.message}`);
    }
  }

  /**
   * Get secret from AWS Secrets Manager
   */
  async getAWSSecret(secretName, key = null) {
    try {
      const command = new GetSecretValueCommand({ SecretId: secretName });
      const result = await this.secretsManagerClient.send(command);

      if (!result.SecretString) {
        throw new Error(`Secret not found: ${secretName}`);
      }

      let secretData;
      try {
        secretData = JSON.parse(result.SecretString);
      } catch {
        // If it's not JSON, treat it as a plain string
        secretData = { value: result.SecretString };
      }

      if (key) {
        if (!secretData[key]) {
          throw new Error(`Key '${key}' not found in secret: ${secretName}`);
        }
        return secretData[key];
      }

      // Return the entire secret object as JSON string
      return JSON.stringify(secretData);
    } catch (error) {
      throw new Error(`AWS Secrets Manager retrieval failed: ${error.message}`);
    }
  }

  /**
   * Get secret from environment variables
   */
  getEnvironmentSecret(secretName) {
    // Convert secret path to environment variable format
    const envVar = secretName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return process.env[envVar] || null;
  }

  /**
   * Get cached secret if not expired
   */
  getCachedSecret(cacheKey) {
    const cached = this.cache.get(cacheKey);
    const expiry = this.cacheExpiry.get(cacheKey);
    
    if (cached && expiry && Date.now() < expiry) {
      return cached;
    }
    
    // Remove expired cache entry
    this.cache.delete(cacheKey);
    this.cacheExpiry.delete(cacheKey);
    return null;
  }

  /**
   * Set cached secret with expiry
   */
  setCachedSecret(cacheKey, value) {
    this.cache.set(cacheKey, value);
    this.cacheExpiry.set(cacheKey, Date.now() + this.defaultCacheTTL);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  /**
   * Get database credentials dynamically
   */
  async getDatabaseCredentials() {
    return {
      host: await this.getSecret('database/host'),
      port: await this.getSecret('database/port'),
      username: await this.getSecret('database/username'),
      password: await this.getSecret('database/password'),
      database: await this.getSecret('database/name'),
      ssl: process.env.DB_SSL === 'true'
    };
  }

  /**
   * Get Redis credentials dynamically
   */
  async getRedisCredentials() {
    return {
      host: await this.getSecret('redis/host'),
      port: await this.getSecret('redis/port'),
      password: await this.getSecret('redis/password'),
      tls: process.env.REDIS_TLS === 'true'
    };
  }

  /**
   * Get API keys dynamically
   */
  async getAPIKeys() {
    return {
      stellar: await this.getSecret('api/stellar_key'),
      sentry: await this.getSecret('api/sentry_dsn'),
      discord: await this.getSecret('api/discord_token'),
      ses: await this.getSecret('api/ses_key')
    };
  }
}

module.exports = new SecretsService();
