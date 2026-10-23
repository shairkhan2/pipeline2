import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/figtree";
import { detectAppRoute, type AppRoute } from "@/components/layout/AppShell";
import { applyTheme } from "@/lib/theme";
import { LibraryPage } from "@/pages/LibraryPage";
import NewSeriesPage from "@/pages/NewSeriesPage";
import { SetupPage } from "@/pages/SetupPage";
import StatusPage from "@/pages/StatusPage";
import "./index.css";
import "@/pages/studio.css";

type PageId = AppRoute | "setup";

/**
 * Path wins over hash so each HTML entry stays on its page.
 * Hash routes (#/studio, #/meter, #/setup, …) still switch pages on `/`.
 * Pages other than Setup render their own AppShell.
 */
export function resolvePage(loc: { pathname: string; hash: string } = window.location): PageId {
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  const hash = loc.hash || "";
  if (path === "/setup" || path.endsWith("/setup.html")) return "setup";
  if ((path === "/" || path.endsWith("/index.html")) && hash.startsWith("#/setup")) return "setup";
  return detectAppRoute({ pathname: path, hash }) ?? "library";
}

function App() {
  const [page, setPage] = useState<PageId>(() => resolvePage());

  useEffect(() => {
    const sync = () => setPage(resolvePage());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  useEffect(() => {
    const path = window.location.pathname.replace(/\/+$/, "");
    if (
      path.endsWith("/setup") ||
      path.endsWith("/setup.html") ||
      window.location.hash.startsWith("#/setup") ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  if (page === "setup") return <SetupPage />;
  if (page === "studio" || page === "meter") return <LibraryPage />;
  if (page === "status") return <StatusPage />;
  if (page === "new-series") return <NewSeriesPage />;
  return <LibraryPage />;
}

applyTheme();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
