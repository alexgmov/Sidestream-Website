import { next, rewrite } from "@vercel/functions";

export const config = {
  matcher: "/api/activation/claim",
};

export default function checkoutHandoffMiddleware(request: Request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.searchParams.get("upgrade") !== "1") {
    return next();
  }

  url.pathname = "/api/checkout/start";
  url.searchParams.delete("upgrade");
  return rewrite(url);
}
