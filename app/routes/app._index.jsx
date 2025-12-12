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
      { variables: { cursor } },
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
        variantId: variant.id, // GID
        productId: productNumericId, // numeric
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
      { variables: { ids: nodeIds } },
    );

    const companyData = await companyResp.json();
    const nodes = companyData?.data?.nodes ?? [];

    companyMap = nodes.reduce((acc, node) => {
      if (!node || !node.id) return acc;
      const numeric = node.id.split("/").pop();
      acc[numeric] = { name: node.name };
      return acc;
    }, {});
  }

  // ----- 4) Derive shop handle for admin URLs -----
  const shopHandle = session.shop.replace(".myshopify.com", "");

  // ----- 5) Fetch backinstock history from Laravel -----
  // IMPORTANT: Your requirement says payload shop_id is numeric like "59668267140".
  // If you already have a numeric shop ID elsewhere, replace this logic with that source.
  // Here we fall back to using the shop handle as shop_id (you can replace it).
  const shopNumericId = shopHandle; // <-- replace with true numeric shop_id if needed

  let backinstockHistory = [];
  try {
    const historyResp = await fetch(
      "https://sellerapp.bloomandgrowgroup.com/api/backinstock/getSavedSubscriptions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: shopNumericId,
          flowSecretHeader: "fss_jeu39ej3032kd03k30dk303kd00293003",
        }),
      },
    );

    const historyJson = await historyResp.json();
    backinstockHistory = historyJson?.ok ? historyJson.data : [];
  } catch (e) {
    backinstockHistory = [];
  }

  return json({ subscriptions, shop: shopHandle, companyMap, backinstockHistory });
}

// =================== REACT PAGE ===================

export default function BackinstockIndex() {
  const { subscriptions, shop, companyMap, backinstockHistory } = useLoaderData();

  // =======================
  // Subscriptions table state
  // =======================
  const [search, setSearch] = useState("");
  const normalizedQuery = search.trim().toLowerCase();

  const ITEMS_PER_PAGE = 20;
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [normalizedQuery]);

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

      return { ...sub, label, companyNames };
    });
  }, [subscriptions, companyMap]);

  const filteredSubscriptions = useMemo(() => {
    if (!normalizedQuery) return enhancedSubscriptions;

    return enhancedSubscriptions.filter((sub) => {
      const haystack = [sub.label, sub.sku, ...(sub.companyNames || [])]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [enhancedSubscriptions, normalizedQuery]);

  const totalItems = filteredSubscriptions.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);

  const pageSubscriptions = filteredSubscriptions.slice(startIndex, endIndex);

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

  // =======================
  // History table state
  // =======================
  const [historySearch, setHistorySearch] = useState("");
  const HISTORY_PER_PAGE = 15;
  const [historyPage, setHistoryPage] = useState(1);

  useEffect(() => {
    setHistoryPage(1);
  }, [historySearch]);

  // Build a fast lookup by numeric variant ID => subscription info (product + sku)
  const variantMap = useMemo(() => {
    const map = {};
    subscriptions.forEach((sub) => {
      const numericVariantId = sub.variantId.split("/").pop();
      map[numericVariantId] = sub;
    });
    return map;
  }, [subscriptions]);

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return backinstockHistory;

    return backinstockHistory.filter((row) => {
      const variant = variantMap[row.variant_id];
      const companyName = companyMap[row.company_id]?.name || "";

      return (
        (variant?.productTitle || "").toLowerCase().includes(q) ||
        (variant?.sku || "").toLowerCase().includes(q) ||
        companyName.toLowerCase().includes(q)
      );
    });
  }, [historySearch, backinstockHistory, variantMap, companyMap]);

  const totalHistory = filteredHistory.length;
  const historyPages = Math.max(1, Math.ceil(totalHistory / HISTORY_PER_PAGE));
  const currentHistoryPage = Math.min(historyPage, historyPages);
  const historyStart = (currentHistoryPage - 1) * HISTORY_PER_PAGE;
  const historyEnd = Math.min(historyStart + HISTORY_PER_PAGE, totalHistory);

  const pageHistory = filteredHistory.slice(historyStart, historyEnd);

  const historyRows = pageHistory
    .map((row) => {
      const variant = variantMap[row.variant_id];
      if (!variant) return null;

      const productUrl = `https://admin.shopify.com/store/${shop}/products/${variant.productId}`;
      const companyUrl = `https://admin.shopify.com/store/${shop}/companies/${row.company_id}?selectedView=all`;

      const dt = new Date(row.created_at);
      const dateLabel = dt.toLocaleString("en-AU", {
        day: "2-digit",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      return [
        <PolarisLink url={productUrl} target="_blank">
          {variant.productTitle}
        </PolarisLink>,
        <PolarisLink url={companyUrl} target="_blank">
          {companyMap[row.company_id]?.name || row.company_id}
        </PolarisLink>,
        variant.sku || "—",
        dateLabel,
      ];
    })
    .filter(Boolean);

  return (
    <Page title="Back in stock subscriptions" fullWidth>
      <Layout>
        {/* =======================
            Subscriptions table
        ======================= */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
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
                        Showing {startIndex + 1}–{endIndex} of {totalItems} subscriptions
                      </Text>
                      <Pagination
                        hasPrevious={currentPage > 1}
                        onPrevious={() => setPage((prev) => Math.max(1, prev - 1))}
                        hasNext={currentPage < totalPages}
                        onNext={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                      />
                    </InlineStack>
                  </Box>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* =======================
            Back in stock history table
        ======================= */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Back in stock history
              </Text>

              <TextField
                label="Search history"
                labelHidden
                value={historySearch}
                onChange={setHistorySearch}
                placeholder="Search by product, SKU, or company"
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setHistorySearch("")}
              />

              {historyRows.length === 0 ? (
                <Text as="p" variant="bodyMd">
                  {totalHistory === 0 && !historySearch.trim()
                    ? "No history found yet."
                    : "No history matches your search."}
                </Text>
              ) : (
                <>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Product Name", "Company Name", "Sku", "Date"]}
                    rows={historyRows}
                  />

                  <Box paddingBlockStart="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm">
                        Showing {historyStart + 1}–{historyEnd} of {totalHistory} records
                      </Text>
                      <Pagination
                        hasPrevious={currentHistoryPage > 1}
                        onPrevious={() =>
                          setHistoryPage((p) => Math.max(1, p - 1))
                        }
                        hasNext={currentHistoryPage < historyPages}
                        onNext={() =>
                          setHistoryPage((p) => Math.min(historyPages, p + 1))
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
