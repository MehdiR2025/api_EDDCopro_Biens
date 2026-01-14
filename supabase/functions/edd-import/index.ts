// ============================================================
// API EDD V1.5 - Edge Function edd-import
// ============================================================
// Endpoint: POST /functions/v1/edd-import
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

// ============================================================
// TYPES
// ============================================================

interface RequestBody {
  tenant_id: string;
  copro_id: string;
  copro_addresses: { label: string; role: "main" | "secondary" }[];
  copro_cadastral_refs: string[];
  files: {
    edd_path: string;
    lot_ref_path: string;
    contacts_path: string;
  };
}

interface Stats {
  lots_upserted: number;
  contacts_upserted: number;
  units_created: number;
  unit_lots_created: number;
  unit_owners_created: number;
  reviews_created: number;
  issues_warning: number;
  issues_error: number;
}

interface ReviewResponse {
  review_id: string;
  owner_ref: string;
  display_name: string;
  contact_category: "physical" | "legal_entity" | "group";
  legal_form: "STE" | "SCI" | "SDC" | null;
  group_type: "INDIV" | "CONSOR" | "SUCESS" | null;
  main_hab_lots: string[];
  dep_lots: string[];
  reason: "multiple_habitation_main_lots";
}

interface ErrorResponse {
  code: string;
  message: string;
  entity: string;
  column?: string;
}

interface ApiResponse {
  job_id: string;
  status: "completed" | "completed_with_review_required" | "failed";
  stats: Stats | null;
  reviews: ReviewResponse[];
  errors: ErrorResponse[];
}

interface DataIssue {
  severity: "warning" | "error";
  code: string;
  entity_type: string;
  entity_key: string | null;
  message: string;
  payload: Record<string, unknown> | null;
}

interface EddRow {
  NumLot: string;
  Etage: string;
  TypeLot: string;
  SurfaceLot?: string;
  Exterieurs?: string;
  SurfaceExterieurs?: string;
  QuotesPartsGenerales?: string;
  "Quotes-parts Ascenseurs"?: string;
  "Quotes-parts Escaliers"?: string;
  "Quotes-parts Chauffage"?: string;
  Observations?: string;
  DateArrivee?: string;
  Batiment?: string;
  "Escalier "?: string;
  NbPieces?: string;
  NumPorte?: string;
  AnnexeLot?: string;
  "Montant Fond travaux"?: string;
}

interface LotRefRow {
  "Référence": string;
  "N° lot": string;
}

interface ContactRow {
  "Référence": string;
  "Civilité": string;
  "Nom": string;
  "Prénom"?: string;
  "Adresse 1"?: string;
  "Adresse 2"?: string;
  "Code postal"?: string;
  "Ville"?: string;
  "Pays"?: string;
  "e-mail"?: string;
  "Téléphone 1"?: string;
  "Téléphone 2"?: string;
}

interface ParsedLot {
  lot_number: string;
  floor_label: string;
  lot_type_label: string;
  lot_family: "MAIN_HABITATION" | "MAIN_COMMERCE" | "DEPENDANCE";
  surface_m2: number | null;
  exteriors: { type: string; surface_m2: number | null }[] | null;
  tantiemes_general_num: number | null;
  tantiemes_general_den: number | null;
  tantiemes_asc_num: number | null;
  tantiemes_asc_den: number | null;
  tantiemes_stairs_num: number | null;
  tantiemes_stairs_den: number | null;
  tantiemes_heat_num: number | null;
  tantiemes_heat_den: number | null;
  observations: string | null;
  acquired_at: string | null;
  building: string | null;
  staircase: string | null;
  nb_rooms: string | null;
  door_number: string | null;
  annex_lot: string | null;
  works_fund_amount: number | null;
}

interface ParsedContact {
  external_ref: string;
  civility_raw: string;
  contact_category: "physical" | "legal_entity" | "group";
  legal_form: "STE" | "SCI" | "SDC" | null;
  group_type: "INDIV" | "CONSOR" | "SUCESS" | null;
  first_name: string | null;
  last_name_or_name: string;
  display_name: string;
  address_line1: string | null;
  address_line2: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
  email: string | null;
  phone1: string | null;
  phone2: string | null;
}

// ============================================================
// CONSTANTS: TypeLot -> lot_family mapping
// ============================================================

const LOT_FAMILY_MAPPING: Record<string, "MAIN_HABITATION" | "MAIN_COMMERCE" | "DEPENDANCE"> = {};

// MAIN_HABITATION keywords
const MAIN_HABITATION_KEYWORDS = [
  "appartement",
  "studio",
  "chambre",
  "chambre de service",
  "maison",
  "logement",
  "habitation",
];

// MAIN_COMMERCE keywords
const MAIN_COMMERCE_KEYWORDS = [
  "commerce",
  "boutique",
  "local commercial",
  "local d'activité",
  "bureaux",
];

