// Seeds 25 realistic fake contacts for local development.
// Usage: npm run seed   (idempotent: skips if any contacts exist, --force wipes)
import { db } from "../src/db/client";
import {
  contactEmails,
  contactFieldSources,
  contacts,
  contactSocials,
  contactTags,
  tags,
} from "../src/db/schema";
import {
  deriveDisplayName,
  normalizeEmail,
} from "../src/lib/contacts/normalize";

const force = process.argv.includes("--force");

const existing = db.select({ id: contacts.id }).from(contacts).all();
if (existing.length > 0 && !force) {
  console.log(
    `DB already has ${existing.length} contacts — pass --force to wipe and reseed.`
  );
  process.exit(0);
}
if (force) {
  db.delete(contacts).run();
  db.delete(tags).run();
}

const now = Date.now();

const TAGS = [
  { name: "investor", color: "#3b82f6" },
  { name: "founder", color: "#f97316" },
  { name: "close-friend", color: "#22c55e" },
  { name: "met-at-conference", color: "#8b5cf6" },
] as const;

const tagIds: Record<string, number> = {};
for (const t of TAGS) {
  const row = db
    .insert(tags)
    .values({ ...t, createdAt: now })
    .returning({ id: tags.id })
    .get();
  tagIds[t.name] = row.id;
}

type SeedContact = {
  first: string;
  last: string;
  title: string;
  company: string;
  location: string;
  email: string;
  linkedin?: string;
  birthday?: [number, number, number | null];
  starred?: boolean;
  tags?: string[];
};

const PEOPLE: SeedContact[] = [
  { first: "Ana", last: "Silva", title: "Product Lead", company: "Anthropic", location: "San Francisco, CA", email: "ana.silva@example.com", linkedin: "https://www.linkedin.com/in/ana-silva-example", birthday: [3, 14, 1990], starred: true, tags: ["close-friend"] },
  { first: "Marc", last: "Dubois", title: "Founder & CEO", company: "Veltra", location: "Paris, France", email: "marc@veltra.example", linkedin: "https://www.linkedin.com/in/marc-dubois-example", birthday: [7, 2, 1985], starred: true, tags: ["founder"] },
  { first: "Priya", last: "Raman", title: "Partner", company: "Meridian Ventures", location: "New York, NY", email: "priya@meridian.example", tags: ["investor"], birthday: [11, 30, null] },
  { first: "Tom", last: "Becker", title: "Staff Engineer", company: "Stripe", location: "Berlin, Germany", email: "tom.becker@example.com", linkedin: "https://www.linkedin.com/in/tom-becker-example" },
  { first: "Lucia", last: "Moreno", title: "Design Director", company: "Figma", location: "Barcelona, Spain", email: "lucia@example.com", birthday: [2, 29, 1992], tags: ["met-at-conference"] },
  { first: "Kenji", last: "Watanabe", title: "CTO", company: "Hoshi Labs", location: "Tokyo, Japan", email: "kenji@hoshi.example", tags: ["founder", "met-at-conference"] },
  { first: "Sarah", last: "O'Neill", title: "Head of Growth", company: "Linear", location: "Dublin, Ireland", email: "sarah.oneill@example.com", starred: true },
  { first: "Diego", last: "Fernandez", title: "Angel Investor", company: "", location: "Mexico City, Mexico", email: "diego.f@example.com", tags: ["investor"] },
  { first: "Emma", last: "Lindqvist", title: "Research Scientist", company: "DeepMind", location: "London, UK", email: "emma.lindqvist@example.com", birthday: [9, 9, 1988] },
  { first: "Raj", last: "Patel", title: "VP Engineering", company: "Notion", location: "San Francisco, CA", email: "raj.patel@example.com" },
  { first: "Claire", last: "Fontaine", title: "Freelance Writer", company: "", location: "Lyon, France", email: "claire@example.com", tags: ["close-friend"], birthday: [12, 25, 1993] },
  { first: "Oluwaseun", last: "Adeyemi", title: "Founder", company: "PayLoop", location: "Lagos, Nigeria", email: "seun@payloop.example", tags: ["founder"] },
  { first: "Hannah", last: "Kim", title: "Product Manager", company: "Vercel", location: "Seoul, South Korea", email: "hannah.kim@example.com", tags: ["met-at-conference"] },
  { first: "Pieter", last: "Van Dam", title: "Solo Founder", company: "Tinybird Tools", location: "Amsterdam, Netherlands", email: "pieter@example.com", tags: ["founder"] },
  { first: "Isabella", last: "Rossi", title: "Partner", company: "Alpine Capital", location: "Milan, Italy", email: "isabella@alpine.example", tags: ["investor"], starred: true },
  { first: "James", last: "Whitfield", title: "Sales Director", company: "Datadog", location: "Austin, TX", email: "james.w@example.com" },
  { first: "Nina", last: "Petrova", title: "ML Engineer", company: "Hugging Face", location: "Lisbon, Portugal", email: "nina.petrova@example.com", birthday: [5, 17, 1995] },
  { first: "Carlos", last: "Mendes", title: "COO", company: "Loggi", location: "São Paulo, Brazil", email: "carlos.mendes@example.com" },
  { first: "Aisha", last: "Khan", title: "Founder & CTO", company: "Medra Health", location: "Boston, MA", email: "aisha@medra.example", tags: ["founder"], birthday: [8, 8, 1987] },
  { first: "Lars", last: "Eriksen", title: "Engineering Manager", company: "Spotify", location: "Stockholm, Sweden", email: "lars.eriksen@example.com" },
  { first: "Mei", last: "Chen", title: "Principal", company: "Horizon Partners", location: "Singapore", email: "mei.chen@horizon.example", tags: ["investor", "met-at-conference"] },
  { first: "David", last: "Okafor", title: "Data Scientist", company: "Airbnb", location: "Seattle, WA", email: "david.okafor@example.com" },
  { first: "Sophie", last: "Martin", title: "Old friend from uni", company: "", location: "Brussels, Belgium", email: "sophie.m@example.com", tags: ["close-friend"], birthday: [1, 19, 1991], starred: true },
  { first: "Ahmed", last: "El-Sayed", title: "Product Designer", company: "Framer", location: "Cairo, Egypt", email: "ahmed.elsayed@example.com" },
  { first: "Kate", last: "Brennan", title: "Founder", company: "Northbeam Analytics", location: "New York, NY", email: "kate@northbeam.example", tags: ["founder", "met-at-conference"] },
];

