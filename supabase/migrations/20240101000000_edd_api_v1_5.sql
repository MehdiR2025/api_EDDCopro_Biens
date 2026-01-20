-- ============================================================
-- API EDD V1.5 - Migration SQL Supabase
-- ============================================================
-- Ce script crée toutes les tables, contraintes, index et triggers
-- requis pour l'API EDD V1.5
-- ============================================================

-- ============================================================
-- 1) TABLE: copros
-- ============================================================
CREATE TABLE IF NOT EXISTS copros (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    name text NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copros_tenant_id ON copros(tenant_id);

-- ============================================================
-- 2) TABLE: addresses
-- ============================================================
CREATE TABLE IF NOT EXISTS addresses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    label text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, label)
);

CREATE INDEX IF NOT EXISTS idx_addresses_tenant_id ON addresses(tenant_id);

-- ============================================================
-- 3) TABLE: parcels
-- ============================================================
CREATE TABLE IF NOT EXISTS parcels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    cadastral_ref text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cadastral_ref)
);

CREATE INDEX IF NOT EXISTS idx_parcels_tenant_id ON parcels(tenant_id);

-- ============================================================
-- 4) LINK TABLE: copro_addresses
-- ============================================================
CREATE TABLE IF NOT EXISTS copro_addresses (
    tenant_id uuid NOT NULL,
    copro_id uuid NOT NULL REFERENCES copros(id),
    address_id uuid NOT NULL REFERENCES addresses(id),
    role text NOT NULL CHECK (role IN ('main', 'secondary')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, copro_id, address_id)
);

CREATE INDEX IF NOT EXISTS idx_copro_addresses_copro_id ON copro_addresses(copro_id);
CREATE INDEX IF NOT EXISTS idx_copro_addresses_address_id ON copro_addresses(address_id);
CREATE INDEX IF NOT EXISTS idx_copro_addresses_role ON copro_addresses(role);

-- ============================================================
-- 5) LINK TABLE: copro_parcels
-- ============================================================
CREATE TABLE IF NOT EXISTS copro_parcels (
    tenant_id uuid NOT NULL,
    copro_id uuid NOT NULL REFERENCES copros(id),
    parcel_id uuid NOT NULL REFERENCES parcels(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, copro_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_copro_parcels_copro_id ON copro_parcels(copro_id);
CREATE INDEX IF NOT EXISTS idx_copro_parcels_parcel_id ON copro_parcels(parcel_id);

-- ============================================================
-- 6) TABLE: import_jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS import_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    copro_id uuid NOT NULL REFERENCES copros(id),
    status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'completed_with_review_required', 'failed')),
    files jsonb NOT NULL,
    stats jsonb NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz NULL,
    ended_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_tenant_id ON import_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_copro_id ON import_jobs(copro_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at ON import_jobs(created_at);

-- ============================================================
-- 7) TABLE: data_issues
-- ============================================================
CREATE TABLE IF NOT EXISTS data_issues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES import_jobs(id),
    tenant_id uuid NOT NULL,
    severity text NOT NULL CHECK (severity IN ('warning', 'error')),
    code text NOT NULL,
    entity_type text NOT NULL,
    entity_key text NULL,
    message text NOT NULL,
    payload jsonb NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_issues_tenant_id ON data_issues(tenant_id);
CREATE INDEX IF NOT EXISTS idx_data_issues_job_id ON data_issues(job_id);
CREATE INDEX IF NOT EXISTS idx_data_issues_severity ON data_issues(severity);
CREATE INDEX IF NOT EXISTS idx_data_issues_code ON data_issues(code);