// DEPENDANCE keywords
const DEPENDANCE_KEYWORDS = [
  "cave",
  "parking",
  "box",
  "stationnement",
  "stationnement double",
  "emplacement de stationnement",
  "emplacement de stationnement double",
];

// Build the mapping
MAIN_HABITATION_KEYWORDS.forEach((k) => {
  LOT_FAMILY_MAPPING[k.toLowerCase()] = "MAIN_HABITATION";
});
MAIN_COMMERCE_KEYWORDS.forEach((k) => {
  LOT_FAMILY_MAPPING[k.toLowerCase()] = "MAIN_COMMERCE";
});
DEPENDANCE_KEYWORDS.forEach((k) => {
  LOT_FAMILY_MAPPING[k.toLowerCase()] = "DEPENDANCE";
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getLotFamily(
  typeLot: string,
  issues: DataIssue[],
  lotNumber: string
): "MAIN_HABITATION" | "MAIN_COMMERCE" | "DEPENDANCE" {
  const normalized = typeLot.toLowerCase().trim();
  const family = LOT_FAMILY_MAPPING[normalized];

  if (family) {
    return family;
  }

  // Unknown mapping -> warning + default DEPENDANCE
  issues.push({
    severity: "warning",
    code: "unknown_lot_type_mapping",
    entity_type: "lot",
    entity_key: lotNumber,
    message: `Unknown TypeLot mapping: "${typeLot}", defaulting to DEPENDANCE`,
    payload: { type_lot: typeLot },
  });

  return "DEPENDANCE";
}

function parseNumeric(value: string | undefined | null): number | null {
  if (!value || value.trim() === "") return null;

  // Replace comma with dot for decimal
  const normalized = value.toString().replace(",", ".").trim();
  const parsed = parseFloat(normalized);

  return isNaN(parsed) ? null : parsed;
}

function parseDate(value: string | undefined | null): string | null {
  if (!value || value.trim() === "") return null;

  const str = value.toString().trim();

  // Try various date formats
  // Excel serial number
  if (/^\d+$/.test(str)) {
    const serial = parseInt(str);
    // Excel serial date (days since 1900-01-01, with Excel bug for 1900 leap year)
    const date = new Date((serial - 25569) * 86400 * 1000);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split("T")[0];
    }
  }

  // Try ISO format
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split("T")[0];
    }
  }

  // Try DD/MM/YYYY format
  const frMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (frMatch) {
    const [, day, month, year] = frMatch;
    const date = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split("T")[0];
    }
  }

  return null;
}

function parseTantieme(
  value: string | undefined | null,
  columnName: string,
  issues: DataIssue[],
  lotNumber: string
): { num: number | null; den: number | null } {
  if (!value || value.toString().trim() === "") {
    return { num: null, den: null };
  }

  const str = value.toString().trim();

  // Try fraction format "411/10000"
  const fractionMatch = str.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fractionMatch) {
    return {
      num: parseInt(fractionMatch[1]),
      den: parseInt(fractionMatch[2]),
    };
  }

  // Try integer format "411"
  const intMatch = str.match(/^(\d+)$/);
  if (intMatch) {
    issues.push({
      severity: "warning",
      code: "tantieme_denominator_missing",
      entity_type: "lot",
      entity_key: lotNumber,
      message: `Tantieme denominator missing for ${columnName}`,
      payload: { column: columnName, value: str },
    });
    return {
      num: parseInt(intMatch[1]),
      den: null,
    };
  }

  // Invalid format
  issues.push({
    severity: "warning",
    code: "edd_tantieme_invalid_format",
    entity_type: "lot",
    entity_key: lotNumber,
    message: `Invalid tantieme format for ${columnName}: "${str}"`,
    payload: { column: columnName, value: str },
  });

  return { num: null, den: null };
}

function parseExteriors(
  exteriorsValue: string | undefined | null,
  surfacesValue: string | undefined | null,
  issues: DataIssue[],
  lotNumber: string
): { type: string; surface_m2: number | null }[] | null {
  if (!exteriorsValue || exteriorsValue.toString().trim() === "") {
    return null;
  }

  const types = exteriorsValue
    .toString()
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");

  if (types.length === 0) {
    return null;
  }

  // Parse surfaces
  let surfaces: (number | null)[] = [];
  if (surfacesValue && surfacesValue.toString().trim() !== "") {
    const surfaceStr = surfacesValue.toString();

    if (types.length === 1) {
      // Single exterior: surface may be decimal
      surfaces = [parseNumeric(surfaceStr)];
    } else {
      // Multiple exteriors: surfaces separated by ", " (comma + space)
      surfaces = surfaceStr.split(", ").map((s) => parseNumeric(s.trim()));
    }
  }

  // Check count mismatch
  if (surfaces.length > 0 && surfaces.length !== types.length) {
    issues.push({
      severity: "warning",
      code: "edd_exteriors_surface_count_mismatch",
      entity_type: "lot",
      entity_key: lotNumber,
      message: `Exteriors count (${types.length}) != surfaces count (${surfaces.length})`,
      payload: { exteriors: types, surfaces },
    });
  }

  // Build result
  return types.map((type, i) => ({
    type,
    surface_m2: surfaces[i] ?? null,
  }));
}

