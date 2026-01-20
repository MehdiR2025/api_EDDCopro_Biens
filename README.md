# API EDD V1.5 - Copropriétés Biens

API d'import EDD pour la création de lots et biens (units) dans un CRM immobilier de copropriétés.

## Structure du projet

```
.
├── supabase/
│   ├── migrations/
│   │   └── 20240101000000_edd_api_v1_5.sql    # Script SQL de migration
│   └── functions/
│       └── edd-import/
│           ├── index.ts                        # Edge Function principale
│           └── deno.json                       # Configuration Deno
├── postman/
│   └── EDD_API_V1.5_Collection.postman_collection.json
└── README.md
```

## Installation

### 1. Exécuter la migration SQL

Copier le contenu de `supabase/migrations/20240101000000_edd_api_v1_5.sql` dans l'éditeur SQL de Supabase et exécuter.

### 2. Déployer la Edge Function

```bash
supabase functions deploy edd-import
```

### 3. Configurer le bucket Storage

Créer un bucket `imports` dans Supabase Storage pour stocker les fichiers Excel.

## Endpoint API

### POST /functions/v1/edd-import

Importe les données EDD à partir de 3 fichiers Excel.

#### Request Body

```json
{
  "tenant_id": "UUID",
  "copro_id": "UUID",
  "copro_addresses": [
    {"label": "12 rue de la Paix, 75001 Paris", "role": "main"},
    {"label": "14 rue de la Paix, 75001 Paris", "role": "secondary"}
  ],
  "copro_cadastral_refs": ["75101000AB0001"],
  "files": {
    "edd_path": "path/to/edd.xlsx",
    "lot_ref_path": "path/to/lot_ref.xlsx",
    "contacts_path": "path/to/contacts.xlsx"
  }
}
```

#### Fichiers Excel requis

**1. EDD VF (lots)**
- Headers requis: `NumLot`, `Etage`, `TypeLot`
- Headers optionnels: `SurfaceLot`, `Exterieurs`, `SurfaceExterieurs`, `QuotesPartsGenerales`, `Quotes-parts Ascenseurs`, `Quotes-parts Escaliers`, `Quotes-parts Chauffage`, `Observations`, `DateArrivee`, `Batiment`, `Escalier ` (avec espace), `NbPieces`, `NumPorte`, `AnnexeLot`, `Montant Fond travaux`

**2. lot_ref (association propriétaire-lots)**
- Headers requis: `Référence`, `N° lot`

**3. contacts (propriétaires)**
- Headers requis: `Référence`, `Civilité`, `Nom`
- Headers optionnels: `Prénom`, `Adresse 1`, `Adresse 2`, `Code postal`, `Ville`, `Pays`, `e-mail`, `Téléphone 1`, `Téléphone 2`

#### Réponses

**SUCCESS (completed)**
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

**SUCCESS avec review requis (completed_with_review_required)**
```json
{
  "job_id": "UUID",
  "status": "completed_with_review_required",
  "stats": { ... },
  "reviews": [
    {
      "review_id": "UUID",
      "owner_ref": "REF001",
      "display_name": "Jean Dupont",
      "contact_category": "physical",
      "legal_form": null,
      "group_type": null,
      "main_hab_lots": ["101", "102"],
      "dep_lots": ["C01"],
      "reason": "multiple_habitation_main_lots"
    }
  ],
  "errors": []
}
```

**FAILED**
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

## Règles métier

### Classification TypeLot -> lot_family

| lot_family | TypeLot (case-insensitive) |
|------------|---------------------------|
| MAIN_HABITATION | Appartement, studio, chambre, chambre de service, maison, logement, habitation |
| MAIN_COMMERCE | Commerce, boutique, Local commercial, local d'activité, bureaux |
| DEPENDANCE | Cave, Parking, Box, stationnement, stationnement double, emplacement de stationnement, emplacement de stationnement double |

### Classification Civilité -> contact_category

| Civilité | contact_category | legal_form | group_type |
|----------|-----------------|------------|------------|
| Monsieur, Madame, Monsieur ou Madame | physical | null | null |
| STE, SCI, SDC | legal_entity | (même valeur) | null |
| INDIV, CONSOR, SUCESS | group | null | (même valeur) |
| autre | physical (fallback) | null | null |

### Règles de création des units

1. **Cas normal**: 1 lot principal (habitation OU commerce) -> 1 unit + dépendances en annexes
2. **Cas review**: >= 2 lots MAIN_HABITATION -> création d'une review, pas d'unit
3. **Cas dépendances seules**: aucun lot principal -> 1 unit par type de dépendance

## Tables de la base de données

15 tables implémentées:
- `copros`, `addresses`, `parcels`
- `copro_addresses`, `copro_parcels`
- `import_jobs`, `data_issues`
- `contacts`, `lots`, `units`
- `unit_lots`, `unit_owners`, `unit_addresses`, `unit_parcels`
- `unit_build_reviews`

### Trigger automatique

Le champ `units.lots_count` est maintenu automatiquement par un trigger sur `unit_lots` (INSERT/UPDATE/DELETE).

## Codes d'erreurs et warnings

### Erreurs fatales (job failed)
- `edd_missing_required_column`
- `lot_ref_missing_required_column`
- `contacts_missing_required_column`

### Warnings (job continue)
- `edd_surface_lot_invalid`
- `edd_exteriors_surface_count_mismatch`
- `tantieme_denominator_missing`
- `edd_tantieme_invalid_format`
- `edd_date_arrivee_invalid`
- `owner_link_without_lot`
- `missing_owner_link`
- `missing_contact_for_owner_ref`
- `unknown_lot_type_mapping`
- `contacts_unknown_civility_value`
