# Data Room Validation Notes

The TypeScript Vite application builds successfully and rendered locally at `http://localhost:4173`. The dashboard showed the Deeptrack data-room shell, folder navigation, local-review storage warning, document metrics, searchable document ledger, and an empty-state filing action. The document-filing dialog opened correctly and exposed typed title, folder, clearance, context, source-mode, and upload controls.

Upload smoke test: a harmless local text file was selected through the upload control, automatically populated its proposed title, and was filed successfully. The new record persisted in the browser-local document repository, appeared in the ledger with its folder, clearance tier, version, date, and managed-file source, and opened in the document drawer with version history and a dedicated download action.

Download smoke test: the document-drawer download action successfully generated a browser download named `smoke-test-document.txt`. The browser download history confirmed the saved file originated from the local TypeScript data-room preview, rather than falling back to a public remote object URL.

Persistence verification: after rebuilding the application with the typed production API adapter and reloading the local preview, the smoke-test document remained in the document ledger. This confirms that the local review repository persists filed documents and managed file references across page reloads. The browser remains in explicit local review mode until `VITE_DATA_ROOM_API_BASE_URL` is configured to point to an authenticated private-storage API.

Public preview verification: the exposed Vite hostname was added to the development-server allowlist, the server was restarted, and the public review URL rendered the TypeScript data-room dashboard successfully without the prior host-block error.

Role-login verification: the upgraded public preview rendered a dedicated entry screen with the Founder, Investor Relations Officer, and Investor role choices; each role displayed its intended authority boundary. The screen also visibly stated that the preview does not request a production password and that production identity, MFA, server-side sessions, private storage, and audit events remain required.

Investor-role verification: a harmless review identity entered through the Investor selection reached the investor-only workspace. The rendered interface showed a read-only role badge, clearance-limited document index, permitted-document search, and a session-end action. It did not render document filing, access/invitation, or governance/audit administration controls.

Administrative-role selection verification: the investor review session ended cleanly and the entry interface accepted selection of the separate Investor Relations Officer profile for the next role-specific check.

Investor Relations Officer verification: a harmless administrative review identity reached the Investor Relations workspace. The rendered interface exposed document filing, Access & invitations, and Governance & audit navigation, while continuing to state that production permission enforcement remains server side.

Administrative-control verification: the Investor Relations Officer access view rendered the Founder, Investor Relations, and investor-invitation boundaries with required identity, authorization, expiry, NDA, revocation, and audit-record requirements. The governance view rendered disclosure review, private distribution, download-evidence controls, and a clearly labelled review-mode activity timeline.

Founder-role selection verification: the Investor Relations Officer session ended cleanly and the entry interface accepted selection of the distinct Founder super-privilege profile for the final role-view check.

Founder-role verification: a harmless Founder review identity reached the separate Founder administrative workspace. The rendered interface showed full clearance, document filing, access/invitation, and governance/audit navigation, distinct from the investor read-only workspace and the Investor Relations operational administrator workspace.

Founder-authority verification: the Founder access-control view rendered the explicit Founder-only authority card for administrator appointment or revocation, room-wide policy, and final publication or withdrawal boundaries. This card did not appear in the Investor Relations operational administrator view.

Personal-email entry verification: the review login clearly accepted personal and business email addresses. An Investor review session using `investor.review@gmail.com` reached the read-only Investor workspace successfully, with no upload or administration controls exposed.

Terminology verification: the data-room interface and delivery source now use comprehensive diligence language. The governance workspace is titled “Comprehensive document operations”; the role-and-control handoff no longer frames the product around a specific transaction or listing stage; and a production build completed after the terminology update.

Login-pane visibility verification: the login view now uses a stable access-first layout. The left pane no longer relies on centred vertical positioning or motion to place its content; it uses a scroll-safe constrained-height desktop layout and a normal mobile document flow. The preview visibly rendered the brand, investor-relations label, headline, supporting copy, and all three security points together. The source contains no active keyframe or animation declarations for the login pane.

Administrative entry presentation verification: selecting Founder visibly changes the field to “Authorized email” and presents the Bryan Koyundi reservation notice for `bryan@deeptrack.io`. The Investor option continues to present open personal-or-business email guidance.

Founder-denial verification: an attempt to enter the Founder workspace with `unauthorized@example.com` remained on the login screen and returned the expected reservation message. No administrative workspace was opened.

Founder-authorized-entry verification: entering `bryan@deeptrack.io` reached the Founder administrative workspace and presented the required Founder identity as Bryan Koyundi, including document filing, access, and governance controls.

Investor Relations entry presentation verification: selecting Investor Relations Officer visibly changes the field to “Authorized email” and presents the Yvonne reservation notice for `ygachara@deeptrack.io`.

Investor Relations authorized-entry verification: entering `ygachara@deeptrack.io` reached the Investor Relations Officer administrative workspace and presented the required identity as Yvonne, including document filing, access, and governance controls.

Open-investor entry verification: a different personal address, `another.investor@gmail.com`, reached the Investor workspace successfully. The resulting view remained read-only and exposed no document filing, access, or governance administration controls.
