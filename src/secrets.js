/*
 * secrets.js — Regroupe plusieurs variables d'environnement dans UNE seule variable Render : SECRETS
 * (utile sur l'offre gratuite de Render, où le nombre de variables est limité).
 *
 * SECRETS doit contenir un objet JSON, par exemple :
 *   {"ANTHROPIC_KEY":"sk-ant-...","WHATSAPP_TOKEN":"EAA...","WHATSAPP_APP_SECRET":"...","ADMIN_KEY":"..."}
 *
 * Règles :
 * - Une variable Render séparée du même nom reste PRIORITAIRE sur celle de SECRETS.
 * - Ce fichier doit être chargé en tout premier (première ligne require de server.js).
 * - Les valeurs ne sont jamais affichées dans les logs, seulement le nom des clés chargées.
 */

(function loadSecrets() {
  const raw = process.env.SECRETS;
  if (!raw || !raw.trim()) return;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.error('⛔ SECRETS n\'est pas un JSON valide (' + e.message.substring(0, 80) + ') : ignoré. Vérifiez les guillemets doubles et les virgules.');
    return;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.error('⛔ SECRETS doit être un objet JSON {"NOM":"valeur",...} : ignoré.');
    return;
  }
  const loaded = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || key === 'SECRETS') continue;
    if (value === null || typeof value === 'object') continue;
    if (process.env[key] !== undefined && process.env[key] !== '') continue; // la variable Render séparée gagne
    process.env[key] = String(value);
    loaded.push(key);
  }
  console.log('🔐 SECRETS chargé : ' + (loaded.length ? loaded.join(', ') : 'aucune clé'));
})();
