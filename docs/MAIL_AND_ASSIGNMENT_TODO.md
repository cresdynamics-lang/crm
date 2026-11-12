# CRES OS: staff mail, CC and developer assignment: to-do list

Status as of 2026-11-10. [x] = built, tested locally and deployed. [ ] = still to do.

## 0. BLOCKER: cresdynamics.com has no MX records (found 2026-11-10)
Public DNS (Namecheap nameservers) returns no MX for cresdynamics.com, so nothing can be delivered to info@. Replies to staff mail, and the live-check email, cannot arrive until this is fixed.
- [ ] Namecheap > Domain > Advanced DNS: add MX `@` -> `mx1.privateemail.com` priority 10 and `mx2.privateemail.com` priority 10 (the mailbox host is privateemail.com). Keep the existing `send` MX that Resend uses.
- [ ] Add one combined SPF record for `@`: `v=spf1 include:spf.privateemail.com include:amazonses.com ~all` (only one SPF TXT per name).
- [ ] After DNS propagates, send a test to info@ and confirm it shows in the company inbox, then reply to it from outside to confirm routing.

## A. Invoices only go to the client when Finance creates them
- [x] Remove the client invoice email from project activation (`invoice.create-on-approval` worker); Finance is still notified.
- [x] Test: project activation must not queue a client invoice email (`test/projectCreate.test.js`).
- [x] Deploy to live server.
- [ ] Re-send the 2 invoice emails that failed on 2026-11-10 02:08 UTC (domain was not yet verified): Finance > invoice > Resend.
- [ ] Decide: should the draft invoice made at project activation be marked "draft" until Finance issues it? Today it is `issued` in the list but the client has not been emailed.

## B. Director assigns an existing project to a developer
- [x] `POST /api/assignments` now allows `director` (was sales/admin/pm only).
- [x] Director > Projects: "Assign developer" / "Reassign" button on every active project.
- [x] Test: Director can assign, Finance gets 403.
- [ ] Replace the number `prompt()` picker with a proper dropdown dialog (also used by Sales).
- [ ] Show the pending/accepted state and the invite expiry next to the developer name.
- [ ] Add the same control inside the project detail modal for Director/Admin.

## C. Every staff member sends mail under their own name
- [x] Sender shows as `Nelson Ochieng - Developer Team, Cres Dynamics Ltd <info@cresdynamics.com>` (display name per person, one verified address).
- [x] Not a no-reply: Reply-To is `info@cresdynamics.com`.
- [x] Live send from the production server confirmed through Resend (domain verified).
- [ ] Confirm the message arrives in the info@ mailbox and shows in the company inbox (Resend showed `sent`; arrival not yet seen at time of writing).
- [ ] Optional: per-person addresses (`nelson@cresdynamics.com`) instead of one shared `info@`. Needs mailboxes or aliases and a Resend sender per person.
- [ ] Add an HTML signature with logo and phone number.

## D. Mail inside and outside the system, CC with @
- [x] `To` and `CC` accept outside addresses and `@name` for colleagues (autocomplete after typing `@`).
- [x] `@name` in To/CC gives that colleague a copy in Team mail straight away.
- [x] An email with only `@names` stays inside CRES OS and sends nothing outside.
- [x] Unknown or ambiguous `@name` is rejected with a clear error.
- [ ] Mobile layout check for the @ dropdown.
- [ ] Allow attachments on staff mail.

## E. Replies come back to info@ and are shared
- [x] Replies land in info@; the system matches them to the sender by header, then Ref code, then address.
- [x] The reply goes to the sender's Team mail and to every colleague CC'd with `@`.
- [x] In-app notification and live "new mail" for each.
- [ ] Share replies with CC'd OUTSIDE addresses too (not built on purpose: it would auto-email third parties).
- [ ] Show in the thread who was CC'd and who has opened the reply.
- [ ] Alert Admin when a reply cannot be matched to anyone for more than a day.

## F. Live checks
- [x] Production deploy, migration 031 applied, both PM2 processes online.
- [x] Full test suite passes locally (47 tests).
- [ ] Do not run the full test suite on the live database (it creates and deletes real rows). Use the staging copy, or a read-only live check.
- [ ] Send one reply from outside to info@ with the Ref line and confirm it is routed live.
