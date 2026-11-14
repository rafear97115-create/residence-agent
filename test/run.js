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
process.env.EMERGENCY_PHONE = '0699887766';            // faux numéro de test
process.env.ADDRESS_FULL = '1 rue Exemple, 02100 Saint-Quentin'; // fausse adresse de test
process.env.PRIVACY_URL = 'https://exemple.test/donnees-personnelles';

const assert = require('assert');
const path = require('path');
const src = f => require(path.join(__dirname, '..', 'src', f));

// ---------- Simulation du réseau ----------
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const db = { active: [], upcoming: [], modified: [], stays: [], byId: {}, fail: false, anthropic: [], sent: [], anthropicCalls: [], anthropicBodies: [] };
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
  if (url.includes('departureFrom=') && url.includes('&arrivalTo=') && !url.includes('status=')) return res(200, { data: db.stays }); // /sejour
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


// =============== 9. Correctifs de la version 1.2 ===============
const spray = names => `Bonjour logement 1 du {A} au {D}. ${names}`;
const SURNAMES = 'martin bernard thomas petit robert richard durand dubois moreau laurent simon michel lefebvre leroy roux david bertrand morel fournier girard bonnet lambert fontaine rousseau vincent muller faure andre mercier blanc guerin boyer garnier chevalier francois legrand gauthier garcia perrin robin clement morin nicolas henry roussel mathieu gautier masson marchand duval denis dumont marie lemaire noel meyer dufour meunier brun blanchard giraud joly riviere lucas brunet gaillard barbier arnaud martinez gerard roche renard schmitt roy leroux colin vidal caron picard roger fabre aubert lemoine renaud dumas lacroix olivier philippe bourgeois pierre benoit rey leclerc';
const dayOf = d => String(parseInt(d.slice(8, 10), 10));

test('identité : une liste de noms ne valide personne ; le vrai voyageur reste reconnu', async () => {
  const idn = src('identity'); const sec = src('security'); const { conversations } = src('state');
  sec.rateBuckets.clear(); db.fail = false; offset += 61 * 1000;
  const b1 = guestBooking({ id: 4001, lastName: 'Karim', arrival: today, departure: addDays(today, 3) });
  const b2 = guestBooking({ id: 4002, firstName: 'Anne', lastName: 'Dupont', arrival: addDays(today, -1), departure: addDays(today, 4) });
  db.active = [b1, b2]; db.byId = { 4001: b1, 4002: b2 };
  const fill = t => t.replace('{A}', dayOf(b1.arrival)).replace('{D}', dayOf(b1.departure));

  // légitime : son nom, ses dates, son logement
  assert.strictEqual((await idn.identifyWhatsAppGuest('33600010001', [], fill('Fatima Karim du {A} au {D} logement 1')))?.id, 4001);
  // liste de noms (contient "karim" ET "dupont") + bonnes dates + bon logement, depuis un numéro sans rapport : refusé
  assert.strictEqual(await idn.identifyWhatsAppGuest('33600010002', [], fill(spray(SURNAMES + ' karim dupont'))), null, 'liste de noms acceptée');
  assert((conversations.get('33600010002')?.failedAttempts || 0) >= 1, 'la tentative n\'est pas comptée comme échec');
  // la fonction elle-même
  const ctx = idn.buildWaCtx('33600010003', fill('karim dupont'), new Map([['10', 1]]));
  assert.strictEqual(idn.detectNameSpray([b1, b2], ctx), true);
  assert.strictEqual(idn.detectNameSpray([b1, b2], idn.buildWaCtx('33600010003', 'je suis karim', new Map())), false);
  // deux réservations au même nom de famille = une seule personne : pas de fausse alerte
  const b3 = guestBooking({ id: 4003, firstName: 'Samir', lastName: 'Karim' });
  assert.strictEqual(idn.detectNameSpray([b1, b3], idn.buildWaCtx('x', 'karim', new Map())), false);
  sec.rateBuckets.clear();
});

test('identité : un prospect qui demande des dates n\'est plus bloqué ; une vraie devinette l\'est toujours', async () => {
  const idn = src('identity'); const sec = src('security'); const { conversations, isLocked } = src('state');
  sec.rateBuckets.clear(); db.fail = false; offset += 61 * 1000;
  const b = guestBooking({ id: 4101, lastName: 'Karim', arrival: today, departure: addDays(today, 2) });
  db.active = [b]; db.byId = { 4101: b };
  const d1 = dayOf(addDays(today, 10)), d2 = dayOf(addDays(today, 13));

  const prospect = '33600020001';
  for (let i = 0; i < 8; i++) await idn.identifyWhatsAppGuest(prospect, [], `Avez-vous une chambre du ${d1} au ${d2} ? logement 3 si possible`);
  assert.strictEqual(isLocked(conversations.get(prospect)), false, 'prospect bloqué');
  assert.strictEqual(conversations.get(prospect).failedAttempts || 0, 0, 'prospect compté comme tentative de devinette');
  assert.strictEqual(idn.verificationFailureCount(), 0, 'prospect compté dans le plafond global');

  // devinette : le bon nom de famille avec de mauvaises dates, 5 fois
  const guesser = '33600020002';
  for (let i = 0; i < 5; i++) await idn.identifyWhatsAppGuest(guesser, [], `Karim du ${d1} au ${d2} logement 3`);
  assert.strictEqual(isLocked(conversations.get(guesser)), true, 'devinette non bloquée');
  sec.rateBuckets.clear();
});

