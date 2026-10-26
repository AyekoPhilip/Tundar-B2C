# Tunde Capital C2B callback service

Node.js 24 service using fast-xml-parser to validate and read NAV SOAP responses. Receives C2B JSON and maps it to the supplied NAV SOAP WSDL. Hosted at sacco-services.top; server management: maishabora-ventures.com via HTTPS WinRM port 55986.

Deployment status (26 October 2026): installed at `C:\Apps\TundeMpesa` under the `TundeMpesaCallbacks` scheduled task running as Network Service. Both public callbacks returned HTTP 400 for empty test payloads, and the existing `/unisa` portal redirect remains intact. Shortcode: 4166285. Validation accepts all references for that shortcode. NAV forwarding is enabled to the user-authorized BC130 HTTP endpoint. Authentication and service metadata retrieval succeeded from the callback server. Three real payments were subsequently delivered successfully, each with HTTP 200 and responseCode 00, after the NAV PhoneNo field was expanded to accommodate the 64-character payer hash. Production Daraja C2B registration succeeded with ResponseCode 00000000 and ResponseType Completed on 26 October 2026; registration reference 39a8-44ca-88d8-00f815a5e67a619543. Public URLs use /payments/c2b/ because Safaricom rejects URLs containing MPESA. Actual URLs are in the git-ignored `callback-urls.private.txt`; treat them as secrets. IIS access logging is disabled for the callback path. The NAV server is separate from this host. The user explicitly authorized HTTP on 26 October 2026 because no NAV domain is available. NAV credentials and payment data travel unencrypted on that connection.

## Local setup

Copy `.env.example` to `.env`, supply the real shortcode and a random callback token, then run `npm ci`, `npm test` and `npm start`. Run `npm ci` locally before using deploy.ps1 so its dependency folder is available. Keep `.env` and `data/` private. The service binds to loopback port 3087. Run one instance only against the SQLite database; protect and back up the database using SQLite-aware backup tooling.

Registered public URL patterns:

- `https://sacco-services.top/payments/c2b/<CALLBACK_TOKEN>/validation`
- `https://sacco-services.top/payments/c2b/<CALLBACK_TOKEN>/confirmation`

Do not publish the real token in documentation, access logs or chat. Terminate HTTPS at the existing web server and proxy these routes to `127.0.0.1:3087`. Do not replace unrelated sites or bindings. Limit request bodies to 32 KiB, rate limit requests and use current Safaricom-approved source controls at the proxy. Never trust a client-supplied forwarding header for origin checks. The secret path is defense in depth, not cryptographic proof that Safaricom sent a payment. Verify origin controls and reconcile provider records before enabling financial posting.

## Processing

Validation accepts syntactically valid payments for the configured shortcode only when `ACCEPT_ALL_REFERENCES=true`. Otherwise it rejects them pending an agreed reference-validation policy. The WSDL does not expose an account lookup operation. Validation never posts to NAV.

Confirmation commits to SQLite before returning `ResultCode: 0`. A repeated receipt with the same mapped fields is acknowledged without a second record; changed fields produce HTTP 409 for operator investigation. Invalid callbacks return 400; storage failure returns 503. Do not depend on provider retries: reconcile missed callbacks with M-Pesa records.

NAV forwarding is disabled by default. When enabled, the worker sends SOAP with Basic authentication using the configured NAVUserPassword account. URLs default to HTTPS or loopback HTTP. The explicit NAV_ALLOWED_HTTP_ORIGIN setting permits only http://158.220.121.153:3057 for this deployment. Redirects remain disabled. NAV_PASSWORD_BASE64 handles dotenv special characters; it is encoding, not encryption. The server environment file is protected by filesystem ACLs. TLS verification remains enabled for HTTPS connections.

Updated SOAP contract: requests append the required empty `responseCode` parameter after `postingDate`. A successful HTTP response is considered delivered only when the SOAP result contains the exact string `00` in `responseCode` and has no SOAP Fault. Missing, malformed or non-success responses remain uncertain. `nav_attempts` records HTTP status, response code and diagnostic detail in the restricted database. Existing stored callback payloads and their deduplication hashes remain unchanged.

Receipt states: `pending`, `sending`, `delivered`, `uncertain`. A timeout, SOAP fault or unexpected response is quarantined as uncertain, as is an interrupted send after restart. No automatic retry occurs: NAV may have committed before the response was lost. Check NAV by receipt before manually requeuing. NAV must enforce receipt uniqueness to safely replay or recover from database loss. The WSDL alone cannot confirm that protection.

Mapping: `TransID` → receiptNo, `TransactionType` → transactionType, `TransTime` → transactionTime (+03:00) and postingDate, `TransAmount` → transactionAmount, `BusinessShortCode` → paybillCode, `BillRefNumber` → accountCode, `MSISDN` → phoneNo; FirstName/MiddleName/LastName map to the respective name fields, missing values become empty strings. Masked phone numbers remain masked. customerDetails is empty because the C2B callback supplies no equivalent field. Confirm these business mappings and NAV field lengths with the NAV owner before production.

## Deployment checklist

1. Connect through authenticated WinRM to maishabora-ventures.com; inspect OS, existing websites, certificates, Node installation, firewall and service supervisor before modifying anything.
2. Install this directory in a dedicated application folder. Configure a service account, restricted filesystem permissions and a persistent supervisor with the application directory as its working directory.
3. Set the real shortcode, secret token, validation policy and NAV credentials in the server's protected `.env` file. Keep forwarding disabled initially.
4. Add routes on the existing sacco-services.top TLS site, preserving other routes. Suppress token-bearing request paths in logs. Verify TLS and inbound source controls.
5. Exercise callbacks with synthetic receipts against an isolated test database and NAV test company. Verify duplicate handling, outage recovery and receipt lookup/uniqueness in NAV. Never send test financial postings to the production company.
6. Enable NAV forwarding only after these checks. Register the URLs using the appropriate Daraja environment and credentials. Confirm the desired provider timeout behavior before setting registration ResponseType (Completed versus Cancelled).
7. Monitor pending/uncertain receipt counts, disk space and service availability; establish reconciliation and backups. Keep database and admin access off the public web.

WinRM and NAV credentials are saved locally as Windows-encrypted credential files. NAV credentials were transferred over encrypted WinRM into the restricted server environment file. Forwarding is enabled at the user's request. Receipt replay safety in NAV and callback origin controls remain unverified; end-to-end delivery has been confirmed for three real payments. The receipt queue was empty at activation. No payment initiation or URL registration is performed by this application.

Reference: https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/web-services-authentication
