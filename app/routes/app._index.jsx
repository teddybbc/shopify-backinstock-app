import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  // ----- 1) Fetch ALL products in pages (not just first: 100) -----
  const allProductEdges = [];
  let cursor = null;
  let hasNextPage = true;
  const PAGE_SIZE = 100;
  let safetyCounter = 0; // to avoid infinite loops, just in case

  while (hasNextPage && safetyCounter < 50) {
    safetyCounter += 1;

    const response = await admin.graphql(
      `
        query BackInStockAll($cursor: String) {
          products(first: ${PAGE_SIZE}, after: $cursor) {
            edges {
              cursor
              node {
                id
                title
                variants(first: 50) {
                  edges {
                    node {
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
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
      {
        variables: { cursor },
      },
    );

    const data = await response.json();
    const productsConnection = data?.data?.products;
    const edges = productsConnection?.edges ?? [];

    allProductEdges.push(...edges);

    hasNextPage = productsConnection?.pageInfo?.hasNextPage ?? false;

    if (hasNextPage && edges.length > 0) {
      cursor = edges[edges.length - 1].cursor;
    } else {
      cursor = null;
      hasNextPage = false;
    }
  }

  // ----- 2) Build subscriptions from ALL product edges -----
  const subscriptions = [];
  const companyIdSet = new Set();

  for (const pEdge of allProductEdges) {
    const product = pEdge?.node;
    if (!product) continue;

    const productIdGid = product.id;
    const productNumericId = productIdGid.split("/").pop();

    const variants = product.variants?.edges ?? [];
    for (const vEdge of variants) {
      const variant = vEdge?.node;
      if (!variant) continue;

      const raw = variant.metafield?.value;
      if (!raw) continue;

      let companies = [];
      try {
        companies = JSON.parse(raw);
        if (!Array.isArray(companies)) companies = [];
      } catch {
        companies = [];
      }

      if (!companies.length) continue;

      companies.forEach((id) => companyIdSet.add(id));

      subscriptions.push({
        variantId: variant.id,
        productId: productNumericId,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku || "",
        companies, // array of numeric IDs as strings
      });
    }
  }

  // ----- 3) Lookup company names via nodes() -----
  let companyMap = {};
  const companyIds = Array.from(companyIdSet);

  if (companyIds.length > 0) {
    const nodeIds = companyIds.map((id) => `gid://shopify/Company/${id}`);

    const companyResp = await admin.graphql(
      `
        query CompanyNames($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Company {
              id
              name
            }
          }
        }
      `,
      {
        variables: { ids: nodeIds },
      },
    );

    const companyData = await companyResp.json();
    const nodes = companyData?.data?.nodes ?? [];

    companyMap = nodes.reduce((acc, node) => {
      if (!node || !node.id) return acc;
      const numeric = node.id.split("/").pop();
      acc[numeric] = {
        name: node.name,
      };
      return acc;
    }, {});
  }

  // ----- 4) Derive shop handle for admin URLs -----
  const shopHandle = session.shop.replace(".myshopify.com", "");

  return json({ subscriptions, shop: shopHandle, companyMap });
}
