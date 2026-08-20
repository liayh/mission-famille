# 🧭 Mission Famille

Application web pour suivre les missions du quotidien de vos enfants (ménage, devoirs) et débloquer des récompenses (télé, Nintendo Switch, cinéma, restaurant) en fonction des points gagnés.

- **100% autonome** : une page HTML/CSS/JS, sans compte ni backend.
- **Données locales** : tout est stocké dans le navigateur (`localStorage`), rien n'est envoyé sur internet.
- **Protégée par code PIN** : les réglages et la validation des récompenses nécessitent un code à 4 chiffres connu des parents. Le code est haché (SHA-256) avant d'être stocké.
- **Installable** : l'application peut être ajoutée à l'écran d'accueil (mobile ou ordinateur) et fonctionne hors-ligne une fois chargée une première fois.
- **Notifications, statistiques et sauvegarde** : alerte optionnelle quand un enfant demande une récompense, suivi des points/série de jours dans un nouveau panneau **📈 Statistiques**, et rappel automatique de sauvegarde si vous n'avez pas exporté depuis un moment.

## ⚠️ Bon à savoir avant de démarrer

Comme l'application ne stocke les données que dans le navigateur de l'appareil utilisé :

- Si vos enfants utilisent des appareils différents, chacun aura **son propre carnet séparé** (les données ne se synchronisent pas automatiquement entre appareils).
- Le plus simple : ouvrir l'application sur **un seul appareil partagé** (tablette familiale, PC du salon).
- Pensez à faire une sauvegarde régulière via *Réglages → Sécurité → Exporter les données*, surtout avant de vider le cache du navigateur ou de changer d'appareil. Le fichier exporté peut être réimporté à tout moment. Un bandeau de rappel apparaît automatiquement si aucune sauvegarde n'a été faite depuis 14 jours.
- Si un jour vous voulez un vrai accès multi-appareils synchronisé (ex. un compte par enfant, accessible depuis plusieurs téléphones), il faudra ajouter une base de données en ligne (ex. Firebase) — je peux vous aider à faire évoluer le projet dans cette direction si besoin.

## 🚀 Mettre l'application en ligne avec GitHub Pages (gratuit)

1. **Créer un compte GitHub** si vous n'en avez pas : https://github.com/signup
2. **Créer un nouveau dépôt** :
   - Cliquez sur le bouton **+** en haut à droite → *New repository*.
   - Nom suggéré : `mission-famille`.
   - Laissez-le en **Public** (nécessaire pour GitHub Pages gratuit) — rassurez-vous, vos données (points, prénoms) ne sont jamais envoyées sur GitHub, seul le code de l'application y est hébergé.
   - Cliquez sur *Create repository*.
3. **Envoyer les fichiers** :
   - Sur la page du dépôt fraîchement créé, cliquez sur *uploading an existing file*.
   - Glissez-déposez les 7 fichiers : `index.html`, `style.css`, `app.js`, `README.md`, `manifest.webmanifest`, `sw.js`, `icon.svg`.
   - Cliquez sur *Commit changes*.
4. **Activer GitHub Pages** :
   - Allez dans l'onglet **Settings** du dépôt.
   - Dans le menu de gauche, cliquez sur **Pages**.
   - Sous *Build and deployment* → *Source*, choisissez **Deploy from a branch**.
   - Sélectionnez la branche **main** et le dossier **/ (root)**, puis **Save**.
   - Patientez 1 à 2 minutes : une bannière verte affichera l'adresse de votre site, du type :
     `https://votre-pseudo.github.io/mission-famille/`
5. **Ouvrir l'application** à cette adresse, sur l'appareil que vos enfants utiliseront.

### Mettre à jour l'application plus tard

Si je vous fournis une nouvelle version des fichiers, il suffit de les re-uploader dans le dépôt (même procédure qu'à l'étape 3) : GitHub Pages se met à jour automatiquement en 1 à 2 minutes. Vos données restant dans le navigateur, elles ne sont pas affectées par une mise à jour du code.

## 🔐 Première utilisation

1. À l'ouverture, cliquez sur **Configurer maintenant** pour ajouter votre premier enfant (prénom + avatar).
2. Dès qu'une action sensible est demandée (réglages, validation d'une récompense), l'application vous demande de **créer un code parent à 4 chiffres**. Choisissez-en un que les enfants ne devineront pas facilement.
3. Dans **⚙️ Réglages** :
   - **Enfants** : ajouter/modifier/supprimer, réinitialiser les points.
   - **Missions** : des tâches de ménage et devoirs par défaut sont déjà créées (modifiables), avec leur valeur en points. Une mission peut être limitée aux "jours d'école" (lundi-vendredi), pratique pour les devoirs.
   - **Récompenses** : télé (15 pts), Nintendo Switch (25 pts), cinéma (50 pts), restaurant (80 pts) par défaut — coûts et icônes entièrement personnalisables.
   - **Sécurité** : changer le code, activer les notifications de demandes, exporter/importer une sauvegarde, tout réinitialiser.

## 🎮 Utilisation au quotidien

- Chaque enfant a son propre onglet (avatar avec un anneau qui se remplit selon les missions du jour accomplies).
- L'enfant (ou le parent) coche les missions faites → les points s'ajoutent automatiquement à son total.
- Le panneau **Récompenses** affiche la progression vers chaque récompense ; une fois le seuil atteint, le bouton **Utiliser** se débloque.
- Valider l'utilisation d'une récompense demande le **code parent**, pour éviter qu'un enfant se l'accorde tout seul.
- Le **journal des récompenses** en bas de page garde l'historique de ce qui a été utilisé et quand.
- Le panneau **📈 Statistiques** affiche la série de jours consécutifs réussis (🔥) et les points gagnés semaine par semaine.
- Après une action sensible (suppression, validation, réinitialisation), un bouton **Annuler** reste disponible quelques secondes en bas de l'écran en cas d'erreur.
- Dans *Réglages → Sécurité*, activez les **notifications** pour être alerté dès qu'un enfant demande une récompense (nécessite l'autorisation du navigateur).

## 📲 Installer l'application sur l'écran d'accueil

Une fois le site ouvert dans le navigateur (Chrome, Edge, Safari...), une option *Ajouter à l'écran d'accueil* ou *Installer l'application* est proposée (menu du navigateur ou icône dans la barre d'adresse). L'application s'ouvre alors comme une app à part entière et reste utilisable même sans connexion internet, une fois chargée une première fois.

## 🛠️ Personnaliser le design

Toutes les couleurs, polices et styles sont dans `style.css` (variables en haut du fichier sous `:root`). La logique de l'application est dans `app.js`, commentée par sections.

---

Fait avec Claude 🧭
