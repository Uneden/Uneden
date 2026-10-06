import pool from "../config/db.js";
import { createClient } from "@supabase/supabase-js";
import { sanitizeText, validateInput } from "../utils/validate.js";

const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;
import { CLIENT_TAX_PROVINCE_SQL } from "../utils/taxProvince.js";
import { expandLocationILIKEpatterns } from "../utils/caLocationFilter.js";
import { sanitizeListingTranslations, canonicalListingTexts } from "../utils/serviceTranslations.js";
import {
  canonServiceFieldsInPlace,
  normalizeAvailability,
  normalizeMobility,
  serviceTextLengthError,
} from "../utils/serviceFieldCanonical.js";
import { normalizeDurationForStorage } from "../utils/serviceDuration.js";
import { resolveServicePricingFields } from "../utils/servicePricing.js";
import {
  normalizeListingTags,
  ensureListingTagsSchema,
  OTHER_CATEGORY_NAME,
} from "../utils/listingTags.js";
import {
  ensureDepositsAndCalendarSchema,
  parseDepositFields,
  resolveDepositBaseAmount,
} from "../utils/depositSchema.js";
import {
  isTestListingTitle,
  publicTestListingFilter,
  shouldHideTestListingsFromPublic,
} from "../utils/testListings.js";
import {
  ensureListingVisibilitySchema,
  publicListingFilter,
  parseIsPublic,
  canViewService,
} from "../utils/listingVisibility.js";
import {
  ensureServiceLocationsSchema,
  normalizeLocationsInput,
  primaryLocationFields,
  locationTextMatchClause,
  minDistanceExpr,
  withinRadiusClause,
  resolveListingLocationForSearch,
} from "../utils/serviceLocations.js";
import {
  normalizedLocationKeySql,
  normalizedLocationMatchClause,
  rankLocationSearchMatch,
} from "../utils/locationSearchNormalize.js";

function normalizeTagKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isOtherCategoryName(name) {
  const key = normalizeTagKey(name);
  return key === "other" || key === "autre" || key === "autres";
}

function listingTagMatchClause(paramCount) {
  return `(
    s.subcategory ILIKE $${paramCount}
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(s.listing_tags, '[]'::jsonb)) AS tag(value)
      WHERE tag.value ILIKE $${paramCount}
    )
  )`;
}

export const createService = async (req, res) => {
  try {
    await ensureListingTagsSchema(pool);
    await ensureDepositsAndCalendarSchema(pool);
    await ensureListingVisibilitySchema(pool);
    await ensureServiceLocationsSchema(pool);
    const translationsSanitized = sanitizeListingTranslations(req.body.translations);
    const canon = canonicalListingTexts(translationsSanitized);

    let mergedTitle = canon.title || sanitizeText(String(req.body.title ?? ""));
    let mergedDesc = canon.description || sanitizeText(String(req.body.description ?? ""));
    mergedTitle = String(mergedTitle).trim();
    mergedDesc = String(mergedDesc).trim();

    const { errors, data } = validateInput(
      { ...req.body, title: mergedTitle, description: mergedDesc },
      {
        title: { required: true, type: "string", maxLen: 200 },
        description: { required: true, type: "string", maxLen: 5000 },
        type: { required: true, enum: ["offer", "looking"] },
      },
    );

    if (errors) {
      return res.status(400).json({ message: errors[0] });
    }

    const pricingResolved = resolveServicePricingFields({ ...req.body, ...data }, { isCreate: true });
    if (pricingResolved.error) {
      return res.status(400).json({ message: pricingResolved.error });
    }

    const {
      type,
      title,
      description,
      category,
      category_id,
      subcategory,
      location,
      address,
      latitude,
      longitude,
      city,
      poster_type,
      availability,
      language,
      mobility,
      duration,
      urgency,
      image_url,
      image_urls,
      is_one_time,
      hide_exact_location,
      is_public,
    } = { ...req.body, ...data };

    const isPublic = parseIsPublic(is_public);

    // Resolve canonical image list: prefer image_urls array, fall back to single image_url
    const resolvedImageUrls = Array.isArray(image_urls) && image_urls.length > 0
      ? image_urls
      : (image_url ? [image_url] : []);
    const resolvedImageUrl = resolvedImageUrls[0] ?? null;

    const tagFields = normalizeListingTags(req.body);

    const depositBase = resolveDepositBaseAmount(
      { ...pricingResolved, pricing_mode: pricingResolved.pricing_mode },
      null,
    );
    let depositParsed = parseDepositFields(
      req.body,
      depositBase,
      pricingResolved.pricing_mode,
    );
    if (depositParsed.error) {
      return res.status(400).json({ message: depositParsed.error });
    }
    // Looking ads: poster pays — no listing-level deposit.
    if (type === "looking") {
      depositParsed = {
        deposit_enabled: false,
        deposit_type: null,
        deposit_value: null,
        error: null,
      };
    }

    const locationsParsed = normalizeLocationsInput(req.body);
    if (locationsParsed.error) {
      return res.status(400).json({ message: locationsParsed.error });
    }
    const primaryLoc = primaryLocationFields(locationsParsed.locations);

    const textFields = {
      poster_type: poster_type || null,
      availability: normalizeAvailability(availability) || null,
      language: language || null,
      mobility: normalizeMobility(mobility) || null,
      duration: normalizeDurationForStorage(duration),
      urgency: urgency || null,
    };
    const textError = serviceTextLengthError(textFields);
    if (textError) {
      return res.status(400).json({ message: textError });
    }

    // Créer le service
    const result = await pool.query(
      `INSERT INTO services (
        user_id, type, title, description, category, category_id, subcategory,
        listing_tags, has_custom_tags,
        price, location, address, latitude, longitude, city,
        poster_type, availability,
        language, mobility, duration, urgency, image_url, image_urls, is_one_time, hide_exact_location,
        pricing_mode, price_min, price_max, estimated_hours,
        deposit_enabled, deposit_type, deposit_value,
        translations, is_public, locations
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33::jsonb, $34, $35::jsonb)
      RETURNING *`,
      [
        req.user.id,
        type,
        data.title,
        data.description,
        category || null,
        category_id || null,
        tagFields.subcategory,
        JSON.stringify(tagFields.tags),
        tagFields.hasCustomTags,
        pricingResolved.price,
        primaryLoc.location,
        primaryLoc.address,
        primaryLoc.latitude,
        primaryLoc.longitude,
        primaryLoc.city,
        textFields.poster_type,
        textFields.availability,
        textFields.language,
        textFields.mobility,
        textFields.duration,
        textFields.urgency,
        resolvedImageUrl,
        resolvedImageUrls,
        is_one_time === true || is_one_time === "true" ? true : false,
        hide_exact_location === true || hide_exact_location === "true" ? true : false,
        pricingResolved.pricing_mode,
        pricingResolved.price_min,
        pricingResolved.price_max,
        pricingResolved.estimated_hours ?? null,
        depositParsed.deposit_enabled,
        depositParsed.deposit_type,
        depositParsed.deposit_value,
        translationsSanitized,
        isPublic,
        JSON.stringify(locationsParsed.locations),
      ]
    );

    const created = result.rows[0];
    canonServiceFieldsInPlace(created);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while creating service" });
  }
};

