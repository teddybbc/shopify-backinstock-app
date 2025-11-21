import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// ===== CORS CONFIG =====
const ALLOWED_ORIGINS = [
  "https://shopify.dreampim.com",
  "https://bloomconnecttest.myshopify.com",
];

function corsHeaders(origin: string | null) {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0]; // default to first

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ===== SHOP CONFIG (same as before) =====

type ShopAdminConfig = {
  shopDomain: string;
  adminAccessToken: string;
};

function getBloomConnectTestConfig(): ShopAdminConfig {
  const shopDomain = process.env.SHOP_59668267140_DOMAIN;
  const adminAccessToken = process.env.SHOP_59668267140_ADMIN_TOKEN;

  if (!shopDomain || !adminAccessToken) {
    throw new Error(
      "Missing SHOP_59668267140_DOMAIN or SHOP_59668267140_ADMIN_TOKEN env vars",
    );
  }

  return {
    shopDomain,
    adminAccessToken,
  };
}

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

// ===== ACTION: subscribe company to variant =====

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
    shopCfg = getBloomConnectTestConfig();
  } catch (err: any) {
    console.error("Backinstock subscribe: config error", err);
    return new Response(
      JSON.stringify({ ok: false, error: "Server misconfigured" }),
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
