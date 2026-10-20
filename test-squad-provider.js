require('dotenv').config();
const squad = require('./src/providers/squad');

(async () => {
  const creds = await squad.getSquadCreds();
  console.log('Creds loaded from squad.js:');
  console.log('  secretKey prefix:', (creds.secretKey || '').slice(0, 15) || '(EMPTY)');
  console.log('  publicKey prefix:', (creds.publicKey || '').slice(0, 15) || '(EMPTY)');
  console.log('  webhookSecret set:', !!creds.webhookSecret);
  console.log('');

  const ref = 'connecto-test-' + Date.now();
  try {
    const url = await squad.initTransaction({
      email: 'test@connecto.app',
      amountKobo: 10000,
      reference: ref,
      callbackUrl: 'https://connecto.app/payment-return'
    });
    console.log('initTransaction returned:', url);
    if (!url) {
      console.log('BUG: initTransaction returned null/falsy');
    } else {
      console.log('WORKING: initTransaction returned a URL');
    }
  } catch (e) {
    console.log('initTransaction threw:', e.message);
  }
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
