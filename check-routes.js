require("dotenv").config();

const express = require("express");
const path = require("path");

// Load control-server.js as a module and inspect its routes
const router = require("./control-server.js");

const routes = router.stack
  .filter(layer => layer.route)
  .map(layer => {
    const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
    return methods + " " + layer.route.path;
  });

console.log("Total routes in control-server.js:", routes.length);
console.log("");
console.log("Routes containing 'organizations':");
routes.filter(r => r.includes("organizations")).forEach(r => console.log("  " + r));
console.log("");
console.log("Routes containing 'verify':");
routes.filter(r => r.includes("verify")).forEach(r => console.log("  " + r));
console.log("");
console.log("Routes containing 'display-numbers':");
routes.filter(r => r.includes("display")).forEach(r => console.log("  " + r));

process.exit(0);
