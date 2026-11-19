# Rolo collector (laptop side)

Everything in this folder runs on the owner's Windows laptop, never on the
Rolo server. See SPEC §15 and CLAUDE.md §WhatsApp for the terms.

Today it holds a **feasibility probe in two parts** and the read-only
store reader the collector will be built on (`idb.mjs`). The collector
itself is not written yet — whether it can be depends on what part 2 finds.

## What part 1 found (2026-11-19, WhatsApp 2.2645.101.0)

- Messages are **not** in the encrypted native databases under
  `LocalState` (those are a few KB each). They are in the WebView's own
  store: `LocalCache\EBWebView\Default\IndexedDB\https_web.whatsapp.com_0.indexeddb.leveldb`.
- Those files can be read while WhatsApp is running.
- A message reaches them within about a second, from the phone or the desktop.
- Not yet known: whether message *text* inside that store is readable.

## Part 2: `inspect.mjs`

Looks inside the store to answer that. It reads the store's files as
bytes — never opening the database, never writing or locking anything in
WhatsApp's folder — decodes records in memory to learn their shape, and,
if message text is encrypted, tries the keys kept in the same store on a
few messages, again in memory. The report holds only table and field
names, counts, sizes and yes/no answers: no message text, no contact
name, no phone number. No network code.

Save `inspect.mjs` **and** `idb.mjs` in the same folder, then:

```powershell
node inspect.mjs
```

and send back `rolo-whatsapp-inspect-report.txt` after reading it.

`idb.mjs` is developed against a real store written by Chromium
(`tests/fixtures/whatsapp-idb/`, tests in `tests/collector/`): LevelDB
logs and tables, Snappy, IndexedDB's key layout, Blink's value envelope
and V8's value format, with no dependencies. It has not yet been run on
WhatsApp's actual store.

## Part 1: `probe.mjs`

`probe.mjs` answers one question: can a program on this laptop read
WhatsApp Desktop's own files, and how soon does a new message reach them?

It looks at the files WhatsApp Desktop keeps under your Windows profile —
names, sizes, dates, and whether each is an ordinary database or an
encrypted one — and, with `--watch`, which of them change when a message
arrives.

It never reads, prints or stores the content of any message or contact;
never writes, moves or deletes anything; has no network code; and does not
ask for administrator rights. Long runs of digits in file names are masked
in the report, since they can be phone numbers.

### Run it

1. Install **WhatsApp** from the Microsoft Store, link it to your phone,
   and wait until your chats have finished loading. Leave it open.
2. Install **Node.js** (LTS) from <https://nodejs.org> if you do not have
   it. In PowerShell, `node --version` should print v22 or newer.
3. Save `probe.mjs` somewhere, for example your Downloads folder, and in
   PowerShell go there:

   ```powershell
   cd $HOME\Downloads
   ```

4. Layout report:

   ```powershell
   node probe.mjs
   ```

5. Timing report — it asks you to send one message from your phone and
   one from WhatsApp Desktop, and watches for two minutes each time:

   ```powershell
   node probe.mjs --watch
   ```

Each run writes `rolo-whatsapp-probe-report.txt` next to the script (the
second run replaces the first, and contains everything the first did).
Open it, check you are happy with what it says, and send that file back.

### What the answers mean

- **Databases: PLAIN** — readable as they are; the collector is simple.
- **Databases: ENCRYPTED** — expected. The next step is checking whether
  the keys can be obtained on your own machine without touching the
  running app. If they cannot, there is no automatic path within the
  rules, and the phone export stays the source.
- **Watch: first change after N s** — how "shortly after" a synced message
  could appear in Rolo.
