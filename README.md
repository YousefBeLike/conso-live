# conso-live

Plugin Claude Code : un widget au-dessus de la zone de saisie qui affiche ta consommation de tokens Claude en direct, avec un panneau de détail à la demande.

## Le widget

Une ligne discrète au-dessus de la barre d'écriture, sans cadre, au style de Claude Desktop. Chaque mesure a un petit donut qui se remplit, avec son nom et son chiffre à côté :

- **Discussion** : le total de tokens, qui défile pendant que Claude écrit, avec le débit en tok/s. Son donut montre la répartition entre sortie, entrée, cache écrit et cache lu ;
- **5 h** et **Semaine** : le pourcentage, les tokens restants estimés et le temps avant la remise à zéro (les limites Opus ou Sonnet de la semaine s'ajoutent quand elles passent 50 %) ;
- **Contexte** : le remplissage de la fenêtre de contexte, en tokens ;
- à droite : le débit du PC quand Claude travaille, et **Détails ›**, qui ouvre le panneau complet.

Chaque mesure a sa couleur (orange pour 5 h, bleu pour la semaine, vert pour le contexte) ; une limite passe à l'ambre à 75 % et au rouge à 90 %. Le `[-]` à droite du widget le replie.

## Le panneau de détail

Le même style que le widget : des sections sous un petit titre, sans cadres, un donut à côté de chaque chiffre et la même couleur pour la même mesure.


- **Cette discussion** : le total de tokens, un compteur qui défile pendant que Claude écrit (jusqu'à 20 rafraîchissements par seconde), les tokens générés par seconde, et le détail entrée / sortie / cache lu / cache écrit, avec le nombre de requêtes et le coût équivalent API.
- **Toutes discussions** :
  - **Ce PC** : le débit exact de toutes les sessions Claude Code de la machine, en tokens par seconde, lu dix fois par seconde dans leurs journaux (`~/.claude/projects`). En dessous, le total consommé sur la fenêtre de 5 h et sur la semaine.
  - **Compte entier** : un débit estimé à partir de la progression du pourcentage de la fenêtre de 5 h, en moyenne sur 5 à 15 minutes. Il compte aussi claude.ai, les autres machines et les autres personnes du compte.
- **Contexte** : le remplissage de la fenêtre de contexte, en tokens, et ce qui reste.
- **Limites d'abonnement** : chaque limite (fenêtre 5 h, semaine, Opus, Sonnet…) en pourcentage, son équivalent estimé en tokens utilisés et restants, et le temps avant la remise à zéro.

Anthropic ne donne les limites qu'en pourcentage. Le plugin les convertit en tokens d'après ce que la machine a consommé depuis l'ouverture de chaque fenêtre. Si d'autres appareils consomment aussi, ces équivalents sont sous-estimés.

## Installation

Il faut Claude Code 2.1.275 ou plus récent, et `python3`.

À l'invite d'une session Claude Code dans un terminal :

```
/plugin install conso-live --marketplace YousefBeLike/conso-live
```

Réponds `y` pour ajouter la marketplace, puis choisis la portée (utilisateur par défaut).

Depuis un shell :

```bash
claude plugin install conso-live --marketplace YousefBeLike/conso-live
```

Dans l'application de bureau, où `/plugin` n'est pas disponible : clique sur **+** à côté de la zone de saisie, puis **Plugins**, **Add marketplace** avec `YousefBeLike/conso-live`, puis **Add plugin**.

## Utilisation

Le widget apparaît dans chaque session. Le bouton **Détails** ou la commande `/conso` ouvre le panneau complet.

## Données et réseau

Le script `scripts/conso-watch.py` fait les relevés :

- il lit les journaux de Claude Code dans `~/.claude/projects` (ou `$CLAUDE_CONFIG_DIR/projects`) ;
- toutes les 90 secondes, et quelques secondes après chaque remise à zéro d'une fenêtre, il interroge `https://api.anthropic.com/api/oauth/usage` avec le jeton de connexion de Claude Code (`~/.claude/.credentials.json`), pour lire les pourcentages des limites.

Chaque session lance son propre relevé, mais un seul interroge le compte à la fois : la réponse est partagée par un fichier de cache, `~/.cache/conso-live/usage.json`. Dix sessions ouvertes font donc autant d'appels qu'une seule, ce qui évite d'être limité par l'API. Si un relevé échoue, le panneau garde les derniers chiffres, l'indique en orange et réessaie tout seul. Si le script s'arrête, il est relancé automatiquement.

Le jeton n'est envoyé qu'à `api.anthropic.com`. Le plugin n'écrit rien d'autre que ce cache et son propre stockage Claude Code, qui garde les équivalents en tokens des limites.

## Mise à jour

```bash
claude plugin update conso-live@conso-live
```

Puis `/reload-plugins` dans les sessions ouvertes.

## Licence

MIT
