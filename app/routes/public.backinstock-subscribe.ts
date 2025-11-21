// app/routes/public.backinstock-subscribe.ts
import { json, type ActionFunctionArgs } from "@remix-run/node";

const ADMIN_API_VERSION = "2025-07";

// This route is currently for bloomconnecttest only.
// We use its domain + admin token from env vars.
const SHOP_DOMAIN_ENV = "SHOP_59668267140_DOMAIN";
const SHOP_TOKEN_ENV = "SHOP_59668267140_ADMIN_TOKEN";

// Allow requests from your storefront
const ALLOWED_ORIGINS = [
  "https://shopify.dreampim.com",
  "https://bloomconnecttest.myshopify.com",
];

// Build CORS headers
function corsHeaders(origin: string | null) {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "https://shopify.dreampim.com";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Simple helper to call Admin GraphQL using the bloomconnecttest token
async function adminGraphql(query: string, variables: any) {
  const shopDomain = process.env[SHOP_DOMAIN_ENV];
  const adminAccessToken = process.env[SHOP_TOKEN_ENV];

  if (!shopDomain || !adminAccessToken) {
    throw new Error(
      `Missing env vars ${SHOP_DOMAIN_ENV} or ${SHOP_TOKEN_ENV} for public.backinstock-subscribe`,
    );
  }

  const url = `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();

  let jsonObj: any;
  try {
    jsonObj = JSON.parse(text);
  } catch {
    console.error("Admin GraphQL non-JSON response:", text);
    throw new Error("Admin GraphQL non-JSON response");
  }

  if (!resp.ok) {
    console.error(
      "Admin GraphQL HTTP error",
      resp.status,
      JSON.stringify(jsonObj, null, 2),
    );
    throw new Error(
      `Admin GraphQL HTTP ${resp.status}: ${JSON.stringify(jsonObj)}`,
    );
  }

  if (jsonObj.errors) {
    console.error("Admin GraphQL errors:", JSON.stringify(jsonObj.errors));
  }

  return jsonObj;
}

export async function action({ request }: ActionFunctionArgs) {
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers,
    });
  }

  const formData = await request.formData();
  const variantIdRaw = formData.get("variant_id");
  const companyId = formData.get("company_id");

  if (!variantIdRaw || !companyId) {
    return json(
      { ok: false, error: "Missing variant_id or company_id" },
      { status: 400, headers },
    );
  }

  // Convert numeric variant ID → Shopify GID
  let variantId: string;
  if (String(variantIdRaw).startsWith("gid://")) {
    variantId = String(variantIdRaw);
  } else {
    variantId = `gid://shopify/ProductVariant/${variantIdRaw}`;
  }

  // STEP 1 — Fetch current metafield value
  const getQuery = `
    query GetNotifyCompanies($id: ID!) {
      productVariant(id: $id) {
        id
        metafield(namespace: "backinstock", key: "notify_companies") {
          id
          value
        }
      }
    }
  `;

  const existingJson = await adminGraphql(getQuery, { id: variantId });

  const currentValue =
    existingJson?.data?.productVariant?.metafield?.value || "[]";

  let arr: string[] = [];
  try {
    const parsed = JSON.parse(currentValue);
    if (Array.isArray(parsed)) {
      arr = parsed;
    }
  } catch (err) {
    console.warn(
      "Failed to parse existing notify_companies metafield; resetting to []",
      err,
    );
    arr = [];
  }

  // Add company if not yet subscribed
  const companyStr = String(companyId);
  if (!arr.includes(companyStr)) {
    arr.push(companyStr);
  }

  const newJsonValue = JSON.stringify(arr);

  // STEP 2 — Save the metafield
  const setMutation = `
    mutation SetNotifyCompanies($ownerId: ID!, $value: String!) {
      metafieldsSet(
        metafields: [
          {
            ownerId: $ownerId
            namespace: "backinstock"
            key: "notify_companies"
            type: "json"
            value: $value
          }
        ]
      ) {
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
  `;

  const setJson = await adminGraphql(setMutation, {
    ownerId: variantId,
    value: newJsonValue,
  });

  const userErrors =
    setJson?.data?.metafieldsSet?.userErrors ??
    setJson?.data?.metafieldsSet?.userErrors ??
    [];

  return json(
    {
      ok: userErrors.length === 0,
      message:
        userErrors.length === 0
          ? "Subscription saved"
          : "Saved with userErrors",
      variantId,
      newValue: arr,
      userErrors,
    },
    { status: 200, headers },
  );
}

// Optional: block GET requests to this route
export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}
