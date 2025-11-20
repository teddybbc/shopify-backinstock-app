// app/routes/api.backinstock.stock-restored.ts
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";

/**
 * Shopify Flow POST body (example):
 * {
 *   "shopId": "gid://shopify/Shop/66638577877",
 *   "variantId": "gid://shopify/ProductVariant/44763933573333",
 *   "inventoryQuantity": 3,
 *   "previousInventoryQuantity": 0
 * }
 */

const ADMIN_API_VERSION = "2025-07";

// Map numeric shopId -> env keys (domain + admin token)
const SHOP_CONFIGS: Record<
  string,
  { domainEnv: string; tokenEnv: string }
> = {
  // NZ
  "42102259871": {
    domainEnv: "SHOP_42102259871_DOMAIN",
    tokenEnv: "SHOP_42102259871_ADMIN_TOKEN",
  },
  // AU
  "35012608137": {
    domainEnv: "SHOP_35012608137_DOMAIN",
    tokenEnv: "SHOP_35012608137_ADMIN_TOKEN",
  },
  // SG
  "44068798624": {
    domainEnv: "SHOP_44068798624_DOMAIN",
    tokenEnv: "SHOP_44068798624_ADMIN_TOKEN",
  },
  // HK
  "49541087392": {
    domainEnv: "SHOP_49541087392_DOMAIN",
    tokenEnv: "SHOP_49541087392_ADMIN_TOKEN",
  },
  // MY
  "48475504790": {
    domainEnv: "SHOP_48475504790_DOMAIN",
    tokenEnv: "SHOP_48475504790_ADMIN_TOKEN",
  },
  // ID
  "46777794714": {
    domainEnv: "SHOP_46777794714_DOMAIN",
    tokenEnv: "SHOP_46777794714_ADMIN_TOKEN",
  },
  // dev02 Bloom Connect
  "66638577877": {
    domainEnv: "SHOP_66638577877_DOMAIN",
    tokenEnv: "SHOP_66638577877_ADMIN_TOKEN",
  },
};

type ShopAdminConfig = {
  shopId: string;
  shopDomain: string;
  adminAccessToken: string;
};

function getShopAdminConfig(shopId: string): ShopAdminConfig {
  const cfg = SHOP_CONFIGS[shopId];
  console.log("getShopAdminConfig: looking up shopId:", shopId);

  if (!cfg) {
    console.error("getShopAdminConfig: no SHOP_CONFIGS entry for shopId");
    throw new Error(`No SHOP_CONFIGS entry for shopId: ${shopId}`);
  }

  const shopDomain = process.env[cfg.domainEnv];
  const adminAccessToken = process.env[cfg.tokenEnv];

  console.log(
    "getShopAdminConfig: domainEnv:",
    cfg.domainEnv,
    "isSet:",
    !!shopDomain,
  );
  console.log(
    "getShopAdminConfig: tokenEnv:",
    cfg.tokenEnv,
    "isSet:",
    !!adminAccessToken,
  );

  if (!shopDomain || !adminAccessToken) {
    throw new Error(
      `Missing env vars for shopId ${shopId}: ${cfg.domainEnv} or ${cfg.tokenEnv}`,
    );
  }

  return {
    shopId,
    shopDomain,
    adminAccessToken,
  };
}

/**
 * Simple Admin GraphQL call using fetch + offline token
 */
