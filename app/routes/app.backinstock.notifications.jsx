// app/routes/app.backinstock.notifications.jsx

import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { Page, Card, IndexTable, Text } from "@shopify/polaris";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  // 1) Get all variants that have the backinstock metafield
  const variantsRes = await admin.graphql(`
    query BackInStockAll {
      productVariants(
        first: 100
        query: "metafield:backinstock.notify_companies:*"
      ) {
        edges {
          node {
            id
            sku
            displayName
            product {
              id
              title
            }
            metafield(namespace: "backinstock", key: "notify_companies") {
              value
            }
          }
        }
      }
    }
  `);

  const variantsJson = await variantsRes.json();

  const variantNodes =
    variantsJson?.data?.productVariants?.edges?.map((e) => e.node) ?? [];

  // 2) Collect all unique company IDs
  const companyIdSet = new Set();

  for (const v of variantNodes) {
    const rawValue = v?.metafield?.value;
    if (!rawValue) continue;

    try {
      const ids = JSON.parse(rawValue);
      if (Array.isArray(ids)) {
        ids.forEach((id) => {
          if (id) companyIdSet.add(id);
        });
      }
    } catch {
      // ignore bad JSON
    }
  }

  const companyIds = Array.from(companyIdSet);
  let companyNameByShortId = {};

  // 3) Look up company names
  if (companyIds.length > 0) {
    const fullCompanyGids = companyIds.map(
      (shortId) => `gid://shopify/Company/${shortId}`,
    );

    const companiesRes = await admin.graphql(
      `
        query BackInStockCompanies($ids: [ID!]!) {
          companies(first: 100, ids: $ids) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `,
      {
        variables: {
          ids: fullCompanyGids,
        },
      },
    );

    const companiesJson = await companiesRes.json();

    const edges = companiesJson?.data?.companies?.edges ?? [];
    companyNameByShortId = edges.reduce((acc, edge) => {
      const fullId = edge?.node?.id;
      const name = edge?.node?.name;
      if (!fullId || !name) return acc;

      const shortId = fullId.replace("gid://shopify/Company/", "");
      acc[shortId] = name;
      return acc;
    }, {});
  }

  // 4) Build rows for the table
  const rows = variantNodes.map((v) => {
    const rawValue = v?.metafield?.value;
    let companyShortIds = [];

    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed)) {
          companyShortIds = parsed.filter((id) => typeof id === "string");
        }
      } catch {
        // ignore
      }
    }

    const companyNames = companyShortIds.map(
      (id) => companyNameByShortId[id] ?? id,
    );

    return {
      id: v.id,
      productTitle:
        v?.product?.title || v?.displayName || "Untitled product/variant",
      sku: v?.sku || "—",
      companies: companyNames,
    };
  });

  return json({ rows });
}

export default function BackinstockNotificationsPage() {
  const { rows } = useLoaderData();

  return (
    <Page title="Back in stock subscriptions">
      <Card>
        {rows.length === 0 ? (
          <Text as="p" variant="bodyMd">
            No subscriptions found yet.
          </Text>
        ) : (
          <IndexTable
            resourceName={{
              singular: "subscription",
              plural: "subscriptions",
            }}
            itemCount={rows.length}
            headings={[
              { title: "Product" },
              { title: "SKU" },
              { title: "Companies" },
            ]}
            selectable={false}
          >
            {rows.map((row, index) => (
              <IndexTable.Row id={row.id} key={row.id} position={index}>
                <IndexTable.Cell>
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {row.productTitle}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{row.sku}</IndexTable.Cell>
                <IndexTable.Cell>
                  {row.companies.length ? row.companies.join(", ") : "—"}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
