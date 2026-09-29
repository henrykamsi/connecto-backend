const { query } = require('../db');

const threatPatterns = [
  /\bkill you\b/i,
  /\bi will kill\b/i,
  /\bgoing to kill\b/i,
  /\bshoot you\b/i,
  /\bstab you\b/i,
  /\bblow you up\b/i,
  /\bbeat you to death\b/i,
  /\bhurt you\b/i
];

const scamPatterns = [
  /\bsend me money\b/i,
  /\binvestment opportunity\b/i,
  /\bverification code\b/i,
  /\bsend your otp\b/i,
  /\bgive me your password\b/i,
  /\bcrypto giveaway\b/i,
  /\bdouble your money\b/i
];

function classifyMessage(text='') {
  if (threatPatterns.some(r => r.test(text))) return 'threat';
  if (scamPatterns.some(r => r.test(text))) return 'scam';
  return null;
}

async function moderateMessage({userId,messageId,text}) {
  const category = classifyMessage(text);

  if (!category) {
    return {allowed:true,category:null};
  }

  await query(
    `INSERT INTO moderation_events
     (user_id,message_id,category,action,reason)
     VALUES($1,$2,$3,$4,$5)`,
    [
      userId,
      messageId,
      category,
      'block_message',
      `Automated ${category} detection`
    ]
  );

  return {
    allowed:false,
    category,
    replacement:
      'Message deleted — this message was deleted because it contained threatening content.'
  };
}

module.exports = { classifyMessage, moderateMessage };
