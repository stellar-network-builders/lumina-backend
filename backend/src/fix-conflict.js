const fs = require('fs');
const logger = require('./utils/logger');
let content = fs.readFileSync('index.js', 'utf8');
const conflict = `const pdfService = require('./services/pdfService');
<<<<<<< feat/rwa-legal-document-hashing-service
const legalDocumentHashingService = require('./services/legalDocumentHashingService');
=======
const ledgerSyncService = require('./services/ledgerSyncService');
const multiSigRevocationService = require('./services/multiSigRevocationService');
const dividendService = require('./services/dividendService');
>>>>>>> main
const VaultService = require('./services/vaultService');`;

const resolved = `const pdfService = require('./services/pdfService');
const legalDocumentHashingService = require('./services/legalDocumentHashingService');
const ledgerSyncService = require('./services/ledgerSyncService');
const multiSigRevocationService = require('./services/multiSigRevocationService');
const dividendService = require('./services/dividendService');
const VaultService = require('./services/vaultService');`;

if (!content.includes(conflict)) {
  logger.info('Conflict pattern not found');
  process.exit(1);
}

content = content.replace(conflict, resolved);
fs.writeFileSync('index.js', content, 'utf8');
logger.info('Resolved merge conflict in index.js');