-- ============================================================
-- 8) TABLE: contacts (V1.5)
-- ============================================================
CREATE TABLE IF NOT EXISTS contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    external_ref text NOT NULL,
    civility_raw text NOT NULL,
    contact_category text NOT NULL CHECK (contact_category IN ('physical', 'legal_entity', 'group')),
    legal_form text NULL CHECK (legal_form IS NULL OR legal_form IN ('STE', 'SCI', 'SDC')),
    group_type text NULL CHECK (group_type IS NULL OR group_type IN ('INDIV', 'CONSOR', 'SUCESS')),
    first_name text NULL,
    last_name_or_name text NOT NULL,
    display_name text NOT NULL,
    address_line1 text NULL,
    address_line2 text NULL,
    postcode text NULL,
    city text NULL,
    country text NULL,
    email text NULL,
    phone1 text NULL,
    phone2 text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_contact_category ON contacts(contact_category);
CREATE INDEX IF NOT EXISTS idx_contacts_legal_form ON contacts(legal_form);
CREATE INDEX IF NOT EXISTS idx_contacts_group_type ON contacts(group_type);

-- ============================================================
-- 9) TABLE: lots
-- ============================================================
CREATE TABLE IF NOT EXISTS lots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    copro_id uuid NOT NULL REFERENCES copros(id),
    lot_number text NOT NULL,
    floor_label text NOT NULL,
    lot_type_label text NOT NULL,
    lot_family text NOT NULL CHECK (lot_family IN ('MAIN_HABITATION', 'MAIN_COMMERCE', 'DEPENDANCE')),
    surface_m2 numeric NULL,
    exteriors jsonb NULL,
    tantiemes_general_num int NULL,
    tantiemes_general_den int NULL,
    tantiemes_asc_num int NULL,
    tantiemes_asc_den int NULL,
    tantiemes_stairs_num int NULL,
    tantiemes_stairs_den int NULL,
    tantiemes_heat_num int NULL,
    tantiemes_heat_den int NULL,
    observations text NULL,
    acquired_at date NULL,
    building text NULL,
    staircase text NULL,
    nb_rooms text NULL,
    door_number text NULL,
    annex_lot text NULL,
    works_fund_amount numeric NULL,
    source_job_id uuid NULL REFERENCES import_jobs(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, copro_id, lot_number)
);

CREATE INDEX IF NOT EXISTS idx_lots_tenant_id ON lots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lots_copro_id ON lots(copro_id);
CREATE INDEX IF NOT EXISTS idx_lots_lot_family ON lots(lot_family);
CREATE INDEX IF NOT EXISTS idx_lots_lot_type_label ON lots(lot_type_label);

