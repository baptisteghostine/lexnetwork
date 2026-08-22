import { describe, expect, it, afterEach } from "vitest";
import { fetchAllConnections } from "@/lib/sync/linkedin-voyager";

const SESSION = {
  liAt: "AQEDATestTokenValueLongEnough1234567890",
  jsessionId: "ajax:123456789",
  cookieHeader: 'li_at=AQEDATestTokenValueLongEnough1234567890; JSESSIONID="ajax:123456789"; lidc="b=OB01"',
};
const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

describe("lidc redirect dance", () => {
  it("adopts the rotated cookie and succeeds on the retry", async () => {
    const cookiesSeen: string[] = [];
    let call = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      cookiesSeen.push(new Headers(init.headers).get("cookie") ?? "");
      call++;
      if (call === 1) {
        // LinkedIn: wrong datacenter — here's a new lidc, come back.
        const h = new Headers({ location: String(url) });
        h.append("set-cookie", 'lidc="b=VB02:s=V"; Path=/; HttpOnly');
        return new Response(null, { status: 302, headers: h });
      }
      return new Response(
        JSON.stringify({ elements: [], paging: { total: 0 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const out = await fetchAllConnections(SESSION, { delayMs: 0 });
    expect(out).toEqual([]);
    expect(call).toBe(2);
    expect(cookiesSeen[0]).toContain('lidc="b=OB01"');
    // The retry carried the cookie LinkedIn just set.
    expect(cookiesSeen[1]).toContain('lidc="b=VB02:s=V"');
    expect(cookiesSeen[1]).toContain("li_at=");
  });

  it("gives up with a clear error when it redirects forever", async () => {
    globalThis.fetch = (async (url: string) =>
      new Response(null, { status: 302, headers: { location: String(url) } })
    ) as unknown as typeof fetch;
    await expect(fetchAllConnections(SESSION, { delayMs: 0 })).rejects.toThrow(
      /kept redirecting to itself/
    );
  });
});