const SCALAR_FIELDS = [
  "first_name",
  "last_name",
  "title",
  "company",
  "location",
  "birthday",
] as const;

db.transaction(() => {
  for (const p of PEOPLE) {
    const row = db
      .insert(contacts)
      .values({
        firstName: p.first,
        lastName: p.last,
        displayName: deriveDisplayName({
          firstName: p.first,
          lastName: p.last,
        }),
        title: p.title || null,
        company: p.company || null,
        location: p.location || null,
        birthdayMonth: p.birthday?.[0] ?? null,
        birthdayDay: p.birthday?.[1] ?? null,
        birthdayYear: p.birthday?.[2] ?? null,
        starred: p.starred ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: contacts.id })
      .get();

    db.insert(contactEmails)
      .values({
        contactId: row.id,
        email: p.email,
        emailNormalized: normalizeEmail(p.email),
        priority: 0,
        source: "user",
        createdAt: now,
      })
      .run();

    if (p.linkedin) {
      db.insert(contactSocials)
        .values({
          contactId: row.id,
          platform: "linkedin",
          url: p.linkedin,
          source: "user",
          createdAt: now,
        })
        .run();
    }

    for (const name of p.tags ?? []) {
      db.insert(contactTags)
        .values({ contactId: row.id, tagId: tagIds[name], createdAt: now })
        .run();
    }

    for (const field of SCALAR_FIELDS) {
      db.insert(contactFieldSources)
        .values({ contactId: row.id, field, source: "user", updatedAt: now })
        .run();
    }
  }
});

console.log(`Seeded ${PEOPLE.length} contacts and ${TAGS.length} tags.`);
