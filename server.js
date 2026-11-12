/*
 * Assistant virtuel — Résidence de l'Industrie
 *
 * VARIABLES D'ENVIRONNEMENT (Render)
 * Existantes : ANTHROPIC_KEY, BEDS24_REFRESH_TOKEN, BEDS24_TOKEN, WHATSAPP_PHONE_ID,
 * WHATSAPP_TOKEN, OWNER_PHONE
 * - ADMIN_KEY (OBLIGATOIRE pour /status, /test-*, /setup-beds24, /debug-beds24)
 * appel : en-tête "x-admin-key: ..." ou ?key=...
 * - WHATSAPP_APP_SECRET (OBLIGATOIRE) secret de l'app Meta (Paramètres > Général) : vérification de signature des webhooks.
 *   Sans lui, les webhooks WhatsApp sont REFUSÉS (sauf ALLOW_UNSIGNED_WEBHOOKS=true : déconseillé, seulement le temps de le configurer)
 * - WEBHOOK_VERIFY_TOKEN (nécessaire pour (re)configurer le webhook chez Meta) : jeton de vérification, plus aucune valeur par défaut
 * - NOTIFY_ALL=true (optionnel) renvoie AUSSI les échanges ordinaires au propriétaire
 * - PAUSE_HOURS (optionnel, défaut 12) durée de la pause du bot
 * - CORS_ORIGIN (optionnel) origines autorisées pour /api/chat, séparées par des virgules. Défaut : le site (avec et sans www).
 *   "*" = ouvert à tous (déconseillé)
 * - CATCHUP_HOURS (optionnel, défaut 12) : un message Airbnb/Booking reçu pendant que le bot dormait ou redémarrait
 *   reçoit quand même une réponse s'il a moins de N heures et si personne n'y a répondu depuis
 * - STAY_VERIFICATION=off (optionnel) désactive la vérification "nom + dates + logement" sur WhatsApp
 *   (par défaut : un voyageur est vérifié s'il donne son nom ET les dates exactes de son séjour ET son logement)
 * - ROOM_MAP (optionnel) JSON qui associe l'ID Beds24 de chaque logement à son numéro, ex. {"123456":1,"123457":2}
 *   (utile si les logements ne s'appellent pas Agate, Bégonia... dans Beds24 ; voir /test-verification)
 * - PENDING_WATCH=off (optionnel) désactive la surveillance des demandes en attente et des réservations directes
 * - PENDING_LOOKBACK_HOURS (optionnel, défaut 12) : fenêtre de recherche des réservations récentes
 * - IGNORE_BOOKING_NAMES (optionnel) : mots (séparés par des virgules) qui, dans le prénom ou le nom d'une réservation,
 *   la font traiter comme un blocage : aucune alerte. Défaut : travaux,bloque,blocage,maintenance,indisponible,fermeture,proprietaire
 * - PENDING_ACK=on (optionnel, désactivé par défaut) : accusé de réception automatique au voyageur Airbnb/Booking
 *   qui a fait une demande en attente (aucune promesse, la demande est dite "transmise au propriétaire")
 *
 * - STATE_FILE (optionnel) fichier JSON où le bot garde ses pauses, ses vérifications et les alertes déjà envoyées, pour survivre
 *   à un redémarrage. Défaut : /var/data/state.json si ce dossier existe (disque persistant Render), sinon ./state.json
 *   (ATTENTION : sans disque persistant Render, ce fichier est effacé à chaque redémarrage). Aucun texte de message n'y est écrit.
 * - ADMIN_KEY_QUERY=off (optionnel) refuse la clé admin dans l'URL (?key=) : seul l'en-tête x-admin-key est accepté
 * - OWNER_TEST_MODE=on (optionnel) le propriétaire reçoit les réponses de l'IA à ses messages libres, comme un voyageur (tests)
 * - LOG_CONTENT=on (optionnel) écrit le texte des messages et les noms dans les logs (par défaut : seulement leur longueur, RGPD)
 * - BEDS24_MAX_PAGES (optionnel, défaut 3) : nombre de pages de 100 résultats lues chez Beds24
 * - ALLOW_UNSIGNED_WEBHOOKS=true (déconseillé) accepte les webhooks WhatsApp sans signature
 * - REQUIRE_EMAIL_VERIFICATION=off (optionnel) : par défaut, si la réservation a une VRAIE adresse email (pas une adresse relais
 *   Airbnb/Booking), le voyageur doit la donner en plus d'un autre critère (WhatsApp et chat web)
 * - LOCK_DAYS (optionnel, défaut 90) : durée du blocage de la vérification automatique d'un numéro après trop de tentatives ratées.
 *   Le blocage survit au redémarrage (fichier d'état) ; /valider ou /debloquer le lèvent avant
 * - CHAT_DAILY_LIMIT (optionnel, défaut 1000) : nombre maximum de requêtes /api/chat par 24 h, tous visiteurs confondus (coût IA).
 *   Le propriétaire est alerté (une fois par jour) quand il est atteint.
 * - CHAT_IP_DAILY_LIMIT (optionnel, défaut 100) : nombre maximum de requêtes /api/chat par 24 h et par adresse IP,
 *   pour qu'une seule connexion ne puisse pas épuiser le plafond global
 *   Le chat du site ne donne JAMAIS de codes d'accès (digicode, boîte à clé, Wi-Fi) ni de numéro d'urgence : tout passe par WhatsApp.
 *   /api/chat refuse aussi les requêtes dont l'en-tête Origin n'est pas dans CORS_ORIGIN (ou sans Origin).
 *   /api/chat ne lit que les messages du VISITEUR : les "réponses de l'assistant" envoyées par le navigateur sont ignorées.
 * - OWNER_REPLY_SIGNATURE (optionnel) : signature ajoutée aux messages envoyés avec /repondre.
   Défaut : « — Service Relation Client, Résidence de l'Industrie ». "off" = aucune signature
 * - WHATSAPP_PUBLIC_NUMBER (optionnel) : numéro WhatsApp de la Résidence, donné aux visiteurs du chat du site qui demandent à être recontactés
 * - FORMER_GUEST_STATUSES (optionnel, défaut confirmed) : statuts Beds24 comptés pour un "ancien voyageur" (séparés par des virgules)
 * - FORMER_GUEST_PAST_ONLY=off (optionnel) : compter aussi les séjours à venir (par défaut : seulement les séjours déjà commencés)
 *   (le comptage utilise l'adresse email exacte et réelle de la réservation ; pas d'adresse relais Airbnb/Booking)
 * - FORMER_GUEST_MIN_BOOKINGS (optionnel, défaut 3) : nombre de réservations à partir duquel un voyageur est un "ancien voyageur"
   (le bot peut alors transmettre sa demande de tarif préférentiel au Service Relation Client ; aucun tarif n'est jamais promis)
 *
 * DEMANDES EN ATTENTE ET RÉSERVATIONS DIRECTES : toutes les 2 minutes, le bot prévient le propriétaire d'une demande
 * en attente (statut Beds24 inquiry / request, toutes plateformes) et de toute nouvelle réservation confirmée (site, Airbnb, Booking),
 * avec l'origine, le téléphone du voyageur (lien WhatsApp) et la disponibilité du logement. Il ne peut ni accepter
 * ni refuser une demande : cela reste à faire dans Airbnb / Booking.
 *
 * COMMANDES PROPRIÉTAIRE (à envoyer au numéro du bot depuis OWNER_PHONE) : /aide les explique, avec des exemples
 * /aide : la liste des commandes, expliquées
 * /sejour [jours] : séjours en cours et à venir (30 jours par défaut, 365 au maximum)
 * /statut : état du bot (en ligne depuis..., conversations en pause, numéros bloqués, voyageurs reconnus, réglages actifs)
 * /repondre numéro|bIDRÉSERVATION message : envoie VOTRE réponse au voyageur (WhatsApp, ou Airbnb/Booking via Beds24),
 *   à utiliser en cas de réelle nécessité. Le destinataire est OBLIGATOIRE (plus de destinataire par défaut).
 * /pause [numéro|bIDRÉSERVATION] [heures] : le bot se tait sur cette conversation ; les messages WhatsApp du voyageur
 *   vous sont alors transférés (💬) pour que vous puissiez lui répondre avec /repondre
 * /reprise [numéro|bIDRÉSERVATION] : le bot reprend
 * /debloquer [numéro] : lève le blocage de la vérification automatique d'un numéro WhatsApp
 * /valider bIDRÉSERVATION [numéro] : confirme à la main l'identité d'un voyageur WhatsApp
 *   (le bot lui envoie alors directement ses informations d'accès)
 * (bIDRÉSERVATION = réservation Beds24, ex. /pause b95878640)
 *
 * ESCALADE : toute demande particulière passe d'abord par le "Service Relation Client" (c'est lui qui reçoit les alertes
 * ci-dessous et qui saisit la Direction si nécessaire). Le bot ne s'adresse jamais directement à la Direction.
 *
 * CHAT SUR LE SITE INTERNET : déposer public/chat-widget.js sur le serveur, puis ajouter AVANT </body> sur chaque page du site :
 *   <script src="https://VOTRE-APP.onrender.com/chat-widget.js" defer></script>
 *   Le site doit figurer dans CORS_ORIGIN (par défaut : locations-residence-industrie.fr, avec et sans www).
 *   Options (attributs data- de la balise script) : data-api (adresse du serveur, si différente), data-color (couleur #rrggbb), data-title.
 *
 * ALERTES PROPRIÉTAIRE : le message libre WhatsApp ne part que si le propriétaire a écrit au bot dans les dernières 24 h
 * (règle de Meta). Pour ne plus avoir à le faire, 2 secours automatiques (utilisés dans cet ordre si l'envoi échoue) :
 * - WHATSAPP_ALERT_TEMPLATE nom d'un modèle WhatsApp approuvé (corps avec UNE variable {{1}}), autorisé hors fenêtre 24 h
 * - WHATSAPP_ALERT_TEMPLATE_LANG (optionnel, défaut fr) langue du modèle
 * - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optionnels) alerte sur Telegram, sans aucune limite de 24 h
 *
 * ARCHITECTURE (dossier src/) — ce fichier ne contient plus que le démarrage ; la commande Render reste "node server.js"
 *   config.js          réglages et constantes              utils.js        fonctions pures (dates, textes, fetch)
 *   security.js        clé admin, Meta, limites, adresse   prompts.js      textes et règles de l'assistant
 *   rooms.js           logements et équipements            beds24.js       API Beds24 (jeton, réservations, messages)
 *   identity.js        vérification d'identité             state.js        conversations, pauses, persistance
 *   messaging.js       WhatsApp / Telegram                 alerts.js       alertes au propriétaire
 *   ai.js              appels à Claude, outil              owner-commands.js  commandes du propriétaire
 *   whatsapp.js        message WhatsApp                    platforms.js    Airbnb / Booking
 *   bookings-watch.js  demandes en attente                 maintenance.js  nettoyage mémoire
 *   routes/            webhook.js, admin.js, chat.js
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const { executeTool, isPureCourtesy } = require('./src/ai');
const { fallbackCategory, fmtDate, formatOwnerAlert, parseAlert } = require('./src/alerts');
const { bookingPhone, countGuestBookings, countsAsFormerStay, detectPlatform, isActiveStay, isBlockBooking } = require('./src/beds24');
const { bookingEventKind, checkNewBookings, formatBookingAlert } = require('./src/bookings-watch');
const { CORS_OPEN, applyEmailRequirement, corsOrigins, hasRealEmail } = require('./src/config');
const { buildWaCtx, countDayNumbers, extractUnits, looksLikeIdentityAttempt, pickBestBooking, registerFailedAttempt, stayDatesMatch, waIdentityScore, webIdentityScore } = require('./src/identity');
const { flattenForTemplate } = require('./src/messaging');
const { catchupDecision, fetchAndReplyBeds24Messages } = require('./src/platforms');
const { CACHE_BREAK, bookingFormatRules, buildSystemPrompt, ensureSignature, hasIntro, toSystemBlocks } = require('./src/prompts');
const { beds24UnitSheet, buildRoomNumbers, flattenFeatures } = require('./src/rooms');
const { collapseVisitorTurns, redactSecrets, sanitizeChatMessages } = require('./src/routes/chat');
const { applyAddressPolicy } = require('./src/security');
const { conversations, ensureConv, getHistory, introducedBookings, isLocked, loadState, lockConv, pauses, restoreState, saveState, seenBookingEvents, snapshotState } = require('./src/state');
const { bookingPhoneKeys, calendarHint, logText, normalizeWaNumber, phoneKey, scrub } = require('./src/utils');

const app = express();

app.set('trust proxy', 1); // Render : récupérer la vraie IP du visiteur

app.use(cors(CORS_OPEN ? undefined : { origin: corsOrigins }));
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static('public'));
// Widget de chat à intégrer au site internet (voir l'en-tête du fichier) ; repli si le dossier public n'est pas résolu depuis le dossier courant
app.get('/chat-widget.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'public', 'chat-widget.js'), err => { if (err && !res.headersSent) res.status(404).end(); });
});

require('./src/maintenance'); // nettoyage périodique de la mémoire
require('./src/routes/webhook').register(app);
require('./src/routes/admin').register(app);
require('./src/routes/chat').register(app);

// ==================== DÉMARRAGE ====================

module.exports = {
  app, isPureCourtesy, parseAlert, fallbackCategory, phoneKey, normalizeWaNumber, webIdentityScore,
  waIdentityScore, sanitizeChatMessages, buildSystemPrompt, executeTool, calendarHint, bookingFormatRules,
  applyAddressPolicy, isActiveStay, stayDatesMatch, extractUnits, hasIntro, ensureSignature, buildRoomNumbers,
  flattenForTemplate, catchupDecision, formatOwnerAlert, fmtDate, detectPlatform, bookingPhone,
  bookingEventKind, formatBookingAlert, bookingPhoneKeys, isBlockBooking, flattenFeatures, beds24UnitSheet,
  buildWaCtx, pickBestBooking, looksLikeIdentityAttempt, countDayNumbers, registerFailedAttempt, toSystemBlocks,
  CACHE_BREAK, snapshotState, restoreState, logText, conversations, pauses, seenBookingEvents,
  introducedBookings, hasRealEmail, applyEmailRequirement, ensureConv, isLocked, lockConv, getHistory,
  countGuestBookings, countsAsFormerStay, collapseVisitorTurns, redactSecrets, scrub
};

if (require.main === module) {
  loadState();
  setInterval(saveState, 30 * 1000).unref(); // filet : sauvegarde régulière en plus des sauvegardes déclenchées par les événements
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveState(); process.exit(0); }); // Render arrête l'ancienne instance avec SIGTERM

  // Polling Beds24 toutes les 2 minutes
  setInterval(fetchAndReplyBeds24Messages, 2 * 60 * 1000);
  setTimeout(fetchAndReplyBeds24Messages, 5000);
  // Demandes en attente et réservations directes (premier passage 20 s après le démarrage, puis toutes les 2 minutes)
  setInterval(checkNewBookings, 2 * 60 * 1000);
  setTimeout(checkNewBookings, 20000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Serveur démarré sur port', PORT));
}
