/*
 * owner-commands.js — Commandes du propriétaire par WhatsApp (/aide, /statut, /repondre, /pause, /valider...)
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { ownerCtx } = require('./alerts');
const { bookingPhone, detectPlatform, getBeds24Token, getBookingById, getPropertyInfo, getStays, sendBeds24Message } = require('./beds24');
const { AGENT_START_TIME, OWNER_REPLY_SIGNATURE, OWNER_TEST_MODE, PAUSE_HOURS, PENDING_ACK, PENDING_WATCH, REQUIRE_EMAIL, STAY_VERIFICATION } = require('./config');
const { getOwnerNumber, sendWhatsAppReply } = require('./messaging');
const { describeRoom } = require('./rooms');
const { conversations, ensureConv, isLocked, isPaused, markDirty, pauseConversation, pauses, resumeConversation, runSerial } = require('./state');
const { normalizeText, normalizeWaNumber, parisToday } = require('./utils');

function pauseLabel(key) {
  return String(key).startsWith('b') ? `la réservation ${String(key).slice(1)}` : `+${key}`;
}

// ----- Commandes propriétaire : aide, statut, réponse -----

function ownerHelpText() {
  return [
    "📖 *COMMANDES DE L'ASSISTANT*",
    "_À envoyer depuis votre numéro._",
    "",
    "*Cible* = un numéro WhatsApp (ex. 33612345678) ou une réservation Airbnb/Booking (ex. b95878640). Sans cible, /pause et /reprise visent la dernière conversation qui vous a été signalée ; /repondre exige toujours un destinataire.",
    "",
    "💬 *RÉPONDRE À UN VOYAGEUR*",
    "*/repondre cible votre message*",
    "→ Envoie VOTRE message au voyageur, en cas de réelle nécessité (le bot ne rédige rien). WhatsApp : possible si le voyageur a écrit dans les dernières 24 h. Airbnb/Booking : envoyé comme message de l'hôte. Le chat du site n'est pas joignable : le visiteur est invité à vous écrire sur WhatsApp.",
    "Ex : /repondre b95878640 Bonjour, votre demande est acceptée.",
    "",
    "⏸️ *REPRENDRE LA MAIN*",
    "*/pause [cible] [heures]*",
    `→ Le bot se tait sur cette conversation (par défaut ${PAUSE_HOURS} h).`,
    "Ex : /pause 33612345678 3",
    "*/reprise [cible]*",
    "→ Le bot reprend tout de suite.",
    "",
    "🔓 *IDENTITÉ DES VOYAGEURS (WhatsApp)*",
    "*/valider bRÉSERVATION [numéro]*",
    "→ Confirme à la main l'identité d'un voyageur : le bot lui envoie ses informations d'accès.",
    "Ex : /valider b95878640 33612345678",
    "*/debloquer [numéro]*",
    "→ Lève le blocage d'un numéro après trop de tentatives d'identification ratées.",
    "",
    "📊 *SUIVI*",
    "*/sejour [jours]*",
    "→ Les séjours en cours et à venir (30 jours par défaut, 365 au maximum) : logement, voyageur, plateforme, dates, numéro de réservation.",
    "Ex : /sejour 60",
    "*/statut*",
    "→ État du bot : conversations en pause, numéros bloqués, voyageurs reconnus, réglages actifs.",
    "*/aide*",
    "→ Affiche ce message."
  ].join('\n');
}

