const crypto = require('crypto');

function hashSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashSecret, randomSecret };
