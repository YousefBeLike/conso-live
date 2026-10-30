# conso-live

Plugin Claude Code : un panneau à côté de la conversation qui affiche ta consommation de tokens Claude en direct.

## Ce qu'il affiche

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

Le panneau s'ouvre au démarrage de chaque session. Si tu le fermes, la commande `/conso` le rouvre.

## Données et réseau

Le script `bin/conso-watch.py` fait les relevés :

- il lit les journaux de Claude Code dans `~/.claude/projects` (ou `$CLAUDE_CONFIG_DIR/projects`) ;
- toutes les minutes, il interroge `https://api.anthropic.com/api/oauth/usage` avec le jeton de connexion de Claude Code (`~/.claude/.credentials.json`), pour lire les pourcentages des limites.

Le jeton n'est envoyé qu'à `api.anthropic.com`. Le plugin n'écrit rien d'autre que son propre stockage Claude Code, qui garde les équivalents en tokens des limites.

## Licence

MIT
