import React, { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  BlockStack,
  InlineStack,
  Text,
} from "@shopify/ui-extensions-react/admin";

const TARGET = "admin.product-details.block.render";

export default reactExtension(TARGET, () => <App />);

function App() {
  const { data, authenticatedFetch } = useApi(TARGET);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const productId = data?.selected?.[0]?.id;

  useEffect(() => {
    async function load() {
      console.log("Backinstock admin block productId:", productId);

      if (!productId) {
        setLoading(false);
        setRows([]);
        setError("");
        return;
      }

      try {
        setLoading(true);
        setError("");

        const fetchFn = authenticatedFetch ?? fetch;
        const res = await fetchFn(
          `/api/backinstock/list?productId=${encodeURIComponent(productId)}`
        );

        if (!res.ok) {
          const text = await res.text();
          console.error(
            "Backinstock admin block – list error:",
            res.status,
            text
          );
          setError(`Could not load subscriptions`);
          setRows([]);
          return;
        }

        const data = await res.json();
        console.log("Backinstock admin block – list data:", data);

        setRows(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error("Backinstock admin block – fetch failed:", err);
        setError("Could not load subscriptions");
        setRows([]);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [productId, authenticatedFetch]);

  if (!productId) {
    return (
      <BlockStack>
        <Text>Product not available in context.</Text>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="large">
      <Text size="large" emphasis="bold">
        Back In Stock — Subscribed Companies
      </Text>

      {loading && <Text>Loading subscriptions…</Text>}

      {!loading && error && <Text tone="critical">{error}</Text>}

      {!loading && !error && rows.length === 0 && (
        <Text>No subscriptions found for this product.</Text>
      )}

      {!loading && !error && rows.length > 0 && (
        <BlockStack>
          {rows.map((row) => (
            <BlockStack
              key={row.variantId}
              padding="base"
              border="base"
              cornerRadius="large"
            >
              <InlineStack gap="base">
                <Text>Variant:</Text>
                <Text emphasis="bold">{row.title}</Text>
              </InlineStack>

              <InlineStack gap="base">
                <Text>SKU:</Text>
                <Text>{row.sku || "—"}</Text>
              </InlineStack>

              <InlineStack gap="base">
                <Text>Companies:</Text>
                <Text>
                  {row.companyNames && row.companyNames.length > 0
                    ? row.companyNames.join(", ")
                    : row.companies && row.companies.length > 0
                    ? row.companies.join(", ")
                    : "—"}
                </Text>
              </InlineStack>
            </BlockStack>
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}
