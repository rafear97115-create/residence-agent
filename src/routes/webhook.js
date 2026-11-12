/*
 * webhook.js — Webhook WhatsApp (vérification Meta et réception des messages)
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { WEBHOOK_VERIFY_TOKEN } = require('../config');
const { verifyMetaSignature } = require('../security');
const { alreadySeen, runSerial } = require('../state');
const { safeEqual } = require('../utils');
const { handleWhatsAppMessage } = require('../whatsapp');



function register(app) {
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && WEBHOOK_VERIFY_TOKEN && token && safeEqual(token, WEBHOOK_VERIFY_TOKEN)) {
    console.log('✅ Webhook WhatsApp vérifié !');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('⛔ Webhook rejeté : signature invalide');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const names = new Map((value.contacts || []).map(c => [String(c.wa_id), c.profile?.name || null]));
        for (const message of value.messages || []) {
          if (alreadySeen(message.id)) continue;
          message._profileName = names.get(String(message.from)) || null;
          await runSerial(String(message.from), () =>
            handleWhatsAppMessage(message).catch(err => console.error('Erreur message WhatsApp:', err.message)));
        }
      }
    }
  } catch (err) {
    console.error('Erreur webhook WhatsApp:', err.message);
  }
});
}

module.exports = {
  register
};
