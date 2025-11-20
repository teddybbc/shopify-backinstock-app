import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { authenticate } from "../shopify.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId");

    if (!productId) {
      console.error("Missing productId in /api/backinstock/list");
      return json([], { status: 200, headers: corsHeaders });
    }

    const { admin } = await authenticate.admin(request);

    // 1) Fetch product + variants with metafield
    const response = await admin.graphql(
      `
        query BackinstockProduct($id: ID!) {
          product(id: $id) {
            id
            title
            variants(first: 100) {
              nodes {
                id
                title
                sku
                metafield(namespace: "backinstock", key: "notify_companies") {
                  value
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          id: productId,
        },
      }
    );

    const data = await response.json();
    // console.log("Backinstock list raw GraphQL:", JSON.stringify(data, null, 2));

    const productTitle: string =
      data?.data?.product?.title ?? "(Untitled product)";
    const variants = data?.data?.product?.variants?.nodes ?? [];

    // 2) Build basic rows with company IDs
    type Row = {
      variantId: string;
      title: string;
      sku: string;
      companies: string[];
      companyNames?: string[];
    };

    const rows: Row[] =
      variants.map((v: any) => {
        let companyIds: string[] = [];

        const raw = v?.metafield?.value;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              companyIds = parsed.filter(Boolean);
            }
          } catch {
            companyIds = [];
          }
        }

        // Better display title:
        // - If variant title is "Default Title", show just the product title
        // - Else show "Product title – Variant title"
        const rawVariantTitle: string = v?.title ?? "";
        let displayTitle: string;

        if (!rawVariantTitle || rawVariantTitle === "Default Title") {
          displayTitle = productTitle;
        } else {
          displayTitle = `${productTitle} – ${rawVariantTitle}`;
        }

        return {
          variantId: v?.id,
          title: displayTitle,
          sku: v?.sku || "-",
          companies: companyIds,
        };
      }) ?? [];

    // If no companies at all, we can return now
    const allCompanyIds = Array.from(
      new Set(rows.flatMap((r) => r.companies).filter(Boolean))
    );

    if (allCompanyIds.length === 0) {
      return json(rows, { status: 200, headers: corsHeaders });
    }

    // 3) Lookup company names via Admin GraphQL `nodes`
    const companyGids = allCompanyIds.map((id) =>
      id.startsWith("gid://") ? id : `gid://shopify/Company/${id}`
    );

    const companiesResponse = await admin.graphql(
      `
        query BackinstockCompanies($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Company {
              id
              name
            }
          }
        }
      `,
      {
        variables: {
          ids: companyGids,
        },
      }
    );

    const companiesData = await companiesResponse.json();
    // console.log("Backinstock companies raw:", JSON.stringify(companiesData, null, 2));

    const idToName: Record<string, string> = {};

    const nodes: any[] = companiesData?.data?.nodes ?? [];
    for (const node of nodes) {
      if (!node) continue;
      const gid: string = node.id;
      const name: string = node.name;
      if (!gid || !name) continue;

      // Extract numeric ID from gid://shopify/Company/2008121557
      const parts = gid.split("/");
      const numericId = parts[parts.length - 1];

      idToName[numericId] = name;
      idToName[gid] = name; // just in case we ever use the full GID
    }

    // 4) Attach `companyNames` to each row
    const enrichedRows: Row[] = rows.map((row) => {
      const companyNames = row.companies.map(
        (id) => idToName[id] ?? id // fallback to ID if name not found
      );
      return {
        ...row,
        companyNames,
      };
    });

    return json(enrichedRows, { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error("Error in /api/backinstock/list", error);
    return json([], { status: 500, headers: corsHeaders });
  }
}

export function action({}: ActionFunctionArgs) {
  return new Response("Method not allowed", {
    status: 405,
    headers: corsHeaders,
  });
}
