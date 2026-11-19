# Rolo collector (laptop side)

Everything in this folder runs on the owner's Windows laptop, never on the
Rolo server. See SPEC §15 and CLAUDE.md §WhatsApp for the terms.

Today it holds one thing: a **feasibility probe**. The collector itself is
not written yet — whether it can be depends on what the probe finds.

## The probe

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
