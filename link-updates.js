const fs = require('fs');
let src = fs.readFileSync('server.js', 'utf8');

if (!src.includes('[SHOP-ROUTES]')) {
  const anchor = 'app.use("/control-api", controlRouter);';
  const block = `
/* [SHOP-ROUTES] */
const shopRouter = require('./src/routes/shop');
const analyticsRouter = require('./src/routes/analytics');
app.use('/api/v1/shop', shopRouter);
app.use('/api/v1/analytics', analyticsRouter);

const { startCronJobs } = require('./src/services/cron');
startCronJobs();
`;
  if (src.includes(anchor)) {
    src = src.replace(anchor, anchor + '\n' + block);
    fs.writeFileSync('server.js', src);
    console.log('OK: Routes and Cron linked into server.js');
  } else {
    console.log('Anchor not found!');
  }
} else {
  console.log('Already linked.');
}
