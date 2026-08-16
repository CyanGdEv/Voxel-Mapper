import test from "node:test";
import assert from "node:assert/strict";
import { isPublicIpv4, publicIpv4Answers, resolvePublicIpv4 } from "../src/lib/public-dns-http.mjs";

test("DNS fallback accepts only public IPv4 answers", () => {
  const answers = publicIpv4Answers({
    Answer: [
      { type: 5, data: "alias.example." },
      { type: 1, data: "93.184.216.34" },
      { type: 1, data: "127.0.0.1" },
      { type: 1, data: "10.0.0.5" },
      { type: 1, data: "93.184.216.34" },
      { type: 1, data: "203.0.113.7" }
    ]
  });
  assert.deepEqual(answers, ["93.184.216.34"]);
});

test("public IPv4 guard rejects private, link-local, carrier and documentation ranges", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1",
    "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1"
  ]) assert.equal(isPublicIpv4(address), false, address);
  assert.equal(isPublicIpv4("93.184.216.34"), true);
});

test("injected DNS resolver cannot smuggle a private address into the fallback", async () => {
  await assert.rejects(
    resolvePublicIpv4("example.com", { resolvePublicIpv4Impl: async () => ["127.0.0.1", "10.0.0.1"] }),
    /no public IPv4 address/
  );
  assert.deepEqual(
    await resolvePublicIpv4("example.com", { resolvePublicIpv4Impl: async () => ["127.0.0.1", "93.184.216.34"] }),
    ["93.184.216.34"]
  );
});