function getCivilityInfo(civilityRaw: string): {
  contact_category: "physical" | "legal_entity" | "group";
  legal_form: "STE" | "SCI" | "SDC" | null;
  group_type: "INDIV" | "CONSOR" | "SUCESS" | null;
  isUnknown: boolean;
} {
  const normalized = civilityRaw.trim();

  // Physical persons
  if (["Monsieur", "Madame", "Monsieur ou Madame"].includes(normalized)) {
    return { contact_category: "physical", legal_form: null, group_type: null, isUnknown: false };
  }

  // Legal entities
  if (["STE", "SCI", "SDC"].includes(normalized)) {
    return {
      contact_category: "legal_entity",
      legal_form: normalized as "STE" | "SCI" | "SDC",
      group_type: null,
      isUnknown: false,
    };
  }

  // Groups
  if (["INDIV", "CONSOR", "SUCESS"].includes(normalized)) {
    return {
      contact_category: "group",
      legal_form: null,
      group_type: normalized as "INDIV" | "CONSOR" | "SUCESS",
      isUnknown: false,
    };
  }

  // Unknown -> fallback to physical
  return { contact_category: "physical", legal_form: null, group_type: null, isUnknown: true };
}

function getDisplayName(
  contactCategory: string,
  firstName: string | null,
  lastName: string
): string {
  if (contactCategory === "physical") {
    if (firstName && firstName.trim() !== "") {
      return `${firstName.trim()} ${lastName.trim()}`;
    }
    return lastName.trim();
  }
  // legal_entity or group
  return lastName.trim();
}

function toStr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str === "" ? null : str;
}

// ============================================================
// MAIN HANDLER
// ============================================================

