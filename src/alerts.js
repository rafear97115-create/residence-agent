/*
 * alerts.js — Alertes au propriétaire : catégories, balises [[ALERTE:...]], mise en forme, anti-spam
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { TELEGRAM_CHAT_ID } = require('./config');
const { bookingPhone, getPropertyInfo } = require('./beds24');
const { candidateBookings } = require('./identity');
const { getOwnerNumber, sendOwnerAlert } = require('./messaging');
const { describeRoom } = require('./rooms');
const { conversations } = require('./state');
const { normalizeText } = require('./utils');

const ALERT_META = {
  urgence_acces: { icon: '🚨', label: 'URGENT – Accès / voyageur bloqué' },
  urgence_technique: { icon: '🚨', label: 'URGENT – Panne / incident' },
  plainte: { icon: '⚠️', label: 'Plainte (bruit, voisinage…)' },
  contact_humain: { icon: '🙋', label: 'Demande à parler à un humain (Service Relation Client)' },
  demande_horaire: { icon: '⏰', label: 'Arrivée anticipée / départ tardif à confirmer' },
  long_sejour: { icon: '💼', label: 'Long séjour / demande de tarif' },
  tarif_preferentiel: { icon: '🎁', label: 'Tarif préférentiel (ancien voyageur)', hint: 'Circuit : Service Relation Client → validation de la Direction avant toute proposition au voyageur.' },
  voyageur_verifie: { icon: '🔓', label: 'Voyageur vérifié automatiquement – codes accessibles' },
  erreur_ia: { icon: '❗', label: 'Erreur technique – message sans réponse' },
  message_non_texte: { icon: '📎', label: 'Message audio / image / document reçu' }
};

const ALERT_RE = /\[\[\s*ALERTE\s*:\s*([a-z_]+)\s*\]\]/gi;

function fallbackCategory(userText) {
  const t = normalizeText(userText);
  if (/bloqu|(code|digicode|porte|cle|boite).{0,40}(marche pas|fonctionne pas|ne marche|ouvre pas|ouvre plus)|impossible (d'|de )?(entrer|rentrer|ouvrir)/.test(t)) return 'urgence_acces';
  if (/fuite|inond|degat des eaux|panne|plus (d'eau|de chauffage|d'electricite|de courant)|incendie|fumee|court-circuit/.test(t)) return 'urgence_technique';
  if (/\bbruit|tapage|voisin|insupportable/.test(t)) return 'plainte';
  if (/proprietaire|responsable|service (relation )?client|direction|parler a (quelqu'un|un humain|une personne)|un humain/.test(t)) return 'contact_humain';
  return 'aucune';
}

function parseAlert(raw, userText) {
  let category = null;
  const reply = String(raw || '').replace(ALERT_RE, (_, c) => { category = c.toLowerCase(); return ''; })
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!category) category = fallbackCategory(userText);
  if (category !== 'aucune' && !ALERT_META[category]) category = 'aucune';
  // Si le bot annonce qu'il prévient le propriétaire sans balise, on déclenche quand même l'alerte :
  // sinon la promesse faite au voyageur serait fausse.
  if (category === 'aucune') {
    const r = normalizeText(reply);
    if (/proprietaire|service relation client/.test(r) && /(transmets|transmis|previens|prevenu|alerte)/.test(r)) category = 'contact_humain';
  }
  return { reply, category };
}

// Dernière conversation signalée au propriétaire : numéro WhatsApp, ou "b<id>" pour une réservation Beds24 (pour /pause sans argument)
const ownerCtx = { lastNotified: null };

// Alertes : un message complet la première fois, puis seulement une ligne de suite pendant 10 minutes (pas de spam)
const alertCooldown = new Map();
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// "2026-11-09" -> "9/11/2026"
function fmtDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : String(d || '?');
}

function platformLabelFor(channel) {
  const c = String(channel || '').toLowerCase();
  if (c.includes('airbnb')) return 'Airbnb';
  if (c.includes('booking')) return 'Booking';
  if (c.includes('direct')) return 'Site (direct)';
  if (c.includes('whatsapp')) return 'WhatsApp';
  if (c.includes('chat')) return 'Chat web';
  return 'Beds24';
}

function formatOwnerAlert({ channel, contact, question, reply, category = 'aucune', booking = null, bookingId = null, profileName = null, locked = false, note = null }, propInfo) {
  const meta = ALERT_META[category];
  const isWa = channel === 'WhatsApp';
  const digits = String(contact).replace(/\D/g, '');
  const resId = (booking && booking.id) || bookingId || null;
  const plat = platformLabelFor(channel);
  const shortRef = isWa ? (resId ? `WhatsApp (${resId})` : `WhatsApp (+${digits})`) : (resId ? `${plat} (${resId})` : plat);

  const headRef = (isWa && !resId) ? 'WhatsApp' : shortRef; // le numéro WhatsApp a sa propre ligne
  let text = `${meta ? `${meta.icon} ${meta.label}` : '📱 Message'}\nPlate-forme${resId ? ' (réservation)' : ''} : ${headRef}`;
  if (isWa) text += `\nTéléphone : +${digits}`;
  if (channel === 'Chat web') text += `\nVisiteur : ${contact} (chat du site : aucun moyen de lui répondre depuis ce chat)`;
  if (booking) {
    const nm = `${booking.firstName || ''} ${booking.lastName || ''}`.trim();
    text += `\nVoyageur : ${nm || 'inconnu'}`;
    text += `\nLogement : ${describeRoom(booking.roomId, propInfo)}`;
    text += `\nSéjour : ${fmtDate(booking.arrival)} au ${fmtDate(booking.departure)}`;
    const bookingTel = bookingPhone(booking);
    if (bookingTel && !isWa) text += `\nTéléphone (Beds24) : +${bookingTel}`;
  } else {
    text += `\nVoyageur : non vérifié${profileName ? ` (profil WhatsApp : ${profileName})` : ''}`;
  }
  if (locked) text += '\n🔒 Vérification automatique bloquée (trop de tentatives)';
  if (meta && meta.hint) text += `\n${meta.hint}`;
  if (note) text += `\n${note}`;
  text += `\n\nMessage : ${String(question).substring(0, 800)}\n\nRéponse envoyée : ${String(reply).substring(0, 1200)}`;
  return { shortRef, text };
}

async function notifyOwner({ channel, contact, question, reply, category = 'aucune', booking = null, bookingId = null, profileName = null, locked = false, note = null }) {
  try {
    const meta = ALERT_META[category];
    if (!meta && process.env.NOTIFY_ALL !== 'true') return true;
    const owner = getOwnerNumber();
    if (!owner && !TELEGRAM_CHAT_ID) { console.warn('⚠️ OWNER_PHONE non défini : alerte non envoyée'); return false; }
    const contactDigits = String(contact).replace(/\D/g, '');
    if (channel === 'WhatsApp' && owner === contactDigits) return true; // inutile de se notifier soi-même

    if (channel === 'WhatsApp') ownerCtx.lastNotified = contactDigits;
    else if (String(channel).startsWith('Beds24') && bookingId) ownerCtx.lastNotified = `b${bookingId}`;

    const propInfo = await getPropertyInfo();
    const fmt = formatOwnerAlert({ channel, contact, question, reply, category, booking, bookingId, profileName, locked, note }, propInfo);

    const cdKey = `${channel}|${contact}|${category}`;
    if (meta && Date.now() - (alertCooldown.get(cdKey) || 0) < ALERT_COOLDOWN_MS) {
      if (channel === 'Chat web') return true; // visiteurs anonymes : une seule alerte complète par période, pas de lignes de suite
      const line = `↪️ Suite – ${fmt.shortRef} : « ${String(question).substring(0, 300)} »${booking ? '' : ' (non vérifié)'}`;
      return await sendOwnerAlert(line);
    }

    let msg = fmt.text;

    if (channel === 'WhatsApp') {
      // Aide à la validation manuelle d'un voyageur bloqué dehors
      if (!booking && (category === 'urgence_acces' || category === 'contact_humain')) {
        const conv = conversations.get(contactDigits);
        const heard = [conv?.identityText || '', question].join(' ');
        const cands = await candidateBookings(heard);
        if (cands.length) {
          const propInfo = await getPropertyInfo();
          const lines = cands.map(b => {
            const room = propInfo?.rooms?.find(r => String(r.id) === String(b.roomId))?.name || b.roomId;
            return `- ${b.firstName || ''} ${b.lastName || ''}, logement ${room}, du ${b.arrival} au ${b.departure}\n  /valider b${b.id} ${contactDigits}`;
          });
          msg += `\n\nRéservations possibles (envoyez la commande pour confirmer ce voyageur) :\n${lines.join('\n')}`;
        } else {
          msg += '\n\nAucune réservation active ne correspond. Si vous reconnaissez le voyageur : /valider bIDRÉSERVATION ' + contactDigits;
        }
      }
      msg += `\n\nPour répondre vous-même au voyageur : /repondre ${contactDigits} votre message`;
      msg += `\nPour couper le bot sur cette conversation : /pause ${contactDigits}`;
    } else if (String(channel).startsWith('Beds24') && bookingId) {
      msg += `\n\nPour répondre vous-même au voyageur : /repondre b${bookingId} votre message`;
      msg += `\nPour couper le bot sur cette réservation : /pause b${bookingId}`;
    }

    const ok = await sendOwnerAlert(msg.substring(0, 4000));
    if (ok && meta) alertCooldown.set(cdKey, Date.now());
    return ok;
  } catch (err) {
    console.error('Erreur notifyOwner:', err.message);
    return false;
  }
}

module.exports = {
  ALERT_META,
  ALERT_RE,
  fallbackCategory,
  parseAlert,
  ownerCtx,
  alertCooldown,
  ALERT_COOLDOWN_MS,
  fmtDate,
  platformLabelFor,
  formatOwnerAlert,
  notifyOwner
};
