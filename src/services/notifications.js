const { query } = require('../db');
const { sendToUser } = require('./fcm');

async function notify({
  userId,
  actorId=null,
  type,
  title,
  body,
  targetType=null,
  targetId=null,
  data={}
}) {
  const { v4: uuidv4 } = require('uuid');
  const result = await query(
    `INSERT INTO notifications
     (id,recipient_id,actor_id,type,title,body,target_type,target_id,data)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      uuidv4(),
      userId,
      actorId,
      type,
      title,
      body,
      targetType,
      targetId,
      data
    ]
  );

  try {
    await sendToUser(userId,{title,body},{
      type,
      target_type:targetType || '',
      target_id:targetId || '',
      ...data
    });
  } catch (err) {
    console.error('[FCM]',err.message);
  }

  return result.rows[0];
}

module.exports = { notify };