function fmtParisShort(ts) {
  return new Date(ts).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtUptime(ms) {
  const min = Math.max(Math.floor(ms / 60000), 0);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}

function ownerStatusText() {
  const cap = (arr, fn, max = 10) => arr.slice(0, max).map(fn).concat(arr.length > max ? [`… et ${arr.length - max} autre(s)`] : []);
  const paused = [...pauses.entries()].filter(([n]) => isPaused(n));
  const locked = [...conversations.entries()].filter(([, c]) => isLocked(c));
  const verified = [...conversations.entries()].filter(([, c]) => c.verifiedBookingId);
  const onOff = v => (v ? 'activé' : 'désactivé');

  const out = [
    "📊 *STATUT DE L'ASSISTANT*",
    '',
    `🟢 *Bot en ligne* depuis le ${fmtParisShort(AGENT_START_TIME)} (${fmtUptime(Date.now() - AGENT_START_TIME.getTime())})`,
    '_Il répond seul aux voyageurs : WhatsApp, Airbnb, Booking et chat du site._',
    '',
    `⏸️ *Conversations en pause : ${paused.length}*`,
    '_Sur ces conversations le bot se tait : vous avez la main._'
  ];
  if (paused.length) out.push(...cap(paused, ([n, until]) => `- ${pauseLabel(n)}, jusqu'au ${fmtParisShort(until)} → /reprise ${n}`));
  else out.push('Aucune : le bot répond partout.');

  out.push('', `🔒 *Numéros bloqués : ${locked.length}*`, "_Trop de tentatives d'identification ratées : le bot ne donne plus de codes à ces numéros._");
  if (locked.length) out.push(...cap(locked, ([n]) => `- +${n} → /debloquer ${n}`));
  else out.push('Aucun.');

  out.push('', `✅ *Voyageurs WhatsApp reconnus : ${verified.length}*`, '_Identité confirmée (automatiquement ou par /valider) : ils ont accès aux codes pendant leur séjour._');

  out.push('', '🔔 *Dernière conversation signalée*', '_C\'est la cible par défaut de /pause et /reprise quand vous n\'indiquez pas de numéro._');
  out.push(ownerCtx.lastNotified ? `${pauseLabel(ownerCtx.lastNotified)} → /repondre ${ownerCtx.lastNotified} votre message` : 'Aucune depuis le démarrage.');

  out.push('', '⚙️ *Réglages actifs*',
    `- Durée de pause par défaut : ${PAUSE_HOURS} h`,
    `- Vérification du séjour (nom + dates + logement) : ${onOff(STAY_VERIFICATION)}`,
    `- Email exigé si la réservation en contient un vrai : ${REQUIRE_EMAIL ? 'oui' : 'non'}`,
    `- Surveillance des demandes en attente : ${onOff(PENDING_WATCH)}`,
    `- Accusé de réception automatique des demandes : ${onOff(PENDING_ACK)}`,
    `- Mode test propriétaire : ${onOff(OWNER_TEST_MODE)}`,
    '',
    '_Envoyez /aide pour la liste des commandes._');
  return out.join('\n');
}

// ----- /sejour : séjours en cours et à venir -----

const SEJOUR_DEFAULT_DAYS = 30;
const SEJOUR_MAX_DAYS = 365;

function dayDiff(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function fmtDM(d) {
  const m = String(d || '').match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : '?';
}
function plural(n, w) { return `${n} ${w}${n > 1 ? 's' : ''}`; }

function stayLine(b, propInfo, today) {
  const a = String(b.arrival || '').slice(0, 10);
  const d = String(b.departure || '').slice(0, 10);
  const nights = dayDiff(a, d);
  const nm = `${b.firstName || ''} ${b.lastName || ''}`.trim() || 'voyageur inconnu';
  const origin = { airbnb: 'Airbnb', booking: 'Booking', direct: 'Site' }[detectPlatform(b)] || 'Origine ?';
  let when;
  if (a <= today) {
    const left = dayDiff(today, d);
    when = left <= 0 ? "part aujourd'hui" : left === 1 ? 'part demain' : `part dans ${left} j`;
    if (a === today) when = "arrive aujourd'hui, " + when;
  } else {
    const wait = dayDiff(today, a);
    when = wait === 1 ? 'arrive demain' : `arrive dans ${wait} j`;
  }
  const phone = bookingPhone(b);
  return `- *${describeRoom(b.roomId, propInfo)}* · ${nm} · ${origin}\n  ${fmtDM(a)} → ${fmtDM(d)}${nights > 0 ? ` (${plural(nights, 'nuit')})` : ''} · ${when}\n  b${b.id}${phone ? ` · +${phone}` : ''}`;
}

async function ownerStaysText(days = SEJOUR_DEFAULT_DAYS) {
  const stays = await getStays(days);
  if (!stays) return '❌ Impossible de lire les réservations dans Beds24 pour le moment. Réessayez dans quelques minutes.';
  const today = parisToday();
  const propInfo = await getPropertyInfo();
  const current = stays.filter(b => String(b.arrival).slice(0, 10) <= today);
  const upcoming = stays.filter(b => String(b.arrival).slice(0, 10) > today);

  const out = ['🏠 *SÉJOURS*', ''];
  let size = out.join('\n').length;
  const MAX = 3600; // WhatsApp coupe à 4000 caractères
  const section = (title, list, empty) => {
    out.push(`*${title} : ${list.length}*`);
    if (!list.length) { out.push(empty); out.push(''); return; }
    let shown = 0;
    for (const b of list) {
      const line = stayLine(b, propInfo, today);
      if (size + line.length > MAX) break;
      out.push(line); size += line.length + 1; shown++;
    }
    if (shown < list.length) out.push(`… et ${list.length - shown} autre(s) : réduisez la période (ex. /sejour 14)`);
    out.push('');
  };
  section('En cours', current, 'Aucun séjour en cours.');
  section(`À venir (${days} prochains jours)`, upcoming, 'Aucune arrivée prévue sur cette période.');
  out.push('_/sejour 60 pour regarder plus loin (365 jours maximum). Écrire à un voyageur : /repondre bNUMÉRO votre message._');
  return out.join('\n');
}

// Garde la trace du message envoyé à la main, pour que le bot ne le contredise pas dans la suite de la conversation WhatsApp
function addOwnerReplyToHistory(phone, text) {
  const conv = conversations.get(phone);
  if (!conv || !conv.messages.length) return;
  const note = `[Message envoyé par le Service Relation Client] ${text}`.substring(0, 1500);
  const last = conv.messages[conv.messages.length - 1];
  if (last.role === 'assistant') last.content = `${last.content}\n\n${note}`;
  else conv.messages.push({ role: 'assistant', content: note });
  conv.updated = Date.now();
}

async function handleOwnerCommand(text) {
  const owner = getOwnerNumber();
  const say = m => sendWhatsAppReply(owner, m);
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = normalizeText(cmdRaw); // "/Répondre" = "/repondre"
  const bArg = args.find(a => /^b\d{4,}$/i.test(a));
  const numArg = args.find(a => a !== bArg && a.replace(/\D/g, '').length >= 9);
  const target = bArg ? bArg.toLowerCase() : (numArg ? normalizeWaNumber(numArg) : ownerCtx.lastNotified);
  const hoursArg = args.find(a => a !== numArg && a !== bArg && /^\d{1,3}h?$/i.test(a));
  const hours = hoursArg ? parseInt(hoursArg, 10) : PAUSE_HOURS;

  if (cmd === '/repondre') {
    // Format : /repondre [numéro|bIDRÉSERVATION] message (sans cible : dernière conversation signalée)
    const rest = text.trim().slice(cmdRaw.length).trim();
    const first = rest.split(/\s+/)[0] || '';
    let tgt = null; // aucun destinataire par défaut : un message libre ne doit jamais partir vers la mauvaise conversation
    let body = rest;
    if (/^b\d{4,}$/i.test(first)) { tgt = first.toLowerCase(); body = rest.slice(first.length).trim(); }
    else if (/^\+?\d{9,15}$/.test(first)) { tgt = normalizeWaNumber(first); body = rest.slice(first.length).trim(); }
    if (!body) return say('Usage : /repondre [numéro ou bIDRÉSERVATION] votre message\nExemple : /repondre b95878640 Bonjour, ...\nLe destinataire est obligatoire.');
    if (!tgt) return say("Précisez le destinataire (il n'y a plus de destinataire par défaut).\nExemple : /repondre 33612345678 votre message  ou  /repondre b95878640 votre message" + (ownerCtx.lastNotified ? `\nDernière conversation signalée : ${pauseLabel(ownerCtx.lastNotified)} -> /repondre ${ownerCtx.lastNotified} votre message` : ""));
    if (body.length > 3500) return say(`Message trop long (${body.length} caractères, maximum 3500). Raccourcissez-le.`);
    const finalText = OWNER_REPLY_SIGNATURE ? `${body}\n\n${OWNER_REPLY_SIGNATURE}` : body;
    const preview = body.length > 200 ? `${body.slice(0, 200)}…` : body;

    if (tgt.startsWith('b')) {
      const bookingId = tgt.slice(1);
      const token = await getBeds24Token();
      const ok = token ? await sendBeds24Message(token, bookingId, finalText) : false;
      if (!ok) return say(`❌ Message NON envoyé à la réservation ${bookingId} (Beds24 indisponible ou refus). Répondez directement dans Airbnb / Booking.`);
      return say(`✅ Message envoyé sur la réservation ${bookingId} (Airbnb / Booking) :\n« ${preview} »\n\nLe bot reste actif sur ce fil. Pour le couper : /pause ${tgt}`);
    }
    const ok = await sendWhatsAppReply(tgt, finalText);
    if (!ok) return say(`❌ Message NON envoyé à +${tgt}.\nWhatsApp n'autorise un message libre que si le voyageur a écrit dans les dernières 24 h. Sinon, joignez-le directement (appel ou plateforme).`);
    addOwnerReplyToHistory(tgt, body);
    return say(`✅ Message envoyé à +${tgt} :\n« ${preview} »\n\nLe bot reste actif sur cette conversation. Pour le couper : /pause ${tgt}`);
  }
  if (cmd === '/pause') {
    if (!target) return say('Précisez le numéro : /pause 336XXXXXXXX [heures] (ou /pause b95878640 pour une réservation Airbnb/Booking)');
    pauseConversation(target, hours);
    return say(`⏸️ Bot en pause pour ${pauseLabel(target)} pendant ${hours} h.\nPour reprendre : /reprise ${target}`);
  }
  if (cmd === '/reprise') {
    if (!target) return say('Précisez le numéro : /reprise 336XXXXXXXX (ou /reprise b95878640)');
    resumeConversation(target);
    return say(`▶️ Bot réactivé pour ${pauseLabel(target)}.`);
  }
  if (cmd === '/valider') {
    const phone = numArg ? normalizeWaNumber(numArg) : (ownerCtx.lastNotified && !String(ownerCtx.lastNotified).startsWith('b') ? ownerCtx.lastNotified : null);
    if (!bArg || !phone) return say('Usage : /valider bIDRÉSERVATION [numéro WhatsApp du voyageur]\nExemple : /valider b95878640 33612345678');
    const b = await getBookingById(bArg.slice(1));
    if (!b) return say(`Réservation ${bArg} introuvable.`);
    const conv = ensureConv(phone);
    conv.verifiedBookingId = b.id;
    conv.locked = false; conv.lockedAt = 0;
    conv.failedAttempts = 0; conv.failedAt = 0;
    markDirty();
    resumeConversation(phone);
    await say(`✅ +${phone} validé : ${b.firstName || ''} ${b.lastName || ''}, du ${b.arrival} au ${b.departure}. Le bot lui envoie ses informations d'accès.`);
    // Le voyageur reçoit tout de suite ses informations, sans avoir à réécrire
    const synthetic = () => require('./whatsapp').handleWhatsAppMessage({ from: phone, type: 'text', text: { body: "Le propriétaire a confirmé ma réservation. Pouvez-vous me donner les informations d'accès ?" } });
    // Dans la file du voyageur (pas de course avec un vrai message) ; sauf si c'est le numéro du propriétaire lui-même (test) : on est déjà dans sa file
    if (phone === owner) await synthetic(); else await runSerial(phone, synthetic);
    return;
  }
  if (cmd === '/debloquer') {
    const phone = numArg ? normalizeWaNumber(numArg) : (ownerCtx.lastNotified && !String(ownerCtx.lastNotified).startsWith('b') ? ownerCtx.lastNotified : null);
    if (!phone) return say('Usage : /debloquer numéro (ex. /debloquer 33612345678)');
    const conv = conversations.get(phone);
    if (!conv || !conv.locked) return say(`+${phone} n'est pas bloqué.`);
    conv.locked = false; conv.lockedAt = 0; conv.failedAttempts = 0; conv.failedAt = 0;
    markDirty();
    return say(`🔓 Vérification automatique de +${phone} débloquée.`);
  }
  if (cmd === '/sejour' || cmd === '/sejours') {
    const daysArg = args.map(a => a.match(/^(\d{1,3})\s*j?$/i)).find(Boolean);
    const days = daysArg ? Math.min(Math.max(parseInt(daysArg[1], 10), 1), SEJOUR_MAX_DAYS) : SEJOUR_DEFAULT_DAYS;
    return say(await ownerStaysText(days));
  }
  if (cmd === '/statut') return say(ownerStatusText());
  if (cmd === '/aide') return say(ownerHelpText());
  return say(`Commande inconnue : ${cmdRaw}\n\n${ownerHelpText()}`);
}

module.exports = {
  pauseLabel,
  ownerHelpText,
  fmtParisShort,
  fmtUptime,
  ownerStatusText,
  ownerStaysText,
  stayLine,
  addOwnerReplyToHistory,
  handleOwnerCommand
};
