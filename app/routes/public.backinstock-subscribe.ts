import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

// This route is ONLY for bloomconnecttest
// Numeric shop ID = 59668267140 (you already used this)
// We read its domain & token from env
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

// POST: subscribe current company to a variant
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const formData = await request.formData();
  const variantIdRaw = formData.get("variant_id")?.toString() || "";
  const companyId = formData.get("company_id")?.toString() || "";

  if (!variantIdRaw || !companyId) {
    return new Response("Missing variant_id or company_id", {
      status: 400,
    });
  }

  // Liquid gives numeric variant ID → build Admin GID
  const variantGid = `gid://shopify/ProductVariant/${variantIdRaw}`;

  let shopCfg: ShopAdminConfig;
  try {
    shopCfg = getBloomConnectTestConfig();
  } catch (err: any) {
    console.error("Backinstock subscribe: config error", err);
    return new Response("Server misconfigured", { status: 500 });
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
      return new Response("Failed to save subscription", {
        status: 500,
      });
    }

    // Simple thank-you HTML so it works when posting normally
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Subscribed</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
        <p>✅ You’ll be notified when this product is back in stock.</p>
        <p><a href="javascript:history.back()">← Back to product</a></p>
      </body>
      </html>
    `;

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("Backinstock subscribe: unexpected error", err);
    return new Response("Internal error", { status: 500 });
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
      headers: { "Content-Type": "application/json" },
    },
  );
}
