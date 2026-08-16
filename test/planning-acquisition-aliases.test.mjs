import test from "node:test";
import assert from "node:assert/strict";
import { collapsePlanningAcquisitionAliases } from "../src/lib/planning-acquisition-aliases.mjs";

const canonicalUrl = (pkid) => `https://publicaccess.example.gov/portal/servlets/ApplicationSearchServlet?PKID=${pkid}`;

test("acquisition collapses a suffix application alias onto its stronger first-party register record", () => {
  const result = collapsePlanningAcquisitionAliases([
    {
      reference: "26/001/FUL",
      description: "Construction of a new attraction building",
      documentationUrl: canonicalUrl(100)
    },
    {
      reference: "26/001/FUL MSA",
      description: "Construction of a new attraction building",
      documentationUrl: "https://secondary.example/application/500"
    }
  ]);

  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].reference, "26/001/FUL");
  assert.deepEqual(result.aliases, [{
    reference: "26/001/FUL MSA",
    documentationUrl: "https://secondary.example/application/500",
    canonicalReference: "26/001/FUL",
    canonicalDocumentationUrl: canonicalUrl(100),
    reason: "reference-suffix-alias"
  }]);
});

test("acquisition collapses a consultation record whose description explicitly names the canonical application", () => {
  const result = collapsePlanningAcquisitionAliases([
    {
      reference: "ABC/2022/0556",
      description: "Installation of replacement ride infrastructure",
      documentationUrl: canonicalUrl(101)
    },
    {
      reference: "SCC/22/0155/CON",
      description: "Consultation response regarding planning application ABC/2022/0556",
      documentationUrl: "https://secondary.example/application/501"
    }
  ]);

  assert.equal(result.applications.length, 1);
  assert.equal(result.aliases.length, 1);
  assert.equal(result.aliases[0].canonicalReference, "ABC/2022/0556");
  assert.equal(result.aliases[0].reason, "explicit-related-application-reference");
});

test("acquisition collapses equivalent long descriptions when the canonical first-party record is a revised submission", () => {
  const description = "Erection of hotel conference centre leisure pool with associated car parking landscaping and re grading of land";
  const result = collapsePlanningAcquisitionAliases([
    {
      reference: "OLD/01/999",
      description,
      documentationUrl: "https://secondary.example/application/502"
    },
    {
      reference: "NEW/01/1000",
      description: `${description} (Revised Submission)`,
      documentationUrl: canonicalUrl(102)
    }
  ]);

  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].reference, "NEW/01/1000");
  assert.equal(result.aliases[0].reason, "equivalent-description");
});

test("acquisition aliasing fails closed when the candidate target is not a stronger first-party register source", () => {
  const description = "A sufficiently long application description that is intentionally identical for both records in this test";
  const result = collapsePlanningAcquisitionAliases([
    {
      reference: "26/010/FUL",
      description,
      documentationUrl: "https://secondary-a.example/application/1"
    },
    {
      reference: "26/011/FUL",
      description: `${description} Revised Submission`,
      documentationUrl: "https://secondary-b.example/application/2"
    }
  ]);

  assert.equal(result.applications.length, 2);
  assert.deepEqual(result.aliases, []);
});

test("unrelated planning applications are never collapsed merely because they share the same bbox", () => {
  const result = collapsePlanningAcquisitionAliases([
    {
      reference: "26/020/FUL",
      description: "New maintenance building",
      documentationUrl: canonicalUrl(103)
    },
    {
      reference: "26/021/FUL",
      description: "New roller coaster station",
      documentationUrl: "https://secondary.example/application/503"
    }
  ]);

  assert.equal(result.applications.length, 2);
  assert.equal(result.aliases.length, 0);
});