export const getAllServices = async (req, res) => {
  try {
    await ensureListingVisibilitySchema(pool);
    await ensureServiceLocationsSchema(pool);
    const {
      category,
      location,
      minPrice,
      maxPrice,
      search,
      categoryName,
      subcategory,
      type,
      userLat,
      userLng,
      radius,
      limit,
      page,
      spokenLanguage,
      pricingMode,
      pricing_mode,
    } = req.query;
    const categoryNames = String(categoryName || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const subcategories = String(subcategory || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const isPaginated = !!page;
    const parsedPage  = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.max(1, parseInt(limit, 10) || 12);
    const offset      = (parsedPage - 1) * parsedLimit;

    let query = `
      SELECT
        s.*,
        COALESCE(c.name, s.category) AS category_name,
        c.image_url AS category_image_url,
        (SELECT COUNT(*)::int FROM bookings b WHERE b.service_id = s.id AND b.status = 'completed') AS completed_bookings_count,
        (SELECT COUNT(*)::int FROM reviews r WHERE r.target_id = s.user_id) AS review_count,
        (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.target_id = s.user_id) AS average_rating
        ${isPaginated ? ", COUNT(*) OVER() AS total_count" : ""}
      FROM services s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.is_active = true
      ${publicTestListingFilter("s")}
      ${publicListingFilter("s")}
    `;

    const params = [];
    let paramCount = 1;

    if (category) {
      query += ` AND s.category_id = $${paramCount}`;
      params.push(category);
      paramCount++;
    }

    if (categoryNames.length > 0) {
      const otherFilter = categoryNames.some(isOtherCategoryName);
      const regularCategoryNames = categoryNames.filter((name) => !isOtherCategoryName(name));

      const categoryClauses = [];

      if (regularCategoryNames.length > 0) {
        regularCategoryNames.forEach((name) => {
          categoryClauses.push(`(c.name ILIKE $${paramCount} OR s.category ILIKE $${paramCount})`);
          params.push(`%${name}%`);
          paramCount++;
        });
      }

      if (otherFilter) {
        categoryClauses.push(
          `(s.category ILIKE $${paramCount} OR s.has_custom_tags = true)`,
        );
        params.push(`%${OTHER_CATEGORY_NAME}%`);
        paramCount++;
      }

      if (categoryClauses.length > 0) {
        query += ` AND (${categoryClauses.join(" OR ")})`;
      }
    }

    if (subcategories.length > 0) {
      const subcategoryClauses = subcategories.map((name) => {
        const clause = listingTagMatchClause(paramCount);
        params.push(`%${name}%`);
        paramCount++;
        return clause;
      });

      query += ` AND (${subcategoryClauses.join(" OR ")})`;
    }

    if (type && (type === "offer" || type === "looking")) {
      query += ` AND s.type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    /** Filtre langue : codes (french/en/bilingual), anciennes valeurs (fr_en, fr_en, etc.), JSON translations, repli FR si JSON sans clé fr mais titre/desc avec accents. */
    const tr = "COALESCE(s.translations, '{}'::jsonb)";
    const sl = String(spokenLanguage || "");
    if (["french", "english", "bilingual"].includes(sl)) {
      const txtFr = `(NULLIF(trim(${tr} #>> '{title,fr}'), '') IS NOT NULL OR NULLIF(trim(${tr} #>> '{description,fr}'), '') IS NOT NULL)`;
      const txtEn = `(NULLIF(trim(${tr} #>> '{title,en}'), '') IS NOT NULL OR NULLIF(trim(${tr} #>> '{description,en}'), '') IS NOT NULL)`;
      const langNorm = `lower(regexp_replace(trim(coalesce(s.language, '')), '[^a-z]+', '_', 'gi'))`;
      const langExact = `lower(trim(coalesce(s.language, '')))`;
      const langFrench = `(${langNorm} IN ('french','fr','francais','bilingual','fr_en','en_fr','fren','enfr'))
        OR ${langExact} IN (
          'french','fr','français','francais','bilingual','bilingue','fr_en','fr-en','en_fr','en-fr','fr,en','en,fr','fr en','en fr'
        )`;
      const langEnglish = `(${langNorm} IN ('english','en','bilingual','fr_en','en_fr','fren','enfr'))
        OR ${langExact} IN (
          'english','anglais','bilingual','bilingue','fr_en','fr-en','en_fr','en-fr','fr,en','en,fr','fr en','en fr'
        )`;
      const noFrInJson = `(NULLIF(trim(${tr} #>> '{title,fr}'), '') IS NULL AND NULLIF(trim(${tr} #>> '{description,fr}'), '') IS NULL)`;
      const heuristicFrCanon = `(${noFrInJson} AND NULLIF(concat(trim(coalesce(s.title,'')), ' ', trim(coalesce(s.description,''))), '') IS NOT NULL
        AND concat(trim(coalesce(s.title,'')), ' ', trim(coalesce(s.description,''))) ~ '[éèêëàâäùûüôöîïçœÉÈÀÇ]'::text)`;
      if (sl === "french") {
        query += ` AND (
            ${langFrench}
            OR ${txtFr}
            OR ${heuristicFrCanon}
          )`;
      } else if (sl === "english") {
        query += ` AND (
            ${langEnglish}
            OR ${txtEn}
          )`;
      } else if (sl === "bilingual") {
        query += ` AND (
            ${langExact} IN ('bilingual','bilingue')
            OR ${langNorm} IN ('bilingual','fr_en','en_fr','fren','enfr')
            OR (${txtFr} AND ${txtEn})
          )`;
      }
    }

    const pricingModeRaw = String(pricingMode || pricing_mode || "")
      .trim()
      .toLowerCase();
    if (["fixed", "range", "quote", "hourly"].includes(pricingModeRaw)) {
      query += ` AND COALESCE(NULLIF(trim(s.pricing_mode), ''), 'fixed') = $${paramCount}`;
      params.push(pricingModeRaw);
      paramCount++;
    }

    const lat = parseFloat(userLat);
    const lng = parseFloat(userLng);
    const km  = parseFloat(radius) || 50;
    const hasGeo = !isNaN(lat) && !isNaN(lng);
    const locRaw = location ? String(location).trim() : "";
    const hasLocText = Boolean(locRaw);
    let geoLatIdx = null;
    let geoLngIdx = null;

    const buildLocationTextSql = () => {
      const clauses = [locationTextMatchClause(`$${paramCount}`)];
      params.push(locRaw);
      let next = paramCount + 1;

      const extraPatterns = expandLocationILIKEpatterns(locRaw).filter(
        (pattern) => pattern !== `%${locRaw}%`,
      );
      for (const pattern of extraPatterns) {
        clauses.push(`(
          s.location ILIKE $${next}
          OR s.city ILIKE $${next}
          OR COALESCE(s.address, '') ILIKE $${next}
        )`);
        params.push(pattern);
        next++;
      }

      paramCount = next;
      return `(${clauses.join(" OR ")})`;
    };

    if (hasLocText && hasGeo) {
      const textSql = buildLocationTextSql();
      geoLatIdx = paramCount;
      geoLngIdx = paramCount + 1;
      const radiusIdx = paramCount + 2;
      query += ` AND (${textSql} OR ${withinRadiusClause(`$${geoLatIdx}`, `$${geoLngIdx}`, `$${radiusIdx}`)})`;
      params.push(lat, lng, km);
      paramCount += 3;
    } else if (hasLocText) {
      query += ` AND ${buildLocationTextSql()}`;
    }

    /** Filtre prix : listings « quote » inclus·es ; sinon borne basse / haute. */
    if (minPrice) {
      query += ` AND (
          COALESCE(s.pricing_mode, 'fixed') = 'quote'
          OR COALESCE(s.price_min, s.price)::numeric >= $${paramCount}::numeric
        )`;
      params.push(minPrice);
      paramCount++;
    }

    if (maxPrice) {
      query += ` AND (
          COALESCE(s.pricing_mode, 'fixed') = 'quote'
          OR COALESCE(s.price_max, s.price)::numeric <= $${paramCount}::numeric
        )`;
      params.push(maxPrice);
      paramCount++;
    }

    if (search && search.trim()) {
      // Bilingual synonym map (FR ↔ EN common service terms)
      const SYNONYMS = {
        cleaning: ["nettoyage", "ménage", "menage", "nettoyer"],
        nettoyage: ["cleaning", "ménage", "menage"],
        menage: ["cleaning", "nettoyage", "ménage"],
        moving: ["déménagement", "demenagement", "déménager"],
        "déménagement": ["moving", "demenagement"],
        demenagement: ["moving", "déménagement"],
        repair: ["réparation", "reparation", "réparer", "reparer"],
        "réparation": ["repair", "reparation", "fix"],
        reparation: ["repair", "réparation"],
        painting: ["peinture", "peindre", "peintre"],
        peinture: ["painting", "peindre"],
        gardening: ["jardinage", "jardin", "aménagement paysager"],
        jardinage: ["gardening", "garden", "jardin"],
        landscaping: ["aménagement paysager", "jardinage", "jardin"],
        childcare: ["garde enfants", "babysitting", "garderie"],
        babysitting: ["garde enfants", "childcare", "garderie"],
        "garde": ["childcare", "babysitting"],
        delivery: ["livraison", "livrer", "courses"],
        livraison: ["delivery", "livrer"],
        tech: ["informatique", "support technique", "ordinateur"],
        informatique: ["tech", "computer", "support"],
        snow: ["neige", "déneigement", "deneigement"],
        "déneigement": ["snow removal", "neige", "deneigement"],
        deneigement: ["déneigement", "snow"],
        plumbing: ["plomberie", "plombier"],
        plomberie: ["plumbing", "plombier"],
        electrical: ["électricité", "electricite", "électricien"],
        "électricité": ["electrical", "electricite"],
        pet: ["animal", "animaux", "chien", "chat"],
        dog: ["chien", "animal", "animaux"],
        cat: ["chat", "animal", "animaux"],
        tutoring: ["cours", "tutorat", "enseignement", "leçons"],
        cours: ["tutoring", "lessons", "leçons"],
        photography: ["photographie", "photo", "photographe"],
        photographie: ["photography", "photo"],
        renovation: ["rénovation", "rénover"],
        "rénovation": ["renovation", "rénover"],
      };

      const words = search.trim().split(/\s+/).filter((w) => w.length > 0);

      for (const word of words) {
        const lw = word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const synonymKey = Object.keys(SYNONYMS).find(
          (k) => k.normalize("NFD").replace(/[\u0300-\u036f]/g, "") === lw
        );
        const alternatives = synonymKey ? [word, ...SYNONYMS[synonymKey]] : [word];
        const conditions = [];

        for (const alt of alternatives) {
          const p = `%${alt}%`;
          conditions.push(
            `s.title ILIKE $${paramCount}`,
            `s.description ILIKE $${paramCount}`,
            `COALESCE(c.name, s.category) ILIKE $${paramCount}`,
            `s.subcategory ILIKE $${paramCount}`,
            `EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(COALESCE(s.listing_tags, '[]'::jsonb)) AS tag(value)
              WHERE tag.value ILIKE $${paramCount}
            )`,
            `s.city ILIKE $${paramCount}`,
            `s.location ILIKE $${paramCount}`,
            `EXISTS (
              SELECT 1
              FROM jsonb_array_elements(COALESCE(s.locations, '[]'::jsonb)) AS loc(value)
              WHERE loc.value->>'city' ILIKE $${paramCount}
                 OR loc.value->>'address' ILIKE $${paramCount}
                 OR loc.value->>'location' ILIKE $${paramCount}
            )`
          );
          params.push(p);
          paramCount++;
        }
        query += ` AND (${conditions.join(" OR ")})`;
      }
    }

    // Relevance score: rank title matches higher than description/category
    let hasSearch = !!(search && search.trim());
    let relevanceExpr = "s.created_at";
    if (hasSearch) {
      const scoreParam = `%${search.trim()}%`;
      relevanceExpr = `(
        CASE WHEN s.title ILIKE $${paramCount} THEN 100 ELSE 0 END +
        CASE WHEN s.title ILIKE $${paramCount + 1} THEN 60 ELSE 0 END +
        CASE WHEN COALESCE(c.name, s.category) ILIKE $${paramCount} THEN 30 ELSE 0 END +
        CASE WHEN s.subcategory ILIKE $${paramCount} THEN 20 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(s.listing_tags, '[]'::jsonb)) AS tag(value)
          WHERE tag.value ILIKE $${paramCount}
        ) THEN 20 ELSE 0 END +
        CASE WHEN s.description ILIKE $${paramCount} THEN 10 ELSE 0 END
      )`;
      params.push(scoreParam, `${search.trim()}%`);
      paramCount += 2;
    }

    if (hasGeo) {
      if (!hasLocText) {
        geoLatIdx = paramCount;
        geoLngIdx = paramCount + 1;
        query += `
          AND ${withinRadiusClause(`$${paramCount}`, `$${paramCount + 1}`, `$${paramCount + 2}`)}
        `;
        params.push(lat, lng, km);
        paramCount += 3;
      }

      const distExpr = minDistanceExpr(`$${geoLatIdx}`, `$${geoLngIdx}`);

      query += `
          ORDER BY ${hasSearch ? `${relevanceExpr} DESC,` : ""} ${distExpr} ASC
        `;
    } else {
      query += hasSearch
        ? ` ORDER BY ${relevanceExpr} DESC, s.created_at DESC`
        : ` ORDER BY s.created_at DESC`;
    }

    if (isPaginated) {
      query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params.push(parsedLimit, offset);
    } else if (limit) {
      const limitOnly = parseInt(limit, 10);
      if (!isNaN(limitOnly) && limitOnly > 0) {
        query += ` LIMIT $${paramCount}`;
        params.push(limitOnly);
      }
    }

    const result = await pool.query(query, params);
    result.rows.forEach((row) => canonServiceFieldsInPlace(row));

    const searchLocationText = location ? String(location).trim() : "";
    const hasLocationSearchContext = hasGeo || Boolean(searchLocationText);
    if (hasLocationSearchContext) {
      result.rows.forEach((row) => {
        const { label, extraCount } = resolveListingLocationForSearch(row, {
          searchLat: hasGeo ? lat : undefined,
          searchLng: hasGeo ? lng : undefined,
          searchText: searchLocationText || undefined,
        });
        row.display_location_label = label;
        row.display_location_extra_count = extraCount;
      });
    }

    if (isPaginated) {
      const total = parseInt(result.rows[0]?.total_count ?? "0", 10);
      return res.json({
        data: result.rows,
        total,
        page: parsedPage,
        totalPages: Math.ceil(total / parsedLimit),
      });
    }

    res.json(result.rows);
  } catch (err) {
    console.error("[getAllServices] error:", err.message, err.stack);
    return res.status(500).json({ message: "Server error while fetching services" });
  }
};

export const suggestServiceLocations = async (req, res) => {
  try {
    await ensureListingVisibilitySchema(pool);
    await ensureServiceLocationsSchema(pool);

    const q = String(req.query.q ?? req.query.search ?? "").trim();
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 8));
    if (!q) return res.json([]);

    const fetchLimit = Math.min(60, limit * 6);

    const result = await pool.query(
      `
      WITH raw_locations AS (
        SELECT
          COALESCE(NULLIF(trim(s.city), ''), NULLIF(trim(s.location), ''), NULLIF(trim(s.address), '')) AS label,
          s.latitude::double precision AS lat,
          s.longitude::double precision AS lng
        FROM services s
        WHERE s.is_active = true
        ${publicTestListingFilter("s")}
        ${publicListingFilter("s")}
        UNION ALL
        SELECT
          COALESCE(
            NULLIF(trim(loc.value->>'city'), ''),
            NULLIF(trim(loc.value->>'location'), ''),
            NULLIF(trim(loc.value->>'address'), '')
          ) AS label,
          NULLIF(trim(loc.value->>'lat'), '')::double precision AS lat,
          NULLIF(trim(loc.value->>'lng'), '')::double precision AS lng
        FROM services s
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.locations, '[]'::jsonb)) AS loc(value)
        WHERE s.is_active = true
        ${publicTestListingFilter("s")}
        ${publicListingFilter("s")}
      ),
      filtered AS (
        SELECT
          label,
          lat,
          lng,
          ${normalizedLocationKeySql("label")} AS search_key
        FROM raw_locations
        WHERE label IS NOT NULL AND trim(label) <> ''
      )
      SELECT DISTINCT ON (search_key)
        label,
        lat,
        lng
      FROM filtered
      WHERE ${normalizedLocationMatchClause("label", "$1")}
      ORDER BY search_key, length(label), label
      LIMIT $2
      `,
      [q, fetchLimit],
    );

    const ranked = result.rows
      .map((row) => ({
        ...row,
        score: rankLocationSearchMatch(row.label, q),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label))
      .slice(0, limit);

    res.json(
      ranked.map((row) => ({
        label: row.label,
        lat: row.lat,
        lng: row.lng,
      })),
    );
  } catch (err) {
    console.error("[suggestServiceLocations] error:", err.message);
    return res.status(500).json({ message: "Server error while fetching location suggestions" });
  }
};

export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;

    const check = await pool.query(
      `SELECT * FROM services WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ message: "You can't delete this service" });
    }

    const bookings = await pool.query(
      `SELECT id FROM bookings WHERE service_id = $1 LIMIT 1`,
      [id],
    );

    if (bookings.rows.length > 0) {
      await pool.query(`UPDATE services SET is_active = false WHERE id = $1`, [id]);
      return res.json({
        message: "Service removed from listings (bookings history preserved)",
        deactivated: true,
      });
    }

    await pool.query(`DELETE FROM service_favorites WHERE service_id = $1`, [id]);
    await pool.query(`DELETE FROM services WHERE id = $1`, [id]);
    res.json({ message: "Service deleted successfully", deactivated: false });
  } catch (err) {
    console.error(err);
    if (err.code === "23503") {
      const owned = await pool.query(
        `SELECT id FROM services WHERE id = $1 AND user_id = $2`,
        [id, req.user.id],
      );
      if (owned.rows.length > 0) {
        await pool.query(`UPDATE services SET is_active = false WHERE id = $1`, [id]);
        return res.json({
          message: "Service removed from listings (linked records preserved)",
          deactivated: true,
        });
      }
    }
    res.status(500).json({ message: "Server error while deleting service" });
  }
};

export const getMyServices = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        s.*,
        COALESCE(c.name, s.category) AS category_name,
        (SELECT COUNT(*)::int FROM bookings b WHERE b.service_id = s.id AND b.status = 'completed') AS completed_bookings_count,
        EXISTS (
          SELECT 1
          FROM bookings b
          WHERE b.service_id = s.id
            AND b.status NOT IN ('completed', 'cancelled', 'rejected')
        ) AS has_open_booking_flow
      FROM services s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    result.rows.forEach((row) => canonServiceFieldsInPlace(row));
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while fetching your services" });
  }
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getServiceById = async (req, res) => {
  try {
    await ensureListingVisibilitySchema(pool);
    const { id } = req.params;
    const viewerId = req.user?.id;

    if (!UUID_REGEX.test(id)) {
      return res.status(404).json({ message: "Service not found" });
    }

    const result = await pool.query(
      `SELECT
          s.*,
          CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END AS owner_name,
          u.id AS owner_id,
          u.avatar AS owner_avatar,
          u.account_type AS owner_account_type,
          u.province AS owner_province,
          ${CLIENT_TAX_PROVINCE_SQL} AS client_tax_province,
          c.name AS category_name,
          c.image_url AS category_image_url,
          (SELECT COUNT(*)::int FROM bookings b WHERE b.service_id = s.id AND b.status = 'completed') AS completed_bookings_count
       FROM services s
       JOIN users u ON s.user_id = u.id
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Service not found" });
    }

    const row = result.rows[0];
    if (shouldHideTestListingsFromPublic() && isTestListingTitle(row.title)) {
      return res.status(404).json({ message: "Service not found" });
    }

    const isOwner = viewerId && String(row.user_id) === String(viewerId);
    if (!row.is_active && !isOwner) {
      return res.status(404).json({ message: "Service not found" });
    }

    if (!(await canViewService(pool, row, viewerId))) {
      return res.status(404).json({ message: "Service not found" });
    }

    if (isOwner) {
      const completion = await pool.query(
        `SELECT
            b.completed_at,
            b.completed_by_worker,
            b.completed_by_client,
            CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
            CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name
         FROM bookings b
         JOIN users uc ON uc.id = b.client_id
         JOIN users uw ON uw.id = b.worker_id
         WHERE b.service_id = $1 AND b.status = 'completed'
         ORDER BY b.completed_at DESC NULLS LAST, b.created_at DESC
         LIMIT 1`,
        [id],
      );
      row.completion_summary = completion.rows[0] || null;
    }

    canonServiceFieldsInPlace(row);
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while fetching service" });
  }
};

export const updateService = async (req, res) => {
  try {
    await ensureListingTagsSchema(pool);
    await ensureDepositsAndCalendarSchema(pool);
    await ensureListingVisibilitySchema(pool);
    await ensureServiceLocationsSchema(pool);
    const { id } = req.params;
    const {
      title, description, category, category_id, subcategory,
      price, location, address, latitude, longitude, city,
      poster_type, availability, language,
      mobility, duration, urgency, image_url, image_urls, is_one_time, hide_exact_location, translations, is_public,
    } = req.body;

    const check = await pool.query(
      `SELECT * FROM services WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ message: "You can't update this service" });
    }

    const existing = check.rows[0];

    // Resolve canonical image list for update
    let updResolvedUrls, updResolvedUrl;
    if (image_urls !== undefined) {
      updResolvedUrls = Array.isArray(image_urls) ? image_urls : [];
      updResolvedUrl = updResolvedUrls[0] ?? null;
    } else if (image_url !== undefined) {
      updResolvedUrl = image_url;
      updResolvedUrls = image_url ? [image_url] : [];
    } else {
      updResolvedUrl = existing.image_url;
      updResolvedUrls = existing.image_urls || [];
    }

    let translationsOut = sanitizeListingTranslations(existing.translations || {});
    if (translations !== undefined) {
      translationsOut = sanitizeListingTranslations(translations);
    }
    const canon = canonicalListingTexts(translationsOut);
    let mergedTitleFinal;
    let mergedDescFinal;
    if (translations !== undefined) {
      mergedTitleFinal =
        canon.title.trim() !== ""
          ? canon.title.trim()
          : title !== undefined
            ? sanitizeText(String(title))
            : existing.title;
      mergedDescFinal =
        canon.description.trim() !== ""
          ? canon.description.trim()
          : description !== undefined
            ? sanitizeText(String(description))
            : existing.description;
    } else {
      mergedTitleFinal = title !== undefined ? sanitizeText(String(title)) : existing.title;
      mergedDescFinal =
        description !== undefined ? sanitizeText(String(description)) : existing.description;
    }

    const touchesPricing =
      req.body.pricing_mode !== undefined ||
      req.body.pricingMode !== undefined ||
      req.body.price !== undefined ||
      req.body.price_min !== undefined ||
      req.body.priceMin !== undefined ||
      req.body.price_max !== undefined ||
      req.body.priceMax !== undefined ||
      req.body.estimated_hours !== undefined ||
      req.body.estimatedHours !== undefined;

    let mergedPm = existing.pricing_mode ?? "fixed";
    let mergedPrice = existing.price;
    let mergedPriceMin = existing.price_min;
    let mergedPriceMax = existing.price_max;
    let mergedEstimatedHours = existing.estimated_hours ?? null;

    if (touchesPricing) {
      const merged = {
        pricing_mode: req.body.pricing_mode ?? req.body.pricingMode ?? mergedPm,
        price: req.body.price !== undefined ? req.body.price : existing.price,
        price_min:
          req.body.price_min !== undefined ? req.body.price_min
            : req.body.priceMin !== undefined ? req.body.priceMin : existing.price_min,
        price_max:
          req.body.price_max !== undefined ? req.body.price_max
            : req.body.priceMax !== undefined ? req.body.priceMax : existing.price_max,
        estimated_hours:
          req.body.estimated_hours !== undefined ? req.body.estimated_hours
            : req.body.estimatedHours !== undefined ? req.body.estimatedHours : existing.estimated_hours,
      };
      const r = resolveServicePricingFields(merged, { isCreate: false, existing });
      if (r.error) return res.status(400).json({ message: r.error });
      mergedPm = r.pricing_mode;
      mergedPrice = r.price;
      mergedPriceMin = r.price_min;
      mergedPriceMax = r.price_max;
      if (r.estimated_hours !== undefined) mergedEstimatedHours = r.estimated_hours;
    }

    const touchesTags =
      req.body.listing_tags !== undefined ||
      req.body.tags !== undefined ||
      req.body.subcategory !== undefined;
    const tagFields = touchesTags ? normalizeListingTags(req.body) : null;

    const touchesDeposit =
      req.body.deposit_enabled !== undefined ||
      req.body.depositEnabled !== undefined ||
      req.body.deposit_type !== undefined ||
      req.body.depositType !== undefined ||
      req.body.deposit_value !== undefined ||
      req.body.depositValue !== undefined ||
      touchesPricing;

    let depositEnabled = existing.deposit_enabled ?? false;
    let depositType = existing.deposit_type ?? null;
    let depositValue = existing.deposit_value ?? null;

    if (touchesDeposit) {
      const depositBase = resolveDepositBaseAmount(
        {
          pricing_mode: mergedPm,
          price: mergedPrice,
          price_max: mergedPriceMax,
          estimated_hours: mergedEstimatedHours,
        },
        null,
      );
      const depositParsed = parseDepositFields(
        {
          deposit_enabled: req.body.deposit_enabled ?? req.body.depositEnabled ?? existing.deposit_enabled,
          deposit_type: req.body.deposit_type ?? req.body.depositType ?? existing.deposit_type,
          deposit_value: req.body.deposit_value ?? req.body.depositValue ?? existing.deposit_value,
        },
        depositBase,
        mergedPm,
      );
      if (depositParsed.error) return res.status(400).json({ message: depositParsed.error });
      depositEnabled = depositParsed.deposit_enabled;
      depositType = depositParsed.deposit_type;
      depositValue = depositParsed.deposit_value;
    }

    const effectiveType = req.body.type === "offer" || req.body.type === "looking"
      ? req.body.type
      : existing.type;
    // Looking ads: poster pays — clear any listing-level deposit.
    if (effectiveType === "looking") {
      depositEnabled = false;
      depositType = null;
      depositValue = null;
    }

    const touchesLocation =
      req.body.locations !== undefined ||
      location !== undefined ||
      address !== undefined ||
      latitude !== undefined ||
      longitude !== undefined ||
      city !== undefined;

    let mergedLocations = existing.locations ?? [];
    let mergedLocation = existing.location;
    let mergedAddress = existing.address;
    let mergedLatitude = existing.latitude;
    let mergedLongitude = existing.longitude;
    let mergedCity = existing.city;

    if (touchesLocation) {
      const locationsParsed = normalizeLocationsInput(
        {
          ...req.body,
          location: location !== undefined ? location : existing.location,
          address: address !== undefined ? address : existing.address,
          latitude: latitude !== undefined ? latitude : existing.latitude,
          longitude: longitude !== undefined ? longitude : existing.longitude,
          city: city !== undefined ? city : existing.city,
        },
        existing,
      );
      if (locationsParsed.error) {
        return res.status(400).json({ message: locationsParsed.error });
      }
      mergedLocations = locationsParsed.locations;
      const primaryLoc = primaryLocationFields(mergedLocations);
      mergedLocation = primaryLoc.location;
      mergedAddress = primaryLoc.address;
      mergedLatitude = primaryLoc.latitude;
      mergedLongitude = primaryLoc.longitude;
      mergedCity = primaryLoc.city;
    }

    const textFields = {
      poster_type: poster_type !== undefined ? poster_type : existing.poster_type,
      availability: availability !== undefined ? normalizeAvailability(availability) : existing.availability,
      language: language !== undefined ? language : existing.language,
      mobility: mobility !== undefined ? normalizeMobility(mobility) : existing.mobility,
      duration: duration !== undefined ? normalizeDurationForStorage(duration) : existing.duration,
      urgency: urgency !== undefined ? urgency : existing.urgency,
    };
    const textError = serviceTextLengthError(textFields);
    if (textError) {
      return res.status(400).json({ message: textError });
    }

    const updated = await pool.query(
      `UPDATE services
       SET title        = $1,
           description  = $2,
           category     = $3,
           category_id  = $4,
           subcategory  = $5,
           listing_tags = $6::jsonb,
           has_custom_tags = $7,
           price        = $8,
           location     = $9,
           address      = $10,
           latitude     = $11,
           longitude    = $12,
           city         = $13,
           poster_type  = $14,
           availability = $15,
           language     = $16,
           mobility     = $17,
           duration     = $18,
           urgency      = $19,
           image_url    = $20,
           image_urls          = $21,
           is_one_time         = $22,
           hide_exact_location = $23,
           translations       = $24::jsonb,
           pricing_mode       = $25,
           price_min          = $26,
           price_max          = $27,
           estimated_hours    = $28,
           deposit_enabled    = $29,
           deposit_type       = $30,
           deposit_value      = $31,
           is_public          = $32,
           locations          = $33::jsonb
       WHERE id = $34
       RETURNING *`,
      [
        mergedTitleFinal,
        mergedDescFinal,
        category     !== undefined ? category     : existing.category,
        category_id  !== undefined ? category_id  : existing.category_id,
        tagFields ? tagFields.subcategory : (subcategory !== undefined ? subcategory : existing.subcategory),
        tagFields ? JSON.stringify(tagFields.tags) : JSON.stringify(existing.listing_tags ?? []),
        tagFields ? tagFields.hasCustomTags : (existing.has_custom_tags ?? false),
        mergedPrice,
        mergedLocation,
        mergedAddress,
        mergedLatitude,
        mergedLongitude,
        mergedCity,
        textFields.poster_type,
        textFields.availability,
        textFields.language,
        textFields.mobility,
        textFields.duration,
        textFields.urgency,
        updResolvedUrl,
        updResolvedUrls,
        is_one_time          !== undefined ? (is_one_time === true || is_one_time === "true") : existing.is_one_time,
        hide_exact_location  !== undefined ? (hide_exact_location === true || hide_exact_location === "true") : existing.hide_exact_location,
        translationsOut,
        mergedPm,
        mergedPriceMin,
        mergedPriceMax,
        mergedEstimatedHours,
        depositEnabled,
        depositType,
        depositValue,
        is_public !== undefined ? parseIsPublic(is_public) : existing.is_public !== false,
        JSON.stringify(mergedLocations),
        id,
      ]
    );

    const out = updated.rows[0];
    canonServiceFieldsInPlace(out);
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while updating service" });
  }
};

export const getUserServices = async (req, res) => {
  try {
    await ensureListingVisibilitySchema(pool);
    const { userId } = req.params;
    const viewerId = req.user?.id;
    const isProfileOwner = viewerId && String(viewerId) === String(userId);
    const visibilityFilter = isProfileOwner ? "" : publicListingFilter("s");

    if (viewerId && viewerId !== userId && supabaseAdmin) {
      const { data: blockedRow } = await supabaseAdmin
        .from("blocked_users")
        .select("id")
        .eq("blocker_id", userId)
        .eq("blocked_user_id", viewerId)
        .maybeSingle();
      if (blockedRow) {
        return res.json([]);
      }
    }

    const result = await pool.query(
      `SELECT
        s.*,
        CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END AS owner_name,
        u.company_name,
        u.account_type,
        COALESCE(c.name, s.category) AS category_name,
        (SELECT COUNT(*)::int FROM bookings b WHERE b.service_id = s.id AND b.status = 'completed') AS completed_bookings_count
      FROM services s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.user_id = $1
        AND s.is_active = true
        ${publicTestListingFilter("s")}
        ${visibilityFilter}
      ORDER BY s.created_at DESC`,
      [userId]
    );

    result.rows.forEach((row) => canonServiceFieldsInPlace(row));
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while fetching user services" });
  }
};

export const getCategoryCounts = async (req, res) => {
  try {
    await ensureListingTagsSchema(pool);
    await ensureDepositsAndCalendarSchema(pool);
    await ensureListingVisibilitySchema(pool);
    const testFilter = publicTestListingFilter("s");
    const visibilityFilter = publicListingFilter("s");
    const result = await pool.query(`
      SELECT category_name, SUM(count)::int AS count
      FROM (
        SELECT
          COALESCE(c.name, s.category) AS category_name,
          COUNT(*)::int AS count
        FROM services s
        LEFT JOIN categories c ON c.id = s.category_id
        WHERE s.is_active = true
          ${testFilter}
          ${visibilityFilter}
          AND COALESCE(c.name, s.category) IS NOT NULL
          AND COALESCE(c.name, s.category) != ''
        GROUP BY COALESCE(c.name, s.category)

        UNION ALL

        SELECT
          $1 AS category_name,
          COUNT(*)::int AS count
        FROM services s
        WHERE s.is_active = true
          ${testFilter}
          ${visibilityFilter}
          AND s.has_custom_tags = true
      ) grouped
      GROUP BY category_name
      ORDER BY count DESC
    `, [OTHER_CATEGORY_NAME]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while fetching category counts" });
  }
};