test('numéro d\'urgence : absent des consignes des non-vérifiés, filtré en sortie, donné aux vérifiés', () => {
  const { buildSystemPrompt, ensurePrivacyNote } = src('prompts'); const { applyPhonePolicy: P } = src('security');
  const propInfo = { digicode: '4821', wifi_password: 'w', rooms: [] };
  const KEY = '699887766';
  for (const opts of [{ channel: 'web' }, { channel: 'whatsapp' }, { channel: 'platform' }, { channel: 'whatsapp', locked: true }])
    assert(!buildSystemPrompt({ propInfo, ...opts }).replace(/\D/g, '').includes(KEY), `numéro dans le prompt (${JSON.stringify(opts)})`);
  const verified = buildSystemPrompt({ propInfo, channel: 'whatsapp', booking: guestBooking() });
  assert(verified.includes('0699887766'), 'le voyageur vérifié ne reçoit pas le numéro');
  for (const t of ['Appelez le 06 99 88 77 66', 'Appelez le 06.99.88.77.66', 'Appelez le +33 6 99 88 77 66', 'Appelez le 0033699887766', 'Appelez le 06-99-88-77-66', 'Appelez le 0 6 9 9 8 8 7 7 6 6', 'Appelez le +33 (0)6 99 88 77 66'])
    assert(!P(t, false).replace(/\D/g, '').includes(KEY) && /réservé/.test(P(t, false)), `numéro non masqué : ${t}`);
  assert.strictEqual(P('Appelez le 06 99 88 77 66', true), 'Appelez le 06 99 88 77 66');
  assert.strictEqual(P('Arrivée à 15h, 3 nuits, réservation 95878640', false), 'Arrivée à 15h, 3 nuits, réservation 95878640'); // pas de faux positif
  assert.strictEqual(P('Appelez le 07 11 22 33 44', false), 'Appelez le 07 11 22 33 44'); // un autre numéro n'est pas touché
  // aucune donnée personnelle du propriétaire en dur dans le code source
  const fs = require('fs'); const root = path.join(__dirname, '..');
  const files = ['server.js', ...fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => 'src/' + f), ...fs.readdirSync(path.join(root, 'src', 'routes')).map(f => 'src/routes/' + f)];
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!/\b0[67](?:[ .]?\d{2}){4}\b/.test(code), `numéro de téléphone en dur dans ${f}`);
    assert(!/\b11 rue de l'Industrie/i.test(code), `adresse exacte en dur dans ${f}`);
  }
  // note « données personnelles » : une fois, avant la signature
  const out = ensurePrivacyNote("Bonjour.\n\n— Assistant virtuel de la Résidence de l'Industrie", false);
  assert(/donnees-personnelles/.test(out) && out.trim().endsWith("de la Résidence de l'Industrie") && out.indexOf('donnees-personnelles') < out.indexOf('— Assistant'));
  assert.strictEqual(ensurePrivacyNote('Bonjour', true), 'Bonjour');
});

test('lien Airbnb unique (et plus de lien par logement)', () => {
  const { bookingFormatRules, BASE_SYSTEM_PROMPT, buildSystemPrompt } = src('prompts'); const { AIRBNB_URL } = src('config');
  const all = bookingFormatRules() + BASE_SYSTEM_PROMPT + buildSystemPrompt({});
  assert(AIRBNB_URL.startsWith('https://airbnb.com/h/'));
  assert.strictEqual((bookingFormatRules().match(/airbnb\.com/g) || []).length, 1);
  assert(!/rdi-begonia2|rdi-capucine3|rdi-daliha4|rdi-eglantine5/.test(all), 'ancien lien par logement encore présent');
});

