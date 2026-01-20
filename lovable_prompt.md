# Prompt Lovable - Intégration API EDD V1.5

## Contexte

Tu dois intégrer une API backend Supabase pour importer des données EDD (État Descriptif de Division) de copropriétés. L'API est déjà déployée sur Supabase.

## Configuration Supabase

```
SUPABASE_URL: https://xuvyupcdamdmmrtttjlo.supabase.co
Bucket Storage: imports
Edge Function: edd-import
```

## Fonctionnalité à implémenter

Depuis une page de détail d'une copropriété, l'utilisateur peut importer 3 fichiers Excel pour créer automatiquement les lots et biens (units) de la copro.

## Flux d'intégration

### Étape 1 : Upload des fichiers Excel vers Supabase Storage

L'utilisateur doit uploader 3 fichiers .xlsx dans le bucket `imports` :

```typescript
const basePath = `imports/${tenantId}/${coproId}/${Date.now()}`;

// Upload des 3 fichiers
await supabase.storage.from('imports').upload(`${basePath}/edd.xlsx`, eddFile);
await supabase.storage.from('imports').upload(`${basePath}/lot_ref.xlsx`, lotRefFile);
await supabase.storage.from('imports').upload(`${basePath}/contacts.xlsx`, contactsFile);
```

### Étape 2 : Appeler l'Edge Function edd-import

```typescript
const { data, error } = await supabase.functions.invoke('edd-import', {
  body: {
    tenant_id: "UUID du tenant",
    copro_id: "UUID de la copropriété",
    copro_addresses: [
      { label: "Adresse principale de la copro", role: "main" },
      { label: "Adresse secondaire (optionnel)", role: "secondary" }
    ],
    copro_cadastral_refs: ["Référence cadastrale 1", "Référence cadastrale 2"],
    files: {
      edd_path: `${basePath}/edd.xlsx`,
      lot_ref_path: `${basePath}/lot_ref.xlsx`,
      contacts_path: `${basePath}/contacts.xlsx`
    }
  }
});
```

## Format de la requête

| Champ | Type | Obligatoire | Description |
|-------|------|-------------|-------------|
| tenant_id | UUID | Oui | ID du tenant (multi-tenant) |
| copro_id | UUID | Oui | ID de la copropriété |
| copro_addresses | Array | Oui | Au moins 1 adresse avec role="main" |
| copro_addresses[].label | string | Oui | Libellé de l'adresse |
| copro_addresses[].role | "main" \| "secondary" | Oui | Rôle de l'adresse |
| copro_cadastral_refs | string[] | Oui | Références cadastrales (au moins 1) |
| files.edd_path | string | Oui | Chemin Storage du fichier EDD |
| files.lot_ref_path | string | Oui | Chemin Storage du fichier lot_ref |
| files.contacts_path | string | Oui | Chemin Storage du fichier contacts |

## Réponses de l'API

### Cas 1 : SUCCESS (status: "completed")

Import réussi sans ambiguïté. Tous les biens ont été créés.

```json
{
  "job_id": "UUID",
  "status": "completed",
  "stats": {
    "lots_upserted": 45,
    "contacts_upserted": 28,
    "units_created": 25,
    "unit_lots_created": 52,
    "unit_owners_created": 25,
    "reviews_created": 0,
    "issues_warning": 3,
    "issues_error": 0
  },
  "reviews": [],
  "errors": []
}
```

**Action UI** : Afficher un message de succès avec les statistiques.

### Cas 2 : SUCCESS avec REVIEW (status: "completed_with_review_required")

Import réussi mais certains propriétaires ont plusieurs lots d'habitation principaux. L'utilisateur doit choisir comment créer les biens.

```json
{
  "job_id": "UUID",
  "status": "completed_with_review_required",
  "stats": {
    "lots_upserted": 50,
    "contacts_upserted": 30,
    "units_created": 22,
    "unit_lots_created": 45,
    "unit_owners_created": 22,
    "reviews_created": 2,
    "issues_warning": 5,
    "issues_error": 0
  },
  "reviews": [
    {
      "review_id": "UUID",
      "owner_ref": "REF001",
      "display_name": "Jean Dupont",
      "contact_category": "physical",
      "legal_form": null,
      "group_type": null,
      "main_hab_lots": ["101", "102"],
      "dep_lots": ["C01", "P15"],
      "reason": "multiple_habitation_main_lots"
    }
  ],
  "errors": []
}
```

**Action UI** : Afficher une interface pour résoudre chaque review :
- Montrer le propriétaire (display_name)
- Montrer ses lots principaux (main_hab_lots)
- Proposer : "Créer 1 bien par lot" ou "Fusionner en 1 seul bien"

