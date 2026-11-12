/*
 * admin.js — Routes d'administration et de diagnostic (/health, /status, /test-*, /setup-beds24)
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { bookingByIdCache, bookingPhone, detectPlatform, getAllActiveBookings, getBeds24RefreshOverride, getBeds24Token, getBookingById, getPropertyInfo, isActiveStay, maskPhone, setBeds24Session } = require('../beds24');
const { ADMIN_KEY_QUERY, AGENT_START_TIME, ALLOW_UNSIGNED_WEBHOOKS, PENDING_ACK, PENDING_WATCH, RELAY_EMAIL_RE, REQUIRE_EMAIL, STAY_VERIFICATION, hasRealEmail } = require('../config');
const { buildWaCtx, waIdentityScore } = require('../identity');
const { messageBookingId, processedMessages } = require('../platforms');
const { buildRoomNumbers } = require('../rooms');
const { requireAdmin } = require('../security');
const { LOCK_DAYS, PERSISTENT_DISK, STATE_FILE, conversations, isLocked, isPaused, isPersistenceOn, pauses } = require('../state');
const { fetchT, getDatetime } = require('../utils');



function register(app) {
// ==================== ROUTES ====================

// Route publique minimale (pour un moniteur d'uptime) : aucune donnée sensible
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/status', requireAdmin, async (req, res) => {
  const token = await getBeds24Token();
  const propInfo = await getPropertyInfo();
  const activeBookings = await getAllActiveBookings();
  res.json({
    beds24: token ? 'connecté' : 'déconnecté',
    anthropic: process.env.ANTHROPIC_KEY ? 'configuré' : 'manquant',
    whatsapp: process.env.WHATSAPP_TOKEN ? 'configuré' : 'manquant',
    signatureWhatsApp: process.env.WHATSAPP_APP_SECRET ? 'vérifiée' : (ALLOW_UNSIGNED_WEBHOOKS ? 'NON vérifiée (autorisé)' : 'MANQUANTE : webhooks refusés'),
    persistance: isPersistenceOn() ? STATE_FILE : 'désactivée',
    disquePersistant: PERSISTENT_DISK ? 'oui' : 'NON : état perdu à chaque redémarrage',
    emailReservationExige: REQUIRE_EMAIL ? 'oui (si vraie adresse email dans la réservation)' : 'non',
    dureeBlocageJours: LOCK_DAYS,
    numerosBloques: [...conversations.values()].filter(isLocked).length,
    cleAdminDansUrl: ADMIN_KEY_QUERY ? 'acceptée (déconseillé)' : 'refusée',
    verificationParSejour: STAY_VERIFICATION ? 'activée' : 'désactivée',
    surveillanceDemandesEtReservationsDirectes: PENDING_WATCH ? 'activée' : 'désactivée',
    accuseReceptionDemandes: PENDING_ACK ? 'activé' : 'désactivé',
    logements: propInfo?.rooms?.length || 0,
    reservationsActives: activeBookings.length,
    voyageursActifs: activeBookings.map(b => `${b.firstName} ${b.lastName} (logement ${b.roomId})`),
    conversationsEnPause: [...pauses.keys()].filter(isPaused).length,
    messagesTraités: processedMessages.size,
    agentDémarréLe: AGENT_START_TIME.toISOString(),
    heureActuelle: getDatetime()
  });
});

app.get('/test-booking', requireAdmin, async (req, res) => {
  try {
    const token = await getBeds24Token();
    const now = new Date();
    const dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const response = await fetchT(
      `https://beds24.com/api/v2/bookings?arrivalFrom=${dateFrom}&status=confirmed&maxResults=10`,
      { headers: { 'token': token } }
    );
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

// Diagnostic Beds24 : ce que le bot voit dans les messages Airbnb / Booking (lecture seule, rien n'est envoyé)
app.get('/test-beds24-messages', requireAdmin, async (req, res) => {
  try {
    const token = await getBeds24Token();
    if (!token) return res.json({ error: 'Beds24 déconnecté (token indisponible)' });
    const r = await fetchT('https://beds24.com/api/v2/bookings/messages?maxResults=20', { headers: { 'token': token } });
    const raw = await r.json();
    const list = raw?.data || raw;
    if (!Array.isArray(list)) return res.json({ status: r.status, reponse_beds24: raw });
    res.json({
      status: r.status,
      nombre: list.length,
      champs_disponibles: list[0] ? Object.keys(list[0]) : [],
      messages: list.map(m => {
        const id = m.id || m.messageId;
        return {
          id, bookingId: messageBookingId(m), roomId: m.roomId, time: m.time,
          source: m.source || m.type || null,
          lu_comme_message_voyageur: (m.source || m.type || '') === 'guest',
          texte: String(m.message || m.text || '').slice(0, 80),
          deja_traite: processedMessages.has(id),
          ignore_car_avant_demarrage: m.time ? new Date(m.time) < AGENT_START_TIME : true
        };
      })
    });
  } catch (err) { res.json({ error: err.message }); }
});

// Diagnostic : plateforme détectée et droits d'une réservation (lecture seule)
app.get('/test-beds24-booking', requireAdmin, async (req, res) => {
  try {
    const id = String(req.query.id || '').replace(/\D/g, '');
    if (!id) return res.json({ error: 'Ajoutez &id=NUMERO_RESERVATION (ex. 95878640)' });
    bookingByIdCache.delete(id);
    const b = await getBookingById(id);
    if (!b) return res.json({ error: 'Réservation introuvable (ou Beds24 injoignable)' });
    res.json({
      champs_disponibles: Object.keys(b),
      status: b.status, channel: b.channel ?? null, apiSource: b.apiSource ?? null, referer: b.referer ?? null,
      arrivee: b.arrival, depart: b.departure, roomId: b.roomId,
      email_est_une_adresse_relais: RELAY_EMAIL_RE.test(String(b.email || '')),
      email_exige_pour_verification: REQUIRE_EMAIL && hasRealEmail(b),
      telephone_present: !!(b.phone || b.mobile),
      plateforme_detectee: detectPlatform(b),
      dans_la_fenetre_active: isActiveStay(b),
      codes_autorises: String(b.status || '').toLowerCase() === 'confirmed' && isActiveStay(b)
    });
  } catch (err) { res.json({ error: err.message }); }
});

// Diagnostic : pourquoi un voyageur est (ou n'est pas) vérifié. Ex : /test-verification?id=95878640&text=Fatima Karim du 9 au 12 logement 1
app.get('/test-verification', requireAdmin, async (req, res) => {
  try {
    const id = String(req.query.id || '').replace(/\D/g, '');
    if (!id) return res.json({ error: 'Ajoutez ?id=NUMERO_RESERVATION&text=Fatima Karim du 9 au 12 logement 1' });
    bookingByIdCache.delete(id);
    const b = await getBookingById(id);
    if (!b) return res.json({ error: 'Réservation introuvable (ou Beds24 injoignable)' });
    const propInfo = await getPropertyInfo();
    const roomNumbers = buildRoomNumbers(propInfo);
    const ctx = buildWaCtx('', String(req.query.text || ''), roomNumbers);
    const r = waIdentityScore(b, ctx);
    res.json({
      prenom_beds24: b.firstName ?? null, nom_beds24: b.lastName ?? null,
      roomId: b.roomId, unitId: b.unitId ?? null,
      logement_reconnu: roomNumbers.get(String(b.roomId)) ?? null,
      logements_beds24: (propInfo?.rooms || []).map(x => ({ id: x.id, nom: x.name, numero_reconnu: roomNumbers.get(String(x.id)) ?? null })),
      sejour_actif: isActiveStay(b), email_present: !!b.email, telephone_present: !!(b.phone || b.mobile),
      email_exige: REQUIRE_EMAIL && hasRealEmail(b), email_manquant: !!r.emailMissing,
      score: r.score, criteres: r.reasons, verifie: r.score >= 2, texte_suspect: ctx.sprayed
    });
  } catch (err) { res.json({ error: err.message }); }
});

// Diagnostic : droits (scopes) du jeton Beds24 actuel. Lecture seule, rien n'est envoyé, les valeurs de jeton sont masquées.
app.get('/debug-beds24-token', requireAdmin, async (req, res) => {
  try {
    const token = await getBeds24Token();
    if (!token) return res.json({ error: 'Beds24 déconnecté (token indisponible)' });
    const r = await fetchT('https://beds24.com/api/v2/authentication/details', { headers: { 'token': token } }, 10000);
    const txt = await r.text();
    let body; try { body = JSON.parse(txt); } catch (e) { body = txt.substring(0, 500); }
    const redact = o => Array.isArray(o) ? o.map(redact)
      : (o && typeof o === 'object') ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /token/i.test(k) && typeof v === 'string' ? '[masqué]' : redact(v)]))
      : o;
    res.json({ status: r.status, details: redact(body) });
  } catch (err) { res.json({ error: err.message }); }
});

// Diagnostic : réservations récemment créées ou modifiées, tous statuts (demandes, demandes d'information, confirmées...).
// Ex : /test-beds24-requests?hours=48  (lecture seule)
app.get('/test-beds24-requests', requireAdmin, async (req, res) => {
  try {
    const token = await getBeds24Token();
    if (!token) return res.json({ error: 'Beds24 déconnecté (token indisponible)' });
    const hours = Math.min(Math.max(Number(req.query.hours) || 48, 1), 240);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const r = await fetchT(`https://beds24.com/api/v2/bookings?modifiedFrom=${encodeURIComponent(since)}&maxResults=60`, { headers: { 'token': token } });
    const raw = await r.json();
    const list = raw?.data || raw;
    if (!Array.isArray(list)) return res.json({ status: r.status, reponse_beds24: raw });
    list.sort((a, b) => String(b.modifiedTime || b.bookingTime || '').localeCompare(String(a.modifiedTime || a.bookingTime || '')));
    res.json({
      status: r.status, depuis: since, nombre: list.length,
      champs_disponibles: list[0] ? Object.keys(list[0]) : [],
      reservations: list.map(b => ({
        id: b.id, status: b.status, channel: b.channel ?? null, apiSource: b.apiSource ?? null,
        origine_detectee: detectPlatform(b),
        champs_telephone_renvoyes_par_beds24: ['phone', 'mobile'].filter(k => k in b),
        champ_telephone_rempli: b.mobile ? 'mobile' : (b.phone ? 'phone' : null),
        telephone_masque: maskPhone(bookingPhone(b)),
        arrivee: b.arrival, depart: b.departure, roomId: b.roomId,
        nom: `${b.firstName || ''} ${b.lastName || ''}`.trim(),
        creee: b.bookingTime ?? null, modifiee: b.modifiedTime ?? null,
        commentaire_voyageur: String(b.comments || '').slice(0, 200),
        notes: String(b.notes || '').slice(0, 100)
      }))
    });
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/test-templates', requireAdmin, async (req, res) => {
  try {
    const token = await getBeds24Token();
    const response = await fetchT('https://beds24.com/api/v2/properties?includeAllRooms=true&includeTexts=true', {
      headers: { 'token': token }
    });
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/setup-beds24', requireAdmin, async (req, res) => {
  try {
    const code = (process.env.BEDS24_TOKEN || '').trim();
    if (!code) return res.json({ error: 'Variable BEDS24_TOKEN vide sur Render' });
    const response = await fetchT('https://beds24.com/api/v2/authentication/setup', {
      headers: { 'code': code, 'deviceName': 'residence-agent' }
    });
    const data = await response.json();
    if (data.refreshToken) {
      // Connexion immédiate (jusqu'au prochain redémarrage)
      setBeds24Session(data);
      console.log('✅ Beds24 : refresh token reçu via /setup-beds24 (longueur', data.refreshToken.length, ')');
      return res.json({
        succes: true,
        etape_suivante: 'Copiez la valeur de A_COPIER_DANS_BEDS24_REFRESH_TOKEN dans la variable BEDS24_REFRESH_TOKEN sur Render, puis enregistrez.',
        A_COPIER_DANS_BEDS24_REFRESH_TOKEN: data.refreshToken
      });
    }
    console.error('Setup Beds24 échoué:', JSON.stringify(data).substring(0, 300));
    res.json({ succes: false, reponse_beds24: data });
  } catch (err) { res.json({ error: err.message }); }
});

// Diagnostic : n'affiche aucune valeur secrète, seulement des informations de forme
app.get('/debug-beds24', requireAdmin, async (req, res) => {
  try {
    const raw = process.env.BEDS24_REFRESH_TOKEN || '';
    const info = {
      refreshToken_longueur: raw.length,
      refreshToken_espaces_ou_retours: raw !== raw.trim() || /\s/.test(raw),
      refreshToken_guillemets: /["']/.test(raw),
      code_invitation_longueur: (process.env.BEDS24_TOKEN || '').length,
      refreshToken_en_memoire: !!getBeds24RefreshOverride()
    };
    const used = (getBeds24RefreshOverride() || raw).replace(/["',\s{}]/g, '');
    info.refreshToken_longueur_apres_nettoyage = used.length;
    if (used) {
      const r = await fetchT('https://beds24.com/api/v2/authentication/token', { headers: { 'refreshToken': used } }, 10000);
      const d = await r.json();
      info.test_beds24 = d.token ? 'OK : token reçu' : d;
    } else {
      info.test_beds24 = 'aucun refresh token disponible';
    }
    res.json(info);
  } catch (err) { res.json({ error: err.message }); }
});
}

module.exports = {
  register
};
