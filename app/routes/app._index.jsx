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
  RadioButton,
  Select,
  useBreakpoints,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// =================== HELPERS ===================

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function formatDateLabel(dateStr) {
  // "10 Oct at 3:19 am"
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "-";

  const day = d.toLocaleString("en-AU", { day: "2-digit" });
  const month = d.toLocaleString("en-AU", { month: "short" });
  const time = d
    .toLocaleString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(" AM", " am")
    .replace(" PM", " pm");

  return `${day} ${month} at ${time}`;
}

function isEmptyRestockAt(restock_at) {
  return restock_at === null || restock_at === undefined || String(restock_at).trim() === "";
}

// =================== LOADER ===================

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  // For admin links
  const shopHandle = session.shop.replace(".myshopify.com", "");

  // 1) Get numeric shop id from Admin API: gid://shopify/Shop/59668267140 -> 59668267140
  const shopResp = await admin.graphql(`
    query GetShopId {
      shop {
        id
      }
    }
  `);
  const shopJson = await shopResp.json();
  const shopGid = shopJson?.data?.shop?.id || "";
  const shopIdNumeric = shopGid ? shopGid.split("/").pop() : "";

  // 2) Fetch history rows from Laravel for THIS shop_id (numeric)
  let backinstockHistory = [];
  try {
    const historyResp = await fetch(
      "https://sellerapp.bloomandgrowgroup.com/api/backinstock/getSavedSubscriptions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: shopIdNumeric, // ✅ numeric, matches DB
          flowSecretHeader: "fss_jeu39ej3032kd03k30dk303kd00293003",
        }),
      },
    );

    const historyJson = await historyResp.json();
    backinstockHistory = historyJson?.ok ? historyJson.data : [];
  } catch (e) {
    backinstockHistory = [];
  }

  // Normalize expected fields & keep sorting safety (Laravel already sorts desc)
  backinstockHistory = (backinstockHistory || []).map((r) => ({
    company_id: String(r.company_id ?? ""),
    variant_id: String(r.variant_id ?? ""),
    created_at: r.created_at ?? null,
    restock_at: r.restock_at ?? null,
  }));

  // 3) Bulk lookup variant + company info from Shopify (FAST, no product paging)
  const variantIdsNumeric = Array.from(
    new Set(backinstockHistory.map((r) => r.variant_id).filter(Boolean)),
  );

  const companyIdsNumeric = Array.from(
    new Set(backinstockHistory.map((r) => r.company_id).filter(Boolean)),
  );

  // Maps for UI
  const variantInfoMap = {}; // variant_numeric_id -> { productTitle, sku, productNumericId }
  const companyMap = {}; // company_numeric_id -> { name }

  // ---- 3a) Lookup variants via nodes() in chunks
  const variantChunks = chunkArray(
    variantIdsNumeric.map((id) => `gid://shopify/ProductVariant/${id}`),
    100,
  );

  for (const idsChunk of variantChunks) {
    const vResp = await admin.graphql(
      `
        query VariantNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              sku
              product {
                id
                title
              }
            }
          }
        }
      `,
      { variables: { ids: idsChunk } },
    );

    const vJson = await vResp.json();
    const nodes = vJson?.data?.nodes ?? [];

    for (const node of nodes) {
      if (!node?.id) continue;
      const variantNumericId = node.id.split("/").pop();
      const productGid = node?.product?.id || "";
      const productNumericId = productGid ? productGid.split("/").pop() : "";
      const productTitle = node?.product?.title || "—";
      const sku = node?.sku || "—";

      variantInfoMap[variantNumericId] = {
        productTitle,
        sku,
        productNumericId,
      };
    }
  }

  // ---- 3b) Lookup companies via nodes() in chunks
  const companyChunks = chunkArray(
    companyIdsNumeric.map((id) => `gid://shopify/Company/${id}`),
    100,
  );

  for (const idsChunk of companyChunks) {
    const cResp = await admin.graphql(
      `
        query CompanyNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Company {
              id
              name
            }
          }
        }
      `,
      { variables: { ids: idsChunk } },
    );

    const cJson = await cResp.json();
    const nodes = cJson?.data?.nodes ?? [];

    for (const node of nodes) {
      if (!node?.id) continue;
      const companyNumericId = node.id.split("/").pop();
      companyMap[companyNumericId] = { name: node.name || companyNumericId };
    }
  }

  return json({
    shop: shopHandle,
    shopIdNumeric,
    backinstockHistory,
    variantInfoMap,
    companyMap,
  });
}

// =================== REACT PAGE ===================

