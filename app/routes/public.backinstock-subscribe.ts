// app/routes/public.backinstock-subscribe.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// ==============================
// CORS + SHOP CONFIG
// ==============================

type ShopEnvConfig = {
  domainEnv: string;
  tokenEnv: string;
};

type ShopAdminConfig = {
  shopDomain: string;
  adminAccessToken: string;
};

/**
 * Map frontend Origins → env var keys for domain + admin token.
 *
 * Add more origins here as you roll out to more countries / custom domains.
 */
const ORIGIN_TO_ENV: Record<string, ShopEnvConfig> = {
  // BC TEST (bloomconnecttest) — two domains pointing to same shop
  "https://shopify.dreampim.com": {
    domainEnv: "SHOP_59668267140_DOMAIN",
    tokenEnv: "SHOP_59668267140_ADMIN_TOKEN",
  },
  "https://bloomconnecttest.myshopify.com": {
    domainEnv: "SHOP_59668267140_DOMAIN",
    tokenEnv: "SHOP_59668267140_ADMIN_TOKEN",
  },

  // NZ
  "https://bloomconnect.co.nz": {
    domainEnv: "SHOP_42102259871_DOMAIN",
    tokenEnv: "SHOP_42102259871_ADMIN_TOKEN",
  },

  // AU
  "https://bloomconnect.com.au": {
    domainEnv: "SHOP_35012608137_DOMAIN",
    tokenEnv: "SHOP_35012608137_ADMIN_TOKEN",
  },

  // SG
  "https://bloomconnect.com.sg": {
    domainEnv: "SHOP_44068798624_DOMAIN",
    tokenEnv: "SHOP_44068798624_ADMIN_TOKEN",
  },

  // HK
  "https://bloomconnect.com.hk": {
    domainEnv: "SHOP_49541087392_DOMAIN",
    tokenEnv: "SHOP_49541087392_ADMIN_TOKEN",
  },

  // MY
  "https://bloomconnectmy.myshopify.com": {
    domainEnv: "SHOP_48475504790_DOMAIN",
    tokenEnv: "SHOP_48475504790_ADMIN_TOKEN",
  },

  // ID
  "https://bloomconnect.co.id": {
    domainEnv: "SHOP_46777794714_DOMAIN",
    tokenEnv: "SHOP_46777794714_ADMIN_TOKEN",
  },

  // dev02 (if you ever use this route from dev02 storefront)
  "https://dev02-bloom-connect.myshopify.com": {
    domainEnv: "SHOP_66638577877_DOMAIN",
    tokenEnv: "SHOP_66638577877_ADMIN_TOKEN",
  },
};

// Allowed origins = keys of ORIGIN_TO_ENV
const ALLOWED_ORIGINS = Object.keys(ORIGIN_TO_ENV);

function corsHeaders(origin: string | null) {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0]; // default to first known origin

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * Given an Origin header, resolve which shop we should talk to.
 * Uses env vars like SHOP_59668267140_DOMAIN / _ADMIN_TOKEN, etc.
 */
function getShopConfigFromOrigin(origin: string | null): ShopAdminConfig {
  if (!origin) {
    throw new Error("Missing Origin header on request");
  }

  const envCfg = ORIGIN_TO_ENV[origin];
  if (!envCfg) {
    throw new Error(`Origin not allowed or not mapped: ${origin}`);
  }

  const shopDomain = process.env[envCfg.domainEnv];
  const adminAccessToken = process.env[envCfg.tokenEnv];

  if (!shopDomain || !adminAccessToken) {
    throw new Error(
      `Missing env vars for origin ${origin}: ${envCfg.domainEnv} or ${envCfg.tokenEnv}`,
    );
  }

  return {
    shopDomain,
    adminAccessToken,
  };
}

// ==============================
// Admin GraphQL helper
// ==============================

async function adminGraphql(
  shopCfg: ShopAdminConfig,
  query: string,
  variables: any,
) {
  const ADMIN_API_VERSION = "2025-07";
  const url = `https://${shopCfg.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopCfg.adminAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("Admin GraphQL non-JSON response:", text);
    throw new Error("Admin GraphQL returned non-JSON");
  }

  if (!resp.ok) {
    console.error(
      "Admin GraphQL HTTP error",
      resp.status,
      JSON.stringify(json, null, 2),
    );
    throw new Error(
      `Admin GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`,
    );
  }

  if (json.errors) {
    console.error("Admin GraphQL errors:", JSON.stringify(json.errors));
  }

  return json;
}

// ==============================
// ACTION: subscribe company to variant
// ==============================

export async function action({ request }: ActionFunctionArgs) {
  const origin = request.headers.get("Origin");
  const baseHeaders = corsHeaders(origin);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed" }),
      {
        status: 405,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  const formData = await request.formData();
  const variantIdRaw = formData.get("variant_id")?.toString() || "";
  const companyId = formData.get("company_id")?.toString() || "";

  if (!variantIdRaw || !companyId) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Missing variant_id or company_id",
      }),
      {
        status: 400,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  // Liquid gives numeric variant ID → build Admin GID
  const variantGid = `gid://shopify/ProductVariant/${variantIdRaw}`;

  let shopCfg: ShopAdminConfig;
  try {
    shopCfg = getShopConfigFromOrigin(origin);
  } catch (err: any) {
    console.error("Backinstock subscribe: config error", err);
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Server misconfigured or origin not allowed",
      }),
      {
        status: 500,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  try {
    // 1) Read the existing metafield
    const readJson = await adminGraphql(
      shopCfg,
      `
        query VariantNotifyCompanies($id: ID!) {
          productVariant(id: $id) {
            id
            metafield(namespace: "backinstock", key: "notify_companies") {
              value
            }
          }
        }
      `,
      { id: variantGid },
    );

    const mfValue =
      readJson?.data?.productVariant?.metafield?.value ?? null;

    let companies: string[] = [];
    if (mfValue) {
      try {
        const parsed = JSON.parse(mfValue);
        if (Array.isArray(parsed)) {
          companies = parsed.filter((c) => typeof c === "string");
        }
      } catch (err) {
        console.error(
          "Backinstock subscribe: failed to parse existing metafield JSON",
          err,
        );
      }
    }

    if (!companies.includes(companyId)) {
      companies.push(companyId);
    }

    const newValue = JSON.stringify(companies);

    // 2) Write back updated JSON
    const writeJson = await adminGraphql(
      shopCfg,
      `
        mutation SetBackinstockNotifyCompanies($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        metafields: [
          {
            ownerId: variantGid,
            namespace: "backinstock",
            key: "notify_companies",
            type: "json",
            value: newValue,
          },
        ],
      },
    );

    const userErrors =
      writeJson?.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.error(
        "Backinstock subscribe: metafieldsSet userErrors",
        userErrors,
      );
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Failed to save subscription",
          userErrors,
        }),
        {
          status: 500,
          headers: {
            ...baseHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // ✅ JSON response for your modal JavaScript
    return new Response(
      JSON.stringify({
        ok: true,
        message: "You’ll be notified when this product is back in stock.",
        variantId: variantGid,
        companies,
      }),
      {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("Backinstock subscribe: unexpected error", err);
    return new Response(
      JSON.stringify({ ok: false, error: "Internal error" }),
      {
        status: 500,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
}

// Optional GET handler: quick health check for this route
export function loader({}: LoaderFunctionArgs) {
  return new Response(
    JSON.stringify({
      status: "ok",
      route: "public/backinstock-subscribe",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}
