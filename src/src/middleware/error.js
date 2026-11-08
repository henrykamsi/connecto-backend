function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    path: req.originalUrl,
    request_id: req.requestId
  });
}

function errorHandler(err, req, res, next) {
  console.error("[ERROR]", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    error: err.code || "SERVER_ERROR",
    message:
      process.env.NODE_ENV === "production"
        ? "An unexpected server error occurred."
        : err.message,
    request_id: req.requestId
  });
}

module.exports = {
  notFound,
  errorHandler
};
