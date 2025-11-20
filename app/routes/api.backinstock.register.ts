import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { authenticate } from "../shopify.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function toVariantGid(id: string): string {
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/ProductVariant/${id}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let admin;
  try {
    const appProxyContext = await authenticate.public.appProxy(request);
    admin = appProxyContext.admin;

    if (!admin) {
      console.error("App proxy context has no admin client", appProxyContext);
      return json(
        { ok: false, error: "Admin API is not available for this shop." },
        { status: 500, headers: corsHeaders },
      );
    }
  } catch (error) {
    console.error("App proxy authentication failed", error);
    return json(
      { ok: false, error: "Unauthorized app proxy request." },
      { status: 401, headers: corsHeaders },
    );
  }

  let payload: { variantId?: string; companyId?: string };
  try {
    payload = await request.json();
  } catch {
    return json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders },
    );
  }

  let { variantId, companyId } = payload;

  if (!variantId || !companyId) {
    return json(
      { ok: false, error: "Missing variantId or companyId" },
      { status: 400, headers: corsHeaders },
    );
  }

  const ownerId = toVariantGid(variantId);
  variantId = ownerId;

  console.log("Backinstock payload on server:", {
    rawVariantId: payload.variantId,
    normalizedVariantId: ownerId,
    companyId,
  });

  // 1) Read existing metafield
  let current: string[] = [];

  try {
    const readRes = await admin.graphql(
      `
        query VariantMeta($id: ID!) {
          productVariant(id: $id) {
            metafield(namespace: "backinstock", key: "notify_companies") {
              value
            }
          }
        }
      `,
      {
        variables: { id: ownerId },
      },
    );

    const readJson = await readRes.json();
    const value =
      readJson?.data?.productVariant?.metafield?.value;

    current = value ? JSON.parse(value) : [];
    if (!Array.isArray(current)) current = [];
  } catch (error) {
    console.error("Error reading metafield", error);
    current = [];
  }

  if (!current.includes(companyId)) {
    current.push(companyId);
  }

  // 2) Write metafield – IMPORTANT: type must be "json"
  try {
    const writeRes = await admin.graphql(
      `
        mutation SetMeta($ownerId: ID!, $val: String!) {
          metafieldsSet(
            metafields: [
              {
                ownerId: $ownerId
                namespace: "backinstock"
                key: "notify_companies"
                type: "json"
                value: $val
              }
            ]
          ) {
            metafields {
              id
              namespace
              key
              type
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
        variables: { ownerId, val: JSON.stringify(current) },
      },
    );

    const writeJson = await writeRes.json();
    console.log(
      "Backinstock metafieldsSet result:",
      JSON.stringify(writeJson, null, 2),
    );

    const error = writeJson?.data?.metafieldsSet?.userErrors?.[0];
    if (error) {
      return json(
        { ok: false, error: error.message, debug: writeJson },
        { status: 400, headers: corsHeaders },
      );
    }

    return json(
      {
        ok: true,
        debug: {
          variantId: ownerId,
          companyId,
          current,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error: any) {
    console.error("Error writing metafield", error);
    return json(
      { ok: false, error: "Failed to update metafield.", debug: String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
}

export function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: corsHeaders,
  });
}
