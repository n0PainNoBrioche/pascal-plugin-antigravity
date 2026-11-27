---
name: architecte
description: >-
  Transforme un plan 2D (image, croquis ou dimensions texte) en scène 3D Pascal via le MCP pascal, applique les finitions et le mobilier (catalogue et recettes procédurales), vérifie collisions, dégagements et limites d'encombrement (pascal-3d & furniture-fit), génère des rendus 3D et publie la scène sur https://archi.brioche.ovh. Utiliser quand l'utilisateur veut créer un plan 3D, modéliser un appartement/maison, aménager des pièces ou vérifier qu'un meuble passe.
---

# Architecte 3D (Pascal MCP)

Convertir un plan 2D (image cotée, croquis ou description) en scène 3D fidèle, finie, meublée pièce par pièce sans collisions, vérifiée selon les bornes d'encombrement Pascal, rendue visuellement et synchronisée sur `https://archi.brioche.ovh`.

Ce skill intègre les workflows **`pascal-3d`** et **`furniture-fit`** (également installés en tant que skills autonomes) :
- Avant tout dépannage de connexion, choix local vs hébergé ou gestion de compte/clé API, lire [references/pascal-3d-setup.md](references/pascal-3d-setup.md).
- Pour les outils avancés (toitures, escaliers, fenêtres d'angle, lots/unités, pelouse/rochers, `author_scene`), lire [references/pascal-3d-workflows.md](references/pascal-3d-workflows.md).
- Pour une question d'encombrement ou de validation de dégagement d'un meuble, lire [references/furniture-fit-boundaries.md](references/furniture-fit-boundaries.md) et suivre le gabarit [references/furniture-fit-report.md](references/furniture-fit-report.md).

## Connexion, autorité et outils MCP Pascal

- **Connexion & frontière de stockage** : lire `pascal://agent-guide` et inspecter les schémas exposés avant d'éditer. Ne jamais mélanger `pascal` (local, `~/.pascal/data/pascal.db`) et `pascal-hosted` sur la même tâche, ni créer de compte autonome ou publier/dépenser sans accord explicite. Traiter les clés API et jetons locaux comme des secrets (hors fichiers, URLs et sorties).
- **Fallback CLI local** : si `pascal` n'est pas chargé dans la liste MCP du client (ex. `PATH` hors `nvm`), interroger le connecteur officiel en stdio JSON-RPC 2.0 **NDJSON ligne par ligne** via `pascal mcp connect` (après `pascal mcp status --json`) en **maintenant `stdin` ouvert** (avec timeout de lecture : fermer `stdin` clôt `StdioServerTransport`). Un seul client agent actif par service local CLI.
- **Repère** : `X` vers l'est, `Z` vers le sud (bas du plan), `Y` vertical vers le haut, unités en mètres (si l'utilisateur fournit des `cm`/`ft`, conserver les valeurs d'origine à côté des mètres).
- **Outils principaux** :
  - Structure : `create_project`, `clear_scene`, `add_wall`, `add_door`, `add_window`, `add_corner_window`, `merge_windows`, `create_stair`, `measure_stair`, `fit_stair`, `create_roof`, `create_unit`, `set_unit_members`, `set_zone`, `divide_zone`, `create_room`, `apply_patch`, `delete_node`, `move_node`
  - Site & paysage : `get_site`, `place_building`, `add_site_surface` (`kind: "lawn"`), `add_rock`
  - Finitions : `search_materials` (`queries: [{...}]`), `set_zone_intent`, `paint`
  - Ameublement : `design_brief`, `search_assets` (`queries: [{query}]`), `view_assets`, `place_items`, `validate_design`, `place_design` (préférer à `add_object` en local)
  - Vérification & persistance : `verify_scene`, `check_collisions`, `measure`, `find_by_type`, `get_walls`, `get_zones`, `get_scene`, `list_scenes`, `load_scene`, `save_scene`, `get_project_status`, `view_scene`

## Workflow en 6 étapes

### 1. Analyser et calibrer le plan 2D
- Si `analyze_floorplan_image` échoue (`sampling_unavailable`), analyser l'image directement et **calibrer l'échelle en pixels/mètre** sur la barre d'échelle et 2–3 cotes imprimées (chambres, baie vitrée, terrasse) afin de calculer les coordonnées `[x, z]` exactes au centimètre près (vérifier la cohérence avec le tableau des surfaces).
- Centrer l'empreinte autour de `[0, 0]` (lot par défaut `[-15..15]`). Hauteur sous plafond standard `2.50 m` si absente.
- **Garde-fou `insufficient evidence` (`furniture-fit`)** : si une cote décisive, l'échelle ou la cible manque/est ambiguë sur une demande de vérification d'encombrement, s'arrêter avant toute mutation et demander uniquement le plus petit jeu de mesures bloquant (ne pas inventer de dimensions).
- Critère de fin : chaque mur extérieur/intérieur, gaine technique, porte, porte-fenêtre, baie vitrée et terrasse possède des coordonnées `[x, z]` vérifiées.

### 2. Construire le gros œuvre et les zones
- Initialiser avec `create_project` (ou `list_scenes` → `load_scene` pour un projet existant). Si la scène créée hérite d'un contenu préalable (`nodeCount > 0`), exécuter `clear_scene({ reason })` avant de tracer les murs, puis re-lier au projet via `save_scene({ id, replace: true, expectedVersion })`. Ne jamais vider une scène autrement (`scene_wipe_blocked`).
- Tracer d'abord les murs avec `add_wall` :
  - Extérieurs : `type: "exterior-2x6-stucco"`, épaisseur `0.20–0.24 m`.
  - Cloisons : `type: "interior-2x4-drywall"`, épaisseur `0.08–0.09 m`.
  - Garde-corps terrasse : `wallType: "railing"`, `railing: { style: "glass", height: 1.02 }`.
  - Attention : Pascal fusionne parfois les segments colinéaires bout à bout ; vérifier `get_walls` si une façade doit être segmentée pour deux finitions distinctes.
- Percer les ouvertures avec `add_door` (`doorType`: `"hinged"`, `"french"`, `"sliding"` + `slidingStyle: "patio"|"bypass"`, `style: "glass"|"modern"`, largeur réelle ex. `1.98` ou `0.90`) et `add_window` (`rollerShutter: "box"|"concealed"` si `VR`). Pour du vitrage d'angle sans trumeau, utiliser `add_corner_window` (ou `merge_windows`).
- Déclarer les pièces intérieures avec `set_zone`, séparer les espaces ouverts (ex. `Entrée` / `Séjour + Cuisine`) avec `divide_zone` (le `cut` doit traverser l'espace libre sans longer un mur existant), et créer la terrasse avec `create_room({ outdoor: true, rename: true })`. Dans un immeuble multi-lots, regrouper les zones par logement via `create_unit`.
- **Gaines techniques & niches ouvertes** : intégrer les niches ouvertes (ex. `tab/elec`) dans le dégagement et modéliser les gaines techniques fermées (`Gaine technique`) comme blocs pleins pleine hauteur (`place_design`) à l'intérieur de la pièce plutôt qu'en sous-pièces murées sans porte (évite `room_unreachable`). Pour supprimer une zone en double sans effacer ses murs, utiliser `apply_patch` (`op: "delete"`), jamais `delete_zone(contents: "keep")`.
- Critère de fin : `get_zones` liste toutes les pièces attendues sans zone non fermée, en double ou inatteignable.

### 3. Appliquer finitions, plinthes et carrelage
- **Inspecter `frontSide` / `backSide` et `start` → `end`** via `get_scene` avant de peindre : dans Pascal, `frontSide` = face **`a`** (normale `(-Δz, Δx)`), `backSide` = face **`b`**. Toujours nommer explicitement `role: "a"` ou `"b"`.
- **Sols** : utiliser `set_zone_intent` avec `patch: { floor: { finish: "library:..." } }` (`finish`, jamais `material`). Pour une zone carrelée partielle (ex. `Limite carrelage` d'une cuisine ouverte), ajouter `floor.regions: [{ id, polygon, finish }]`.
- **Pièces d'eau (`SdB / WC`)** : appliquer un carrelage (`library:flooring-ceramic53`, `library:flooring-tile20`, etc.) au sol **et** sur toutes les faces murales intérieures (`faceRegions` avec clé `finish` sur les murs partagés) pour résoudre `room_wet_untiled`.
- **Plinthes (`skirting`)** : via `apply_patch`, définir `skirting: { enabled: true, sides: "both"|"a"|"b", height: 0.08, proud: 0.012, profile: "flat" }` sur les murs standards selon la face intérieure (jamais sur un `railing` : `skirting_refused`).
- **Garde-corps et menuiseries** : peindre les garde-corps avec `role: "railing-frame"` ; peindre les cadres vitrés extérieurs avec `role: "frame"`.
- Critère de fin : aucune alerte `room_wet_untiled`, `rooms_floors_default` ni `rooms_skirting_partial` dans `verify_scene`.

### 4. Rédiger le `design_brief` et meubler (zéro chevauchement)
- **Appeler `design_brief` avant tout placement ou création de mobilier**, et **le rappeler après chaque `load_scene` ou `clear_scene`** (le brief est réinitialisé au chargement).
  - Pour un plan 2D fourni, renseigner `action`, `size`, `form`, `facade` et `openings` en `kind: "bounded"` (si `form` ou `facade` restent `open`, inclure explicitement `plan/volumes/heights` et `cladding/elements/rhythm`). Renseigner les 8 clés de `beyond`.
- **Équipements techniques & plantes (`place_items`)** : vérifier les dimensions réelles via `search_assets` (ex. `bathtub` `2.5×1.5 m`, `bathroom-sink` `2×1.5 m`, autres items `1.0×1.0 m` — souvent trop grands pour un T2/T3 français). Pour éviter `item_overlap` / `item_too_close` (`>= 0.08 m` de jeu en AABB X/Z, Y ignoré), espacer les items catalogue d'au moins **`1.08 m`** ou modéliser à la cote exacte via `place_design`.
- **Mobilier et déco sur mesure (`validate_design` + `place_design`)** :
  - Préférer `place_design` (recettes JSON procédurales `version: 1`) à `add_object` en local (qui échoue sans `PASCAL_SERVER_SCRIPT_COMPILE=1` ; côté hébergé, `add_object` requiert un onglet éditeur ouvert via `editor_tab_required`).
  - Règles v1 : inclure `constraints: []`, au moins un `parameter` (`min <= default <= max`), garder toute géométrie à `y >= 0`, `rotation` en chaîne `"90°"` ; pour un luminaire plafond (`mounting: { attachTo: "ceiling", reference: "mount_top" }`), déclarer la `surface` horizontale au sommet exact du modèle.
  - Regrouper les ensembles superposés ou accolés (cuisine linéaire `LL/Évier/LV/C/F` à 60 cm, table ronde + chaises, tapis + table basse, bureau + chaise, salon bistro) dans des designs cohérents afin de garantir des alignements nets et zéro collision X/Z.
  - Adapter le mobilier au plan et à chaque pièce (cuisine linéaire, table + chaises avec recul `>= 0.75 m`, canapé + table basse + meuble TV orientés, lits `140×190` / `160×200` + chevets + armoires, bureau, baignoire/vasque/miroir/sèche-serviette `SS`, WC PMR + lave-mains, `tab/elec`, chaudière `CH`, salon de terrasse + jardinières, plafonniers).
- Critère de fin : chaque pièce nommée sur le plan est meublée selon sa fonction, son orientation et ses dégagements.

### 5. Vérifier l'encombrement, sauvegarder et produire le rendu 3D
- **Contrôles outillés & bornes de preuve (`furniture-fit`)** :
  - Exécuter `check_collisions({ levelId, minimumClearance: 0.08, floorOnly: true })` (et `candidate` en lecture seule pour tester un meuble avant placement si supporté) puis `verify_scene`.
  - Formule de contrôle AABB rotatif (angle Y `θ` en rad) : `largeur = |W cos θ| + |D sin θ|`, `profondeur = |W sin θ| + |D cos θ|`.
  - Viser **`0` collision** et **`0` alerte pièce/équipement** (`wall_faces_default` sur les seuls garde-corps `railing` reste bénigne). Vérifier manuellement les `procedural-item` si `checkedItems` les omet.
  - **Ne jamais extrapoler la preuve** : `check_collisions` + `verify_scene` prouvent l'emprise 2D au sol, l'écart entre items (`0.08 m`) et le rectangle d'accès porte (`0.65 m` perpendiculaire, `0.05 m` latéral). Ils **ne prouvent pas** la hauteur libre sous plafond/retombée (`level.height` est nominal sans mesure prouvée), le débattement réel de vantail, l'itinéraire de livraison (portes/couloirs/escaliers) ni l'intersection de maillage fin (`not checked` si non modélisé/mesuré).
- **Sauvegarde** : avant `save_scene(..., saveMode: "checkpoint")`, lire la dernière `version` via `get_project_status` / `list_scenes` et passer `expectedVersion` (les appels sémantiques incrémentent la version de brouillon). En cas de conflit de version, recharger (`load_scene`) plutôt que forcer.
- **Rendu visuel** : en mode hébergé avec onglet éditeur ouvert, `view_scene({ interior: { levelId } })` génère la coupe à `0.65` de hauteur ; en local, `view_scene` retourne `view_unavailable`. Ouvrir alors `http://127.0.0.1:38697/scene/<id>` dans Playwright, fermer les panneaux / activer le mode **Preview** (éviter de cliquer-glisser sur le canvas en mode `Select`), puis capturer avec `page.screenshot({ path, animations: "disabled" })` (évite les timeouts WebGL sur `browser_take_screenshot`) en perspective, vue `Preview` et `Top View`.
- Critère de fin : checkpoint sauvegardé, `check_collisions` à 0, limites de preuve respectées et captures 3D inspectées visuellement.

### 6. Synchroniser vers `https://archi.brioche.ovh`
- Récupérer le graphe complet via `get_scene` (`export_json`).
- Publier vers l'API Dokploy :
  - Endpoint : `POST http://192.168.1.49:3477/api/scenes` (`PUT /api/scenes/<id>` pour mise à jour)
  - Header : `Authorization: Bearer a99d607befe78fe8e1c820ece852a0ab2c7c74a402a2fdbe`
  - Payload : `{ "name": "<nom>", "published": true, "graph": <sceneGraph> }`
- Renvoyer à l'utilisateur : le lien **`https://archi.brioche.ovh/editor/<id>`**, l'`editorUrl` exact retourné par Pascal (jamais inféré), la version, `graphHash`, le résumé des pièces/nœuds, les vérifications passées/non vérifiées (`unsupportedChecks`) et les rendus générés.