serve(async (req) => {
  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Initialize Supabase client
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let jobId: string | null = null;
  const issues: DataIssue[] = [];
  const errorResponses: ErrorResponse[] = [];
  const reviewResponses: ReviewResponse[] = [];

  try {
    // Parse request body
    const body: RequestBody = await req.json();
    const { tenant_id, copro_id, copro_addresses, copro_cadastral_refs, files } = body;

    // Validate required fields
    if (!tenant_id || !copro_id || !files?.edd_path || !files?.lot_ref_path || !files?.contacts_path) {
      return new Response(
        JSON.stringify({
          job_id: null,
          status: "failed",
          stats: null,
          reviews: [],
          errors: [{ code: "invalid_request", message: "Missing required fields", entity: "request" }],
        } as ApiResponse),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }

    // Create import job
    const { data: jobData, error: jobError } = await supabase
      .from("import_jobs")
      .insert({
        tenant_id,
        copro_id,
        status: "running",
        files: files,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (jobError || !jobData) {
      throw new Error(`Failed to create import job: ${jobError?.message}`);
    }

    jobId = jobData.id;

    // ============================================================
    // DOWNLOAD AND PARSE FILES
    // ============================================================

    // Download EDD file
    const { data: eddFileData, error: eddFileError } = await supabase.storage
      .from("imports")
      .download(files.edd_path);
    if (eddFileError || !eddFileData) {
      throw new Error(`Failed to download EDD file: ${eddFileError?.message}`);
    }

    // Download lot_ref file
    const { data: lotRefFileData, error: lotRefFileError } = await supabase.storage
      .from("imports")
      .download(files.lot_ref_path);
    if (lotRefFileError || !lotRefFileData) {
      throw new Error(`Failed to download lot_ref file: ${lotRefFileError?.message}`);
    }

    // Download contacts file
    const { data: contactsFileData, error: contactsFileError } = await supabase.storage
      .from("imports")
      .download(files.contacts_path);
    if (contactsFileError || !contactsFileData) {
      throw new Error(`Failed to download contacts file: ${contactsFileError?.message}`);
    }

    // Parse Excel files
    const eddWorkbook = XLSX.read(await eddFileData.arrayBuffer(), { type: "array" });
    const eddSheet = eddWorkbook.Sheets[eddWorkbook.SheetNames[0]];
    const eddRows: EddRow[] = XLSX.utils.sheet_to_json(eddSheet, { defval: "" });
    const eddHeaders = eddRows.length > 0 ? Object.keys(eddRows[0]) : [];

    const lotRefWorkbook = XLSX.read(await lotRefFileData.arrayBuffer(), { type: "array" });
    const lotRefSheet = lotRefWorkbook.Sheets[lotRefWorkbook.SheetNames[0]];
    const lotRefRows: LotRefRow[] = XLSX.utils.sheet_to_json(lotRefSheet, { defval: "" });
    const lotRefHeaders = lotRefRows.length > 0 ? Object.keys(lotRefRows[0]) : [];

    const contactsWorkbook = XLSX.read(await contactsFileData.arrayBuffer(), { type: "array" });
    const contactsSheet = contactsWorkbook.Sheets[contactsWorkbook.SheetNames[0]];
    const contactsRows: ContactRow[] = XLSX.utils.sheet_to_json(contactsSheet, { defval: "" });
    const contactsHeaders = contactsRows.length > 0 ? Object.keys(contactsRows[0]) : [];

    // ============================================================
    // VALIDATE REQUIRED HEADERS
    // ============================================================

    const eddRequiredHeaders = ["NumLot", "Etage", "TypeLot"];
    const lotRefRequiredHeaders = ["Référence", "N° lot"];
    const contactsRequiredHeaders = ["Référence", "Civilité", "Nom"];

    let hasFatalError = false;

    // Check EDD headers
    for (const header of eddRequiredHeaders) {
      if (!eddHeaders.includes(header)) {
        issues.push({
          severity: "error",
          code: "edd_missing_required_column",
          entity_type: "edd",
          entity_key: null,
          message: `Missing required column: ${header}`,
          payload: { column: header },
        });
        errorResponses.push({
          code: "edd_missing_required_column",
          message: `Missing required column: ${header}`,
          entity: "edd",
          column: header,
        });
        hasFatalError = true;
      }
    }

    // Check lot_ref headers
    for (const header of lotRefRequiredHeaders) {
      if (!lotRefHeaders.includes(header)) {
        issues.push({
          severity: "error",
          code: "lot_ref_missing_required_column",
          entity_type: "lot_ref",
          entity_key: null,
          message: `Missing required column: ${header}`,
          payload: { column: header },
        });
        errorResponses.push({
          code: "lot_ref_missing_required_column",
          message: `Missing required column: ${header}`,
          entity: "lot_ref",
          column: header,
        });
        hasFatalError = true;
      }
    }

    // Check contacts headers
    for (const header of contactsRequiredHeaders) {
      if (!contactsHeaders.includes(header)) {
        issues.push({
          severity: "error",
          code: "contacts_missing_required_column",
          entity_type: "contacts",
          entity_key: null,
          message: `Missing required column: ${header}`,
          payload: { column: header },
        });
        errorResponses.push({
          code: "contacts_missing_required_column",
          message: `Missing required column: ${header}`,
          entity: "contacts",
          column: header,
        });
        hasFatalError = true;
      }
    }

    // If fatal error, save issues and return failed
    if (hasFatalError) {
      // Save issues to database
      if (issues.length > 0) {
        await supabase.from("data_issues").insert(
          issues.map((issue) => ({
            job_id: jobId,
            tenant_id,
            ...issue,
          }))
        );
      }

      // Update job status to failed
      await supabase
        .from("import_jobs")
        .update({
          status: "failed",
          ended_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      return new Response(
        JSON.stringify({
          job_id: jobId,
          status: "failed",
          stats: null,
          reviews: [],
          errors: errorResponses,
        } as ApiResponse),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // ============================================================
    // PROCESS ADDRESSES AND PARCELS
    // ============================================================

    const addressIdMap = new Map<string, string>();
    let mainAddressId: string | null = null;

    // Upsert addresses
    for (const addr of copro_addresses) {
      const { data: addrData, error: addrError } = await supabase
        .from("addresses")
        .upsert(
          { tenant_id, label: addr.label },
          { onConflict: "tenant_id,label", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (addrError || !addrData) {
        // Try to get existing
        const { data: existingAddr } = await supabase
          .from("addresses")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("label", addr.label)
          .single();

        if (existingAddr) {
          addressIdMap.set(addr.label, existingAddr.id);
          if (addr.role === "main") mainAddressId = existingAddr.id;
        }
      } else {
        addressIdMap.set(addr.label, addrData.id);
        if (addr.role === "main") mainAddressId = addrData.id;
      }
    }

    // Link copro to addresses
    for (const addr of copro_addresses) {
      const addressId = addressIdMap.get(addr.label);
      if (addressId) {
        await supabase
          .from("copro_addresses")
          .upsert(
            { tenant_id, copro_id, address_id: addressId, role: addr.role },
            { onConflict: "tenant_id,copro_id,address_id", ignoreDuplicates: true }
          );
      }
    }

    // Upsert parcels
    const parcelIds: string[] = [];
    for (const ref of copro_cadastral_refs) {
      const { data: parcelData, error: parcelError } = await supabase
        .from("parcels")
        .upsert(
          { tenant_id, cadastral_ref: ref },
          { onConflict: "tenant_id,cadastral_ref", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (parcelError || !parcelData) {
        // Try to get existing
        const { data: existingParcel } = await supabase
          .from("parcels")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("cadastral_ref", ref)
          .single();

        if (existingParcel) {
          parcelIds.push(existingParcel.id);
        }
      } else {
        parcelIds.push(parcelData.id);
      }
    }

    // Link copro to parcels
    for (const parcelId of parcelIds) {
      await supabase
        .from("copro_parcels")
        .upsert(
          { tenant_id, copro_id, parcel_id: parcelId },
          { onConflict: "tenant_id,copro_id,parcel_id", ignoreDuplicates: true }
        );
    }

    // ============================================================
    // PARSE AND UPSERT LOTS
    // ============================================================

    const lotsMap = new Map<string, ParsedLot>();
    const lotIdMap = new Map<string, string>();

    for (const row of eddRows) {
      const lotNumber = toStr(row.NumLot);
      if (!lotNumber) continue;

      const floorLabel = toStr(row.Etage) || "";
      const typeLot = toStr(row.TypeLot) || "";

      const lotFamily = getLotFamily(typeLot, issues, lotNumber);

      // Parse surface
      let surfaceM2: number | null = null;
      const rawSurface = toStr(row.SurfaceLot);
      if (rawSurface) {
        surfaceM2 = parseNumeric(rawSurface);
        if (surfaceM2 === null) {
          issues.push({
            severity: "warning",
            code: "edd_surface_lot_invalid",
            entity_type: "lot",
            entity_key: lotNumber,
            message: `Invalid SurfaceLot value: "${rawSurface}"`,
            payload: { value: rawSurface },
          });
        }
      }

      // Parse exteriors
      const exteriors = parseExteriors(
        toStr(row.Exterieurs),
        toStr(row.SurfaceExterieurs),
        issues,
        lotNumber
      );

      // Parse tantiemes
      const tantGen = parseTantieme(toStr(row.QuotesPartsGenerales), "QuotesPartsGenerales", issues, lotNumber);
      const tantAsc = parseTantieme(toStr(row["Quotes-parts Ascenseurs"]), "Quotes-parts Ascenseurs", issues, lotNumber);
      const tantStairs = parseTantieme(toStr(row["Quotes-parts Escaliers"]), "Quotes-parts Escaliers", issues, lotNumber);
      const tantHeat = parseTantieme(toStr(row["Quotes-parts Chauffage"]), "Quotes-parts Chauffage", issues, lotNumber);

      // Parse date
      let acquiredAt: string | null = null;
      const rawDate = toStr(row.DateArrivee);
      if (rawDate) {
        acquiredAt = parseDate(rawDate);
        if (acquiredAt === null) {
          issues.push({
            severity: "warning",
            code: "edd_date_arrivee_invalid",
            entity_type: "lot",
            entity_key: lotNumber,
            message: `Invalid DateArrivee value: "${rawDate}"`,
            payload: { value: rawDate },
          });
        }
      }

      // Parse works fund amount
      let worksFundAmount: number | null = null;
      const rawWorksFund = toStr(row["Montant Fond travaux"]);
      if (rawWorksFund) {
        worksFundAmount = parseNumeric(rawWorksFund);
      }

      const parsedLot: ParsedLot = {
        lot_number: lotNumber,
        floor_label: floorLabel,
        lot_type_label: typeLot,
        lot_family: lotFamily,
        surface_m2: surfaceM2,
        exteriors,
        tantiemes_general_num: tantGen.num,
        tantiemes_general_den: tantGen.den,
        tantiemes_asc_num: tantAsc.num,
        tantiemes_asc_den: tantAsc.den,
        tantiemes_stairs_num: tantStairs.num,
        tantiemes_stairs_den: tantStairs.den,
        tantiemes_heat_num: tantHeat.num,
        tantiemes_heat_den: tantHeat.den,
        observations: toStr(row.Observations),
        acquired_at: acquiredAt,
        building: toStr(row.Batiment),
        staircase: toStr(row["Escalier "]),
        nb_rooms: toStr(row.NbPieces),
        door_number: toStr(row.NumPorte),
        annex_lot: toStr(row.AnnexeLot),
        works_fund_amount: worksFundAmount,
      };

      lotsMap.set(lotNumber, parsedLot);
    }

    // Upsert lots to database
    let lotsUpserted = 0;
    for (const [lotNumber, lot] of lotsMap) {
      const { data: lotData, error: lotError } = await supabase
        .from("lots")
        .upsert(
          {
            tenant_id,
            copro_id,
            lot_number: lot.lot_number,
            floor_label: lot.floor_label,
            lot_type_label: lot.lot_type_label,
            lot_family: lot.lot_family,
            surface_m2: lot.surface_m2,
            exteriors: lot.exteriors,
            tantiemes_general_num: lot.tantiemes_general_num,
            tantiemes_general_den: lot.tantiemes_general_den,
            tantiemes_asc_num: lot.tantiemes_asc_num,
            tantiemes_asc_den: lot.tantiemes_asc_den,
            tantiemes_stairs_num: lot.tantiemes_stairs_num,
            tantiemes_stairs_den: lot.tantiemes_stairs_den,
            tantiemes_heat_num: lot.tantiemes_heat_num,
            tantiemes_heat_den: lot.tantiemes_heat_den,
            observations: lot.observations,
            acquired_at: lot.acquired_at,
            building: lot.building,
            staircase: lot.staircase,
            nb_rooms: lot.nb_rooms,
            door_number: lot.door_number,
            annex_lot: lot.annex_lot,
            works_fund_amount: lot.works_fund_amount,
            source_job_id: jobId,
          },
          { onConflict: "tenant_id,copro_id,lot_number", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (!lotError && lotData) {
        lotIdMap.set(lotNumber, lotData.id);
        lotsUpserted++;
      } else {
        // Try to get existing
        const { data: existingLot } = await supabase
          .from("lots")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("copro_id", copro_id)
          .eq("lot_number", lotNumber)
          .single();

        if (existingLot) {
          lotIdMap.set(lotNumber, existingLot.id);
          lotsUpserted++;
        }
      }
    }

    // ============================================================
    // PARSE LOT_REF (OWNER_REF -> LOTS)
    // ============================================================

    const ownerToLots = new Map<string, string[]>();
    const lotsWithOwner = new Set<string>();

    for (const row of lotRefRows) {
      const ownerRef = toStr(row["Référence"]);
      const lotNumber = toStr(row["N° lot"]);

      if (!ownerRef || !lotNumber) continue;

      // Check if lot exists in EDD
      if (!lotsMap.has(lotNumber)) {
        issues.push({
          severity: "warning",
          code: "owner_link_without_lot",
          entity_type: "lot_ref",
          entity_key: lotNumber,
          message: `Lot "${lotNumber}" referenced in lot_ref but not found in EDD`,
          payload: { owner_ref: ownerRef, lot_number: lotNumber },
        });
        continue;
      }

      lotsWithOwner.add(lotNumber);

      if (!ownerToLots.has(ownerRef)) {
        ownerToLots.set(ownerRef, []);
      }
      ownerToLots.get(ownerRef)!.push(lotNumber);
    }

    // Check for lots without owner
    for (const lotNumber of lotsMap.keys()) {
      if (!lotsWithOwner.has(lotNumber)) {
        issues.push({
          severity: "warning",
          code: "missing_owner_link",
          entity_type: "lot",
          entity_key: lotNumber,
          message: `Lot "${lotNumber}" has no owner reference in lot_ref`,
          payload: { lot_number: lotNumber },
        });
      }
    }

    // ============================================================
    // PARSE AND UPSERT CONTACTS
    // ============================================================

    const contactsMap = new Map<string, ParsedContact>();
    const contactIdMap = new Map<string, string>();

    for (const row of contactsRows) {
      const externalRef = toStr(row["Référence"]);
      const civilityRaw = toStr(row["Civilité"]) || "";
      const nom = toStr(row["Nom"]);

      if (!externalRef || !nom) continue;

      const civilityInfo = getCivilityInfo(civilityRaw);

      if (civilityInfo.isUnknown) {
        issues.push({
          severity: "warning",
          code: "contacts_unknown_civility_value",
          entity_type: "contact",
          entity_key: externalRef,
          message: `Unknown civility value: "${civilityRaw}", defaulting to physical`,
          payload: { civility: civilityRaw },
        });
      }

      const firstName = toStr(row["Prénom"]);
      const displayName = getDisplayName(civilityInfo.contact_category, firstName, nom);

      const parsedContact: ParsedContact = {
        external_ref: externalRef,
        civility_raw: civilityRaw,
        contact_category: civilityInfo.contact_category,
        legal_form: civilityInfo.legal_form,
        group_type: civilityInfo.group_type,
        first_name: firstName,
        last_name_or_name: nom,
        display_name: displayName,
        address_line1: toStr(row["Adresse 1"]),
        address_line2: toStr(row["Adresse 2"]),
        postcode: toStr(row["Code postal"]),
        city: toStr(row["Ville"]),
        country: toStr(row["Pays"]),
        email: toStr(row["e-mail"]),
        phone1: toStr(row["Téléphone 1"]),
        phone2: toStr(row["Téléphone 2"]),
      };

      contactsMap.set(externalRef, parsedContact);
    }

    // Check for missing contacts for owner_refs
    for (const ownerRef of ownerToLots.keys()) {
      if (!contactsMap.has(ownerRef)) {
        issues.push({
          severity: "warning",
          code: "missing_contact_for_owner_ref",
          entity_type: "contact",
          entity_key: ownerRef,
          message: `Owner reference "${ownerRef}" from lot_ref has no matching contact`,
          payload: { owner_ref: ownerRef },
        });
      }
    }

    // Upsert contacts to database
    let contactsUpserted = 0;
    for (const [ref, contact] of contactsMap) {
      const { data: contactData, error: contactError } = await supabase
        .from("contacts")
        .upsert(
          {
            tenant_id,
            external_ref: contact.external_ref,
            civility_raw: contact.civility_raw,
            contact_category: contact.contact_category,
            legal_form: contact.legal_form,
            group_type: contact.group_type,
            first_name: contact.first_name,
            last_name_or_name: contact.last_name_or_name,
            display_name: contact.display_name,
            address_line1: contact.address_line1,
            address_line2: contact.address_line2,
            postcode: contact.postcode,
            city: contact.city,
            country: contact.country,
            email: contact.email,
            phone1: contact.phone1,
            phone2: contact.phone2,
          },
          { onConflict: "tenant_id,external_ref", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (!contactError && contactData) {
        contactIdMap.set(ref, contactData.id);
        contactsUpserted++;
      } else {
        // Try to get existing
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("external_ref", ref)
          .single();

        if (existingContact) {
          contactIdMap.set(ref, existingContact.id);
          contactsUpserted++;
        }
      }
    }

    // ============================================================
    // BUILD UNITS
    // ============================================================

    let unitsCreated = 0;
    let unitLotsCreated = 0;
    let unitOwnersCreated = 0;
    let reviewsCreated = 0;

    for (const [ownerRef, lotNumbers] of ownerToLots) {
      // Get lot details
      const ownerLots = lotNumbers
        .map((ln) => lotsMap.get(ln))
        .filter((l): l is ParsedLot => l !== undefined);

      // Classify lots
      const mainHabLots = ownerLots.filter((l) => l.lot_family === "MAIN_HABITATION");
      const mainCommLots = ownerLots.filter((l) => l.lot_family === "MAIN_COMMERCE");
      const depLots = ownerLots.filter((l) => l.lot_family === "DEPENDANCE");

      const contact = contactsMap.get(ownerRef);
      const contactId = contactIdMap.get(ownerRef);

      // ============================================================
      // CASE: Multiple MAIN_HABITATION lots -> Review required
      // ============================================================
      if (mainHabLots.length >= 2) {
        // Build proposals
        const proposals = {
          P1_split: mainHabLots.map((l) => ({
            main_lot: l.lot_number,
            unit_type: "habitation",
            dep_lots: depLots.map((d) => d.lot_number),
          })),
          P2_merge: {
            main_lot: mainHabLots[0].lot_number,
            unit_type: "habitation",
            all_lots: ownerLots.map((l) => l.lot_number),
          },
        };

        const lotsInScope = {
          main_habitation: mainHabLots.map((l) => ({
            lot_number: l.lot_number,
            lot_type_label: l.lot_type_label,
          })),
          main_commerce: mainCommLots.map((l) => ({
            lot_number: l.lot_number,
            lot_type_label: l.lot_type_label,
          })),
          dependance: depLots.map((l) => ({
            lot_number: l.lot_number,
            lot_type_label: l.lot_type_label,
          })),
        };

        const { data: reviewData } = await supabase
          .from("unit_build_reviews")
          .insert({
            tenant_id,
            copro_id,
            job_id: jobId,
            owner_ref: ownerRef,
            status: "pending_review",
            reason: "multiple_habitation_main_lots",
            lots_in_scope: lotsInScope,
            proposals,
          })
          .select("id")
          .single();

        if (reviewData) {
          reviewsCreated++;
          reviewResponses.push({
            review_id: reviewData.id,
            owner_ref: ownerRef,
            display_name: contact?.display_name || ownerRef,
            contact_category: contact?.contact_category || "physical",
            legal_form: contact?.legal_form || null,
            group_type: contact?.group_type || null,
            main_hab_lots: mainHabLots.map((l) => l.lot_number),
            dep_lots: depLots.map((l) => l.lot_number),
            reason: "multiple_habitation_main_lots",
          });
        }

        continue; // Do NOT create units for this owner
      }

      // ============================================================
      // CASE: Exactly 1 main lot (habitation OR commerce)
      // ============================================================
      const mainLot = mainHabLots[0] || mainCommLots[0];

      if (mainLot) {
        const unitType = mainLot.lot_family === "MAIN_HABITATION" ? "habitation" : "commercial";

        // Create unit
        const { data: unitData, error: unitError } = await supabase
          .from("units")
          .insert({
            tenant_id,
            copro_id,
            unit_type: unitType,
            status: "active",
            main_lot_number: mainLot.lot_number,
            source_owner_external_ref: ownerRef,
            source_job_id: jobId,
          })
          .select("id")
          .single();

        if (unitError || !unitData) continue;

        unitsCreated++;
        const unitId = unitData.id;

        // Create unit_lots (main lot)
        const mainLotId = lotIdMap.get(mainLot.lot_number);
        if (mainLotId) {
          await supabase.from("unit_lots").insert({
            tenant_id,
            unit_id: unitId,
            lot_id: mainLotId,
            role: "main",
          });
          unitLotsCreated++;
        }

        // Create unit_lots (annex lots = all dependances)
        for (const depLot of depLots) {
          const depLotId = lotIdMap.get(depLot.lot_number);
          if (depLotId) {
            await supabase.from("unit_lots").insert({
              tenant_id,
              unit_id: unitId,
              lot_id: depLotId,
              role: "annex",
            });
            unitLotsCreated++;
          }
        }

        // Create unit_owners
        if (contactId) {
          await supabase.from("unit_owners").insert({
            tenant_id,
            unit_id: unitId,
            contact_id: contactId,
          });
          unitOwnersCreated++;
        }

        // Create unit_addresses (main address)
        if (mainAddressId) {
          await supabase.from("unit_addresses").insert({
            tenant_id,
            unit_id: unitId,
            address_id: mainAddressId,
            role: "main",
          });
        }

        // Create unit_parcels (all copro parcels)
        for (const parcelId of parcelIds) {
          await supabase.from("unit_parcels").insert({
            tenant_id,
            unit_id: unitId,
            parcel_id: parcelId,
          });
        }

        continue;
      }

      // ============================================================
      // CASE: Dependance-only (no main lot)
      // ============================================================
      if (depLots.length > 0) {
        // Group dependances by normalized lot_type_label
        const depByType = new Map<string, ParsedLot[]>();
        for (const dep of depLots) {
          const normalizedType = dep.lot_type_label.toLowerCase().trim();
          if (!depByType.has(normalizedType)) {
            depByType.set(normalizedType, []);
          }
          depByType.get(normalizedType)!.push(dep);
        }

        // Create one unit per dependance type
        for (const [depType, lotsOfType] of depByType) {
          const { data: unitData, error: unitError } = await supabase
            .from("units")
            .insert({
              tenant_id,
              copro_id,
              unit_type: "dependance",
              status: "active",
              main_lot_number: lotsOfType[0].lot_number,
              source_owner_external_ref: ownerRef,
              source_job_id: jobId,
            })
            .select("id")
            .single();

          if (unitError || !unitData) continue;

          unitsCreated++;
          const unitId = unitData.id;

          // Create unit_lots for all lots of this type
          for (const lot of lotsOfType) {
            const lotId = lotIdMap.get(lot.lot_number);
            if (lotId) {
              await supabase.from("unit_lots").insert({
                tenant_id,
                unit_id: unitId,
                lot_id: lotId,
                role: "main",
              });
              unitLotsCreated++;
            }
          }

          // Create unit_owners
          if (contactId) {
            await supabase.from("unit_owners").insert({
              tenant_id,
              unit_id: unitId,
              contact_id: contactId,
            });
            unitOwnersCreated++;
          }

          // Create unit_addresses (main address)
          if (mainAddressId) {
            await supabase.from("unit_addresses").insert({
              tenant_id,
              unit_id: unitId,
              address_id: mainAddressId,
              role: "main",
            });
          }

          // Create unit_parcels (all copro parcels)
          for (const parcelId of parcelIds) {
            await supabase.from("unit_parcels").insert({
              tenant_id,
              unit_id: unitId,
              parcel_id: parcelId,
            });
          }
        }
      }
    }

    // ============================================================
    // SAVE ISSUES AND FINALIZE JOB
    // ============================================================

    // Save all issues to database
    if (issues.length > 0) {
      await supabase.from("data_issues").insert(
        issues.map((issue) => ({
          job_id: jobId,
          tenant_id,
          ...issue,
        }))
      );
    }

    // Count issues by severity
    const issuesWarning = issues.filter((i) => i.severity === "warning").length;
    const issuesError = issues.filter((i) => i.severity === "error").length;

    // Determine final status
    const finalStatus = reviewsCreated > 0 ? "completed_with_review_required" : "completed";

    // Build stats
    const stats: Stats = {
      lots_upserted: lotsUpserted,
      contacts_upserted: contactsUpserted,
      units_created: unitsCreated,
      unit_lots_created: unitLotsCreated,
      unit_owners_created: unitOwnersCreated,
      reviews_created: reviewsCreated,
      issues_warning: issuesWarning,
      issues_error: issuesError,
    };

    // Update job
    await supabase
      .from("import_jobs")
      .update({
        status: finalStatus,
        stats,
        ended_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    // Return response
    const response: ApiResponse = {
      job_id: jobId,
      status: finalStatus,
      stats,
      reviews: reviewResponses,
      errors: [],
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error("Error in edd-import:", error);

    // Update job status to failed if we have a job
    if (jobId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      await supabase
        .from("import_jobs")
        .update({
          status: "failed",
          ended_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    }

    return new Response(
      JSON.stringify({
        job_id: jobId,
        status: "failed",
        stats: null,
        reviews: [],
        errors: [
          {
            code: "internal_error",
            message: "An internal error occurred during import",
            entity: "system",
          },
        ],
      } as ApiResponse),
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
        status: 500,
      }
    );
  }
});
