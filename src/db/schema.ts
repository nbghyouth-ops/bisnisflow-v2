import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (n: string) => timestamp(n, { withTimezone: true }).notNull().defaultNow();
const num = (n: string) => numeric(n, { precision: 20, scale: 4 }).notNull().default("0");
const wsId = () => uuid("workspace_id").notNull().references(() => workspaces.id);

/* ───────────── Identity (app-managed; see docs/AUTHENTICATION.md) ───────────── */
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  status: text("status").notNull().default("unverified"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: ts("created_at"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const authCodes = pgTable(
  "auth_codes",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    createdAt: ts("created_at"),
  },
  (t) => [index("auth_codes_user_idx").on(t.userId, t.purpose)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

/* ───────────── Workspace / tenant ───────────── */
export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  template: text("template").notNull().default("other"),
  status: text("status").notNull().default("active"),
  uiMode: text("ui_mode").notNull().default("simple"),
  currency: text("currency").notNull().default("IDR"),
  locale: text("locale").notNull().default("id-ID"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  enabledModules: jsonb("enabled_modules").notNull().default(sql`'[]'::jsonb`),
  onboarding: jsonb("onboarding").notNull().default(sql`'{}'::jsonb`),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at"),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: wsId(),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    moduleAccess: jsonb("module_access"),
    createdAt: ts("created_at"),
  },
  (t) => [unique("wm_unique").on(t.workspaceId, t.userId), index("wm_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    workspaceId: wsId(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: ts("created_at"),
  },
  (t) => [index("inv_ws_idx").on(t.workspaceId)],
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    id: id(),
    workspaceId: wsId(),
    userId: uuid("user_id").notNull().references(() => users.id),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: ts("updated_at"),
  },
  (t) => [unique("pref_unique").on(t.workspaceId, t.userId, t.key)],
);

export const businesses = pgTable(
  "businesses",
  {
    id: id(),
    workspaceId: wsId(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    address: text("address"),
    phone: text("phone"),
    email: text("email"),
    taxId: text("tax_id"),
    logoFileId: uuid("logo_file_id"),
    photoFileId: uuid("photo_file_id"),
    workingHours: jsonb("working_hours").notNull().default(sql`'{}'::jsonb`),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => [unique("biz_ws_id").on(t.workspaceId, t.id)],
);

export const branches = pgTable(
  "branches",
  {
    id: id(),
    workspaceId: wsId(),
    businessId: uuid("business_id").notNull(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    address: text("address"),
    timezone: text("timezone"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("branch_ws_id").on(t.workspaceId, t.id),
    unique("branch_code").on(t.workspaceId, t.code),
    foreignKey({ columns: [t.workspaceId, t.businessId], foreignColumns: [businesses.workspaceId, businesses.id] }),
  ],
);

export const warehouses = pgTable(
  "warehouses",
  {
    id: id(),
    workspaceId: wsId(),
    branchId: uuid("branch_id"),
    name: text("name").notNull(),
    code: text("code").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("wh_ws_id").on(t.workspaceId, t.id),
    unique("wh_code").on(t.workspaceId, t.code),
    foreignKey({ columns: [t.workspaceId, t.branchId], foreignColumns: [branches.workspaceId, branches.id] }),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    result: text("result").notNull().default("ok"),
    requestId: text("request_id"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at"),
  },
  (t) => [index("audit_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: wsId(),
    key: text("key").notNull(),
    route: text("route").notNull(),
    statusCode: integer("status_code").notNull(),
    response: jsonb("response").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key, t.route] })],
);

export const docSequences = pgTable(
  "doc_sequences",
  {
    workspaceId: wsId(),
    docType: text("doc_type").notNull(),
    period: text("period").notNull(),
    last: integer("last").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.docType, t.period] })],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    payloadVersion: integer("payload_version").notNull().default(1),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").unique(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    checkpoint: jsonb("checkpoint").notNull().default(sql`'{}'::jsonb`),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: ts("created_at"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("jobs_claim_idx").on(t.status, t.nextRunAt)],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    workspaceId: wsId(),
    ownerId: uuid("owner_id").notNull(),
    objectKey: text("object_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status").notNull().default("active"),
    kind: text("kind").notNull().default("document"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    data: bytea("data"),
    createdAt: ts("created_at"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("files_ws_idx").on(t.workspaceId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    workspaceId: wsId(),
    userId: uuid("user_id"),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: ts("created_at"),
  },
  (t) => [index("notif_user_idx").on(t.workspaceId, t.userId, t.readAt)],
);

/* ───────────── Master data & rules ───────────── */
export const taxRates = pgTable("tax_rates", {
  id: id(),
  workspaceId: wsId(),
  name: text("name").notNull(),
  rate: numeric("rate", { precision: 7, scale: 4 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
});

export const businessRules = pgTable("business_rules", {
  id: id(),
  workspaceId: wsId(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  scopeLevel: text("scope_level").notNull().default("workspace"),
  scopeId: uuid("scope_id"),
  version: integer("version").notNull().default(1),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  status: text("status").notNull().default("draft"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
});

/* ───────────── Accounting ───────────── */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    workspaceId: wsId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    normal: text("normal").notNull(),
    isCash: boolean("is_cash").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    parentCode: text("parent_code"),
  },
  (t) => [
    unique("acc_code").on(t.workspaceId, t.code),
    unique("acc_ws_id").on(t.workspaceId, t.id),
    check("acc_type", sql`${t.type} in ('asset','liability','equity','revenue','expense')`),
  ],
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: id(),
    workspaceId: wsId(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    status: text("status").notNull().default("closed"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
  },
  (t) => [unique("fp_unique").on(t.workspaceId, t.year, t.month)],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    /** Original transaction currency (ISO 4217). Filled from the workspace currency by a BEFORE INSERT trigger when omitted. */
    currencyCode: text("currency_code").notNull().default(""),
    id: id(),
    workspaceId: wsId(),
    number: text("number").notNull(),
    entryDate: date("entry_date").notNull(),
    memo: text("memo"),
    status: text("status").notNull().default("posted"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    reversalOf: uuid("reversal_of"),
    reversedBy: uuid("reversed_by"),
    currency: text("currency").notNull().default("IDR"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("je_number").on(t.workspaceId, t.number),
    unique("je_source").on(t.workspaceId, t.sourceType, t.sourceId),
    unique("je_ws_id").on(t.workspaceId, t.id),
    index("je_date_idx").on(t.workspaceId, t.entryDate),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    workspaceId: wsId(),
    entryId: uuid("entry_id").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: num("debit"),
    credit: num("credit"),
    description: text("description"),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.entryId], foreignColumns: [journalEntries.workspaceId, journalEntries.id] }),
    foreignKey({ columns: [t.workspaceId, t.accountId], foreignColumns: [accounts.workspaceId, accounts.id] }),
    check("jl_nonneg", sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0 or ${t.credit} = 0)`),
    index("jl_entry_idx").on(t.entryId),
    index("jl_acc_idx").on(t.workspaceId, t.accountId),
  ],
);

/* ───────────── Products & inventory ───────────── */
export const products = pgTable(
  "products",
  {
    id: id(),
    workspaceId: wsId(),
    sku: text("sku").notNull(),
    barcode: text("barcode"),
    name: text("name").notNull(),
    type: text("type").notNull().default("goods"),
    category: text("category"),
    uom: text("uom").notNull().default("pcs"),
    price: num("price"),
    costMethod: text("cost_method").notNull().default("average"),
    taxable: boolean("taxable").notNull().default(true),
    minStock: num("min_stock"),
    reorderQty: num("reorder_qty"),
    trackBatch: boolean("track_batch").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    variantOf: uuid("variant_of"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    imageFileId: uuid("image_file_id"),
    description: text("description"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("prod_sku").on(t.workspaceId, t.sku),
    unique("prod_barcode").on(t.workspaceId, t.barcode),
    unique("prod_ws_id").on(t.workspaceId, t.id),
    check("prod_type", sql`${t.type} in ('goods','service')`),
    index("prod_name_idx").on(t.workspaceId, t.name),
  ],
);

export const stockBalances = pgTable(
  "stock_balances",
  {
    workspaceId: wsId(),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    qty: num("qty"),
    value: num("value"),
    reserved: num("reserved"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.productId, t.warehouseId] }),
    foreignKey({ columns: [t.workspaceId, t.productId], foreignColumns: [products.workspaceId, products.id] }),
    foreignKey({ columns: [t.workspaceId, t.warehouseId], foreignColumns: [warehouses.workspaceId, warehouses.id] }),
    check("sb_nonneg", sql`${t.qty} >= 0 and ${t.value} >= 0`),
  ],
);

export const stockLots = pgTable(
  "stock_lots",
  {
    id: id(),
    workspaceId: wsId(),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    batchNo: text("batch_no"),
    expiryDate: date("expiry_date"),
    receivedQty: num("received_qty"),
    remainingQty: num("remaining_qty"),
    unitCost: num("unit_cost"),
    receivedAt: ts("received_at"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.productId], foreignColumns: [products.workspaceId, products.id] }),
    index("lot_fifo_idx").on(t.workspaceId, t.productId, t.warehouseId, t.receivedAt),
  ],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    workspaceId: wsId(),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    movementType: text("movement_type").notNull(),
    qty: num("qty"),
    unitCost: num("unit_cost"),
    totalCost: num("total_cost"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    lotId: uuid("lot_id"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.productId], foreignColumns: [products.workspaceId, products.id] }),
    foreignKey({ columns: [t.workspaceId, t.warehouseId], foreignColumns: [warehouses.workspaceId, warehouses.id] }),
    index("sm_prod_idx").on(t.workspaceId, t.productId, t.createdAt),
  ],
);

export const costSnapshots = pgTable("cost_snapshots", {
  id: id(),
  workspaceId: wsId(),
  productId: uuid("product_id").notNull(),
  method: text("method").notNull(),
  unitCost: num("unit_cost"),
  qtyOnHand: num("qty_on_hand"),
  reason: text("reason"),
  createdAt: ts("created_at"),
});

export const boms = pgTable(
  "boms",
  {
    id: id(),
    workspaceId: wsId(),
    productId: uuid("product_id").notNull(),
    outputQty: num("output_qty"),
    notes: text("notes"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("bom_ws_id").on(t.workspaceId, t.id),
    unique("bom_prod").on(t.workspaceId, t.productId),
    foreignKey({ columns: [t.workspaceId, t.productId], foreignColumns: [products.workspaceId, products.id] }),
  ],
);

export const bomItems = pgTable(
  "bom_items",
  {
    id: id(),
    workspaceId: wsId(),
    bomId: uuid("bom_id").notNull(),
    componentProductId: uuid("component_product_id").notNull(),
    qty: num("qty"),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.bomId], foreignColumns: [boms.workspaceId, boms.id] }),
    foreignKey({ columns: [t.workspaceId, t.componentProductId], foreignColumns: [products.workspaceId, products.id] }),
  ],
);

export const productionBatches = pgTable("production_batches", {
  id: id(),
  workspaceId: wsId(),
  number: text("number").notNull(),
  productId: uuid("product_id").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  qtyOut: num("qty_out"),
  materialCost: num("material_cost"),
  laborCost: num("labor_cost"),
  overheadCost: num("overhead_cost"),
  unitCost: num("unit_cost"),
  expiryDate: date("expiry_date"),
  productionDate: date("production_date").notNull(),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
});

/* ───────────── CRM / suppliers ───────────── */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    workspaceId: wsId(),
    code: text("code"),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    groupName: text("group_name"),
    segment: text("segment"),
    creditLimit: num("credit_limit"),
    notes: text("notes"),
    consentMarketing: boolean("consent_marketing").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: ts("created_at"),
  },
  (t) => [unique("cust_ws_id").on(t.workspaceId, t.id), index("cust_name_idx").on(t.workspaceId, t.name)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    workspaceId: wsId(),
    name: text("name").notNull(),
    contact: text("contact"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: ts("created_at"),
  },
  (t) => [unique("sup_ws_id").on(t.workspaceId, t.id)],
);

/* ───────────── Sales ───────────── */
export const salesDocuments = pgTable(
  "sales_documents",
  {
    /** Original transaction currency (ISO 4217). Filled from the workspace currency by a BEFORE INSERT trigger when omitted. */
    currencyCode: text("currency_code").notNull().default(""),
    id: id(),
    workspaceId: wsId(),
    type: text("type").notNull(),
    number: text("number").notNull(),
    customerId: uuid("customer_id"),
    branchId: uuid("branch_id"),
    warehouseId: uuid("warehouse_id"),
    status: text("status").notNull(),
    businessDate: date("business_date").notNull(),
    dueDate: date("due_date"),
    subtotal: num("subtotal"),
    discount: num("discount"),
    tax: num("tax"),
    total: num("total"),
    paid: num("paid"),
    refunded: num("refunded"),
    returnedTotal: num("returned_total"),
    cogs: num("cogs"),
    currency: text("currency").notNull().default("IDR"),
    idempotencyKey: text("idempotency_key"),
    refDocId: uuid("ref_doc_id"),
    cashierId: uuid("cashier_id"),
    notes: text("notes"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("sd_number").on(t.workspaceId, t.number),
    unique("sd_idem").on(t.workspaceId, t.idempotencyKey),
    unique("sd_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.customerId], foreignColumns: [customers.workspaceId, customers.id] }),
    index("sd_date_idx").on(t.workspaceId, t.businessDate),
  ],
);

export const salesLines = pgTable(
  "sales_lines",
  {
    id: id(),
    workspaceId: wsId(),
    docId: uuid("doc_id").notNull(),
    productId: uuid("product_id").notNull(),
    description: text("description"),
    qty: num("qty"),
    unitPrice: num("unit_price"),
    discount: num("discount"),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    tax: num("tax"),
    lineTotal: num("line_total"),
    cogs: num("cogs"),
    returnedQty: num("returned_qty"),
  },
  (t) => [
    index("sl_doc_idx").on(t.workspaceId, t.docId),
    foreignKey({ columns: [t.workspaceId, t.docId], foreignColumns: [salesDocuments.workspaceId, salesDocuments.id] }),
    foreignKey({ columns: [t.workspaceId, t.productId], foreignColumns: [products.workspaceId, products.id] }),
    check("sl_qty", sql`${t.qty} > 0`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    workspaceId: wsId(),
    direction: text("direction").notNull(),
    kind: text("kind").notNull(),
    docType: text("doc_type"),
    docId: uuid("doc_id"),
    method: text("method").notNull(),
    amount: num("amount"),
    paidAt: ts("paid_at"),
    cashSessionId: uuid("cash_session_id"),
    reference: text("reference"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [check("pay_amount", sql`${t.amount} > 0`), index("pay_doc_idx").on(t.workspaceId, t.docId)],
);

/* ───────────── Purchasing ───────────── */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    /** Original transaction currency (ISO 4217). Filled from the workspace currency by a BEFORE INSERT trigger when omitted. */
    currencyCode: text("currency_code").notNull().default(""),
    id: id(),
    workspaceId: wsId(),
    number: text("number").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    status: text("status").notNull().default("draft"),
    orderDate: date("order_date").notNull(),
    expectedDate: date("expected_date"),
    subtotal: num("subtotal"),
    tax: num("tax"),
    total: num("total"),
    notes: text("notes"),
    approvedBy: uuid("approved_by"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("po_number").on(t.workspaceId, t.number),
    unique("po_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.supplierId], foreignColumns: [suppliers.workspaceId, suppliers.id] }),
    foreignKey({ columns: [t.workspaceId, t.warehouseId], foreignColumns: [warehouses.workspaceId, warehouses.id] }),
  ],
);

export const purchaseLines = pgTable(
  "purchase_lines",
  {
    id: id(),
    workspaceId: wsId(),
    poId: uuid("po_id").notNull(),
    productId: uuid("product_id").notNull(),
    qty: num("qty"),
    unitCost: num("unit_cost"),
    receivedQty: num("received_qty"),
    returnedQty: num("returned_qty"),
  },
  (t) => [
    index("pl_po_idx").on(t.workspaceId, t.poId),
    unique("pl_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.poId], foreignColumns: [purchaseOrders.workspaceId, purchaseOrders.id] }),
    foreignKey({ columns: [t.workspaceId, t.productId], foreignColumns: [products.workspaceId, products.id] }),
    check("pl_qty", sql`${t.qty} > 0 and ${t.receivedQty} <= ${t.qty} and ${t.returnedQty} >= 0 and ${t.returnedQty} <= ${t.receivedQty}`),
  ],
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: id(),
    workspaceId: wsId(),
    number: text("number").notNull(),
    poId: uuid("po_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    receivedAt: ts("received_at"),
    idempotencyKey: text("idempotency_key"),
    total: num("total"),
    createdBy: uuid("created_by"),
  },
  (t) => [
    index("gr_po_idx").on(t.workspaceId, t.poId),
    unique("gr_number").on(t.workspaceId, t.number),
    unique("gr_idem").on(t.workspaceId, t.idempotencyKey),
    foreignKey({ columns: [t.workspaceId, t.poId], foreignColumns: [purchaseOrders.workspaceId, purchaseOrders.id] }),
  ],
);

export const bills = pgTable("bills", {
    /** Original transaction currency (ISO 4217). Filled from the workspace currency by a BEFORE INSERT trigger when omitted. */
    currencyCode: text("currency_code").notNull().default(""),
  id: id(),
  workspaceId: wsId(),
  number: text("number").notNull(),
  supplierId: uuid("supplier_id").notNull(),
  poId: uuid("po_id"),
  receiptId: uuid("receipt_id"),
  billDate: date("bill_date").notNull(),
  dueDate: date("due_date"),
  total: num("total"),
  paid: num("paid"),
  /** Supplier credit (purchase returns) applied against this bill; outstanding = total - paid - credited. */
  credited: num("credited"),
  status: text("status").notNull().default("open"),
  createdAt: ts("created_at"),
}, (t) => [unique("bill_number").on(t.workspaceId, t.number), index("bill_po_idx").on(t.workspaceId, t.poId), index("bill_status_idx").on(t.workspaceId, t.status, t.billDate), check("bill_credit", sql`${t.credited} >= 0 and ${t.paid} + ${t.credited} <= ${t.total}`)]);

/* ───────────── Purchase returns / supplier credit notes ───────────── */
export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    /** Original transaction currency (ISO 4217). Filled from the workspace currency by a BEFORE INSERT trigger when omitted. */
    currencyCode: text("currency_code").notNull().default(""),
    id: id(),
    workspaceId: wsId(),
    number: text("number").notNull(),
    poId: uuid("po_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    returnDate: date("return_date").notNull(),
    reason: text("reason").notNull(),
    total: num("total"),
    appliedCredit: num("applied_credit"),
    unappliedCredit: num("unapplied_credit"),
    idempotencyKey: text("idempotency_key"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("pr_number").on(t.workspaceId, t.number),
    unique("pr_idem").on(t.workspaceId, t.idempotencyKey),
    unique("pr_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.poId], foreignColumns: [purchaseOrders.workspaceId, purchaseOrders.id] }),
    foreignKey({ columns: [t.workspaceId, t.supplierId], foreignColumns: [suppliers.workspaceId, suppliers.id] }),
    index("pr_po_idx").on(t.workspaceId, t.poId),
  ],
);

export const purchaseReturnLines = pgTable(
  "purchase_return_lines",
  {
    id: id(),
    workspaceId: wsId(),
    returnId: uuid("return_id").notNull(),
    poLineId: uuid("po_line_id").notNull(),
    productId: uuid("product_id").notNull(),
    qty: num("qty"),
    unitCost: num("unit_cost"),
    totalCost: num("total_cost"),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.returnId], foreignColumns: [purchaseReturns.workspaceId, purchaseReturns.id] }),
    index("prl_return_idx").on(t.workspaceId, t.returnId),
    foreignKey({ columns: [t.workspaceId, t.poLineId], foreignColumns: [purchaseLines.workspaceId, purchaseLines.id] }),
    check("prl_qty", sql`${t.qty} > 0`),
  ],
);

/* ───────────── Cash control ───────────── */
export const cashSessions = pgTable("cash_sessions", {
  id: id(),
  workspaceId: wsId(),
  register: text("register").notNull(),
  branchId: uuid("branch_id"),
  openedBy: uuid("opened_by").notNull(),
  openedAt: ts("opened_at"),
  openingFloat: num("opening_float"),
  status: text("status").notNull().default("open"),
  closedBy: uuid("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  expectedCash: num("expected_cash"),
  countedCash: num("counted_cash"),
  variance: num("variance"),
  denominations: jsonb("denominations").notNull().default(sql`'{}'::jsonb`),
  notes: text("notes"),
});

export const cashMovements = pgTable("cash_movements", {
  id: id(),
  workspaceId: wsId(),
  sessionId: uuid("session_id").notNull(),
  type: text("type").notNull(),
  amount: num("amount"),
  accountCode: text("account_code"),
  reason: text("reason"),
  refType: text("ref_type"),
  refId: text("ref_id"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
}, (t) => [check("cm_amount", sql`${t.amount} > 0`), index("cm_session_idx").on(t.sessionId)]);

/* ───────────── Bookings ───────────── */
export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    workspaceId: wsId(),
    resourceId: uuid("resource_id").notNull(),
    resourceName: text("resource_name").notNull(),
    customerName: text("customer_name").notNull(),
    customerId: uuid("customer_id"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("confirmed"),
    depositAmount: num("deposit_amount"),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [check("bk_range", sql`${t.endAt} > ${t.startAt}`), index("bk_res_idx").on(t.workspaceId, t.resourceId, t.startAt)],
);

/* ───────────── Generic module records (tasks, HR, ops, marketing, projects, assets, privacy, templates) ───────────── */
export const records = pgTable(
  "records",
  {
    id: id(),
    workspaceId: wsId(),
    module: text("module").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    amount: num("amount"),
    dueDate: date("due_date"),
    parentId: uuid("parent_id"),
    assignee: text("assignee"),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("rec_kind_idx").on(t.workspaceId, t.kind, t.status), index("rec_parent_idx").on(t.parentId)],
);

/* ───────────── Import center ───────────── */
export const importBatches = pgTable(
  "import_batches",
  {
    id: id(),
    workspaceId: wsId(),
    entity: text("entity").notNull(),
    fileName: text("file_name").notNull(),
    status: text("status").notNull().default("staged"),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    errorRows: integer("error_rows").notNull().default(0),
    committedRows: integer("committed_rows").notNull().default(0),
    mapping: jsonb("mapping").notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [unique("ib_ws_id").on(t.workspaceId, t.id)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    workspaceId: wsId(),
    batchId: uuid("batch_id").notNull(),
    rowNo: integer("row_no").notNull(),
    raw: jsonb("raw").notNull(),
    mapped: jsonb("mapped"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.batchId], foreignColumns: [importBatches.workspaceId, importBatches.id] }),
    index("ir_batch_idx").on(t.batchId, t.status),
  ],
);

/* ───────────── Legal & privacy ───────────── */
export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: id(),
    workspaceId: wsId(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [unique("ld_ws_id").on(t.workspaceId, t.id)],
);

export const legalVersions = pgTable(
  "legal_versions",
  {
    id: id(),
    workspaceId: wsId(),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    locale: text("locale").notNull().default("id"),
    content: text("content").notNull(),
    summary: text("summary"),
    status: text("status").notNull().default("draft"),
    effectiveDate: date("effective_date"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("lv_unique").on(t.workspaceId, t.documentId, t.version, t.locale),
    foreignKey({ columns: [t.workspaceId, t.documentId], foreignColumns: [legalDocuments.workspaceId, legalDocuments.id] }),
  ],
);

export const legalAcceptances = pgTable("legal_acceptances", {
  id: id(),
  workspaceId: wsId(),
  versionId: uuid("version_id").notNull(),
  userId: uuid("user_id"),
  subjectLabel: text("subject_label"),
  acceptedAt: ts("accepted_at"),
});

export const consentRecords = pgTable("consent_records", {
  id: id(),
  workspaceId: wsId(),
  subjectType: text("subject_type").notNull(),
  subjectRef: text("subject_ref").notNull(),
  purpose: text("purpose").notNull(),
  legalBasis: text("legal_basis").notNull().default("consent"),
  status: text("status").notNull().default("granted"),
  recordedAt: ts("recorded_at"),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
});

export const dataSubjectRequests = pgTable("data_subject_requests", {
  id: id(),
  workspaceId: wsId(),
  requestType: text("request_type").notNull(),
  subjectName: text("subject_name").notNull(),
  subjectEmail: text("subject_email"),
  subjectRef: text("subject_ref"),
  status: text("status").notNull().default("received"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  resolution: text("resolution"),
  createdAt: ts("created_at"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/* ───────────── Platform administration (NOT tenant data: no workspace_id, no access for bf_runtime) ───────────── */
export const platformAdmins = pgTable("platform_admins", {
  id: id(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("SUPER_ADMIN"),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: ts("created_at"),
}, (t) => [check("pa_role", sql`${t.role} in ('SUPER_ADMIN')`)]);

/** Append-only (trigger + revoked privileges): every platform-admin action, including denied attempts. */
export const adminAuditLog = pgTable("admin_audit_log", {
  id: id(),
  actor: text("actor"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  reason: text("reason"),
  outcome: text("outcome").notNull().default("ok"),
  ip: text("ip"),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  createdAt: ts("created_at"),
}, (t) => [index("aal_created_idx").on(t.createdAt)]);

/* ───────────── Multi-currency (base ledger stays in workspace currency; rates are reference data) ───────────── */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: id(),
    workspaceId: wsId(),
    currencyFrom: text("currency_from").notNull(),
    currencyTo: text("currency_to").notNull(),
    rate: numeric("rate", { precision: 24, scale: 10 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    unique("fx_unique").on(t.workspaceId, t.currencyFrom, t.currencyTo, t.effectiveDate),
    check("fx_codes", sql`${t.currencyFrom} ~ '^[A-Z]{3}$' and ${t.currencyTo} ~ '^[A-Z]{3}$' and ${t.currencyFrom} <> ${t.currencyTo}`),
    check("fx_rate", sql`${t.rate} > 0`),
    index("fx_lookup_idx").on(t.workspaceId, t.currencyFrom, t.currencyTo, t.effectiveDate),
  ],
);