export default function BackinstockIndex() {
  const { shop, backinstockHistory, variantInfoMap, companyMap } = useLoaderData();

  const { smUp } = useBreakpoints(); // smUp=false on small/mobile

  // Search + Filter + Pagination
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState("all"); // "all" | "pending" | "sent"
  const [historyPage, setHistoryPage] = useState(1);
  const HISTORY_PER_PAGE = 15;

  const normalizedHistoryQuery = historySearch.trim().toLowerCase();

  useEffect(() => {
    setHistoryPage(1);
  }, [normalizedHistoryQuery, historyStatus]);

  // Combined filter (radio/select) + search
  const filteredHistory = useMemo(() => {
    let base = backinstockHistory || [];

    // 1) Status filter
    if (historyStatus === "pending") {
      base = base.filter((row) => isEmptyRestockAt(row.restock_at));
    } else if (historyStatus === "sent") {
      base = base.filter((row) => !isEmptyRestockAt(row.restock_at));
    }

    // 2) Search filter
    if (!normalizedHistoryQuery) return base;

    return base.filter((row) => {
      const v = variantInfoMap[row.variant_id];
      const productTitle = (v?.productTitle || "").toLowerCase();
      const sku = (v?.sku || "").toLowerCase();
      const companyName = (companyMap[row.company_id]?.name || "").toLowerCase();

      const haystack = `${productTitle} ${companyName} ${sku}`;
      return haystack.includes(normalizedHistoryQuery);
    });
  }, [backinstockHistory, normalizedHistoryQuery, historyStatus, variantInfoMap, companyMap]);

  // Pagination
  const totalHistory = filteredHistory.length;
  const totalPages = Math.max(1, Math.ceil(totalHistory / HISTORY_PER_PAGE));
  const currentPage = Math.min(historyPage, totalPages);

  const startIndex = (currentPage - 1) * HISTORY_PER_PAGE;
  const endIndex = Math.min(startIndex + HISTORY_PER_PAGE, totalHistory);

  const pageRows = filteredHistory.slice(startIndex, endIndex);

  // Rows
  const rows = pageRows.map((row) => {
    const v = variantInfoMap[row.variant_id];

    const productTitle = v?.productTitle || `Variant ${row.variant_id}`;
    const sku = v?.sku || "—";

    const productNumericId = v?.productNumericId || "";
    const productUrl = productNumericId
      ? `https://admin.shopify.com/store/${shop}/products/${productNumericId}`
      : null;

    const companyName = companyMap[row.company_id]?.name || row.company_id;
    const companyUrl = `https://admin.shopify.com/store/${shop}/companies/${row.company_id}?selectedView=all`;

    const dateLabel = row.created_at ? formatDateLabel(row.created_at) : "—";
    const dateRestock = row.restock_at ? formatDateLabel(row.restock_at) : "Pending";

    const productCell = productUrl ? (
      <PolarisLink url={productUrl} target="_blank">
        {productTitle}
      </PolarisLink>
    ) : (
      <Text as="span">{productTitle}</Text>
    );

    const companyCell = (
      <PolarisLink url={companyUrl} target="_blank">
        {companyName}
      </PolarisLink>
    );

    return [productCell, sku, companyCell, dateLabel, dateRestock];
  });

  const emptyMessage = (() => {
    if (totalHistory === 0 && !normalizedHistoryQuery && historyStatus === "all")
      return "No history found yet.";

    if (totalHistory === 0) {
      if (historyStatus === "pending") return "No pending notifications match your search.";
      if (historyStatus === "sent") return "No sent notifications match your search.";
      return "No history matches your search.";
    }

    return "No history matches your search.";
  })();

  return (
    <Page title="Subscriptions" fullWidth>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {/* Search + Filter row */}
              <InlineStack align="space-between" gap="400" wrap={false}>
                {/* Left 49% */}
                <Box width="49%">
                  <TextField
                    label="Search history"
                    labelHidden
                    value={historySearch}
                    onChange={setHistorySearch}
                    placeholder="Search by product, sku, or company"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setHistorySearch("")}
                  />
                </Box>

                {/* Right 49% */}
                <Box width="49%">
                  {smUp ? (
                    // Desktop/Tablet: horizontal radios
                    <InlineStack align="end" gap="400" wrap={false}>
                      <RadioButton
                        label="All"
                        checked={historyStatus === "all"}
                        name="historyStatus"
                        id="historyStatusAll"
                        onChange={() => setHistoryStatus("all")}
                      />
                      <RadioButton
                        label="Pending Notification"
                        checked={historyStatus === "pending"}
                        name="historyStatus"
                        id="historyStatusPending"
                        onChange={() => setHistoryStatus("pending")}
                      />
                      <RadioButton
                        label="Notification Sent"
                        checked={historyStatus === "sent"}
                        name="historyStatus"
                        id="historyStatusSent"
                        onChange={() => setHistoryStatus("sent")}
                      />
                    </InlineStack>
                  ) : (
                    // Mobile: select dropdown
                    <Select
                      label="Filter"
                      labelHidden
                      value={historyStatus}
                      onChange={setHistoryStatus}
                      options={[
                        { label: "All", value: "all" },
                        { label: "Pending Notification", value: "pending" },
                        { label: "Notification Sent", value: "sent" },
                      ]}
                    />
                  )}
                </Box>
              </InlineStack>

              {rows.length === 0 ? (
                <Text as="p" variant="bodyMd">
                  {emptyMessage}
                </Text>
              ) : (
                <>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={[
                      "Product Name",
                      "Sku",
                      "Company Name",
                      "Subscription Date",
                      "Notification Date",
                    ]}
                    rows={rows}
                  />

                  <Box paddingBlockStart="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm">
                        Showing {startIndex + 1}–{endIndex} of {totalHistory} records
                      </Text>

                      <Pagination
                        hasPrevious={currentPage > 1}
                        onPrevious={() => setHistoryPage((p) => Math.max(1, p - 1))}
                        hasNext={currentPage < totalPages}
                        onNext={() => setHistoryPage((p) => Math.min(totalPages, p + 1))}
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