test('chat du site : aucune vérification, aucune fuite, numéro d\'urgence filtré', async () => {
  const sec = src('security'); sec.rateBuckets.clear(); db.fail = false; resetSent();
  const handlers = {}; src('routes/chat').register({ post: (p, h) => { handlers[p] = h; } });
  const answer = async body => {
    let out; const r = { status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; } };
    await handlers['/api/chat']({ get: h => (h.toLowerCase() === 'origin' ? 'https://www.locations-residence-industrie.fr' : ''), body, ip: '9.9.9.9' }, r);
    return out;
  };
  const b = guestBooking({ id: 4201, lastName: 'Karim', mobile: '+33611111111' }); db.active = [b]; db.byId = { 4201: b }; offset += 61 * 1000;
  db.anthropicBodies.length = 0;
  db.anthropic = [ok200('Appelez le 06 99 88 77 66, digicode 4821, 1 rue Exemple, 02100 Saint-Quentin.\n[[ALERTE:aucune]]')];
  const r = await answer({ messages: [{ role: 'user', content: 'Bonjour' }], guestName: 'Fatima Karim', guestPhone: '0611111111', guestEmail: 'abc@guest.airbnb.com' });
  assert.strictEqual(r.code, 200);
  assert(!('guestVerified' in r.body), 'le chat annonce encore une vérification');
  const text = r.body.content[0].text;
  assert(!/6 99 88|4821|1 rue Exemple/.test(text), text);
  const sys = JSON.stringify(db.anthropicBodies[0].system);
  assert(!/Fatima|Karim|0611111111|VISITEUR RECONNU/.test(sys) && !/4821/.test(sys), 'des données de réservation sont dans le prompt du chat');
});

test('panne Beds24 : message Airbnb/Booking = simple alerte, aucune réponse du bot', async () => {
  const pl = src('platforms'); const sec = src('security');
  sec.rateBuckets.clear(); resetSent(); db.anthropicCalls.length = 0;
  const msg = { id: 'm-down-1', bookingId: 9876543, source: 'guest', time: new Date(realNow() + offset).toISOString(), message: 'Bonjour, le code ne marche pas' };
  db.fail = true;
  await pl.handleBeds24Group('T', null, '9876543', [msg], [msg]);
  db.fail = false;
  assert.strictEqual(db.anthropicCalls.length, 0, 'le bot a répondu malgré la panne');
  assert(ownerMsgs().some(m => /Beds24 injoignable/.test(m) && /9876543/.test(m) && /le code ne marche pas/.test(m)), ownerMsgs().join('|'));
  assert(pl.processedMessages.has('m-down-1'), 'le message sera traité en retard par-dessus la réponse du propriétaire');
});

test('/sejour : trois parties (départs ce jour, en cours, à venir)', async () => {
  const { handleOwnerCommand } = src('owner-commands');
  src('security').rateBuckets.clear(); db.fail = false; resetSent(); offset += 61 * 1000;
  const mk = (id, last, a, d) => ({ id, status: 'confirmed', channel: 'airbnb', firstName: 'X', lastName: last, arrival: addDays(today, a), departure: addDays(today, d), roomId: 10 });
  db.stays = [mk(5001, 'Partant', -3, 0), mk(5002, 'Encours', -1, 2), mk(5003, 'Arrivant', 0, 2), mk(5004, 'Futur', 5, 8)];
  await handleOwnerCommand('/sejour');
  const m = ownerMsgs().find(t => /SÉJOURS/.test(t)) || '';
  const iDep = m.indexOf('Départs ce jour'), iCur = m.indexOf('En cours'), iUp = m.indexOf('À venir (30 prochains jours)');
  assert(iDep > 0 && iCur > iDep && iUp > iCur, m);
  const part = (a, b) => m.slice(a, b);
  assert(/Partant/.test(part(iDep, iCur)) && !/Encours|Arrivant|Futur/.test(part(iDep, iCur)), 'départs ce jour');
  assert(/Encours/.test(part(iCur, iUp)) && /Arrivant/.test(part(iCur, iUp)) && !/Partant|Futur/.test(part(iCur, iUp)), 'en cours');
  assert(/Futur/.test(part(iUp)) && !/Partant|Encours|Arrivant/.test(part(iUp)), 'à venir');
  db.stays = [];
});

test('conservation : voyageur vérifié 30 jours, numéro bloqué plus longtemps, le reste 24 h', () => {
  const st = src('state');
  assert.strictEqual(st.convTtl({ verifiedBookingId: 1 }), 30 * 24 * 3600 * 1000);
  assert.strictEqual(st.convTtl({ locked: true, verifiedBookingId: 1 }), st.DURABLE_TTL_MS);
  assert.strictEqual(st.convTtl({}), st.MEMORY_TTL_MS);
});

// =============== 10. Fichiers du projet ===============
test('package.json et fichiers du dépôt', () => {
  const fs = require('fs'); const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.start, 'node server.js');
  assert(/22/.test(pkg.engines.node) && !pkg.dependencies['node-fetch'], 'Node 22 attendu');
  assert.strictEqual(pkg.version, '1.2.0');
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
