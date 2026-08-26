const logger = require('../utils/logger');
const crypto = require("crypto");

// Use a static key for encryption. In a real environment, this should be an environment variable.
const ALGORITHM = "aes-256-cbc";
const ENCRYPTION_KEY =
  process.env.EMAIL_ENCRYPTION_KEY ||
  crypto
    .createHash("sha256")
    .update("default_secret_key_for_development_must_change")
    .digest(); // Must be 256 bits (32 characters)

/**
 * Encrypts an email address deterministically.
 * This ensures the same email encrypts to the same ciphertext, allowing database queries.
 * @param {string} text - The email address to encrypt
 * @returns {string|null} The encrypted email address, or null if input is null
 */
function encryptEmail(text) {
  if (!text) return text;

  // Create a deterministic IV using a hash of the email address
  // We use the first 16 bytes of the hash as the IV for AES-CBC
  const iv = crypto.createHash("md5").update(text).digest();

  let cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  // Prepend the IV to the encrypted text so we can decrypt it later
  // We store as hex: iv(32 chars) + encrypted_text
  return iv.toString("hex") + ":" + encrypted;
}

/**
 * Decrypts an encrypted email address.
 * @param {string} text - The encrypted email address
 * @returns {string|null} The decrypted email address, or null if input is null
 */
function decryptEmail(text) {
  if (!text) return text;

  try {
    const textParts = text.split(":");

    // If it's not encrypted (doesn't have the IV prefix format), return as is
    // This allows for backward compatibility with existing unencrypted emails
    if (textParts.length !== 2 || textParts[0].length !== 32) {
      return text;
    }

    const iv = Buffer.from(textParts[0], "hex");
    const encryptedText = Buffer.from(textParts[1], "hex");

    let decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString("utf8");
  } catch (error) {
    logger.error("Error decrypting email:", error.message);
    // Return original text if decryption fails (might be unencrypted)
    return text;
  }
}

module.exports = {
  encryptEmail,
  decryptEmail,
};
