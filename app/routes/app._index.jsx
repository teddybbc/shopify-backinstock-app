// app/routes/app._index.jsx

import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import React, { useMemo, useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  Link as PolarisLink,
  TextField,
  InlineStack,
  Pagination,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// =================== LOADER ===================

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  // ----- 1) Fetch ALL products in pages (not just first: 100) -----
  const allProductEdges = [];
  let cursor = null;
  let hasNextPage = true;
  const PAGE_SIZE = 100;
  let safetyCounter = 0; // to avoid infinite loops

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

// =================== REACT PAGE ===================

export default function BackinstockIndex() {
  const { subscriptions, shop, companyMap } = useLoaderData();

  // --- Search state ---
  const [search, setSearch] = useState("");
  const normalizedQuery = search.trim().toLowerCase();

  // --- Pagination state ---
  const ITEMS_PER_PAGE = 20;
  const [page, setPage] = useState(1); // 1-based

  // Reset to first page when search changes
  useEffect(() => {
    setPage(1);
  }, [normalizedQuery]);

  // Precompute enhanced subscriptions with label + company names
  const enhancedSubscriptions = useMemo(() => {
    return subscriptions.map((sub) => {
      const variantPart =
        sub.variantTitle && sub.variantTitle !== "Default Title"
          ? ` — ${sub.variantTitle}`
          : "";

      const label = `${sub.productTitle}${variantPart}`;

      const companyNames = (sub.companies || []).map((id) => {
        const info = companyMap[id];
        return info?.name || id;
      });

      return {
        ...sub,
        label,
        companyNames,
      };
    });
  }, [subscriptions, companyMap]);

  // Filter by search (product label, sku, company names)
  const filteredSubscriptions = useMemo(() => {
    if (!normalizedQuery) return enhancedSubscriptions;

    return enhancedSubscriptions.filter((sub) => {
      const haystack = [
        sub.label,
        sub.sku,
        ...(sub.companyNames || []),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [enhancedSubscriptions, normalizedQuery]);

  // Pagination calculations
  const totalItems = filteredSubscriptions.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);

  const pageSubscriptions = filteredSubscriptions.slice(startIndex, endIndex);

  // Build rows for DataTable
  const rows = pageSubscriptions.map((sub) => {
    const productUrl = `https://admin.shopify.com/store/${shop}/products/${sub.productId}`;

    const productCell = (
      <PolarisLink url={productUrl} target="_blank">
        {sub.label}
      </PolarisLink>
    );

    const companiesCell = (
      <InlineStack gap="200" wrap>
        {sub.companies.map((id) => {
          const companyInfo = companyMap[id];
          const name = companyInfo?.name || id;
          const companyUrl = `https://admin.shopify.com/store/${shop}/companies/${id}?selectedView=all`;

          return (
            <PolarisLink key={id} url={companyUrl} target="_blank">
              {name}
            </PolarisLink>
          );
        })}
      </InlineStack>
    );

    return [productCell, sub.sku || "—", companiesCell];
  });

  return (
    <Page title="Back in stock subscriptions" fullWidth>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {/* Search input */}
              <TextField
                label="Search subscriptions"
                labelHidden
                value={search}
                onChange={setSearch}
                placeholder="Search by product, SKU, or company"
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />

              {rows.length === 0 ? (
                <Text as="p" variant="bodyMd">
                  {totalItems === 0 && !normalizedQuery
                    ? "No subscriptions found yet."
                    : "No subscriptions match your search."}
                </Text>
              ) : (
                <>
                  <DataTable
                    columnContentTypes={["text", "text", "text"]}
                    headings={["Product / Variant", "SKU", "Companies"]}
                    rows={rows}
                  />

                  <Box paddingBlockStart="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm">
                        Showing {startIndex + 1}–{endIndex} of {totalItems}{" "}
                        subscriptions
                      </Text>
                      <Pagination
                        hasPrevious={currentPage > 1}
                        onPrevious={() =>
                          setPage((prev) => Math.max(1, prev - 1))
                        }
                        hasNext={currentPage < totalPages}
                        onNext={() =>
                          setPage((prev) =>
                            Math.min(totalPages, prev + 1),
                          )
                        }
                      />
                    </InlineStack>
                  </Box>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
