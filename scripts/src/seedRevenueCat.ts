/**
 * Seed RevenueCat for Clownin.
 *
 * Creates (idempotently):
 *  - RevenueCat project "Clownin"
 *  - Test Store, App Store, and Play Store apps
 *  - Product: pro_monthly ($9.99/mo)
 *  - Entitlement: "pro"
 *  - Offering: default → $rc_monthly package
 *
 * Run:  pnpm --filter @workspace/scripts exec tsx src/seedRevenueCat.ts
 *
 * After a successful run, copy the logged API keys and IDs into these
 * environment variables (Settings → Secrets):
 *   EXPO_PUBLIC_REVENUECAT_TEST_API_KEY
 *   EXPO_PUBLIC_REVENUECAT_IOS_API_KEY
 *   EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY
 *   REVENUECAT_PROJECT_ID
 */
import { getUncachableRevenueCatClient } from "./revenueCatClient";
import {
  listProjects,
  createProject,
  listApps,
  createApp,
  listAppPublicApiKeys,
  listProducts,
  createProduct,
  listEntitlements,
  createEntitlement,
  attachProductsToEntitlement,
  listOfferings,
  createOffering,
  updateOffering,
  listPackages,
  createPackages,
  attachProductsToPackage,
  type App,
  type Product,
  type Project,
  type Entitlement,
  type Offering,
  type Package,
  type CreateProductData,
} from "@replit/revenuecat-sdk";

// ── Config ────────────────────────────────────────────────────────────────────
const PROJECT_NAME = "Clownin";

const PRODUCT_IDENTIFIER = "pro_monthly";
const PLAY_STORE_PRODUCT_IDENTIFIER = "pro_monthly:monthly";
const PRODUCT_DISPLAY_NAME = "Pro Monthly";
const PRODUCT_USER_FACING_TITLE = "Clownin Pro";
const PRODUCT_DURATION = "P1M";

const APP_STORE_APP_NAME = "Clownin iOS";
const APP_STORE_BUNDLE_ID = "com.clownin.app";
const PLAY_STORE_APP_NAME = "Clownin Android";
const PLAY_STORE_PACKAGE_NAME = "com.clownin.app";

const ENTITLEMENT_IDENTIFIER = "pro";
const ENTITLEMENT_DISPLAY_NAME = "Pro Access";

const OFFERING_IDENTIFIER = "default";
const OFFERING_DISPLAY_NAME = "Default Offering";

const PACKAGE_IDENTIFIER = "$rc_monthly";
const PACKAGE_DISPLAY_NAME = "Monthly";

const PRODUCT_PRICES = [
  { amount_micros: 9_990_000, currency: "USD" }, // $9.99
];

