# Bureau des agents

Un bureau en 3D où l'on se promène pour voir ses sessions [Claude Code](https://claude.com/claude-code) et Cowork travailler, et un tableau de bord à plat pour les suivre d'un coup d'œil.

Chaque session récente devient un agent assis à son poste. Il tape quand il travaille, lève la main quand il t'attend, et va faire la sieste au canapé quand il est en pause. Tout est lu sur ta machine, dans les transcripts de Claude Code : rien n'est envoyé ailleurs.

## Démarrage

Il faut [Node.js](https://nodejs.org) 18 ou plus (sur Mac : `brew install node`, ou l'installateur du site), et avoir déjà utilisé Claude Code ou Cowork sur la machine. Il n'y a rien d'autre à installer.

```bash
git clone https://github.com/tommybds/bureau-des-agents.git
cd bureau-des-agents
npm start
```

Puis ouvre :

- http://localhost:4317 pour le bureau en 3D ;
- http://localhost:4317/dashboard pour le tableau de bord à plat.

Sans session récente, ajoute `?demo` à l'adresse pour voir des agents fictifs.

Chacun voit ses propres sessions : le serveur lit les transcripts de la machine où il tourne (`~/.claude/projects` pour Claude Code, le dossier de l'app Claude pour Cowork).

Testé sur macOS. Le reste devrait fonctionner sous Linux et Windows, sauf le bouton « Ouvrir dans le Terminal », propre à macOS. Le bureau 3D charge Three.js depuis un CDN et a donc besoin d'internet ; le tableau de bord, non.

## Tableau de bord à plat

Une page légère, sans 3D, lisible sur téléphone :

- **Ils t'attendent** : en haut, avec un chrono d'attente, le dernier message et les boutons pour répondre.
- **Au travail** : une ligne par agent (projet, action en cours, erreur éventuelle, avancement des tâches).
- **Aujourd'hui, comparé à hier** : tokens, actions, réponses, sessions, temps de travail, coût estimé.
- **Graphiques** : activité par heure, et historique sur 14, 30 ou 90 jours, par semaine ou par mois (tokens, coût, temps ou actions), avec le total de la période.
- **Cumuls** : aujourd'hui, 7 jours, 30 jours, mois en cours et tout l'historique.
- **Frise de la journée** : une ligne par session (travaille, t'attend, en pause).
- **Par projet** : tokens, temps de travail et coût, pour aujourd'hui, 7 jours ou 30 jours.

L'onglet affiche le nombre d'agents qui t'attendent, par exemple « (3) Bureau des agents ».

**Coût estimé** : calculé à partir des tokens au tarif public de l'API, modèle par modèle et cache compris, puis converti en euros au taux BCE du jour. Ce n'est pas le prix d'un abonnement Claude. Les tarifs sont écrits dans `server.js` ; `config.json` peut les corriger.

**Temps de travail** : périodes où un agent enchaîne les réponses à moins de 5 minutes d'écart.

## Le bureau en 3D

Une pièce carrée dans un immeuble de bureaux, qui grandit avec le nombre d'agents (40 au maximum) :

- **Postes de travail** le long des murs, sous de hautes fenêtres à stores. Chaque projet a sa zone, avec un tapis à sa couleur et un écran de stats suspendu.
- **Coin salon et cuisine** : futon, fauteuils, machine à café, micro-ondes, bibliothèque. Les agents en pause s'y installent, changent de place et discutent devant le café.
- **Grand écran** des stats du jour et **tableau blanc** des tâches des agents.
- **Couloir et salle de réunion** : la porte est ouverte, on peut sortir. Le couloir dessert les bureaux voisins, deux escaliers, un ascenseur et les plateaux aux deux bouts ; un plan d'évacuation indique où l'on est. La salle de réunion affiche l'historique par semaine et par mois.
- **Le reste de l'immeuble** : l'ascenseur et l'escalier descendent au hall du rez-de-chaussée, d'où l'on sort sur le parking et la rue ; l'autre escalier monte au toit-terrasse.
- **Dehors** : façade en mosaïque de panneaux, parking devant, rue, arbres, bâtiments voisins et la ville au loin. Le jour et la nuit suivent l'heure réelle.
- **Vue d'ensemble** : les étages du dessus et le toit s'effacent, on voit tout le plan de l'étage comme une maquette.

### Les agents

- **Au travail** : l'animation dépend de l'outil. Ils lisent un livre pour Read, tapent vite pour Edit, se tournent vers leur portable pour le Terminal, sortent la loupe pour Grep ou Glob, et leur antenne clignote pour le web. Quand ils réfléchissent, une bulle affiche leur dernier message.
- **Sous-agents** : de petits robots font l'aller-retour jusqu'à la bibliothèque.
- **Erreur** : un nuage d'orage apparaît au-dessus de l'écran.
- **Fin de tâche** : confettis, puis main levée (« À toi ! ») et un « ding ».
- **En pause** : sieste au canapé, café, lecture, imprimante, ou un regard par la fenêtre.
- **Bureau qui s'encombre** (papiers, mugs) avec le nombre d'actions de la journée.

### Se déplacer

| Touche | Action |
|---|---|
| ZQSD / WASD, souris | marcher (Maj pour courir) |
| `E` / clic | fiche d'un agent, ou agir sur un objet |
| `V` | vue d'ensemble (tourner, zoomer, déplacer) |
| `I` | maquette isométrique ; réappuyer pour tourner d'un quart de tour |
| `F` | suivre l'agent visé par-dessus son épaule |
| `R` | lire l'écran de l'agent en gros plan |
| `O` | visite automatique des agents actifs |
| `T` | accélérer le temps |
| `M` | couper le son |
| `Échap` | revenir à la marche |

Sur téléphone : pouce gauche pour marcher, glisser pour regarder, toucher un agent ou un objet, et une barre de boutons pour les vues.

La mini-carte montre les zones, les agents et ta position ; un clic dessus t'y emmène. Les filtres n'affichent qu'un projet ou masquent les agents en pause.

### Objets avec lesquels agir

| Objet | Action |
|---|---|
| Porte | l'ouvrir ou la fermer |
| Machine à café | faire un café (compteur de cafés du jour) |
| Micro-ondes | le lancer |
| Interrupteur près de la porte | éteindre ou allumer la lumière |
| Fenêtres | baisser ou remonter le store |
| Imprimante | imprimer le rapport du jour, pour de vrai si tu veux |
| Futon, fauteuils, postes libres | s'asseoir ; avancer pour se relever |
| Grand écran, tableau des tâches, écran de la salle de réunion | les regarder de près |
| Ascenseur | l'appeler, puis descendre au rez-de-chaussée ou remonter |
| Escaliers | descendre au hall, ou monter sur le toit-terrasse |
| Toilettes, au bout du couloir | y entrer : chasse d'eau, lavabos, sèche-mains |
| Tableau des occupants, dans le hall | le lire |
| Plan d'évacuation | le regarder de près |
| Distributeur du couloir | acheter un snack |

## Répondre à un agent

Dans la fiche d'un agent ou dans le tableau de bord, **Envoyer via le Terminal** ouvre une fenêtre Terminal qui lance `claude --resume <session>` avec ta réponse : tu vois exactement ce qui est envoyé. Si la session est encore ouverte dans l'app Claude, réponds plutôt là-bas, pour ne pas créer deux conversations parallèles. macOS uniquement ; ailleurs, utilise « Copier la commande ». La première fois, macOS demande d'autoriser le contrôle du Terminal. Les sessions Cowork, elles, se reprennent dans l'app Claude.

## Personnaliser

Tout est facultatif. Sans réglage, c'est le bureau d'origine : 4e étage d'un immeuble de Saint-Herblain, fenêtres à l'est, météo en direct de Saint-Herblain (réglage dans `exemples/bureau-saint-herblain.json`).

Pour un décor neutre ou ton propre lieu, pars de l'exemple et adapte-le :

```bash
cp config.example.json config.json
```

| Clé | Rôle |
|---|---|
| `lieu.nom`, `lieu.latitude`, `lieu.longitude` | active la météo en direct de cet endroit ([Open-Meteo](https://open-meteo.com), gratuit et sans clé) : vrais lever et coucher du soleil, nuages, pluie, neige, orage, température |
| `lieu.fenetres` | côté où donnent les fenêtres : `est`, `sud`, `ouest` ou `nord`. Décide à quelle heure le soleil entre |
| `batiment.etage`, `batiment.etages` | notre étage et le nombre d'étages de l'immeuble (4 et 5 dans le réglage d'origine) |
| `decor` | `mon-bureau` (réglage d'origine : affiche, motos devant l'entrée) ou `neutre` |
| `costumes` | costume par projet, par exemple `{ "MON-PROJET": "pecheur" }` (casque, chemise bleue, canne à pêche) |
| `tarifs` | corrige ou ajoute un tarif de modèle, par exemple `{ "claude-opus-5-5": { "in": 4, "out": 20, "read": 0.2 } }` en dollars par million de tokens |

`config.json` n'est pas versionné ; dès qu'il existe, il remplace entièrement le réglage par défaut.

Variables d'environnement :

| Variable | Rôle |
|---|---|
| `PORT` | port du serveur (4317 par défaut) |
| `WINDOW_HOURS` | sessions affichées si elles ont bougé dans les N dernières heures (12 par défaut) |
| `CLAUDE_PROJECTS_DIR` | dossier des transcripts (`~/.claude/projects` par défaut) |
| `COWORK_DIR`, `COWORK=off` | dossier des sessions Cowork (celui de l'app Claude par défaut), ou ne pas les lire |
| `HISTORY_DAYS` | jours affichés sur les écrans 3D (14 par défaut) |
| `HISTORY_BACKFILL` | jours reconstitués au premier lancement (400 par défaut) |
| `EUR_PER_USD` | force le taux de change |
| `WEATHER=off` | coupe les appels réseau (météo et taux de change) |

Dans l'adresse : `?demo` pour des agents fictifs, `?heure=22` pour fixer l'heure, `?meteo=pluie` (ou `orage`, `neige`, `nuageux`, `brouillard`, `clair`) pour prévisualiser une météo.

## Historique

Le serveur garde un historique jour par jour dans `data/stats-history.json` : tokens, coût, temps de travail, réponses, actions, sessions, outils, fichiers et détail par projet.

- Au premier lancement, il reconstitue tout ce que les transcripts permettent (quelques secondes).
- Ensuite, les jours passés sont archivés et ne sont plus relus. Seuls hier et aujourd'hui sont recalculés à chaque démarrage.
- Claude Code finit par supprimer ses vieux transcripts. Ce qui est archivé ici est conservé (800 jours), à condition de lancer le serveur de temps en temps.

## Depuis le téléphone (wifi)

```bash
npm run lan
```

Le serveur affiche alors un lien avec une clé secrète, à ouvrir une fois depuis le téléphone, sur le même wifi. Sans ce lien, l'accès est refusé. Depuis le wifi, on peut tout regarder mais pas ouvrir de Terminal. La connexion n'est pas chiffrée : à réserver à un réseau de confiance.

## Confidentialité et sécurité

- Le serveur **lit seulement** `~/.claude/projects`. Il n'écrit que dans `data/`.
- Par défaut, il n'écoute que sur la machine (127.0.0.1). Les pages affichent les titres de sessions, des demandes et des extraits de réponses : ne l'expose pas sur internet.
- `data/` contient des noms de projets et de fichiers, et la clé du mode wifi. Il est exclu du dépôt, comme `config.json`.
- La route qui ouvre le Terminal exige un jeton généré au démarrage, refuse les requêtes venant d'autres sites et n'est jamais accessible depuis le wifi.
- Seuls appels sortants : le CDN de Three.js, Open-Meteo pour la météo du lieu réglé (Saint-Herblain par défaut), et frankfurter.app pour le taux de change. `WEATHER=off` coupe les deux derniers.

## Organisation du code

| Fichier | Rôle |
|---|---|
| `server.js` | serveur sans dépendance : lecture des transcripts, stats, historique, météo, accès wifi |
| `public/index.html`, `public/app.js` | le bureau en 3D (Three.js) |
| `public/dashboard.html` | le tableau de bord à plat |
| `config.example.json`, `exemples/` | réglages |

## Licence

MIT, voir [LICENSE](LICENSE).
