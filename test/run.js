/*
 * Tests automatiques (aucune dépendance, aucun accès réseau : Beds24, Meta et Anthropic sont simulés).
 * Lancer : npm test
 */
process.env.OWNER_PHONE = '33600000001';
process.env.WHATSAPP_PHONE_ID = '111';
process.env.WHATSAPP_TOKEN = 'tok';
process.env.ANTHROPIC_KEY = 'key';
process.env.BEDS24_REFRESH_TOKEN = 'rt';
process.env.WHATSAPP_APP_SECRET = 'secret';
process.env.ADMIN_KEY = 'admin';
process.env.WEBHOOK_VERIFY_TOKEN = 'v';

const assert = require('assert');
const path = require('path');
const src = f => require(path.join(__dirname, '..', 'src', f));

// ---------- Simulation du réseau ----------
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const db = { active: [], upcoming: [], modified: [], byId: {}, fail: false, anthropic: [], sent: [], anthropicCalls: [], anthropicBodies: [] };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const PROPS = { data: [{ templates: { template1: '9999', template2: 'wifipass' }, roomTypes: [{ id: 10, name: 'Agate', templates: { template1: '4821', template3: 'RDC', template4: 'wifi1' }, roomSize: 20, maxPeople: 2, featureCodes: [] }] }] };

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('graph.facebook.com')) { db.sent.push(JSON.parse(opts.body)); return res(200, {}); }
  if (url.includes('api.anthropic.com')) {
    db.anthropicCalls.push(url); db.anthropicBodies.push(JSON.parse(opts.body));
    const next = db.anthropic.shift();
    if (!next) return res(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Réponse standard.\n[[ALERTE:aucune]]' }] });
    return next();
  }
  if (url.includes('/authentication/token')) return res(200, { token: 'T', expiresIn: 86400 });
  if (db.fail) return res(503, { error: 'down' });
  if (url.includes('/properties')) return res(200, PROPS);
  if (url.includes('modifiedFrom')) return res(200, { data: db.modified });
  if (url.includes('/bookings?id=')) { const id = decodeURIComponent(url.split('id=')[1]); return res(200, { data: db.byId[id] ? [db.byId[id]] : [] }); }
  if (url.includes('status=confirmed') && url.includes('arrivalTo')) return res(200, { data: db.active });
  if (url.includes('status=confirmed')) return res(200, { data: db.upcoming });
  if (url.includes('arrivalTo=')) return res(200, { data: [] });
  return res(200, { data: [] });
};
const ok200 = text => () => res(200, { stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const status = (s, body = { error: 'x' }) => () => res(s, body);

// ---------- Petit lanceur ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const { addDays, parisToday } = src('utils');
const today = parisToday();
const guestBooking = (over = {}) => ({ id: 1001, status: 'confirmed', arrival: today, departure: addDays(today, 2), roomId: 10, firstName: 'Fatima', lastName: 'Karim', email: 'abc@guest.airbnb.com', channel: 'airbnb', ...over });
const ownerMsgs = () => db.sent.filter(m => m.to === '33600000001').map(m => m.text?.body || JSON.stringify(m));
const resetSent = () => { db.sent.length = 0; };

// =============== 1. Filtre d'adresse ===============
test('adresse : variantes masquées, textes voisins intacts', () => {
  const { applyAddressPolicy: A } = src('security');
  for (const t of ["11 rue de l'Industrie", "au 11 rue de l'Industrie, 02100 Saint-Quentin", 'rue de l’industrie', '11 rue Industrie', "rue de l'Industrie 11",
    "11, rue de l'Industrie", '11 r. de l industrie', "rue de l'Industrie n°11 Saint-Quentin", 'rue de lindustrie 11 bis, 02100 St Quentin', '11 Industry Street']) {
    assert(!/industr/i.test(A(t, false).replace(/Saint-Quentin \(02100\)/g, '')), `adresse non masquée : ${t} → ${A(t, false)}`);
  }
  for (const t of ["rue de l'industrialisation", "L'industrie est belle", 'Départ à 11h, rue du Général']) assert.strictEqual(A(t, false), t);
  assert.strictEqual(A("11 rue de l'Industrie", true), "11 rue de l'Industrie"); // voyageur vérifié : autorisé
});

// =============== 2. Masquage des codes (chat web) ===============
test('redactSecrets : aucun fragment de mot de passe ne fuit', () => {
  const { redactSecrets } = src('routes/chat');
  const out = redactSecrets('code 1234 wifi abc12345 fin', { digicode: '1234', wifi_password: 'abc12345', rooms: [] });
  assert(!/1234|abc|12345|5\b/.test(out.replace('[information réservée à WhatsApp]', '')), out);
  assert.strictEqual((out.match(/information réservée/g) || []).length, 2);
  assert.strictEqual(redactSecrets('en 2025', { digicode: '2025', rooms: [] }), 'en 2025'); // une année n'est pas un code
  assert.strictEqual(redactSecrets('rien', { rooms: [] }), 'rien');
  assert(!redactSecrets('Le CODE est ABCD', { digicode: 'abcd', rooms: [] }).includes('ABCD'));
});

// =============== 3. Faux positifs d'alerte ===============
test('fallbackCategory : vraies urgences oui, faux positifs non', () => {
  const { fallbackCategory: f } = src('alerts');
  const cases = [['Quelle direction pour la gare ?', 'aucune'], ['Le responsable du parking ?', 'aucune'], ['Je voudrais bloquer le logement du 3 au 5', 'aucune'],
    ['Y a-t-il un supermarché dans le voisinage ?', 'aucune'], ['Je veux parler au responsable', 'contact_humain'], ['Je voudrais contacter la direction', 'contact_humain'],
    ['Je suis bloqué dehors', 'urgence_acces'], ['Le digicode ne marche pas', 'urgence_acces'], ['impossible de rentrer', 'urgence_acces'],
    ['il y a une fuite', 'urgence_technique'], ["Je n'ai plus d'eau chaude", 'urgence_technique'], ['les voisins font la fête', 'plainte'], ["c'est trop bruyant", 'plainte']];
  for (const [t, e] of cases) assert.strictEqual(f(t), e, t);
});

// =============== 4. Appels Claude : nouvelles tentatives et réponses tronquées ===============
test('Claude : 2 nouvelles tentatives après 529, puis succès', async () => {
  const ai = src('ai'); ai.AI_RETRY_DELAYS_MS[0] = 1; ai.AI_RETRY_DELAYS_MS[1] = 1;
  db.anthropicCalls.length = 0; db.anthropic = [status(529), status(529), ok200('Bonjour !')];
  assert.strictEqual(await ai.runConversation({ system: 's', messages: [{ role: 'user', content: 'x' }] }), 'Bonjour !');
  assert.strictEqual(db.anthropicCalls.length, 3);
});
test('Claude : erreur 400 = aucune nouvelle tentative', async () => {
  const ai = src('ai'); db.anthropicCalls.length = 0; db.anthropic = [status(400), ok200('jamais')];
  assert.strictEqual(await ai.runConversation({ system: 's', messages: [{ role: 'user', content: 'x' }] }), null);
  assert.strictEqual(db.anthropicCalls.length, 1);
  db.anthropic = [];
});
test('Claude : 3 échecs temporaires = abandon (null) après 3 essais', async () => {
  const ai = src('ai'); db.anthropicCalls.length = 0; db.anthropic = [status(529), status(500), status(429)];
  assert.strictEqual(await ai.runConversation({ system: 's', messages: [{ role: 'user', content: 'x' }] }), null);
  assert.strictEqual(db.anthropicCalls.length, 3);
});
test('Claude : erreur réseau réessayée', async () => {
  const ai = src('ai'); db.anthropicCalls.length = 0; db.anthropic = [() => { throw new Error('réseau coupé'); }, ok200('revenu')];
  assert.strictEqual(await ai.runConversation({ system: 's', messages: [{ role: 'user', content: 'x' }] }), 'revenu');
  assert.strictEqual(db.anthropicCalls.length, 2);
});
test('Claude : réponse tronquée → second essai avec limite doublée', async () => {
  const ai = src('ai'); db.anthropicBodies.length = 0;
  db.anthropic = [() => res(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Début coupé en plein mi' }] }), ok200('Réponse complète.')];
  assert.strictEqual(await ai.runConversation({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 700 }), 'Réponse complète.');
  assert.deepStrictEqual(db.anthropicBodies.map(b => b.max_tokens), [700, 1400]);
});
test('Claude : encore tronquée → coupée à la dernière phrase, balise ouverte retirée', async () => {
  const ai = src('ai');
  const cut = () => res(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: "Bonjour, je suis l'assistant virtuel de la Résidence. Votre arrivée est prévue demain à partir de 15h. Pour le code, il suffit de [[ALERTE:urg" }] });
  db.anthropic = [cut, cut];
  const out = await ai.runConversation({ system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(out, "Bonjour, je suis l'assistant virtuel de la Résidence. Votre arrivée est prévue demain à partir de 15h.");
  assert(!out.includes('[['));
});

// =============== 5. Vérification : une panne Beds24 n'efface plus rien ===============
test('vérification : panne Beds24 = vérification conservée ; réservation vraiment finie = effacée', async () => {
  const { ensureConv } = src('state'); const { identifyWhatsAppGuest } = src('identity'); const { bookingFingerprints } = src('state');
  const phone = '33612340001'; const b = guestBooking();
  db.fail = false; db.active = [b]; db.byId = { 1001: b };
  const conv = ensureConv(phone); conv.verifiedBookingId = 1001;

  assert.strictEqual((await identifyWhatsAppGuest(phone, [], 'bonjour'))?.id, 1001);           // cas normal (remplit le cache)

  offset += 61 * 1000; db.fail = true;                                                          // cache expiré + Beds24 en panne
  assert.strictEqual((await identifyWhatsAppGuest(phone, [], 'bonjour'))?.id, 1001, 'dernière liste connue non utilisée');
  assert.strictEqual(conv.verifiedBookingId, 1001);

  offset += 40 * 60 * 1000;                                                                     // même la dernière liste est trop ancienne
  assert.strictEqual(await identifyWhatsAppGuest(phone, [], 'bonjour'), null);                  // pas de code pour ce message...
  assert.strictEqual(conv.verifiedBookingId, 1001, 'vérification effacée à cause d\'une simple panne');  // ...mais la vérification reste

  db.fail = false; db.active = []; db.byId = {};                                                // Beds24 répond : la réservation n'existe plus
  assert.strictEqual(await identifyWhatsAppGuest(phone, [], 'bonjour'), null);
  assert.strictEqual(conv.verifiedBookingId, null);
  void bookingFingerprints;
});

// =============== 6. Plafond global d'échecs ===============
test('plafond global : vérification suspendue + alerte unique, /valider et voyageurs reconnus épargnés', async () => {
  const sec = src('security'); const idn = src('identity'); const { ensureConv } = src('state');
  sec.rateBuckets.clear(); resetSent(); db.fail = false; offset += 3 * 3600 * 1000;
  const b = guestBooking(); db.active = [b]; db.byId = { 1001: b };
  const text = `Fatima Karim du ${parseInt(b.arrival.slice(8), 10)} au ${parseInt(b.departure.slice(8), 10)} logement 1`;

  assert.strictEqual((await idn.identifyWhatsAppGuest('33612340002', [], text))?.id, 1001, 'vérification normale cassée');

  for (let i = 0; i < 30; i++) idn.noteVerificationFailure('test');
  assert.strictEqual(idn.verificationSuspended(), true);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(ownerMsgs().filter(m => /Trop d.échecs de vérification/.test(m)).length, 1, 'alerte absente ou en double');

  assert.strictEqual(await idn.identifyWhatsAppGuest('33612340003', [], text), null, 'nouveau numéro vérifié malgré la suspension');
  assert.strictEqual((await idn.identifyWhatsAppGuest('33612340002', [], 'bonjour'))?.id, 1001, 'voyageur déjà reconnu pénalisé');
  const c = ensureConv('33612340004'); c.verifiedBookingId = 1001;                              // équivalent d'un /valider
  assert.strictEqual((await idn.identifyWhatsAppGuest('33612340004', [], 'bonjour'))?.id, 1001);

  sec.rateBuckets.clear();
  assert.strictEqual(idn.verificationSuspended(), false);
});

// =============== 7. /valider ===============
test('/valider : refus clairs (futur, statut, panne) et succès avec contrôle', async () => {
  const { handleOwnerCommand } = src('owner-commands'); const { conversations } = src('state');
  src('security').rateBuckets.clear();
  const phone = '33699990001';

  db.fail = false;
  db.byId = { 3001: guestBooking({ id: 3001, arrival: addDays(today, 10), departure: addDays(today, 12) }) };
  resetSent(); await handleOwnerCommand(`/valider b3001 ${phone}`);
  assert(ownerMsgs().some(m => /n'a pas commencé/.test(m) && /Rien n'a été validé/.test(m)), ownerMsgs().join('|'));
  assert(!conversations.get(phone)?.verifiedBookingId);

  db.byId = { 3002: guestBooking({ id: 3002, status: 'request' }) };
  resetSent(); await handleOwnerCommand(`/valider b3002 ${phone}`);
  assert(ownerMsgs().some(m => /statut « request »/.test(m)));

  db.fail = true;
  resetSent(); await handleOwnerCommand(`/valider b3099 ${phone}`); // id jamais consulté (donc pas en cache)
  assert(ownerMsgs().some(m => /injoignable/.test(m)));
  db.fail = false;

  const b = guestBooking({ id: 3003, mobile: '+33611111111' }); db.byId = { 3003: b }; db.active = [b];
  db.anthropic = [ok200('Voici vos informations. Digicode 9999.\n[[ALERTE:aucune]]')];
  resetSent(); await handleOwnerCommand(`/valider b3003 ${phone}`);
  const owner = ownerMsgs();
  assert(owner.some(m => /✅ \+33699990001 validé/.test(m)), owner.join('|'));
  assert(owner.some(m => /⚠️ Ce numéro est différent/.test(m)), 'avertissement de numéro différent absent');
  assert(!owner.some(m => /n'a pas tenu/.test(m)), 'faux message « validation non tenue »');
  assert.strictEqual(String(conversations.get(phone).verifiedBookingId), '3003');
  assert(db.sent.some(m => m.to === phone && /9999/.test(m.text?.body || '')), 'le voyageur n\'a pas reçu ses informations');
  // le prompt envoyé à Claude contenait bien les codes (voyageur vérifié)
  assert(/9999/.test(JSON.stringify(db.anthropicBodies[db.anthropicBodies.length - 1].system)));
});

// =============== 8. Annulations et modifications ===============
test('alertes : création, modification, annulation, demande expirée, séjour passé', async () => {
  const st = src('state'); const w = src('bookings-watch'); const sec = src('security');
  st.seenBookingEvents.clear(); st.bookingFingerprints.clear(); st.runtime.bookingBaselinePending = false; sec.rateBuckets.clear();
  db.fail = false; db.anthropic = [];
  const nowIso = new Date(realNow() + offset).toISOString();
  const mk = over => ({ id: 2001, status: 'confirmed', channel: 'airbnb', bookingTime: nowIso, modifiedTime: nowIso, arrival: addDays(today, 5), departure: addDays(today, 8), roomId: 10, firstName: 'Luc', lastName: 'Martin', ...over });
  const alerts = () => ownerMsgs();
  const pass = async list => { db.modified = list; resetSent(); await w.checkNewBookings(); };

  await pass([mk()]);
  assert.strictEqual(alerts().filter(m => /Nouvelle réservation confirmée/.test(m)).length, 1);
  assert(!alerts().some(m => /MODIFIÉE/.test(m)), 'fausse modification à la création');
  assert(st.bookingFingerprints.has('2001'));

  await pass([mk({ departure: addDays(today, 9) })]);
  const mod = alerts().filter(m => /MODIFIÉE/.test(m));
  assert.strictEqual(mod.length, 1, alerts().join('|'));
  assert(/Avant : .*\n.*Après : /s.test(mod[0]) && /Bégonia|Agate|10/.test(mod[0]));
  await pass([mk({ departure: addDays(today, 9) })]);
  assert.strictEqual(alerts().filter(m => /MODIFIÉE/.test(m)).length, 0, 'modification signalée en double');

  await pass([mk({ departure: addDays(today, 9), status: 'cancelled' })]);
  assert.strictEqual(alerts().filter(m => /ANNULÉE/.test(m)).length, 1, alerts().join('|'));
  await pass([mk({ departure: addDays(today, 9), status: 'cancelled' })]);
  assert.strictEqual(alerts().filter(m => /ANNULÉE/.test(m)).length, 0, 'annulation signalée en double');
  assert(!st.bookingFingerprints.has('2001'));

  await pass([mk({ id: 2002, status: 'inquiry' })]);                                           // demande Airbnb…
  assert.strictEqual(alerts().filter(m => /Demande en attente/.test(m)).length, 1);
  await pass([mk({ id: 2002, status: 'cancelled' })]);                                         // …expirée : pas une annulation
  assert.strictEqual(alerts().filter(m => /ANNULÉE/.test(m)).length, 0, 'demande expirée signalée comme annulation');

  await pass([mk({ id: 2003, status: 'cancelled' })]);                                         // jamais vue, annulée
  assert.strictEqual(alerts().filter(m => /ANNULÉE/.test(m)).length, 1);
  await pass([mk({ id: 2004, status: 'cancelled', arrival: addDays(today, -9), departure: addDays(today, -5) })]); // séjour déjà terminé
  assert.strictEqual(alerts().filter(m => /ANNULÉE/.test(m)).length, 0, 'annulation d\'un séjour passé signalée');
});

test('alertes : empreintes initiales au démarrage, puis modification détectée', async () => {
  const st = src('state'); const w = src('bookings-watch');
  st.bookingFingerprints.clear(); st.seenBookingEvents.clear();
  const nowIso = new Date(realNow() + offset).toISOString();
  const b = { id: 2010, status: 'confirmed', channel: 'booking', bookingTime: '2026-01-01T00:00:00Z', modifiedTime: nowIso, arrival: addDays(today, 20), departure: addDays(today, 22), roomId: 10, firstName: 'Ana', lastName: 'Diaz' };
  db.upcoming = [b];
  assert.strictEqual(await w.seedFingerprints(), 1);
  assert.strictEqual(await w.seedFingerprints(), 0, 'une empreinte existante a été remplacée');
  db.modified = [{ ...b, departure: addDays(today, 25) }]; resetSent(); await w.checkNewBookings();
  assert.strictEqual(ownerMsgs().filter(m => /MODIFIÉE/.test(m)).length, 1, ownerMsgs().join('|'));
});

// =============== 9. Fichiers du projet ===============
test('package.json et fichiers du dépôt', () => {
  const fs = require('fs'); const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.start, 'node server.js');
  assert(pkg.engines.node && !pkg.dependencies['node-fetch']);
  assert(!fs.existsSync(path.join(root, 'public', 'index.html')), 'index.html doit être supprimé');
  assert(/state\.json/.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')));
  assert(/Le Golden Pub/.test(src('prompts').BASE_SYSTEM_PROMPT), 'infos locales de index.html non reprises');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('✔', t.name); }
    catch (e) { failed++; console.log('✘', t.name, '\n   ', (e && e.message || e).toString().split('\n').join('\n    ')); }
  }
  console.log(failed ? `\n${failed} test(s) en échec` : `\n${tests.length} tests OK`);
  process.exit(failed ? 1 : 0);
})();
