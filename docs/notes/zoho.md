# Zoho Inventory + Zoho Accounts: verified reference for MerchantBridge

Scope: only what our tools and OAuth flow use. Every fact cites the vendored file it came from. Anything not in
`docs/vendor/zoho/` is marked **UNVERIFIED** and appears in the smoke checklist at the end. Code that depends on an
UNVERIFIED fact carries a `// UNVERIFIED` comment and a probe in `scripts/smoke.ts`.

Citation keys (all under `docs/vendor/zoho/`):

| Key                                        | File                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `[intro]`                                  | `accounts/introduction.txt` (Inventory API root, org id, DCs, rate limits) |
| `[inv-oauth]`                              | `accounts/oauth.txt` (Inventory's own OAuth page, scopes, header)          |
| `[acc-auth]`                               | `accounts/acc_oauth_web-apps_authorization.txt`                            |
| `[acc-token]`                              | `accounts/acc_oauth_web-apps_access-token.txt`                             |
| `[acc-refresh]`                            | `accounts/acc_oauth_web-apps_access-token-expiry.txt`                      |
| `[acc-revoke]`                             | `accounts/acc_oauth_revoke-refresh-token.txt`                              |
| `[acc-multidc]`                            | `accounts/acc_oauth_multi-dc.txt`                                          |
| `[acc-mobile]`                             | `accounts/acc_oauth_mobile-applications.txt` (PKCE)                        |
| `[errors]` / `[pagination]` / `[response]` | `accounts/errors.txt`, `accounts/pagination.txt`, `accounts/response.txt`  |
| `items.yml#op` etc.                        | OpenAPI 3.0 file + `operationId`                                           |

## 1. Base URL, headers, org id

- API root: `https://www.zohoapis.{tld}/inventory/v1` [intro]. We build it as `${apiDomain}/inventory/v1`.
- Auth header: `Authorization: Zoho-oauthtoken {access_token}`; "Access Token can be passed only in header and cannot
  be passed in the request param" [inv-oauth, Step 6]. The generic Accounts pages say `Authorization: Bearer`
  [acc-token]; we use `Zoho-oauthtoken` only. Whether `Bearer` also works is UNVERIFIED and irrelevant.
- `organization_id` query param on every request [intro]. Exceptions: `GET /organizations` (no org id) and
  `GET /organizations/{organization_id}` (org id is the path param) [intro; organizations.yml#list_organizations,
  #get_organization].
- Response envelope: `{ code, message, <resource> }`; `code` is `0` on success, non-zero on error [response].
  A non-zero `code` on HTTP 200 is not stated explicitly; treat any non-zero `code` as an error regardless of status
  (defensive; probe P-12).
- Timestamps are ISO 8601 `YYYY-MM-DDThh:mm:ssTZD`, example `2016-06-11T17:38:06-0700` (offset without colon)
  [response]. Date-only fields are `yyyy-mm-dd` (e.g. `due_date`, `date` in salesorders.yml/invoices.yml examples).
  Mappers normalize both to ISO strings with a colon offset.
- Money fields are numbers in the OAS for most detail objects but `total` and `balance` on the invoice list are typed
  `string` with numeric examples (invoices.yml#list_invoices). `toMoney()` in `packages/core/src/format.ts` accepts
  both.
- Stock fields on item locations (`location_stock_on_hand`, `location_available_stock`,
  `location_actual_available_stock`) are typed `string` with example `""` (items.yml#get_item). Parse with
  `Number()`; empty string means unknown, not zero. Runtime type UNVERIFIED (P-9).

## 2. Data centers and the serverinfo map

Two vendored tables disagree; we support the intersection (this is what `packages/auth/src/dc.ts` encodes).

| DC  | Accounts server [acc-multidc]   | Inventory API root [intro]               | Supported                 |
| --- | ------------------------------- | ---------------------------------------- | ------------------------- |
| us  | `https://accounts.zoho.com`     | `https://www.zohoapis.com/inventory/`    | yes                       |
| eu  | `https://accounts.zoho.eu`      | `https://www.zohoapis.eu/inventory/`     | yes                       |
| in  | `https://accounts.zoho.in`      | `https://www.zohoapis.in/inventory/`     | yes (our trial org)       |
| au  | `https://accounts.zoho.com.au`  | `https://www.zohoapis.com.au/inventory/` | yes                       |
| jp  | `https://accounts.zoho.jp`      | `https://www.zohoapis.jp/inventory/`     | yes                       |
| ca  | `https://accounts.zohocloud.ca` | `https://www.zohoapis.ca/inventory/`     | yes (note `zohocloud.ca`) |
| sa  | `https://accounts.zoho.sa`      | `https://www.zohoapis.sa/inventory/`     | yes                       |
| uk  | `https://accounts.zoho.uk`      | not listed                               | no (`unsupported_dc`)     |
| cn  | not listed                      | `https://www.zohoapis.com.cn/inventory/` | no (`unsupported_dc`)     |

- `https://accounts.zoho.com/oauth/serverinfo` returns "JSON format server URLs for all the data centers"
  [acc-multidc]. Its exact JSON shape is **not vendored** (UNVERIFIED, P-1). We ship the static table above and use
  serverinfo only to cross-check in smoke; never trust a callback `accounts-server` that is not in the table.
- Inventory's own OAuth page lists only US/EU/IN/AU/CA accounts hosts [inv-oauth]; the Accounts multi-DC page is the
  more complete source.
- The `location` callback values `in` and `eu` are shown in examples [acc-auth, acc-multidc]; the others are assumed
  to be the lowercase DC codes (UNVERIFIED, P-2).

## 3. OAuth 2.0 (server-based client, authorization code)

Endpoints (all `{accounts}` = accounts server of the relevant DC):

| Step      | Request                                                                                                                                      | Source                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Authorize | `GET {accounts}/oauth/v2/auth?response_type=code&client_id&scope&redirect_uri&access_type=offline&prompt=consent&state`                      | [acc-auth], `state` from [inv-oauth]   |
| Callback  | `?code=…&location=in&accounts-server=https://accounts.zoho.in` (+ `state`)                                                                   | [acc-auth], [acc-multidc], [inv-oauth] |
| Exchange  | `POST {accounts-server}/oauth/v2/token` `grant_type=authorization_code&client_id&client_secret&redirect_uri&code`                            | [acc-token]                            |
| Refresh   | `POST {accounts-server}/oauth/v2/token` `grant_type=refresh_token&client_id&client_secret&refresh_token`                                     | [acc-refresh]                          |
| Revoke    | `POST {accounts}/oauth/v2/revoke/token` with `Authorization: Basic base64(client_id:client_secret)`, form `token=…&token_type=refresh_token` | [acc-revoke]                           |

Parameters and behaviour:

- `scope` is comma-separated [inv-oauth]. `access_type=offline` is required to get a `refresh_token`; default is
  `online` [acc-auth, inv-oauth]. `prompt=consent` forces the consent screen every time [acc-auth]. The refresh token
  is returned "for the first time" the app requests offline access [acc-auth, acc-token]; we always send
  `prompt=consent` so a reconnect yields a fresh refresh token.
- Token request parameters may be sent as query string, form body (`x-www-form-urlencoded`), and client credentials as
  a Basic header [acc-refresh]. We send a form body. Never put secrets in a URL we log.
- Token response: `access_token`, `refresh_token` (exchange only), `api_domain`, `token_type: "Bearer"`,
  `expires_in: 3600` [acc-token, acc-refresh]. Access tokens live 1 hour [acc-token]; we cache for 55 min.
- `api_domain` examples in the vendored Accounts pages are `https://api.zoho.com` / `https://api.zoho.eu`
  [acc-token, acc-multidc], not `www.zohoapis.*`. Which value Inventory tokens return is UNVERIFIED (P-3). Rule:
  accept `api_domain` only if it equals the DC table's API domain; otherwise use the table value and log a warning.
- Multi-DC: the token request must go to the user's DC (`accounts-server` from the callback) [acc-multidc,
  acc-token]. The authorize request goes to "the location where your app is registered" [acc-auth]; our clients are
  registered in the IN console (PLAN §8). Starting the authorize step at the user's own DC accounts server (our DC
  picker) is UNVERIFIED (P-4); fallback is to always start at the app's home DC and rely on the callback
  `accounts-server`.
- Multi-DC must be enabled per client in the API console, per DC; client secret may differ per DC unless "use the same
  OAuth credentials for all data centers" is selected [acc-multidc]. Select the same-credentials option.
- Revoke: revoking a refresh token also revokes its access tokens [acc-revoke]. `{accounts}` for revoke is "where
  your app is registered" [acc-revoke]; whether revoke must instead target the user's DC is UNVERIFIED (P-5). Inventory's
  older page shows `POST {accounts}/oauth/v2/token/revoke?token=` [inv-oauth]; we use the Accounts form above.
- PKCE is documented for mobile/desktop public clients [acc-mobile]. We are a confidential server client: HMAC
  single-use `state` instead. Do not claim PKCE.

Authorization code lifetime: **conflict**. [inv-oauth] says 60 seconds; [acc-auth] says 2 minutes, single use.
Design for 60 s: exchange immediately in the callback handler, no queueing.

Limits:

| Limit                           | Value                                                                             | Source                                                          |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Access tokens per refresh token | 10 per 10 min, then blocked for the rest of the window                            | [acc-refresh]                                                   |
| Refresh tokens per user         | 20; the 21st silently deletes the oldest "irrespective of whether [it] is in use" | [inv-oauth]                                                     |
| ...per client                   | the "per user **per client**" qualifier                                           | PLAN §9 research; not in vendored text (UNVERIFIED)             |
| Auth codes per user             | 10 per 10 min                                                                     | PLAN §9 research; "Token limits" page not vendored (UNVERIFIED) |
| Token requests per client       | 10 per 10 min                                                                     | PLAN §9 research; not vendored (UNVERIFIED)                     |

Consequences: single-flight refresh under a Kv lock; cache the access token; separate PROD and DEV clients so local
re-consents cannot evict the prod refresh token (ADR-0004, runbook).

Token endpoint error codes [acc-token, acc-refresh]: `invalid_client` (wrong DC accounts server, bad `client_id`, or bad
`grant_type`), `invalid_client_secret`, `invalid_redirect_uri` (exchange only), `invalid_code` (code or refresh token
missing/invalid/used/**revoked**), and HTTP 400 for wrong method or missing `grant_type`. Authorize errors:
`access_denied`, invalid client, invalid response type, invalid scope, invalid redirect URI [acc-auth].

- A revoked or evicted refresh token surfaces as `invalid_code` per the vendored pages. `invalid_grant` (the RFC 6749
  name used in CLAUDE.md) is not in the vendored text. Treat **both** as `RECONNECT_REQUIRED`. The HTTP status and
  body shape of a failed refresh (`{"error":"invalid_code"}` on 200 vs 400) are UNVERIFIED (P-6).

## 4. Scopes

Request all eight on first consent (each re-consent burns a refresh token). Available Inventory scopes and their
CREATE/UPDATE/READ/DELETE variants are listed in [inv-oauth]; there is no "organizations" scope: `GET /organizations`
needs `ZohoInventory.settings.READ` [intro; organizations.yml].

`ZohoInventory.settings.READ, items.READ, salesorders.READ, invoices.READ, contacts.READ, packages.READ,
shipmentorders.READ, customerpayments.READ` (constants: `packages/zoho-inventory/src/scopes.ts`).

Per endpoint (from each operation's `security` block):

| Endpoint                                                      | Scope                                    | Used by                                     |
| ------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| `GET /organizations`, `GET /organizations/{id}`               | settings.READ                            | connection status, plan detection           |
| `GET /locations`, `GET /locations/{id}`                       | **settings.READ**                        | resolving a warehouse name to `location_id` |
| `GET /items`, `GET /items/{id}`, `GET /itemdetails`           | items.READ                               | search_items, get_item, check_stock         |
| `GET /items/transactions/salesorders`                         | **salesorders.READ** (file is items.yml) | SO fallback when item is known              |
| `GET /items/transactions/invoices`                            | **invoices.READ** (file is items.yml)    | not used in Tier 1                          |
| `GET /salesorders`, `GET /salesorders/{id}`                   | salesorders.READ                         | list/get sales order                        |
| `GET /contacts`, `GET /contacts/{id}`                         | contacts.READ                            | search_customers                            |
| `GET /invoices`, `GET /invoices/{id}`                         | invoices.READ                            | list/get invoice, payment-ref lookup        |
| `GET /invoices/{id}/payments`                                 | **invoices.READ** (not customerpayments) | payment refs on get_invoice                 |
| `GET /customerpayments`, `GET /customerpayments/{payment_id}` | customerpayments.READ                    | find_by_payment_reference                   |
| `GET /packages`, `GET /packages/{id}`                         | packages.READ                            | list_shipments, SO fallback 3               |
| `GET /shipmentorders/{id}`                                    | shipmentorders.READ                      | shipment detail                             |

Cross-module gotchas (all from the `security` blocks above):

- Location lookup is a **settings** scope, not items.
- Item transaction lists live in items.yml but need the **salesorders** / **invoices** scope.
- Invoice payments need **invoices.READ**; payment detail needs **customerpayments.READ**.
- Whether `GET /salesorders/{id}` returns its embedded `packages`/`invoices` without packages.READ/invoices.READ is
  UNVERIFIED (P-10). We request all eight scopes, so this only matters if a merchant narrows consent.
- A missing scope's HTTP status and `code` are not documented ([errors] lists no 403). Map to `SCOPE_NOT_GRANTED`
  once observed (P-11).

## 5. Pagination

- Lists are paginated to 200 by default; `page` (default 1) and `per_page` (default 200) [pagination; every list op].
- Response carries `page_context: { page, per_page, has_more_page }` [pagination]. The OAS list-response schemas for
  `/items`, `/salesorders`, `/invoices`, `/contacts`, `/customerpayments`, `/packages` do **not** declare
  `page_context` (they list only `code`, `message`, `<resource>`); rely on [pagination] and assert it in smoke (P-8).
- Max `per_page` is not documented. Cap at 200 (UNVERIFIED that larger values are rejected).
- Our tool cursors are opaque (`encodeCursor`, core/format.ts) and wrap `{ page, per_page, filters }`; agents never see
  Zoho page numbers.

## 6. Endpoints, query params, response fields

"Documented" = declared as an OAS parameter. "Prose" = only mentioned in another parameter's description text
(e.g. "Variants: name_startswith and name_contains"): usable but UNVERIFIED until smoke.

### 6.1 Organizations (organizations.yml)

- `GET /organizations` -> `organizations[]`: `organization_id, name, contact_name, email, is_default_org, plan_type,
plan_name, plan_period, language_code, fiscal_year_start_month, account_created_date, time_zone, is_org_active,
currency_id, currency_code, currency_symbol, currency_format, price_precision` (#list_organizations).
- `GET /organizations/{organization_id}` -> `organization`: `organization_id, name, time_zone, currency_code,
date_format, is_org_active, address, phone, email, website, ...` (#get_organization). It has **no plan fields**:
  plan detection must use the list. Mapping `plan_name` values (example `"PROFESSIONAL"`) to our plan keys
  free/standard/professional/premium/enterprise is UNVERIFIED (P-7); default to `free` (most conservative).

### 6.2 Locations (locations.yml, settings.READ)

- `GET /locations` params: `is_hierarchical_response` (boolean), `location_type` enum `general|line_item_only`
  (#list_locations). Fields: `location_id, location_name, type, parent_location_id, address, email, phone,
associated_users, ...`.

### 6.3 Items (items.yml, items.READ)

- `GET /items` documented params (#list_items): `page, per_page, search_text` ("name, SKU, or other searchable
  fields"), `filter_by` (`Status.All|Active|Inactive|Lowstock|Unmapped|Uncategorized|Grouped`,
  `ItemType.All|Sales|Purchases|SalesAndPurchases|Inventory|NonInventory|Service`), `sort_column` (`name, sku, rate,
purchase_rate, created_time, last_modified_time, reorder_level, stock_on_hand`), `sort_order` (`A|D`), `status`
  (`active|inactive`), `name`, `name_startswith`, `name_contains`, `sku` (exact), `sku_startswith`, `sku_contains`,
  `rate*` comparisons, `item_id`, `last_modified_time`, `category_id`, `warehouse_id`, `location_id`, `group_id`, ...
- List fields: `item_id, name, sku, status, item_type, product_type, description, rate, purchase_rate, reorder_level,
tax_name, tax_percentage, upc, ean, isbn, hsn_or_sac, created_time, last_modified_time, custom_fields`. **No
  stock fields** in the list schema; stock comes from detail or `/itemdetails`.
- `GET /items/{item_id}` (#get_item) -> `item`: adds `unit, track_inventory, can_be_sold, pricebook_rate,
vendor_name, locations[]` where each location has `location_id, location_name, status, is_primary,
location_stock_on_hand, location_available_stock, location_actual_available_stock`.
- `GET /itemdetails?item_ids=` (#list_item_details): comma-separated ids, `items[]` with the same `locations[]`. Max
  ids per call not documented; we cap at 25 (UNVERIFIED that 25 is accepted, P-13).
- `description` is merchant-authored free text: wrap as `untrusted_text`.
- `sku` "is unique for every item" (items.yml field description): `GET /items?sku=` returns 0 or 1 item.

### 6.4 Sales orders (salesorders.yml, salesorders.READ)

- `GET /salesorders` documented params (#list_sales_orders): `organization_id`, `page`, `per_page`, and
  `salesorder_ids` ("List of sales order IDs separated by comma. Maximum of 200"). `salesorder_ids` is a path-level
  parameter shared with bulk delete and is marked required; the HTML page repeats it as required on the list
  (`accounts/salesorders.txt`). Treat as a doc artifact: we never send it on list; whether GET honours it as a batch
  fetch is UNVERIFIED (P-15).
- **No search, status, customer, date, or sort parameters are documented** for `/salesorders` (OAS and HTML).
  `search_text`, `customer_id`, `status`, `date_start`, `salesorder_number`, `sort_column` are all UNVERIFIED (P-14).
  Default ordering of the list is also undocumented (P-16); the bounded scan assumes newest-first.
- List fields: `salesorder_id, salesorder_number, reference_number, customer_id, customer_name, status, date,
shipment_date, total, bcy_total, currency_code, quantity, quantity_invoiced, quantity_packed, quantity_shipped,
sales_channel, created_time, last_modified_time, is_backorder, is_drop_shipment, custom_fields`.
- Status values (from the status enum on `/items/transactions/salesorders`): `draft, pending_approval, approved,
confirmed, overdue, shipped, partially_shipped, fulfilled, void, drop_shipped, partially_invoiced, invoiced, onhold,
closed, backordered`.
- `GET /salesorders/{salesorder_id}` (#get_sales_order) -> `salesorder` with `line_items[]` (`item_id, line_item_id,
name, description, rate, quantity, quantity_invoiced, quantity_packed, quantity_shipped, item_total, unit,
location_id, location_name`), **`packages[]`** (`package_id, package_number, status, detailed_status,
status_message, shipment_id, shipment_number, shipment_status, carrier, service, tracking_number, shipment_date,
delivery_days, delivery_guarantee`), **`invoices[]`** (`invoice_id, invoice_number, status, date, due_date, total,
balance`), plus `billing_address, shipping_address, notes, terms, total, sub_total, tax_total, currency_code`. One
  call gives the whole dispute chain from order to tracking.
- `GET /items/transactions/salesorders` (#list_item_sales_orders, salesorders.READ): **`item_id` is required**;
  optional `status` (enum above), `customer_id`, `sales_channel`, `sort_column` (`date|salesorder_number`). Useful only
  when the item is known; it is not a per-customer list.

### 6.5 Contacts (contacts.yml, contacts.READ)

- `GET /contacts` (#list_contacts) documented: `contact_name, company_name, first_name, last_name, address, email,
phone` (each max length 100), `filter_by` (`Status.All|Active|Inactive|Duplicate|Crm`), `search_text` ("contact name
  or notes"), `sort_column`, `page, per_page`. The `_startswith` / `_contains` variants are prose only.
- There is no customer-vs-vendor filter; filter `contact_type === 'customer'` client-side.
- List fields: `contact_id, contact_name, company_name, contact_type, status, first_name, last_name, email, phone,
mobile, currency_code, outstanding_receivable_amount, unused_credits_receivable_amount, created_time,
last_modified_time`. Mask `email`, `phone`, `mobile` (core `maskEmail`/`maskPhone`).

### 6.6 Invoices (invoices.yml, invoices.READ)

- `GET /invoices` (#list_invoices) documented: `invoice_number, item_name, item_id, item_description,
reference_number` (exact; no `_contains` variant mentioned), `customer_name, email, total, balance, date, due_date,
status` (`sent, draft, overdue, paid, void, unpaid, partially_paid, viewed`), `customer_id`, `filter_by`
  (`Status.All|Sent|Draft|OverDue|Paid|Void|Unpaid|PartiallyPaid|Viewed`, `Date.PaymentExpectedDate`), `search_text`
  ("invoice number or purchase order or customer name"), `sort_column` (`customer_name, invoice_number, date, due_date,
total, balance, created_time`), `page, per_page`. Prose: `due_date_start, due_date_end, due_date_before,
due_date_after` (also pasted into the `date` description; `date_*` variants are UNVERIFIED).
- List fields: `invoice_id, invoice_number, reference_number, customer_id, customer_name, status, date, due_date,
due_days, currency_code, total, balance, payment_expected_date, last_payment_date, salesperson_name, location_name,
custom_fields`.
- `GET /invoices/{invoice_id}` (#get_invoice): params `print`, `accept` (`json|pdf|html`; never send). Fields add
  `line_items, payment_made, credits_applied, write_off_amount, notes, terms, invoice_url, billing_address,
shipping_address`. There is **no `salesorder_id`** on the invoice schema: invoice -> sales order linkage must come
  from the SO side (`salesorder.invoices[]`) or `reference_number` conventions (UNVERIFIED, P-18).
- `GET /invoices/{invoice_id}/payments` (#list_invoice_payments): `payments[]` with `payment_id, payment_number,
invoice_payment_id, payment_mode, date, reference_number, amount, online_transaction_id, description`.

### 6.7 Customer payments (customer-payments.yml, customerpayments.READ)

- `GET /customerpayments` (#list_customer_payments) documented: `customer_name, reference_number, date` (yyyy-mm-dd),
  `amount, notes, payment_mode, filter_by` (`PaymentMode.All|Check|Cash|BankTransfer|...`), `sort_column`,
  `search_text` ("reference number or customer name or payment description"), `page, per_page`. Prose:
  `reference_number_startswith`, `reference_number_contains`, `customer_name_contains`, `amount_*` comparisons.
- List fields: `payment_id, payment_number, invoice_number, date, payment_mode, amount, bcy_amount, unused_amount,
reference_number, description, customer_id, customer_name, location_name`.
- `GET /customerpayments/{payment_id}` (#retrieve_customer_payment) -> `payment`: adds `invoices[]` (`invoice_id,
invoice_number, date, invoice_amount, amount_applied, balance_amount`), `amount_refunded, bank_charges, status,
email, last_four_digits, currency_code, custom_fields`.
- Which field holds a Razorpay `pay_…` id or UTR is not documented anywhere: `reference_number`, `description`,
  `custom_fields`, and invoice-payment `online_transaction_id` are all candidates (UNVERIFIED, P-17).

### 6.8 Packages and shipment orders

- `GET /packages` (packages.yml#list_packages, packages.READ) documented: `filter_by` (`Status.All|NotShipped|Shipped|
Delivered`), `search_text`, `sort_column` (`tracking_number, salesorder_number, package_number, date, created_time,
last_modified_time, customer_name, customer_id, shipment_date, quantity, delivery_method`),
  `packing_number_startswith/_contains`, `salesorder_number_startswith/_contains` (**typed integer** although SO
  numbers look like `SO-00012`; UNVERIFIED with string values, P-19), `date_start/date_end`,
  `shipment_date_start/shipment_date_end`, `customer_name_startswith/_contains`, `delivery_method_*`, `status`,
  `customer_id`, `page, per_page`.
- List response key is `package` (singular, array) in the OAS for both list and detail (#list_packages, #get_package).
  Almost certainly `packages` on the wire for the list (UNVERIFIED, P-20). Mapper accepts either.
- List fields: `package_id, package_number, salesorder_id, salesorder_number, customer_id, customer_name, date,
total_quantity, email, phone, mobile, notes, created_time, last_modified_time`. **No carrier/tracking on the list**;
  detail `GET /packages/{id}` adds `line_items`, `shipment_order { shipment_id, shipment_number, carrier, service,
tracking_number, status, detailed_status, shipping_date, delivery_method, delivery_days, shipment_rate, notes }`.
- Shipment orders: **no list endpoint**; only `POST /shipmentorders` and `GET/PUT/DELETE /shipmentorders/{id}`
  (shipmentorders.yml). `GET /shipmentorders/{shipmentorder_id}` (shipmentorders.READ) -> `shipment_order`:
  `salesorder_id, salesorder_number, shipment_id, shipment_number, date, status, detailed_status, status_message,
carrier, service, tracking_number, delivery_days, delivery_guarantee, reference_number, customer_id, customer_name,
line_items, notes`.

### 6.9 Deep links (`meta.zoho_url`)

Not documented in the vendored files. Pattern `https://inventory.zoho.{tld}/app/{organization_id}#/{module}/{id}` is
UNVERIFIED (P-21); until confirmed, emit `zoho_url: null` rather than a guessed link.

## 7. Errors

HTTP statuses [errors]: `200`, `201`, `400` (malformed/missing parameter), `401` (invalid AuthToken), `404` (wrong
URL), `405` (method not allowed), `429` (too many requests), `500` (server error). Body always
`{ "code": <non-zero>, "message": "..." }`; example `{"code":1002,"message":"Invoice does not exist."}` [errors].

Mapping (ZohoClient -> core errors):

| Upstream                                                   | Our handling                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 401                                                        | refresh once (single-flight) -> retry once -> `RECONNECT_REQUIRED`                  |
| 400                                                        | `INVALID_INPUT` (our bug or an agent-supplied value Zoho rejects); not retried      |
| 404, or a "does not exist" `code` (1002 seen for invoices) | `NOT_FOUND`. Per-module not-found codes UNVERIFIED (P-22)                           |
| 403 / scope error                                          | `SCOPE_NOT_GRANTED` (status/code UNVERIFIED, P-11)                                  |
| 429 `code 44`                                              | `UpstreamError{rate_limit_minute}` -> governor opens 60 s circuit -> `RATE_LIMITED` |
| 429 `code 45`                                              | `UpstreamError{rate_limit_daily}` -> `DAILY_QUOTA_EXHAUSTED`, never retried         |
| 429 `code 1070`                                            | `UpstreamError{concurrency}` -> requeue with jitter, then `RATE_LIMITED`            |
| 5xx, timeout, network                                      | `UpstreamError{server                                                               | timeout | network}`-> 2 retries ->`UPSTREAM_ERROR` |
| malformed JSON / schema mismatch                           | `UPSTREAM_ERROR`, retryable false                                                   |

## 8. Rate limits [intro]

| Limit                                  | Value                                                                        | Error                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Per minute, per organization           | 100 requests                                                                 | HTTP 429, `code 44`                                                  |
| Per day, per organization              | Free 1000, Standard 2000, Professional 5000, Premium 10000, Enterprise 10000 | HTTP 429, `code 45` ("exceeded the maximum call rate limit of 1000") |
| Concurrent in-flight, per organization | Free 5, paid 10 ("soft limit")                                               | HTTP 429, `code 1070`                                                |

- Two `code 44` messages exist: "your **account** has been blocked" (web UI users) and "your **organization** has been
  blocked" (API customers) [intro]. Both mean the org is blocked; the limit is shared with the merchant's own UI usage
  and other integrations.
- Not documented: `Retry-After` header, block duration after code 44, daily reset time/timezone, whether 429s count
  toward the daily total. Governor defaults are ADR-0005 assumptions: 80/min, leases 4 (free) / 8 (paid), 50% daily
  share, 60 s circuit on 44, UTC-midnight reset (`zohoRateProfile`, core/governor.ts).

## 9. Smoke probes needed (`scripts/smoke.ts`, human-run with the DEV client, GET only)

Results go into ADR-0001's table. IDs are referenced above.

- [ ] P-1 `GET https://accounts.zoho.com/oauth/serverinfo`: record JSON shape; diff against the DC table.
- [ ] P-2 Callback `location` value for the IN trial org (expect `in`).
- [ ] P-3 Token response `api_domain` value for an IN user (`https://www.zohoapis.in` vs `https://api.zoho.in`).
- [ ] P-4 Authorize started at `accounts.zoho.in` with an IN-registered client: works; callback `accounts-server`.
- [ ] P-5 Revoke a throwaway refresh token at the app-home vs user DC accounts server; record status.
- [ ] P-6 Refresh with a bogus refresh token: HTTP status and body (`invalid_code` vs `invalid_grant`).
- [ ] P-7 `GET /organizations`: `plan_name`/`plan_type` for the trial org; build the plan mapping.
- [ ] P-8 `page_context` present on `/items`, `/salesorders`, `/invoices`, `/contacts`, `/customerpayments`,
      `/packages`; try `per_page=201` and record behaviour.
- [ ] P-9 Runtime type of `location_stock_on_hand` / `location_available_stock` (string vs number).
- [ ] P-10 `GET /salesorders/{id}` with a token lacking packages.READ/invoices.READ (DEV client): embedded arrays?
- [ ] P-11 Call `/customerpayments` with a token lacking customerpayments.READ: HTTP status + `code`.
- [ ] P-12 Any error returned with HTTP 200 and non-zero `code`? (record every non-zero code seen.)
- [ ] P-13 `/itemdetails?item_ids=` with 25 ids: accepted?
- [ ] P-14 `/salesorders` with `search_text`, `customer_id`, `status`, `date_start`, `salesorder_number`,
      `sort_column=date&sort_order=D`: ignored, honoured, or 400? (decides ADR-0006 tier 1)
- [ ] P-15 `/salesorders?salesorder_ids=a,b`: honoured as a batch filter?
- [ ] P-16 Default ordering of `/salesorders` (newest first?).
- [ ] P-17 Where `pay_TEST…` refs entered in the trial org land: payment `reference_number`, `description`,
      custom fields, invoice `reference_number`, invoice-payment `online_transaction_id`; does
      `reference_number_contains` and `search_text` match them?
- [ ] P-18 Any invoice field linking back to its sales order (`salesorder_id`/`salesorder_number`/`reference_number`).
- [ ] P-19 `/packages?salesorder_number_contains=00012` and `=SO-00012`.
- [ ] P-20 `/packages` list response key (`packages` vs `package`).
- [ ] P-21 Deep-link pattern for item, SO, invoice, payment in the web app.
- [ ] P-22 `GET /{items,salesorders,invoices,contacts,customerpayments,packages,shipmentorders}/1`: status + `code`.
- [ ] P-23 Response headers on a normal call: any rate-limit headers (`X-RateLimit-*`, `Retry-After`)?
