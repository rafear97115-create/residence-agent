# Modifications

## Réduction du nombre de variables Render
- **Variable `SECRETS`** (nouveau fichier `src/secrets.js`, chargé en premier par `server.js`) : un seul JSON peut remplacer toutes les autres variables
  (ex. `{"ANTHROPIC_KEY":"...","WHATSAPP_TOKEN":"..."}`). Une variable Render séparée du même nom reste prioritaire.
- **Identifiants non secrets en dur** dans `config.js` : `OWNER_PHONE`, `WHATSAPP_PHONE_ID`, `TELEGRAM_CHAT_ID`, `WHATSAPP_ALERT_TEMPLATE(_LANG)`.

## Version du 12/11/2026
1. **Alerte de nouvelle réservation Airbnb / Booking** : seules les demandes en attente et les réservations directes (site) étaient signalées ;
   une réservation Airbnb/Booking confirmée d'emblée (réservation instantanée, ou demande acceptée) ne déclenchait aucune alerte.
   Nouveau type d'alerte « ✅ Nouvelle réservation confirmée (Airbnb / Booking) » (`bookingEventKind` → `'confirmed'`), avec la commande `/repondre bID`.
   Une demande déjà signalée puis acceptée est signalée à nouveau comme confirmée, même si la demande a plus de 12 h.
2. **Réponse du bot incohérente** : pour une réservation confirmée dont le séjour n'a pas commencé, le bot traitait le voyageur comme un prospect
   (« indiquez-moi vos dates, je vérifie les disponibilités »). Il connaît maintenant la réservation (logement, dates, plateforme), ne propose plus
   de réserver, et ne donne toujours aucun code avant le séjour (`knownBookingRules` dans `prompts.js`).
3. **Nouvelle commande `/sejour [jours]`** : séjours en cours et à venir (30 jours par défaut, 365 au maximum), avec logement, voyageur, plateforme, dates,
   numéro de réservation et téléphone si connu. Ajoutée à `/aide`.

## Découpage
`server.js` (point d'entrée inchangé : `node server.js`) + `src/` en 19 modules. Tous les exports de l'ancien fichier sont conservés
(80 comparaisons identiques ancien/nouveau sur les fonctions pures). `package.json`, `public/` et le fichier d'état ne changent pas de place.

## Corrections
1. Vérification WhatsApp : un numéro écrit dans le message ne compte plus ; seul le numéro réel de l'expéditeur compte comme « téléphone ».
2. Jeton Telegram : plus jamais écrit dans les logs (`scrub`).
3. `/pause` : les messages du voyageur (texte ou autre) sont transférés au propriétaire avec les commandes `/repondre` et `/reprise`.
4. `/repondre` : destinataire obligatoire (plus de dernière conversation par défaut). `/pause` et `/reprise` gardent le défaut.
5. Chat web : seuls les messages du visiteur sont lus (10 derniers). Filet en sortie : digicode / Wi-Fi / codes jamais renvoyés.
6. Anciens voyageurs : email exact et réel, statut `confirmed`, séjours déjà commencés, sans blocages ni doublons, cache 30 min.
   Nouvelles variables : `FORMER_GUEST_STATUSES`, `FORMER_GUEST_PAST_ONLY=off`.
7. Adresse : filtre durci (apostrophes, espaces, « lindustrie », n°, bis, St-Quentin, anglais, caractères invisibles).

## À savoir
- `sanitizeChatMessages` ne renvoie plus que des tours « user » : adapter un éventuel test qui attend des tours « assistant ».
- Les voyageurs Airbnb/Booking (adresse relais) ne sont plus comptés comme « anciens » (compte = 0).
- Non fait : exiger `/valider` quand le numéro diffère de la réservation ; nom + séjour deviné reste possible.