### Cas 3 : FAILED (status: "failed")

L'import a échoué (colonnes manquantes dans les fichiers Excel).

```json
{
  "job_id": "UUID",
  "status": "failed",
  "stats": null,
  "reviews": [],
  "errors": [
    {
      "code": "edd_missing_required_column",
      "message": "Missing required column: NumLot",
      "entity": "edd",
      "column": "NumLot"
    }
  ]
}
```

**Action UI** : Afficher les erreurs à l'utilisateur pour qu'il corrige ses fichiers Excel.

## Récupérer les données créées

### Récupérer les biens (units) d'une copro

```typescript
const { data: units } = await supabase
  .from('units')
  .select(`
    id,
    unit_type,
    status,
    main_lot_number,
    lots_count,
    created_at,
    unit_lots (
      role,
      lot:lots (
        id,
        lot_number,
        floor_label,
        lot_type_label,
        lot_family,
        surface_m2
      )
    ),
    unit_owners (
      contact:contacts (
        id,
        display_name,
        contact_category,
        email,
        phone1
      )
    )
  `)
  .eq('copro_id', coproId)
  .eq('tenant_id', tenantId);
```

### Récupérer les lots d'une copro

```typescript
const { data: lots } = await supabase
  .from('lots')
  .select('*')
  .eq('copro_id', coproId)
  .eq('tenant_id', tenantId);
```

### Récupérer les contacts/propriétaires

```typescript
const { data: contacts } = await supabase
  .from('contacts')
  .select('*')
  .eq('tenant_id', tenantId);
```

### Récupérer les reviews en attente

```typescript
const { data: reviews } = await supabase
  .from('unit_build_reviews')
  .select('*')
  .eq('copro_id', coproId)
  .eq('status', 'pending_review');
```

## Structure des données

### Table units (biens)

| Champ | Type | Description |
|-------|------|-------------|
| id | UUID | ID du bien |
| tenant_id | UUID | ID du tenant |
| copro_id | UUID | ID de la copropriété |
| unit_type | "habitation" \| "commercial" \| "dependance" | Type de bien |
| status | "active" | Statut du bien |
| main_lot_number | string | Numéro du lot principal |
| lots_count | int | Nombre de lots (auto-calculé) |
| source_owner_external_ref | string | Référence du propriétaire source |

### Table lots

| Champ | Type | Description |
|-------|------|-------------|
| id | UUID | ID du lot |
| lot_number | string | Numéro du lot (ex: "101") |
| floor_label | string | Étage (ex: "2ème étage") |
| lot_type_label | string | Type brut (ex: "Appartement") |
| lot_family | "MAIN_HABITATION" \| "MAIN_COMMERCE" \| "DEPENDANCE" | Famille du lot |
| surface_m2 | numeric | Surface en m² |
| exteriors | JSON | Extérieurs [{type, surface_m2}] |
| observations | text | Observations |

### Table contacts (propriétaires)

| Champ | Type | Description |
|-------|------|-------------|
| id | UUID | ID du contact |
| external_ref | string | Référence externe (du fichier) |
| display_name | string | Nom affiché |
| contact_category | "physical" \| "legal_entity" \| "group" | Type de contact |
| legal_form | "STE" \| "SCI" \| "SDC" \| null | Forme juridique |
| group_type | "INDIV" \| "CONSOR" \| "SUCESS" \| null | Type de groupement |
| email | string | Email |
| phone1 | string | Téléphone |

## Fichiers Excel attendus

### 1. EDD VF (edd.xlsx)
Colonnes obligatoires : `NumLot`, `Etage`, `TypeLot`
Colonnes optionnelles : `SurfaceLot`, `Exterieurs`, `SurfaceExterieurs`, `Observations`, etc.

### 2. lot_ref (lot_ref.xlsx)
Colonnes obligatoires : `Référence`, `N° lot`
Associe chaque propriétaire (Référence) à ses lots (N° lot).

### 3. contacts (contacts.xlsx)
Colonnes obligatoires : `Référence`, `Civilité`, `Nom`
Colonnes optionnelles : `Prénom`, `Adresse 1`, `e-mail`, `Téléphone 1`, etc.

## Résumé

L'API EDD permet en un seul appel de :
1. Créer/mettre à jour les lots de la copro
2. Créer/mettre à jour les contacts propriétaires
3. Créer les biens (units) en associant lots et propriétaires
4. Gérer les cas ambigus via le système de reviews

Le front doit gérer :
1. L'upload des 3 fichiers Excel
2. L'appel à l'API avec les bons paramètres
3. L'affichage du résultat (succès, reviews à traiter, erreurs)
4. L'affichage des biens créés
