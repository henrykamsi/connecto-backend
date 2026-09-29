const crypto = require("crypto");

function requestId(req, res, next) {
  const id = crypto.randomUUID();

  req.requestId = id;
  res.setHeader("X-Request-ID", id);

  next();
}

module.exports = requestId;
