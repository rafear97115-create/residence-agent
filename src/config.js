/*
 * config.js — Réglages (variables d'environnement), constantes du site, textes à compléter par le propriétaire
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */



const DEFAULT_CORS_ORIGINS = ['https://www.locations-residence-industrie.fr', 'https://locations-residence-industrie.fr'];
const corsRaw = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const CORS_OPEN = corsRaw.includes('*');
const corsOrigins = corsRaw.length ? corsRaw.filter(o => o !== '*') : DEFAULT_CORS_ORIGINS;

const AGENT_START_TIME = new Date();
console.log('Agent démarré à:', AGENT_START_TIME.toISOString());

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || ''; // plus de valeur par défaut en dur
// Modèle principal (variable Render CLAUDE_MODEL pour en changer, ex. claude-haiku-5-5) ; COURTESY_MODEL : modèle des simples remerciements
const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || '').trim() || 'claude-sonnet-5-5';
const COURTESY_MODEL = (process.env.COURTESY_MODEL || '').trim() || CLAUDE_MODEL;
const WHATSAPP_API_VERSION = 'v25.0';
const PAUSE_HOURS = Number(process.env.PAUSE_HOURS) || 12;
const STAY_VERIFICATION = String(process.env.STAY_VERIFICATION || '').toLowerCase() !== 'off';
const MAX_BAD_EMAILS = 3; // au-delà, la vérification automatique est bloquée pour ce numéro
const MAX_FAILED_ATTEMPTS = 5; // tentatives d'identification ratées (nom/dates/logement/email) avant blocage du numéro
const MAX_UNITS_MENTIONED = 2; // plus de logements cités que cela : texte suspect (liste de logements pour deviner)
const MAX_DAY_NUMBERS = 12; // plus de jours distincts (1 à 31) cités que cela : texte suspect (liste de dates)
const ALLOW_UNSIGNED_WEBHOOKS = String(process.env.ALLOW_UNSIGNED_WEBHOOKS || '').toLowerCase() === 'true';
const ADMIN_KEY_QUERY = String(process.env.ADMIN_KEY_QUERY || '').toLowerCase() !== 'off';
const OWNER_TEST_MODE = String(process.env.OWNER_TEST_MODE || '').toLowerCase() === 'on';
const LOG_CONTENT = String(process.env.LOG_CONTENT || '').toLowerCase() === 'on';
const REQUIRE_EMAIL = String(process.env.REQUIRE_EMAIL_VERIFICATION || '').toLowerCase() !== 'off';
const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT) || 1000;
// Plafond par adresse IP et par 24 h : une seule connexion ne peut pas épuiser le plafond global ci-dessus
const CHAT_IP_DAILY_LIMIT = Number(process.env.CHAT_IP_DAILY_LIMIT) || 100;
const FORMER_GUEST_MIN_BOOKINGS = Math.max(Number(process.env.FORMER_GUEST_MIN_BOOKINGS) || 3, 1);
// Signature des messages que le propriétaire envoie lui-même avec /repondre ("off" ou vide = aucune)
const OWNER_REPLY_SIGNATURE = (() => {
  const v = process.env.OWNER_REPLY_SIGNATURE;
  if (v === undefined) return "— Service Relation Client, Résidence de l'Industrie";
  const t = String(v).trim();
  return ['off', 'none', 'non'].includes(t.toLowerCase()) ? '' : t;
})();

