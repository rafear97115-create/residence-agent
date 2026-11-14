/*
 * messaging.js — Envoi de messages : WhatsApp (libre et modèle), Telegram, alerte propriétaire
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { WHATSAPP_API_VERSION, OWNER_PHONE, WHATSAPP_PHONE_ID, TELEGRAM_CHAT_ID, WHATSAPP_ALERT_TEMPLATE, WHATSAPP_ALERT_TEMPLATE_LANG } = require('./config');
const { rateLimit } = require('./security');
const { fetchT, normalizeWaNumber, scrub } = require('./utils');

function getOwnerNumber() {
  return normalizeWaNumber(OWNER_PHONE);
}

async function sendWhatsAppReply(to, message) {
  try {
    const phoneId = WHATSAPP_PHONE_ID;
    const token = process.env.WHATSAPP_TOKEN;
    const response = await fetchT(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(message).substring(0, 4000) } })
    });
    if (!response.ok) {
      console.error('Erreur WhatsApp:', response.status, await response.text(),
        '| destinataire: longueur', String(to).length, 'fin ...' + String(to).slice(-3));
      return false;
    }
    console.log('✅ WhatsApp envoyé à: ...' + String(to).slice(-3));
    return true;
  } catch (err) {
    console.error('Erreur envoi WhatsApp:', err.message);
    return false;
  }
}

// Modèle WhatsApp : une variable, sans retour à la ligne (règle de Meta), longueur limitée
function flattenForTemplate(text) {
  return String(text || '').replace(/\s*\n+\s*/g, ' | ').replace(/[\t ]{2,}/g, ' ').trim().substring(0, 900);
}

async function sendWhatsAppTemplate(to, name, lang, params) {
  try {
    const response = await fetchT(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: lang }, components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }] }
      })
    });
    if (!response.ok) { console.error('Erreur modèle WhatsApp:', response.status, (await response.text()).substring(0, 300)); return false; }
    console.log('✅ Alerte envoyée par modèle WhatsApp');
    return true;
  } catch (err) {
    console.error('Erreur modèle WhatsApp:', err.message);
    return false;
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const response = await fetchT(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).substring(0, 4000) })
    });
    if (!response.ok) { console.error('Erreur Telegram:', response.status); return false; }
    console.log('✅ Alerte envoyée sur Telegram');
    return true;
  } catch (err) {
    console.error('Erreur Telegram:', err.name, scrub(err.message)); // jamais l'URL : elle contient le jeton du bot
    return false;
  }
}

// Alerte au propriétaire : message libre WhatsApp, sinon modèle approuvé (hors fenêtre 24 h), sinon Telegram
async function sendOwnerAlert(text) {
  const owner = getOwnerNumber();
  if (owner && await sendWhatsAppReply(owner, text)) return true;
  const tpl = WHATSAPP_ALERT_TEMPLATE;
  if (owner && tpl && await sendWhatsAppTemplate(owner, tpl, WHATSAPP_ALERT_TEMPLATE_LANG, [flattenForTemplate(text)])) return true;
  return sendTelegram(text);
}

// Beds24 injoignable : une simple alerte au propriétaire (une par heure au plus), qui passe en manuel. Le bot ne répond pas à la place.
async function alertBeds24Down(context = '') {
  if (!rateLimit('beds24down:alert', 1, 3600 * 1000)) return false;
  console.warn('🚨 Beds24 injoignable :', context || '-');
  return sendOwnerAlert(`⚠️ Beds24 est injoignable${context ? ` (${context})` : ''}. Le bot ne peut plus lire les réservations ni répondre aux messages Airbnb / Booking. `
    + `Passez en manuel : répondez directement dans Airbnb / Booking et vérifiez les arrivées vous-même. Je préviens à nouveau dans une heure si la panne continue, et dès que Beds24 répond.`).catch(() => false);
}

module.exports = {
  alertBeds24Down,
  getOwnerNumber,
  sendWhatsAppReply,
  flattenForTemplate,
  sendWhatsAppTemplate,
  sendTelegram,
  sendOwnerAlert
};
