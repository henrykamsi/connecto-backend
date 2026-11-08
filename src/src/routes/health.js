const express = require("express");
const { healthCheck } = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  res.json({
    success: true,
    service: "Connecto API",
    version: "v1",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

router.get("/db", async (req, res) => {
  try {
    const result = await healthCheck();

    res.json({
      success: true,
      database: "connected",
      server_time: result.now
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      database: "unavailable",
      error: error.message
    });
  }
});

module.exports = router;
