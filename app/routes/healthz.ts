import { json, type LoaderFunctionArgs } from "@remix-run/node";

export async function loader({}: LoaderFunctionArgs) {
  console.log("healthz loader hit");
  return json({ status: "ok", source: "healthz route" });
}