async function adminGraphql(
  shopCfg: ShopAdminConfig,
  query: string,
  variables: any,
) {
  const url = `https://${shopCfg.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopCfg.adminAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  let text: string;
  try {
    text = await resp.text();
  } catch (err) {
    console.error("Admin GraphQL: failed to read response body:", err);
    throw new Error("fetch failed");
  }

  let jsonObj: any;
  try {
    jsonObj = JSON.parse(text);
  } catch {
    console.error("Admin GraphQL response not JSON:", text);
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
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 1) Verify shared secret from Shopify Flow
  const flowSecretHeader = request.headers.get("X-Flow-Secret") ?? "";
  const expectedSecret = process.env.FLOW_SHARED_SECRET ?? "";

  if (!expectedSecret || flowSecretHeader !== expectedSecret) {
    console.error("Backinstock Flow: invalid or missing X-Flow-Secret");
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 2) Parse JSON body
  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Backinstock Flow: invalid JSON body", err);
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  let { shopId, variantId, inventoryQuantity, previousInventoryQuantity } =
    body ?? {};

  console.log("Backinstock Flow raw payload:", body);

  if (!shopId) {
    return json({ ok: false, error: "Missing shopId" }, { status: 400 });
  }

  // Normalize shopId: GID ("gid://shopify/Shop/666...") -> "666..."
  let normalizedShopId: string;
  if (
    typeof shopId === "string" &&
    shopId.startsWith("gid://shopify/Shop/")
  ) {
    normalizedShopId = shopId.split("/").pop() || shopId;
  } else {
    normalizedShopId = String(shopId);
  }

  console.log("Backinstock Flow: shopId raw:", shopId);
  console.log("Backinstock Flow: shopId normalized:", normalizedShopId);

  if (!variantId) {
    return json({ ok: false, error: "Missing variantId" }, { status: 400 });
  }

  if (
    typeof inventoryQuantity !== "number" ||
    typeof previousInventoryQuantity !== "number"
  ) {
    return json(
      {
        ok: false,
        error:
          "inventoryQuantity and previousInventoryQuantity must be numbers",
      },
      { status: 400 },
    );
  }

  // 3) Only fire when inventory crosses from <= 0 to > 0
  if (!(inventoryQuantity > 0 && previousInventoryQuantity <= 0)) {
    console.log(
      "Backinstock Flow: inventory did not cross from <= 0 to > 0. Skipping.",
    );
    return json({
      ok: true,
      skipped: true,
      reason: "Inventory threshold not crossed",
    });
  }

  // 4) Resolve shop config
  let shopCfg: ShopAdminConfig;
  try {
    shopCfg = getShopAdminConfig(normalizedShopId);
    console.log(
      "Backinstock Flow: using Admin config for normalized shopId",
      normalizedShopId,
      "domain",
      shopCfg.shopDomain,
    );
  } catch (err) {
    console.error("Backinstock Flow: getShopAdminConfig failed:", err);
    return json(
      {
        ok: false,
        error: "Unknown or misconfigured shopId",
        shopIdRaw: shopId,
        shopIdNormalized: normalizedShopId,
      },
      { status: 500 },
    );
  }

  // 5) Load variant + metafield
  let variantNode: any;
  try {
    const variantDataJson = await adminGraphql(
      shopCfg,
      `
        query BackInStockVariant($id: ID!) {
          productVariant(id: $id) {
            id
            sku
            displayName
            inventoryQuantity
            product {
              id
              title
              handle
            }
            metafield(namespace: "backinstock", key: "notify_companies") {
              value
            }
          }
        }
      `,
      { id: variantId },
    );

    variantNode = variantDataJson?.data?.productVariant;
  } catch (err: any) {
    console.error(
      "Backinstock Flow: error loading variant via Admin API:",
      err,
    );

    return json(
      {
        ok: false,
        error: "Error loading variant via Admin API",
        adminError: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  if (!variantNode) {
    console.error("Backinstock Flow: variant not found in Admin API");
    return json({ ok: false, error: "Variant not found" }, { status: 404 });
  }

  // 6) Extract company IDs from metafield JSON
  let companyIds: string[] = [];
  const rawCompanies = variantNode.metafield?.value;

  if (rawCompanies) {
    try {
      const parsed = JSON.parse(rawCompanies);
      if (Array.isArray(parsed)) {
        companyIds = parsed.filter((c) => typeof c === "string");
      }
    } catch (err) {
      console.error(
        "Backinstock Flow: error parsing notify_companies metafield",
        err,
      );
    }
  }

  console.log("Backinstock Flow: rawCompanies metafield value:", rawCompanies);
  console.log("Backinstock Flow: parsed companyIds:", companyIds);

  if (companyIds.length === 0) {
    console.log("Backinstock Flow: no subscribed companies. Nothing to notify.");
    return json({
      ok: true,
      skipped: true,
      reason: "No subscribed companies",
    });
  }

  console.log("Backinstock Flow: subscribed company IDs:", companyIds);

  // 7) Load each company to get name + main contact email
  type CompanyRecipient = {
    id: string;
    name: string;
    email: string;
  };

  const recipients: CompanyRecipient[] = [];

  await Promise.all(
    companyIds.map(async (companyId) => {
      try {
        const companyJson = await adminGraphql(
          shopCfg,
          `
            query BackInStockCompany($companyId: ID!) {
              company(id: $companyId) {
                id
                name
                mainContact {
                  id
                  customer {
                    defaultEmailAddress {
                      emailAddress
                    }
                  }
                }
              }
            }
          `,
          {
            companyId: `gid://shopify/Company/${companyId}`,
          },
        );

        console.log(
          "Backinstock Flow: companyJson for",
          companyId,
          JSON.stringify(companyJson, null, 2),
        );

        const companyNode = companyJson?.data?.company;

        if (!companyNode) {
          console.warn("Backinstock Flow: company not found", companyId);
          return;
        }

        const mc = companyNode.mainContact;

        let email: string | undefined =
          mc?.customer?.defaultEmailAddress?.emailAddress ||
          mc?.customer?.email ||
          mc?.email;

        console.log(
          "Backinstock Flow: derived email for company",
          companyId,
          "=>",
          email,
        );

        if (!email) {
          console.warn(
            "Backinstock Flow: no email found for companyId (mainContact/customer/defaultEmailAddress all empty)",
            companyId,
          );
          return;
        }

        recipients.push({
          id: companyId,
          name: companyNode.name,
          email,
        });
      } catch (err) {
        console.error(
          "Backinstock Flow: error loading company",
          companyId,
          err,
        );
      }
    }),
  );

  console.log("Backinstock Flow: final recipients array:", recipients);

  if (recipients.length === 0) {
    console.log("Backinstock Flow: no recipients with email found.");
    return json({
      ok: true,
      skipped: true,
      reason: "No company emails found",
    });
  }

  console.log("Backinstock Flow: recipients to notify:", recipients);

  // 8) Derive numeric product_id from product GID
  const productGid: string | undefined = variantNode.product?.id;
  let productNumericId: number | null = null;

  if (productGid) {
    const parts = productGid.split("/");
    const last = parts[parts.length - 1];
    const asNum = parseInt(last, 10);
    if (!Number.isNaN(asNum)) {
      productNumericId = asNum;
    }
  }

  if (!productNumericId) {
    console.error(
      "Backinstock Flow: could not derive numeric product_id from",
      productGid,
    );
    return json(
      { ok: false, error: "Could not derive product_id from product GID" },
      { status: 500 },
    );
  }

  // 9) Build payload for OpenCart
  const handle = variantNode.product?.handle ?? "";
  const productUrl = handle
    ? `https://${shopCfg.shopDomain}/products/${handle}`
    : `https://${shopCfg.shopDomain}/products/${productNumericId}`;

  const ocPayload = {
    product_id: productNumericId,
    product_title: variantNode.product?.title ?? "",
    variant_title: variantNode.displayName ?? "",
    sku: variantNode.sku ?? "",
    product_url: productUrl,
    subscribers: recipients.map((r) => r.email),
  };

  console.log("Backinstock Flow: posting payload to OpenCart:", ocPayload);

  const ocUrl =
    "https://dreampim.com/index.php?route=cronjob/backinstock/sendEmail";

  const payloadToOC = {
    ...ocPayload,
    flowSecretHeader, // For PHP secret validation
  };

  console.log("Backinstock Flow: posting to OpenCart payload:", payloadToOC);

  let ocJson: any = null;

  try {
    const ocResp = await fetch(ocUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payloadToOC),
    });

    const text = await ocResp.text();
    try {
      ocJson = JSON.parse(text);
    } catch {
      ocJson = { raw: text };
    }

    console.log("OpenCart response:", ocJson);

    if (ocJson?.secret_valid === true) {
      console.log("Backinstock Flow: OpenCart SECRET OK");
    } else {
      console.log("Backinstock Flow: OpenCart SECRET INVALID");
    }

    if (!ocResp.ok) {
      return json(
        {
          ok: false,
          error: "OpenCart sendEmail failed",
          status: ocResp.status,
          ocResponse: ocJson,
        },
        { status: 502 },
      );
    }
  } catch (err) {
    console.error("Backinstock Flow: error calling OpenCart sendEmail:", err);
    return json(
      { ok: false, error: "Error calling OpenCart sendEmail" },
      { status: 502 },
    );
  }

  // 10) Clear notify_companies metafield (JSON type) after successful emails
  try {
    const clearMetaJson = await adminGraphql(
      shopCfg,
      `
        mutation ClearNotifyCompanies($metafields: [MetafieldsSetInput!]!) {
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
            ownerId: variantId,
            namespace: "backinstock",
            key: "notify_companies",
            type: "json",
            value: "[]",
          },
        ],
      },
    );

    console.log(
      "Backinstock Flow: metafield cleared response:",
      JSON.stringify(clearMetaJson, null, 2),
    );

    const userErrors =
      clearMetaJson?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("Backinstock Flow: metafield clear errors:", userErrors);
    } else {
      console.log(
        "Backinstock Flow: notify_companies metafield cleared successfully.",
      );
    }
  } catch (err) {
    console.error(
      "Backinstock Flow: failed to clear notify_companies metafield:",
      err,
    );
  }

  // 11) Final response back to Shopify Flow
  return json({
    ok: true,
    sent: recipients.length,
    product_id: productNumericId,
    shopIdRaw: shopId,
    shopIdNormalized: normalizedShopId,
    ocResponse: ocJson,
  });
}

// GET: health check
export function loader({}: LoaderFunctionArgs) {
  return json({
    status: "ok",
    message: "Backinstock endpoint is alive. Use POST from Shopify Flow.",
  });
}