// Adresses relais des plateformes (ex. xxx@guest.airbnb.com, xxx@guest.booking.com) : le voyageur ne les connaît pas
const RELAY_EMAIL_RE = /@(?:[a-z0-9-]+\.)*(?:airbnb|booking|expedia|vrbo|abritel|homeaway)\.[a-z.]+$/i;
function hasRealEmail(b) {
  const e = String(b?.email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !RELAY_EMAIL_RE.test(e);
}
// Si la réservation a une vraie adresse email, elle doit avoir été donnée par le voyageur (en plus d'un autre critère)
function applyEmailRequirement(b, res) {
  if (REQUIRE_EMAIL && res.score > 0 && hasRealEmail(b) && !res.reasons.includes('email')) return { score: 0, reasons: [], emailMissing: true };
  return res;
}

// ==================== IDENTIFIANTS NON SECRETS ====================
// Deux façons de les renseigner : une variable Render du même nom (prioritaire), ou remplacer la valeur '' ci-dessous par la valeur en dur.
// Vides, ils ne produisent aucune erreur : le bot démarre mais ne peut pas envoyer d'alertes (voir les avertissements au démarrage).
// Les secrets (jetons, clés, ADMIN_KEY...) ne vont JAMAIS ici : ils restent sur Render.
const OWNER_PHONE = process.env.OWNER_PHONE || '';                         // ex. '+33612345678' (numéro WhatsApp du propriétaire)
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';             // identifiant du numéro WhatsApp Business (Meta)
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';               // optionnel
const WHATSAPP_ALERT_TEMPLATE = process.env.WHATSAPP_ALERT_TEMPLATE || ''; // optionnel : nom du modèle approuvé
const WHATSAPP_ALERT_TEMPLATE_LANG = process.env.WHATSAPP_ALERT_TEMPLATE_LANG || 'fr';

const SITE_URL = 'https://www.locations-residence-industrie.fr';
const BOOKING_URL = 'https://www.booking.com/Share-4ZhcuX6';
// L'adresse exacte n'est JAMAIS communiquée : la seule précision autorisée est la distance à la gare routière
const ADDRESS_HINT = 'à 1 km de la gare routière';
// Adresse exacte : seulement pour un voyageur vérifié dont le séjour est en cours, sur WhatsApp, s'il la demande
const ADDRESS_FULL = "11 rue de l'Industrie, 02100 Saint-Quentin";
// Numéro WhatsApp public de la Résidence, donné aux visiteurs du chat du site (optionnel, ex. +33 6 12 34 56 78)
const WHATSAPP_PUBLIC_NUMBER = String(process.env.WHATSAPP_PUBLIC_NUMBER || '').trim(); // numéro public (peut aussi être mis en dur ici)

if (!process.env.WEBHOOK_VERIFY_TOKEN) console.warn('⚠️ WEBHOOK_VERIFY_TOKEN non défini : la (re)configuration du webhook chez Meta sera refusée. Définissez-le sur Render.');
if (!process.env.ADMIN_KEY) console.warn('⚠️ ADMIN_KEY non défini : les routes /status, /test-*, /setup-beds24 et /debug-beds24 sont désactivées.');
if (!process.env.WHATSAPP_APP_SECRET) console.warn(ALLOW_UNSIGNED_WEBHOOKS
  ? '⚠️ WHATSAPP_APP_SECRET non défini : webhooks WhatsApp acceptés SANS signature (ALLOW_UNSIGNED_WEBHOOKS=true).'
  : '⛔ WHATSAPP_APP_SECRET non défini : les webhooks WhatsApp sont REFUSÉS. Définissez-le sur Render (Meta > Paramètres de l\'app > Général).');
if (ADMIN_KEY_QUERY && process.env.ADMIN_KEY) console.warn('⚠️ Clé admin acceptée dans l\'URL (?key=) : elle reste dans les logs. Utilisez l\'en-tête x-admin-key puis ADMIN_KEY_QUERY=off.');
// Variables indispensables : lire process.env ne garantit pas qu'elles sont renseignées, et leur absence ne provoque aucune erreur
// (alertes silencieusement non envoyées, réponses impossibles...). Mieux vaut le voir dès le démarrage.
if (!process.env.ANTHROPIC_KEY) console.warn('⛔ ANTHROPIC_KEY non défini : le bot ne peut répondre à personne.');
if (!process.env.WHATSAPP_TOKEN) console.warn('⛔ WHATSAPP_TOKEN non défini : aucun message WhatsApp ne peut être envoyé (réponses, alertes, commandes).');
if (!WHATSAPP_PHONE_ID) console.warn('⛔ WHATSAPP_PHONE_ID non défini : aucun message WhatsApp ne peut être envoyé.');
if (!OWNER_PHONE) console.warn('⛔ OWNER_PHONE non défini : aucune alerte ni commande propriétaire (/aide, /pause, /valider...) ne fonctionnera.');
if (!process.env.BEDS24_REFRESH_TOKEN) console.warn('⚠️ BEDS24_REFRESH_TOKEN non défini : Beds24 déconnecté' + (process.env.BEDS24_TOKEN ? ' (utilisez /setup-beds24 puis copiez le jeton dans BEDS24_REFRESH_TOKEN).' : ' (messages Airbnb/Booking, disponibilités et vérifications indisponibles).'));
if (CORS_OPEN) console.warn('⚠️ CORS_ORIGIN=* : /api/chat est ouvert à tous les sites.');

// ==================== À COMPLÉTER PAR LE PROPRIÉTAIRE ====================
// Tout ce qui est vide est simplement omis du prompt. Ce qui n'est pas écrit ici reste "inconnu" pour l'agent.

// Fonctionnement de la serrure / du digicode (ex : "Taper le code puis appuyer sur la touche ... et tourner la poignée.")
const LOCK_INSTRUCTIONS = `Taper le code envoyé (Cxxxx) puis tourner la poignée presque jusqu'à 90°.`;

// Politique pour les longs séjours (32 nuits ou plus)
const LONG_STAY_POLICY = `Séjour de 32 nuits ou plus : ne promets AUCUN tarif ni remise. Donne la disponibilité vérifiée, puis dis que tu transmets la demande au Service Relation Client, qui l'étudiera et reviendra vers le voyageur.`;

// Plafond GLOBAL d'échecs de vérification d'identité sur 1 h (tous numéros et visiteurs confondus) : au-delà, la vérification
// automatique est suspendue pour les nouveaux voyageurs et le propriétaire est alerté (tentative de devinette probable)
const VERIFY_FAIL_GLOBAL_LIMIT = Math.max(Number(process.env.VERIFY_FAIL_GLOBAL_LIMIT) || 30, 3);
// Alertes d'annulation et de modification (dates / logement) de réservations confirmées
const CANCEL_WATCH = String(process.env.CANCEL_WATCH || '').toLowerCase() !== 'off';
const MODIFY_WATCH = String(process.env.MODIFY_WATCH || '').toLowerCase() !== 'off';

// Réglages qui étaient dispersés dans le fichier d'origine
const PENDING_WATCH = String(process.env.PENDING_WATCH || '').toLowerCase() !== 'off';
const PENDING_ACK = String(process.env.PENDING_ACK || '').toLowerCase() === 'on';

// Ancien voyageur : réservations prises en compte (statuts Beds24, séparés par des virgules) et séjours déjà commencés seulement
const FORMER_GUEST_STATUSES = (process.env.FORMER_GUEST_STATUSES || 'confirmed')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const FORMER_GUEST_PAST_ONLY = String(process.env.FORMER_GUEST_PAST_ONLY || '').toLowerCase() !== 'off';

module.exports = {
  DEFAULT_CORS_ORIGINS,
  corsRaw,
  CORS_OPEN,
  corsOrigins,
  AGENT_START_TIME,
  WEBHOOK_VERIFY_TOKEN,
  CLAUDE_MODEL,
  COURTESY_MODEL,
  VERIFY_FAIL_GLOBAL_LIMIT,
  CANCEL_WATCH,
  MODIFY_WATCH,
  WHATSAPP_API_VERSION,
  PAUSE_HOURS,
  STAY_VERIFICATION,
  MAX_BAD_EMAILS,
  MAX_FAILED_ATTEMPTS,
  MAX_UNITS_MENTIONED,
  MAX_DAY_NUMBERS,
  ALLOW_UNSIGNED_WEBHOOKS,
  ADMIN_KEY_QUERY,
  OWNER_TEST_MODE,
  LOG_CONTENT,
  REQUIRE_EMAIL,
  CHAT_DAILY_LIMIT,
  CHAT_IP_DAILY_LIMIT,
  FORMER_GUEST_MIN_BOOKINGS,
  OWNER_REPLY_SIGNATURE,
  RELAY_EMAIL_RE,
  hasRealEmail,
  applyEmailRequirement,
  SITE_URL,
  BOOKING_URL,
  ADDRESS_HINT,
  ADDRESS_FULL,
  WHATSAPP_PUBLIC_NUMBER,
  OWNER_PHONE,
  WHATSAPP_PHONE_ID,
  TELEGRAM_CHAT_ID,
  WHATSAPP_ALERT_TEMPLATE,
  WHATSAPP_ALERT_TEMPLATE_LANG,
  LOCK_INSTRUCTIONS,
  LONG_STAY_POLICY,
  PENDING_WATCH,
  PENDING_ACK,
  FORMER_GUEST_STATUSES,
  FORMER_GUEST_PAST_ONLY
};
