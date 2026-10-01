require("dotenv").config();
const router = require("./control-server.js");

const routes = router.stack
  .filter(l => l.route)
  .map(l => {
    const m = Object.keys(l.route.methods).join(",").toUpperCase();
    return m + " " + l.route.path;
  });

module.exports = (app) => {
  app.get("/__debug/routes", (req, res) => {
    res.json({ count: routes.length, routes });
  });
};