type TestStorePricesResponse = {
  object: string;
  prices: { amount_micros: number; currency: string }[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureProduct(
  client: Awaited<ReturnType<typeof getUncachableRevenueCatClient>>,
  projectId: string,
  existingProducts: Product[],
  targetApp: App,
  label: string,
  storeIdentifier: string,
  isTestStore: boolean,
): Promise<Product> {
  const existing = existingProducts.find(
    (p) => p.store_identifier === storeIdentifier && p.app_id === targetApp.id,
  );
  if (existing) {
    console.log(`${label} product already exists: ${existing.id}`);
    return existing;
  }

  const body: CreateProductData["body"] = {
    store_identifier: storeIdentifier,
    app_id: targetApp.id,
    type: "subscription",
    display_name: PRODUCT_DISPLAY_NAME,
  };
  if (isTestStore) {
    body.subscription = { duration: PRODUCT_DURATION };
    body.title = PRODUCT_USER_FACING_TITLE;
  }

  const { data, error } = await createProduct({
    client,
    path: { project_id: projectId },
    body,
  });
  if (error) throw new Error(`Failed to create ${label} product: ${JSON.stringify(error)}`);
  console.log(`Created ${label} product: ${data.id}`);
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function seed() {
  const client = await getUncachableRevenueCatClient();

  // 1. Project
  let project: Project;
  const { data: projectList, error: listProjErr } = await listProjects({
    client,
    query: { limit: 20 },
  });
  if (listProjErr) throw new Error("Failed to list projects");

  const found = projectList.items?.find((p) => p.name === PROJECT_NAME);
  if (found) {
    console.log(`Project already exists: ${found.id}`);
    project = found;
  } else {
    const { data, error } = await createProject({ client, body: { name: PROJECT_NAME } });
    if (error) throw new Error("Failed to create project");
    console.log(`Created project: ${data.id}`);
    project = data;
  }

  // 2. Apps
  const { data: apps, error: listAppsErr } = await listApps({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listAppsErr || !apps?.items.length) throw new Error("No apps found");

  let testApp = apps.items.find((a) => a.type === "test_store");
  let iosApp  = apps.items.find((a) => a.type === "app_store");
  let droidApp = apps.items.find((a) => a.type === "play_store");

  if (!testApp) throw new Error("No test_store app found in project");
  console.log(`Test Store app: ${testApp.id}`);

  if (!iosApp) {
    const { data, error } = await createApp({
      client,
      path: { project_id: project.id },
      body: { name: APP_STORE_APP_NAME, type: "app_store", app_store: { bundle_id: APP_STORE_BUNDLE_ID } },
    });
    if (error) throw new Error("Failed to create App Store app");
    iosApp = data;
    console.log(`Created App Store app: ${iosApp.id}`);
  } else {
    console.log(`App Store app: ${iosApp.id}`);
  }

  if (!droidApp) {
    const { data, error } = await createApp({
      client,
      path: { project_id: project.id },
      body: { name: PLAY_STORE_APP_NAME, type: "play_store", play_store: { package_name: PLAY_STORE_PACKAGE_NAME } },
    });
    if (error) throw new Error("Failed to create Play Store app");
    droidApp = data;
    console.log(`Created Play Store app: ${droidApp.id}`);
  } else {
    console.log(`Play Store app: ${droidApp.id}`);
  }

  // 3. Products
  const { data: productList, error: listProdErr } = await listProducts({
    client,
    path: { project_id: project.id },
    query: { limit: 100 },
  });
  if (listProdErr) throw new Error("Failed to list products");
  const existing = productList.items ?? [];

  const testProduct  = await ensureProduct(client, project.id, existing, testApp,  "Test Store", PRODUCT_IDENTIFIER,             true);
  const iosProduct   = await ensureProduct(client, project.id, existing, iosApp,   "App Store",  PRODUCT_IDENTIFIER,             false);
  const droidProduct = await ensureProduct(client, project.id, existing, droidApp, "Play Store", PLAY_STORE_PRODUCT_IDENTIFIER,  false);

  // 3b. Test store prices
  const { error: priceErr } = await client.post<TestStorePricesResponse>({
    url: "/projects/{project_id}/products/{product_id}/test_store_prices",
    path: { project_id: project.id, product_id: testProduct.id },
    body: { prices: PRODUCT_PRICES },
  });
  if (priceErr) {
    if (
      priceErr &&
      typeof priceErr === "object" &&
      "type" in priceErr &&
      (priceErr as Record<string, unknown>)["type"] === "resource_already_exists"
    ) {
      console.log("Test store prices already exist");
    } else {
      throw new Error("Failed to set test store prices");
    }
  } else {
    console.log("Set test store prices: $9.99");
  }

  // 4. Entitlement
  let entitlement: Entitlement;
  const { data: entList, error: listEntErr } = await listEntitlements({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listEntErr) throw new Error("Failed to list entitlements");

  const foundEnt = entList.items?.find((e) => e.lookup_key === ENTITLEMENT_IDENTIFIER);
  if (foundEnt) {
    console.log(`Entitlement already exists: ${foundEnt.id}`);
    entitlement = foundEnt;
  } else {
    const { data, error } = await createEntitlement({
      client,
      path: { project_id: project.id },
      body: { lookup_key: ENTITLEMENT_IDENTIFIER, display_name: ENTITLEMENT_DISPLAY_NAME },
    });
    if (error) throw new Error("Failed to create entitlement");
    console.log(`Created entitlement: ${data.id}`);
    entitlement = data;
  }

  const { error: attachEntErr } = await attachProductsToEntitlement({
    client,
    path: { project_id: project.id, entitlement_id: entitlement.id },
    body: { product_ids: [testProduct.id, iosProduct.id, droidProduct.id] },
  });
  if (attachEntErr && attachEntErr.type !== "unprocessable_entity_error") {
    throw new Error("Failed to attach products to entitlement");
  }
  console.log("Products attached to entitlement");

  // 5. Offering
  let offering: Offering;
  const { data: offList, error: listOffErr } = await listOfferings({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listOffErr) throw new Error("Failed to list offerings");

  const foundOff = offList.items?.find((o) => o.lookup_key === OFFERING_IDENTIFIER);
  if (foundOff) {
    console.log(`Offering already exists: ${foundOff.id}`);
    offering = foundOff;
  } else {
    const { data, error } = await createOffering({
      client,
      path: { project_id: project.id },
      body: { lookup_key: OFFERING_IDENTIFIER, display_name: OFFERING_DISPLAY_NAME },
    });
    if (error) throw new Error("Failed to create offering");
    console.log(`Created offering: ${data.id}`);
    offering = data;
  }

  if (!offering.is_current) {
    const { error } = await updateOffering({
      client,
      path: { project_id: project.id, offering_id: offering.id },
      body: { is_current: true },
    });
    if (error) throw new Error("Failed to set offering as current");
    console.log("Set offering as current");
  }

  // 6. Package
  let pkg: Package;
  const { data: pkgList, error: listPkgErr } = await listPackages({
    client,
    path: { project_id: project.id, offering_id: offering.id },
    query: { limit: 20 },
  });
  if (listPkgErr) throw new Error("Failed to list packages");

  const foundPkg = pkgList.items?.find((p) => p.lookup_key === PACKAGE_IDENTIFIER);
  if (foundPkg) {
    console.log(`Package already exists: ${foundPkg.id}`);
    pkg = foundPkg;
  } else {
    const { data, error } = await createPackages({
      client,
      path: { project_id: project.id, offering_id: offering.id },
      body: { lookup_key: PACKAGE_IDENTIFIER, display_name: PACKAGE_DISPLAY_NAME },
    });
    if (error) throw new Error("Failed to create package");
    console.log(`Created package: ${data.id}`);
    pkg = data;
  }

  const { error: attachPkgErr } = await attachProductsToPackage({
    client,
    path: { project_id: project.id, package_id: pkg.id },
    body: {
      products: [
        { product_id: testProduct.id,  eligibility_criteria: "all" },
        { product_id: iosProduct.id,   eligibility_criteria: "all" },
        { product_id: droidProduct.id, eligibility_criteria: "all" },
      ],
    },
  });
  if (
    attachPkgErr &&
    !(attachPkgErr.type === "unprocessable_entity_error" &&
      attachPkgErr.message?.includes("Cannot attach product"))
  ) {
    throw new Error("Failed to attach products to package");
  }
  console.log("Products attached to package");

  // 7. API Keys
  const keyFetch = async (appId: string) => {
    const { data, error } = await listAppPublicApiKeys({
      client,
      path: { project_id: project.id, app_id: appId },
    });
    if (error) throw new Error(`Failed to fetch API keys for app ${appId}`);
    return data?.items.map((i) => i.key).join(", ") ?? "none";
  };

  const testKey  = await keyFetch(testApp.id);
  const iosKey   = await keyFetch(iosApp.id);
  const droidKey = await keyFetch(droidApp.id);

  console.log("\n====================");
  console.log("RevenueCat setup complete!");
  console.log(`Project ID:              ${project.id}`);
  console.log(`Test Store App ID:       ${testApp.id}`);
  console.log(`App Store App ID:        ${iosApp.id}`);
  console.log(`Play Store App ID:       ${droidApp.id}`);
  console.log(`Entitlement identifier:  ${ENTITLEMENT_IDENTIFIER}`);
  console.log();
  console.log("Add these to Secrets:");
  console.log(`  EXPO_PUBLIC_REVENUECAT_TEST_API_KEY    = ${testKey}`);
  console.log(`  EXPO_PUBLIC_REVENUECAT_IOS_API_KEY     = ${iosKey}`);
  console.log(`  EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = ${droidKey}`);
  console.log(`  REVENUECAT_PROJECT_ID                  = ${project.id}`);
  console.log("====================\n");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
