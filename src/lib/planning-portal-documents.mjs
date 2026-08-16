export function extractPortalPlanningDocumentLinks(html, pageUrl) {
  const text = String(html || "");
  const adapters = [extractLegacyPublicAccessBlobLinks];
  const links = adapters.flatMap((adapter) => adapter(text, pageUrl));
  const seen = new Set();
  const result = [];
  for (const link of links) {
    const key = `${link.url}\n${link.label || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

export function extractLegacyPublicAccessBlobLinks(html, pageUrl) {
  const text = String(html || "");
  if (!/AppBlobImage\s*\(/i.test(text) || !/AttachmentShowServlet\?ImageName=/i.test(text)) return [];

  const attachmentBase = resolveAttachmentBase(text, pageUrl);
  if (!attachmentBase) return [];

  const links = [];
  const pattern = /<a\b[^>]*href\s*=\s*(?:"|')javascript\s*:\s*AppBlobImage\s*\(\s*(?:"|')([0-9]+)(?:"|')\s*\)\s*;?(?:"|')[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const imageId = match[1];
    const label = stripHtml(match[2]);
    if (!imageId || !label) continue;
    const url = new URL(attachmentBase);
    url.searchParams.set("ImageName", imageId);
    links.push({
      url: url.toString(),
      label,
      direct: true,
      source: "legacy-publicaccess-attachment",
      portalAdapter: "legacy-publicaccess-appblobimage",
      attachmentId: imageId
    });
  }
  return links;
}

function resolveAttachmentBase(html, pageUrl) {
  const functionEndpoint = String(html).match(
    /(?:URL\s*=\s*)?["']([^"']*AttachmentShowServlet\?ImageName=)["']\s*\+/i
  );
  if (functionEndpoint?.[1]) {
    try {
      const resolved = new URL(htmlDecode(functionEndpoint[1]), pageUrl);
      resolved.search = "?ImageName=";
      return resolved.toString();
    } catch {}
  }

  // Legacy Oracle PublicAccess deployments commonly expose AppBlobImage on the
  // same /portal/servlets origin as the application details page. Only use this
  // fallback when the page itself explicitly names AttachmentShowServlet.
  try {
    const page = new URL(pageUrl);
    const marker = "/portal/servlets/";
    const index = page.pathname.toLowerCase().indexOf(marker);
    if (index < 0) return null;
    page.pathname = `${page.pathname.slice(0, index)}${marker}AttachmentShowServlet`;
    page.search = "?ImageName=";
    page.hash = "";
    return page.toString();
  } catch {
    return null;
  }
}

function stripHtml(value) {
  return htmlDecode(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
