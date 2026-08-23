# Rolo LinkedIn Sync (browser extension)

Syncs your own LinkedIn connections into your self-hosted Rolo — including
the **locations** LinkedIn omits from its export ZIP.

## Why this exists as an extension

Rolo's server-side sync (SPEC §9b) cannot work, and no amount of tuning
will change that. LinkedIn sits behind Cloudflare bot management, which
fingerprints the **TLS handshake** — sent before any header. Node's
signature is unmistakably not Chrome's, so the request is classified as a
bot and redirected in a loop. Headers can't fix a TLS fingerprint.

Inside the browser there is nothing to fake:

| | Rolo's server | This extension |
|---|---|---|
| TLS fingerprint | Node's — flagged | Chrome's, because it is Chrome |
| `sec-fetch-site: same-origin` | a claim | literally true |
| Cloudflare bot check | fails it | already passed, by you browsing |
| Cookies | pasted, decaying | live, browser-managed |

This is the same mechanism the commercial personal CRMs use.

## Terms this was built under

- **It breaches LinkedIn's User Agreement.** Automated access is against
  their terms and the enforcement risk — account restriction — is on your
  account, not on Rolo. The owner accepted this explicitly; see
  CLAUDE.md §LinkedIn and SPEC §9c.
- **Polite pacing, kept:** serial requests, 2.5 s between pages, a hard
  250-page cap, LinkedIn's own page size of 40. Burst traffic is what
  actually gets accounts flagged.
- **No evasion beyond being a real browser:** no fingerprint spoofing, no
  proxy rotation, no CAPTCHA or challenge solving. If LinkedIn declines,
  the sync stops and says so.
- **Reads only your own connection list.** No other member's data, no
  messages, nothing written back to LinkedIn.

## Install (one minute)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. In Rolo: **Settings → Integrations → Browser extension** → copy the
   pairing token
5. Click the extension icon, paste the token (and your Rolo address if it
   isn't `http://localhost:3000`), click **Save**

The token is needed because the POST arrives cross-origin, where Rolo's
`SameSite=Lax` session cookie would never be sent.

## Use

1. Open **https://www.linkedin.com/mynetwork/invite-connect/connections/**
   in a tab, logged in
2. Click the extension icon → **Sync connections**
3. Leave the tab open. Progress shows in the popup; closing the popup
   doesn't stop the sync

At 2.5 s per 40 connections, ~3,000 connections takes roughly three
minutes.

Results land through Rolo's normal LinkedIn import: same identity ladder
(profile URL first), same provenance rules, same job-change detection and
Today cards. Re-running is safe — imports only ever add or update, and a
contact is never deleted because it stopped appearing.

## When it breaks

It reads an undocumented API, so it will break when LinkedIn changes it.
Failures are loud: zero parsed connections is an error, never a silent
"you have no connections". The parser lives in
`src/lib/linkedin/voyager.ts` and is deliberately structural (duck-typed
profile objects anywhere in the payload) to survive renames.

## Filling in locations

The connections list carries **no location** — verified against a live
payload by enumerating every key at every depth. Names, headlines, photos,
connection dates; nothing geographic. The export ZIP has no location
column either. Location exists only on each individual profile, which
costs one request per person.

So **Fill in locations** is a slow trickle, not a sweep:

- A capped number of profiles a day (default 100, ceiling 300), 4 s apart
- Most important people first — starred, then anyone on a keep-in-touch
  cadence, then whoever you spoke to most recently
- Each contact is fetched once, not every sync; locations barely move
- Stop any time. Closing the tab pauses it; nothing is half-written

At ~2,200 connections that's roughly three weeks — but the map is worth
looking at after the first day, because the people you actually track are
at the front of the queue.

Turn it on first in Rolo: **Settings → Integrations → Fill in locations
from profiles**. It's off by default because per-profile access is a
bigger ask than reading your own connection list, and that's your call to
make.

### When *this* breaks

The profile endpoint has moved before, so the extension tries the known
forms and remembers whichever answers. Location extraction is structural —
it looks for place-shaped keys anywhere in the response rather than a
fixed path — and rejects URNs and bare ids that share those key names.
A round of ten or more profiles where *none* had a location is reported as
suspected shape drift, not as a clean run. Keys live in
`src/lib/linkedin/enrich.ts`.