-- ============================================================
-- 10) TABLE: units
-- ============================================================
CREATE TABLE IF NOT EXISTS units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    copro_id uuid NOT NULL REFERENCES copros(id),
    unit_type text NOT NULL CHECK (unit_type IN ('habitation', 'commercial', 'dependance')),
    status text NOT NULL CHECK (status IN ('active')),
    main_lot_number text NULL,
    lots_count int NOT NULL DEFAULT 0,
    source_owner_external_ref text NULL,
    source_job_id uuid NULL REFERENCES import_jobs(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_units_tenant_id ON units(tenant_id);
CREATE INDEX IF NOT EXISTS idx_units_copro_id ON units(copro_id);
CREATE INDEX IF NOT EXISTS idx_units_unit_type ON units(unit_type);
CREATE INDEX IF NOT EXISTS idx_units_status ON units(status);
CREATE INDEX IF NOT EXISTS idx_units_source_owner_external_ref ON units(source_owner_external_ref);

-- ============================================================
-- 11) LINK TABLE: unit_lots
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_lots (
    tenant_id uuid NOT NULL,
    unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    lot_id uuid NOT NULL REFERENCES lots(id),
    role text NOT NULL CHECK (role IN ('main', 'annex')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, unit_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_lots_unit_id ON unit_lots(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_lots_lot_id ON unit_lots(lot_id);
CREATE INDEX IF NOT EXISTS idx_unit_lots_role ON unit_lots(role);

-- ============================================================
-- 12) LINK TABLE: unit_owners
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_owners (
    tenant_id uuid NOT NULL,
    unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, unit_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_owners_unit_id ON unit_owners(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_owners_contact_id ON unit_owners(contact_id);

-- ============================================================
-- 13) LINK TABLE: unit_addresses
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_addresses (
    tenant_id uuid NOT NULL,
    unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    address_id uuid NOT NULL REFERENCES addresses(id),
    role text NOT NULL CHECK (role IN ('main', 'secondary')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, unit_id, address_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_addresses_unit_id ON unit_addresses(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_addresses_address_id ON unit_addresses(address_id);
CREATE INDEX IF NOT EXISTS idx_unit_addresses_role ON unit_addresses(role);

-- ============================================================
-- 14) LINK TABLE: unit_parcels
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_parcels (
    tenant_id uuid NOT NULL,
    unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, unit_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_parcels_unit_id ON unit_parcels(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_parcels_parcel_id ON unit_parcels(parcel_id);

-- ============================================================
-- 15) TABLE: unit_build_reviews
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_build_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    copro_id uuid NOT NULL REFERENCES copros(id),
    job_id uuid NOT NULL REFERENCES import_jobs(id),
    owner_ref text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending_review')),
    reason text NOT NULL CHECK (reason IN ('multiple_habitation_main_lots')),
    lots_in_scope jsonb NOT NULL,
    proposals jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unit_build_reviews_tenant_id ON unit_build_reviews(tenant_id);
CREATE INDEX IF NOT EXISTS idx_unit_build_reviews_copro_id ON unit_build_reviews(copro_id);
CREATE INDEX IF NOT EXISTS idx_unit_build_reviews_status ON unit_build_reviews(status);
CREATE INDEX IF NOT EXISTS idx_unit_build_reviews_owner_ref ON unit_build_reviews(owner_ref);

-- ============================================================
-- TRIGGER: units.lots_count
-- ============================================================
-- Ce trigger maintient automatiquement le compteur lots_count
-- dans la table units en fonction des enregistrements unit_lots

CREATE OR REPLACE FUNCTION update_units_lots_count()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle INSERT
    IF TG_OP = 'INSERT' THEN
        UPDATE units
        SET lots_count = (
            SELECT COUNT(*) FROM unit_lots WHERE unit_id = NEW.unit_id
        )
        WHERE id = NEW.unit_id;
        RETURN NEW;
    END IF;

    -- Handle DELETE
    IF TG_OP = 'DELETE' THEN
        UPDATE units
        SET lots_count = (
            SELECT COUNT(*) FROM unit_lots WHERE unit_id = OLD.unit_id
        )
        WHERE id = OLD.unit_id;
        RETURN OLD;
    END IF;

    -- Handle UPDATE
    IF TG_OP = 'UPDATE' THEN
        -- If unit_id changed, update both old and new units
        IF OLD.unit_id IS DISTINCT FROM NEW.unit_id THEN
            -- Update old unit
            UPDATE units
            SET lots_count = (
                SELECT COUNT(*) FROM unit_lots WHERE unit_id = OLD.unit_id
            )
            WHERE id = OLD.unit_id;

            -- Update new unit
            UPDATE units
            SET lots_count = (
                SELECT COUNT(*) FROM unit_lots WHERE unit_id = NEW.unit_id
            )
            WHERE id = NEW.unit_id;
        ELSE
            -- unit_id unchanged, just recalculate for that unit
            UPDATE units
            SET lots_count = (
                SELECT COUNT(*) FROM unit_lots WHERE unit_id = NEW.unit_id
            )
            WHERE id = NEW.unit_id;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trg_update_units_lots_count ON unit_lots;

-- Create trigger on unit_lots table
CREATE TRIGGER trg_update_units_lots_count
    AFTER INSERT OR DELETE OR UPDATE ON unit_lots
    FOR EACH ROW
    EXECUTE FUNCTION update_units_lots_count();

-- ============================================================
-- FIN DE LA MIGRATION
-- ============================================================
